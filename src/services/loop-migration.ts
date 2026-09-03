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
import { connectRemoteProject, prepareRemoteLoopLaunch, pushAndLaunchRemoteLoop, deleteForgeSyncRef } from '../utils/tui-remote-launch'
import { resolveLoopPermissionOptionsForWorkspace } from '../utils/loop-permission-options'
import { resolveDataDir } from '../utils/opencode-paths'
import { resolveNamedLoop } from './execution'
import { getRestartability } from '../loop/restartability'
import { loopBranchExists, forgeBranchName } from '../workspace/forge-naming'
import { resolvePostActionConfig } from '../loop/post-action-config'
import { terminationStatusFor, terminationReasonToString, parseTerminationReasonString, type TerminationReason } from '../loop'
import { captureLoopResumeSnapshot, type LoopResumeSnapshot } from '../loop/resume-snapshot'
import { buildResumePromptPlan } from '../loop/resume-prompt'
import { defaultGitService } from '../utils/git-service'
import { getForgeWorkspaceEntry } from '../workspace/forge-worktree'

interface PreFreezeTerminalSnapshot {
  status: import('../loop/state').LoopState['status']
  terminationReason?: string
  completedAt?: string
  completionSummary?: string
}

export async function migrateLoopToRemote(
  deps: ForgeExecutionServiceDeps,
  ctx: ForgeExecutionRequestContext,
  command: MigrateLoopCommand,
): Promise<ForgeExecutionResponse<LoopMigratedResult>> {
  if (!deps.loopHandler || !deps.sectionPlansRepo || !deps.reviewFindingsRepo) {
    return fail('internal_error', 500, 'Loop migration requires the loop handler and section/finding repositories')
  }
  const debug = (message: string) => deps.logger.debug(message)

  const resolved = resolveNamedLoop(deps, command.selector.name)
  if ('response' in resolved) return resolved.response
  const state = resolved.state

  if (!state.worktree) {
    return fail('conflict', 409, `Loop "${state.loopName}" runs in the project directory (worktree: false) and cannot be migrated.`)
  }
  if (deps.featureGroupsRepo?.getFeatureByLoopName(ctx.projectId, state.loopName)) {
    return fail('conflict', 409, `Loop "${state.loopName}" belongs to a feature group and cannot be migrated; groups are orchestrated locally.`)
  }

  const git = deps.git ?? defaultGitService
  const restartability = getRestartability(state, {
    worktreeExists: existsSync,
    branchExists: () => loopBranchExists(state, ctx.directory, git),
  })
  if (!restartability.restartable || restartability.restartBlockedReason === 'migrated') {
    return fail('conflict', 409, restartability.restartBlockedMessage ?? `Loop "${state.loopName}" cannot be migrated.`)
  }
  if (state.phase === 'post_action' && !resolvePostActionConfig(deps.config).enabled) {
    return fail('conflict', 409, 'Loop implementation already completed; post-action is disabled — nothing to migrate.')
  }

  const connected = await connectRemoteProject(
    { remoteName: command.remoteName, localProjectId: ctx.projectId, localDirectory: ctx.directory },
    { config: deps.config, createClient: deps.createRemoteClient, debug },
  )
  if ('error' in connected) {
    return fail('bad_request', 400, connected.error)
  }
  const { remote, project: remoteProject, client: remoteClient } = connected

  const original: PreFreezeTerminalSnapshot = {
    status: state.status,
    terminationReason: state.terminationReason,
    completedAt: state.completedAt,
    completionSummary: state.completionSummary,
  }
  const wsOptions = await resolveLoopPermissionOptionsForWorkspace(deps.client, deps.config, state.workspaceId)
  const remotePermissionOptions = { extraRules: wsOptions.extraRules }
  const previousEntry = state.workspaceId
    ? await getForgeWorkspaceEntry(deps.client, state.workspaceId).catch(() => undefined)
    : undefined
  const ownSyncRef = typeof previousEntry?.extra?.syncRef === 'string' ? previousEntry.extra.syncRef : undefined
  const ownGitRemote = typeof previousEntry?.extra?.gitRemote === 'string' ? previousEntry.extra.gitRemote : undefined

  const warnings: ForgeExecutionWarning[] = []
  const remoteLoopName = await prepareRemoteLoopLaunch({
    client: remoteClient,
    requestedLoopName: state.loopName,
    permissionOptions: remotePermissionOptions,
    config: deps.config,
    dataDir: deps.config.dataDir || resolveDataDir(),
    localDirectory: ctx.directory,
    debug,
    onWarnings: (messages) => warnings.push(...messages.map((message) => ({ code: 'loop_permissions', message }))),
  })
  const syncRef = remoteLoopName.syncRef

  const migratedReason: TerminationReason = { kind: 'migrated', message: remote.name }
  const fresh = await deps.loop.runExclusive(state.loopName, async () => deps.loop.inspect(state.loopName))
  if (!fresh) {
    return fail('not_found', 404, `Loop "${state.loopName}" vanished during migration freeze.`)
  }
  let frozen: import('../loop/state').LoopState | null
  if (fresh.active) {
    const terminated = await deps.loopHandler.terminateLoopByName(fresh.loopName, migratedReason)
    if (terminated === false) {
      return fail('conflict', 409, `Loop "${state.loopName}" changed state during migration; retry.`)
    }
    frozen = deps.loop.inspect(fresh.loopName)
  } else {
    await deps.loop.runExclusive(state.loopName, async () => {
      const latest = deps.loop.inspect(state.loopName)
      if (latest && !latest.active) {
        relabelInactiveLoop(deps, state.loopName, migratedReason)
      }
    })
    frozen = deps.loop.inspect(state.loopName)
  }
  if (!frozen) {
    return fail('internal_error', 500, `Loop "${state.loopName}" vanished during migration freeze.`)
  }
  if (frozen.active || parseTerminationReasonString(frozen.terminationReason ?? '').kind !== 'migrated') {
    return fail('conflict', 409, `Loop "${state.loopName}" changed state during migration; retry.`)
  }

  const projectDir = frozen.projectDir || ctx.directory

  if (frozen.worktreeDir && existsSync(frozen.worktreeDir)) {
    const statusResult = git.statusPorcelain(frozen.worktreeDir)
    if (!statusResult.ok) {
      return rollbackAfterFreeze(
        deps,
        frozen,
        original,
        `Worktree ${frozen.worktreeDir} status check failed after teardown: ${statusResult.stderr || '(no stderr)'}; migration aborted so no work is lost.`,
      )
    }
    if (statusResult.stdout.trim().length > 0) {
      return rollbackAfterFreeze(
        deps,
        frozen,
        original,
        `Worktree ${frozen.worktreeDir} has uncommitted changes after teardown; migration aborted so no work is lost.`,
      )
    }
  }

  let snapshot: LoopResumeSnapshot
  let tip: string
  let launch: { loopName: string; sessionId: string }
  try {
    snapshot = captureLoopResumeSnapshot({
      projectId: ctx.projectId,
      state: frozen,
      sectionPlansRepo: deps.sectionPlansRepo,
      reviewFindingsRepo: deps.reviewFindingsRepo,
    })
    const branch = frozen.worktreeBranch || forgeBranchName(frozen.loopName)
    const tipResult = git.revParseRef(projectDir, `refs/heads/${branch}`)
    if (!tipResult.ok) {
      return rollbackAfterFreeze(deps, frozen, original, `Failed to resolve loop branch ${branch}: ${tipResult.stderr || '(no stderr)'}`)
    }
    tip = tipResult.stdout.trim()

    const resume = buildResumePromptPlan({ service: deps.loop.service, config: deps.config, state: frozen })
    const result = await pushAndLaunchRemoteLoop({
      git,
      cwd: projectDir,
      remote,
      project: remoteProject,
      client: remoteClient,
      loopName: remoteLoopName.loopName,
      syncRef,
      sourceRef: `refs/heads/${branch}`,
      startRef: tip,
      title: frozen.loopName,
      plan: frozen.prompt ?? '',
      executionModel: frozen.executionModel,
      auditorModel: frozen.auditorModel,
      executionVariant: frozen.executionVariant,
      auditorVariant: frozen.auditorVariant,
      permissionOptions: remotePermissionOptions,
      forgeLoopOverrides: {
        maxIterations: frozen.maxIterations,
        resume: snapshot,
      },
      initialPrompt: {
        text: resume.promptText,
        agent: resume.agent,
        model: resume.model,
        variant: resume.variant,
      },
      pushErrorPrefix: `Failed to push loop branch to remote "${remote.name}": `,
      debug,
    })

    if ('error' in result) {
      return rollbackAfterFreeze(deps, frozen, original, result.error)
    }
    launch = result
  } catch (err) {
    return rollbackAfterFreeze(deps, frozen, original, err instanceof Error ? err.message : String(err))
  }

  if (ownSyncRef && ownGitRemote) {
    const cleanup = await deleteForgeSyncRef(git, { cwd: projectDir, gitRemote: ownGitRemote, syncRef: ownSyncRef })
    debug(`loop-migrate: previous sync-ref cleanup ${cleanup.ok ? 'ok' : `failed: ${cleanup.stderr.trim() || 'unknown error'}`}`)
  }

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

function relabelInactiveLoop(
  deps: ForgeExecutionServiceDeps,
  loopName: string,
  reason: TerminationReason,
): void {
  deps.loop.service.terminate(loopName, {
    status: terminationStatusFor(reason),
    reason: terminationReasonToString(reason),
    completedAt: Date.now(),
  })
}

function rollbackAfterFreeze(
  deps: ForgeExecutionServiceDeps,
  frozen: import('../loop/state').LoopState,
  original: PreFreezeTerminalSnapshot,
  message: string,
): ForgeExecutionResponse<never> {
  if (original.status === 'cancelled' || original.status === 'errored' || original.status === 'stalled') {
    deps.loop.service.terminate(frozen.loopName, {
      status: original.status,
      reason: original.terminationReason ?? 'cancelled',
      completedAt: original.completedAt ? Date.parse(original.completedAt) : Date.now(),
      summary: original.completionSummary,
    })
  } else {
    relabelInactiveLoop(deps, frozen.loopName, { kind: 'cancelled' })
  }
  deps.logger.error(`loop-migrate: migration of "${frozen.loopName}" failed after freeze: ${message}`)
  return fail(
    'internal_error',
    502,
    `${message}. Local loop "${frozen.loopName}" is restartable with loop-status restart=true.`,
  )
}
