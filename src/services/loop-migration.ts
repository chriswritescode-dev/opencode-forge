/**
 * Loop migration execution command: moves a local loop's progress to a remote
 * opencode server. Freezes the local loop with a `migrated` termination
 * reason, pushes the loop branch tip to the shared git remote's forge sync
 * ref, and launches the remote loop with a resume snapshot and a
 * phase-appropriate first prompt.
 *
 * Every step composes the owners built in Phases 2-6: remote discovery via
 * `connectRemoteProject`, sync-ref push/delete via `pushForgeSyncRef`/
 * `deleteForgeSyncRef`, loop-name reservation + workspace/session creation
 * via `launchTuiLoop`, snapshot capture via `captureLoopResumeSnapshot`, and
 * prompt selection via `buildResumePromptPlan`. This module only sequences
 * them and owns the freeze/rollback semantics.
 */

import { existsSync } from 'fs'
import type { ForgeExecutionServiceDeps, ForgeExecutionRequestContext, MigrateLoopCommand, LoopMigratedResult } from './execution'
import type { ForgeExecutionResponse, ForgeExecutionWarning } from './execution-response'
import { ok, fail } from './execution-response'
import { connectRemoteProject, pushForgeSyncRef, deleteForgeSyncRef } from '../utils/tui-remote-launch'
import { resolveRemoteLoopPermissionOptions } from '../constants/loop'
import { emitLoopPermissionConfigWarnings } from '../utils/loop-permission-warnings'
import { resolveDataDir } from '../utils/opencode-paths'
import { findPartialMatch } from '../utils/partial-match'
import { getRestartability } from '../loop/restartability'
import { loopBranchExists, forgeBranchName } from '../workspace/forge-naming'
import { resolvePostActionConfig } from '../loop/post-action-config'
import { terminationReasonToString } from '../loop'
import { captureLoopResumeSnapshot } from '../loop/resume-snapshot'
import { buildResumePromptPlan } from '../loop/resume-prompt'
import { reserveTuiLoopName, launchTuiLoop } from '../utils/tui-client'
import { forgeSyncRef } from '../utils/remote-config'
import { defaultGitService } from '../utils/git-service'

export async function migrateLoopToRemote(
  deps: ForgeExecutionServiceDeps,
  ctx: ForgeExecutionRequestContext,
  command: MigrateLoopCommand,
): Promise<ForgeExecutionResponse<LoopMigratedResult>> {
  // 1. Guards
  if (!deps.loopHandler || !deps.sectionPlansRepo || !deps.reviewFindingsRepo) {
    return fail('internal_error', 500, 'Loop migration requires the loop handler and section/finding repositories')
  }
  const debug = (message: string) => deps.logger.debug(message)

  // 2. Resolve the loop (active + recent, same matching as restart)
  const allStates = [...deps.loop.listActive(), ...deps.loop.listRecent()]
  const { match: state, candidates } = findPartialMatch(command.selector.name, allStates, (s) => [s.loopName, s.worktreeBranch])
  if (!state && candidates.length > 0) {
    return fail('conflict', 409, `Multiple loops match "${command.selector.name}". Be more specific.`, undefined, candidates.map((s) => s.loopName))
  }
  if (!state) {
    return fail('not_found', 404, `No loop found for "${command.selector.name}".`, undefined, allStates.map((s) => s.loopName))
  }

  // 3. Restartability + post-action guard (failures leave the loop untouched)
  const git = deps.git ?? defaultGitService
  const restartability = getRestartability(state, {
    worktreeExists: existsSync,
    branchExists: () => loopBranchExists(state, ctx.directory, git),
  })
  if (!restartability.restartable) {
    return fail('conflict', 409, restartability.restartBlockedMessage ?? `Loop "${state.loopName}" cannot be migrated.`)
  }
  if (state.phase === 'post_action' && !resolvePostActionConfig(deps.config).enabled) {
    return fail('conflict', 409, 'Loop implementation already completed; post-action is disabled — nothing to migrate.')
  }

  // 4. Remote connection + project discovery (failures leave the loop untouched)
  const connected = await connectRemoteProject(
    { remoteName: command.remoteName, localProjectId: ctx.projectId, localDirectory: ctx.directory },
    { config: deps.config, createClient: deps.createRemoteClient, debug },
  )
  if ('error' in connected) {
    return fail('bad_request', 400, connected.error)
  }
  const { remote, project: remoteProject, client: remoteClient } = connected

  // 5. Remote loop name + portable permission rules
  const remoteLoopName = await reserveTuiLoopName(remoteClient, null, state.loopName)
  const syncRef = forgeSyncRef(remoteLoopName)
  const remotePermissionOptions = resolveRemoteLoopPermissionOptions(deps.config)
  const warnings: ForgeExecutionWarning[] = []
  emitLoopPermissionConfigWarnings(deps.config, deps.config.dataDir || resolveDataDir(), ctx.directory, {
    logger: { log: debug, error: debug, debug },
    onWarnings: (messages) => warnings.push(...messages.map((message) => ({ code: 'loop_permissions', message }))),
  })

  // 6. Freeze: terminate the local loop as migrated (worktree kept — the
  // reason is not 'completed', so the teardown commits but preserves the branch).
  const migratedReason = { kind: 'migrated' as const, message: remote.name }
  if (state.active) {
    await deps.loopHandler.terminateLoopByName(state.loopName, migratedReason)
  } else {
    deps.loop.service.terminate(state.loopName, {
      status: 'cancelled',
      reason: terminationReasonToString(migratedReason),
      completedAt: Date.now(),
    })
  }
  const frozen = deps.loop.inspect(state.loopName)
  if (!frozen) {
    return fail('internal_error', 500, `Loop "${state.loopName}" vanished during migration freeze.`)
  }

  // 7. Snapshot + branch-tip push. Any failure here rolls the freeze back.
  const snapshot = captureLoopResumeSnapshot({
    projectId: ctx.projectId,
    state: frozen,
    sectionPlansRepo: deps.sectionPlansRepo,
    reviewFindingsRepo: deps.reviewFindingsRepo,
  })
  const branch = frozen.worktreeBranch || forgeBranchName(frozen.loopName)
  const projectDir = frozen.projectDir || ctx.directory
  const tipResult = git.revParseRef(projectDir, `refs/heads/${branch}`)
  if (!tipResult.ok) {
    return rollbackAfterFreeze(deps, frozen, `Failed to resolve loop branch ${branch}: ${tipResult.stderr || '(no stderr)'}`)
  }
  const tip = tipResult.stdout.trim()

  const pushResult = pushForgeSyncRef(git, {
    cwd: projectDir,
    gitRemote: remote.gitRemote,
    sourceRef: `refs/heads/${branch}`,
    syncRef,
  })
  if (!pushResult.ok) {
    return rollbackAfterFreeze(deps, frozen, `Failed to push loop branch to remote "${remote.name}": ${pushResult.error}`)
  }

  // 8+9. Build the phase-appropriate resume prompt and launch the remote loop.
  const resume = buildResumePromptPlan({ service: deps.loop.service, config: deps.config, state: frozen })
  const planText = frozen.prompt ?? ''
  const launch = await launchTuiLoop({
    client: remoteClient,
    directory: remoteProject.worktree,
    projectId: remoteProject.id,
    requestedLoopName: remoteLoopName,
    loopNameReserved: true,
    connectPollIntervalMs: 500,
    title: frozen.loopName,
    plan: planText,
    executionModel: frozen.executionModel,
    auditorModel: frozen.auditorModel,
    executionVariant: frozen.executionVariant,
    auditorVariant: frozen.auditorVariant,
    extraWorkspaceFields: {
      startRef: tip,
      syncRef,
      gitRemote: remote.gitRemote,
      permissionRules: remotePermissionOptions.extraRules,
    },
    forgeLoopOverrides: {
      sandboxEnabled: remote.sandbox,
      maxIterations: frozen.maxIterations,
      resume: snapshot,
    },
    permissionOptions: remotePermissionOptions,
    initialPrompt: {
      text: resume.promptText,
      agent: resume.agent,
      model: resume.model,
      variant: resume.variant,
    },
    debug,
  })

  // 10. Rollback on launch failure: drop the sync ref (best effort, after a
  // successful push), relabel the local loop plain-cancelled (restartable again).
  if ('error' in launch) {
    deleteForgeSyncRef(git, { cwd: projectDir, gitRemote: remote.gitRemote, syncRef })
    return rollbackAfterFreeze(deps, frozen, launch.error)
  }

  // 11. Success
  return ok({
    operation: 'loop.migrate',
    loopName: frozen.loopName,
    remoteName: remote.name,
    remoteLoopName: launch.loopName,
    remoteSessionId: launch.sessionId,
    startRef: tip,
    syncRef,
    phase: snapshot.phase,
    currentSectionIndex: snapshot.currentSectionIndex,
    totalSections: snapshot.totalSections,
  }, warnings.length > 0 ? warnings : undefined)
}

/**
 * Post-freeze failure path: relabel the local loop plain-cancelled so it is
 * restartable again and report the failure with the recovery instructions.
 */
function rollbackAfterFreeze(
  deps: ForgeExecutionServiceDeps,
  frozen: import('../loop/state').LoopState,
  message: string,
): ForgeExecutionResponse<never> {
  deps.loop.service.terminate(frozen.loopName, {
    status: 'cancelled',
    reason: 'cancelled',
    completedAt: Date.now(),
  })
  deps.logger.error(`loop-migrate: migration of "${frozen.loopName}" failed after freeze: ${message}`)
  return fail(
    'internal_error',
    502,
    `${message}. Local loop "${frozen.loopName}" is cancelled and restartable with loop-status restart=true.`,
  )
}
