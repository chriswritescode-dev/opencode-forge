/**
 * Forge Execution Service - Loop/Goal Start Handlers
 *
 * Extracted from execution.ts. Contains the loop.start and goal.start
 * handlers plus their shared guards (committed-project check, plan dedupe
 * hash, goal-title derivation) and rollback paths. The in-flight dedupe map
 * is per-service-instance, so it is passed in from createForgeExecutionService
 * rather than owned here. Types and response helpers come from
 * ./execution-types to avoid any cycle back into the execution facade.
 */

import { selectSessionBestEffort } from '../utils/tui-navigation'
import { extractPlanExecutionMetadata } from '../utils/plan-execution'
import { parseModelString } from '../utils/model-fallback'
import { formatLoopSessionTitle } from '../utils/session-titles'
import { slugify } from '../utils/logger'
import { buildLoopPermissionRuleset, resolveLoopAllowedDirectories } from '../constants/loop'
import { isSandboxEnabled } from '../sandbox/context'
import { createLoopSessionWithWorkspace } from '../utils/loop-session'
import { getWorktreeProjectPreconditionError } from '../workspace/forge-worktree'

import { attachLoopToSession, selectInitialWorktreeSession } from './execution-attach'
import { resolvePlanSource } from './execution-plan-handlers'

import {
  ok,
  fail,
  type ForgeExecutionRequestContext,
  type ForgeExecutionResponse,
  type ForgeExecutionError,
  type ForgeExecutionServiceDeps,
  type StartLoopCommand,
  type StartGoalCommand,
  type LoopStartedResult,
  type GoalStartedResult,
} from './execution-types'

export function createLoopStartHandlers(
  deps: ForgeExecutionServiceDeps,
  inFlightLoopStarts: Map<string, Promise<ForgeExecutionResponse<LoopStartedResult>>>,
) {
  function hashPlanForDedupe(text: string): string {
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h) ^ text.charCodeAt(i)
    return (h >>> 0).toString(36)
  }

  /**
   * Worktree loops require a committed git project. When opencode starts in a
   * directory without a root commit it scopes the instance to project 'global',
   * while sessions created in the forge worktree resolve their project from the
   * root commit (which forge itself creates). The resulting session is invisible
   * to the TUI and cannot be selected, so fail fast with the remedy instead.
   */
  function guardCommittedProject(ctx: ForgeExecutionRequestContext): ForgeExecutionResponse<never> | null {
    const errorMsg = getWorktreeProjectPreconditionError(ctx.projectId)
    if (errorMsg) {
      deps.client.tui.publish({
        directory: ctx.directory,
        body: {
          type: 'tui.toast.show',
          properties: {
            title: 'Loop start blocked',
            message: 'No git commit in this project — the loop session would be invisible to this opencode instance. Commit, restart opencode, and retry.',
            variant: 'error',
            duration: 10_000,
          },
        },
      }).catch((err: unknown) => {
        deps.logger.error('guardCommittedProject: failed to publish toast', err)
      })

      return fail(
        'bad_request',
        400,
        errorMsg,
      )
    }
    return null
  }

  async function handleStartLoop(
    ctx: ForgeExecutionRequestContext,
    command: StartLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopStartedResult>> {
    // Check if loops are disabled in plugin config
    if (deps.config.loop?.enabled === false) {
      return fail('disabled', 403, 'Loops are disabled in plugin config')
    }

    const projectGuard = guardCommittedProject(ctx)
    if (projectGuard) return projectGuard

    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    

    // Extract loop names first so the session title can prefer the explicit Loop Name
    const { displayName, executionName } = extractPlanExecutionMetadata(planText)
    const title = command.title ?? displayName
    const sessionTitle = formatLoopSessionTitle(title, { iteration: 1, currentSectionIndex: 0, totalSections: 0 })
    
    // Generate unique loop name
    const uniqueLoopName = deps.loop.generateUniqueLoopName(command.loopName ?? executionName)

    // In-flight dedupe: suppress concurrent starts for the same source
    const dedupeKey = `${ctx.projectId}::${command.hostSessionId ?? ctx.sourceSessionId ?? ''}::${hashPlanForDedupe(planText)}`
    const existing = inFlightLoopStarts.get(dedupeKey)
    if (existing) {
      deps.logger.log(`handleStartLoop: dedupe — concurrent start suppressed for key=${dedupeKey}`)
      const prior = await existing
      if (prior.ok) {
        return { ok: true, data: { ...prior.data, deduped: true } }
      }
      return prior
    }

    // Wrapped inner async to store/clean up in-flight promise
    async function doStart(): Promise<ForgeExecutionResponse<LoopStartedResult>> {
    // Resolve models
    const resolvedExecutionModel = command.executionModel ?? deps.config.executionModel
    const resolvedAuditorModel = command.auditorModel ?? deps.config.auditorModel
    
    // Resolve variants
    const resolvedExecutionVariant = command.executionVariant ?? deps.config.executionVariant
    const resolvedAuditorVariant = command.auditorVariant ?? deps.config.auditorVariant
    
    // Resolve max iterations
    const maxIterations = command.maxIterations ?? deps.config.loop?.defaultMaxIterations ?? 0
    
    // Track created resources for rollback
    let createdSessionId: string | null = null
    let createdWorkspaceId: string | undefined
    let hostWorktreeDir: string | undefined
    let worktreeBranch: string | undefined
    let sandboxStarted = false
    let sandboxStartAttempted = false
    let sandboxContainer: string | null = null
    let sandboxEnabledForLoop: boolean
    let loopStatePersisted = false

    const rollbackLoopStart = async (): Promise<void> => {
      if (createdSessionId) {
        await deps.client.session.abort({ sessionID: createdSessionId }).catch(() => {})
      }
      if (loopStatePersisted) {
        deps.loop.service.deleteState(uniqueLoopName)
        loopStatePersisted = false
      }
      if ((sandboxStarted || sandboxStartAttempted) && deps.sandboxManager) {
        await deps.sandboxManager.stop(uniqueLoopName).catch(() => {})
        sandboxStarted = false
        sandboxContainer = null
      }
      if (createdWorkspaceId) {
        await deps.client.workspace.remove({ id: createdWorkspaceId }).catch(() => {})
      }
      if (hostWorktreeDir) {
        const { cleanupLoopWorktree } = await import('../utils/worktree-cleanup')
        await cleanupLoopWorktree({
          worktreeDir: hostWorktreeDir,
          logPrefix: 'handleStartLoop',
          logger: deps.logger,
        })
      }
    }
    
    try {
      let sessionId: string
      let initialBoundWorkspaceId: string | undefined

      const doSelectInitialWorktreeSession = async (
        targetSessionId: string,
        boundWorkspaceId: string | undefined,
        context: string,
      ): Promise<void> => {
        await selectInitialWorktreeSession(targetSessionId, boundWorkspaceId, context, {
          selectSession: command.lifecycle?.selectSession,
          logger: deps.logger,
          workspaceStatusRegistry: deps.workspaceStatusRegistry,
          selectSessionFn: (sel) => selectSessionBestEffort(deps.client, deps.directory, deps.logger, sel),
        })
      }

      // Compute host session ID for metadata persistence only (not session parenting)
      const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId

      if (!deps.sandboxManager) {
        deps.logger.log('handleStartLoop: sandbox manager not initialized; running in worktree-only mode')
      }

      // Create builtin worktree workspace (single call — no separate worktree.create)
      const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const wsResult = await createBuiltinWorktreeWorkspace(deps.client, {
        loopName: uniqueLoopName,
        directory: ctx.directory,
      }, deps.logger, deps.workspaceStatusRegistry)
      if (!wsResult.ok) {
        deps.logger.error(`handleStartLoop: failed to create builtin worktree workspace (${wsResult.error.reason})`, wsResult.error.cause ?? '')
        return fail('internal_error', 500, wsResult.error.message, { reason: wsResult.error.reason })
      }
      const ws = wsResult.workspace
      hostWorktreeDir = ws.directory
      worktreeBranch = ws.branch
      const workspaceId = ws.workspaceId
      createdWorkspaceId = ws.workspaceId

      // Build permissions
      const sandboxEnabled = isSandboxEnabled(deps.config, deps.sandboxManager)
      sandboxEnabledForLoop = sandboxEnabled

      const permissionRuleset = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(deps.config) })

      // Create single code session
      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: sessionTitle,
        directory: hostWorktreeDir!,
        permission: permissionRuleset,
        workspaceId,
        loopName: uniqueLoopName,
        logPrefix: 'handleStartLoop',
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
      })

      if (!createResult) {
        deps.logger.error('handleStartLoop: failed to create session')
        await rollbackLoopStart()
        return fail('internal_error', 500, 'Failed to create loop session')
      }

      // eslint-disable-next-line prefer-const
      sessionId = createResult.sessionId
      createdSessionId = sessionId
      // eslint-disable-next-line prefer-const
      initialBoundWorkspaceId = createResult.boundWorkspaceId

      if (createResult.bindFailed) {
        deps.logger.log(`handleStartLoop: workspace ${workspaceId} created but initial bind failed; will retry on next session`)
      }
      // Navigate the TUI to the worktree session immediately so the user sees the new
      // session before the slow sandbox + provisioning + prompt path runs.
      await doSelectInitialWorktreeSession(sessionId, initialBoundWorkspaceId, 'after session create')

      // Start sandbox if enabled
      if (sandboxEnabled && deps.sandboxManager) {
        const existingSandbox = deps.sandboxManager.getActive(uniqueLoopName)
        if (existingSandbox) {
          sandboxStarted = true
          sandboxContainer = existingSandbox.containerName
          deps.logger.log(`handleStartLoop: sandbox container ${existingSandbox.containerName} already provisioned by forge workspace adapter`)
        } else {
          try {
            sandboxStartAttempted = true
            const result = await deps.sandboxManager.start(uniqueLoopName, hostWorktreeDir!)
            sandboxStarted = true
            sandboxContainer = result.containerName
            deps.logger.log(`handleStartLoop: sandbox container ${result.containerName} started`)
          } catch (err) {
            deps.logger.error('handleStartLoop: failed to start sandbox; rolling back loop start', err)
            await rollbackLoopStart()
            return fail('internal_error', 500, 'Failed to start sandbox')
          }
        }
      }

      // Call attachLoopToSession with the final state
      const attachResult = await attachLoopToSession(deps, ctx, {
        sessionId,
        workspaceId: createdWorkspaceId,
        worktreeDir: hostWorktreeDir!,
        worktreeBranch,
        loopName: uniqueLoopName,
        displayName,
        executionName,
        hostSessionId,
        executionModel: resolvedExecutionModel,
        auditorModel: resolvedAuditorModel,
        executionVariant: resolvedExecutionVariant,
        auditorVariant: resolvedAuditorVariant,
        maxIterations,
        sandboxEnabled: sandboxEnabledForLoop,
        sandboxContainer: sandboxContainer ?? undefined,
        planText,
        selectSession: command.lifecycle?.selectSession,
        selectSessionTiming: command.lifecycle?.selectSessionTiming,
        startWatchdog: command.lifecycle?.startWatchdog,
        abortSourceSessionOnSuccess: command.lifecycle?.abortSourceSessionOnSuccess,
        onStarted: command.lifecycle?.onStarted,
      })

      if (!attachResult.ok) {
        // Provider-limit failures already terminate the loop row via
        // attachLoopToSession; rolling back would delete the restartable
        // errored row and workspace, defeating loop-status restart=true.
        if (attachResult.code !== 'provider_limit') {
          await rollbackLoopStart()
        }
        return fail(attachResult.code as ForgeExecutionError['code'], 503, attachResult.message)
      }

      const parsedExec = parseModelString(resolvedExecutionModel)
      const modelUsed = parsedExec
        ? `${parsedExec.providerID}/${parsedExec.modelID}`
        : null

      return ok({
        operation: 'loop.start',
        sessionId,
        loopName: uniqueLoopName,
        displayName,
        executionName,
        worktreeDir: hostWorktreeDir,
        worktreeBranch,
        workspaceId: createdWorkspaceId,
        hostSessionId,
        modelUsed,
        maxIterations,
      })
      
    } catch (err) {
      deps.logger.error('handleStartLoop: unexpected error', err)
      await rollbackLoopStart()
      
      return fail('internal_error', 500, 'Failed to start loop')
    }

    }

    const promise = doStart()
    inFlightLoopStarts.set(dedupeKey, promise)
    try {
      return await promise
    } finally {
      inFlightLoopStarts.delete(dedupeKey)
    }
  }

  /**
   * Derive a short title from a goal's first non-empty line, capped to a bounded length.
   */
  function deriveTitleFromGoal(goal: string): string {
    const firstLine = goal.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? goal.trim()
    const cap = 80
    return firstLine.length > cap ? `${firstLine.slice(0, cap - 1)}…` : firstLine
  }

  async function handleStartGoal(
    ctx: ForgeExecutionRequestContext,
    command: StartGoalCommand,
  ): Promise<ForgeExecutionResponse<GoalStartedResult>> {
    if (deps.config.loop?.enabled === false) {
      return fail('disabled', 403, 'Loops are disabled in plugin config')
    }

    const projectGuard = guardCommittedProject(ctx)
    if (projectGuard) return projectGuard

    const goal = (command.goal ?? '').trim()
    if (!goal) {
      return fail('bad_request', 400, 'Goal text is required')
    }

    const executorSessionId = command.executorSessionId
    if (!executorSessionId) {
      return fail('bad_request', 400, 'executorSessionId is required')
    }

    const title = command.title?.trim() || deriveTitleFromGoal(goal)
    const sessionTitle = formatLoopSessionTitle(title, { iteration: 1, currentSectionIndex: 0, totalSections: 0 })
    const baseName = command.loopName?.trim() ? slugify(command.loopName) : slugify(title)
    const uniqueLoopName = deps.loop.generateUniqueLoopName(baseName)

    const maxIterations = command.maxIterations ?? deps.config.loop?.defaultMaxIterations ?? 0
    const resolvedExecutionModel = deps.config.executionModel
    const resolvedAuditorModel = deps.config.auditorModel
    const resolvedExecutionVariant = deps.config.executionVariant
    const resolvedAuditorVariant = deps.config.auditorVariant
    const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId ?? executorSessionId

    let createdSessionId: string | null = null
    let createdWorkspaceId: string | undefined
    let hostWorktreeDir: string | undefined
    let worktreeBranch: string | undefined
    let sandboxStarted = false
    let sandboxStartAttempted = false
    let sandboxContainer: string | undefined

    const rollbackGoalStart = async (): Promise<void> => {
      if (createdSessionId) {
        await deps.client.session.abort({ sessionID: createdSessionId }).catch(() => {})
      }
      if ((sandboxStarted || sandboxStartAttempted) && deps.sandboxManager) {
        await deps.sandboxManager.stop(uniqueLoopName).catch(() => {})
        sandboxContainer = undefined
      }
      if (createdWorkspaceId) {
        await deps.client.workspace.remove({ id: createdWorkspaceId }).catch(() => {})
      }
      if (hostWorktreeDir) {
        const { cleanupLoopWorktree } = await import('../utils/worktree-cleanup')
        await cleanupLoopWorktree({
          worktreeDir: hostWorktreeDir,
          logPrefix: 'handleStartGoal',
          logger: deps.logger,
        })
      }
    }

    try {
      const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const wsResult = await createBuiltinWorktreeWorkspace(
        deps.client,
        { loopName: uniqueLoopName, directory: ctx.directory },
        deps.logger,
        deps.workspaceStatusRegistry,
      )
      if (!wsResult.ok) {
        deps.logger.error(`handleStartGoal: failed to create worktree workspace (${wsResult.error.reason})`, wsResult.error.cause ?? '')
        return fail('internal_error', 500, wsResult.error.message, { reason: wsResult.error.reason })
      }
      const ws = wsResult.workspace
      hostWorktreeDir = ws.directory
      worktreeBranch = ws.branch
      createdWorkspaceId = ws.workspaceId

      const sandboxEnabled = isSandboxEnabled(deps.config, deps.sandboxManager)
      const permissionRuleset = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(deps.config) })

      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: sessionTitle,
        directory: hostWorktreeDir!,
        permission: permissionRuleset,
        workspaceId: createdWorkspaceId,
        loopName: uniqueLoopName,
        logPrefix: 'handleStartGoal',
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
      })
      if (!createResult) {
        deps.logger.error('handleStartGoal: failed to create session')
        await rollbackGoalStart()
        return fail('internal_error', 500, 'Failed to create goal session')
      }
      createdSessionId = createResult.sessionId

      await selectInitialWorktreeSession(createdSessionId, createResult.boundWorkspaceId, 'goal start', {
        selectSession: true,
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
        selectSessionFn: (sel) => selectSessionBestEffort(deps.client, deps.directory, deps.logger, sel),
      })

      if (sandboxEnabled && deps.sandboxManager) {
        const existingSandbox = deps.sandboxManager.getActive(uniqueLoopName)
        if (existingSandbox) {
          sandboxContainer = existingSandbox.containerName
          sandboxStarted = true
          deps.logger.log(`handleStartGoal: sandbox container ${existingSandbox.containerName} already provisioned`)
        } else {
          try {
            sandboxStartAttempted = true
            const result = await deps.sandboxManager.start(uniqueLoopName, hostWorktreeDir!)
            sandboxContainer = result.containerName
            sandboxStarted = true
            deps.logger.log(`handleStartGoal: sandbox container ${result.containerName} started`)
          } catch (sandboxErr) {
            deps.logger.error('handleStartGoal: failed to start sandbox; rolling back', sandboxErr)
            await rollbackGoalStart()
            return fail('internal_error', 500, 'Failed to start sandbox')
          }
        }
      }

      // Persist state, wait for sandbox readiness, send the initial prompt, re-select
      // the TUI post-prompt, and start the watchdog — the same shared path plan loops use.
      const attachResult = await attachLoopToSession(deps, ctx, {
        sessionId: createdSessionId,
        workspaceId: createdWorkspaceId,
        worktreeDir: hostWorktreeDir!,
        worktreeBranch,
        loopName: uniqueLoopName,
        displayName: title,
        executionName: title,
        hostSessionId,
        executionModel: resolvedExecutionModel,
        auditorModel: resolvedAuditorModel,
        executionVariant: resolvedExecutionVariant,
        auditorVariant: resolvedAuditorVariant,
        maxIterations,
        sandboxEnabled,
        sandboxContainer,
        planText: '',
        kind: 'goal',
        goal,
        executorSessionId: createdSessionId,
        selectSession: true,
        startWatchdog: true,
        // Stop the invoking session's turn so its agent cannot keep implementing
        // the goal in the original directory after launch.
        abortSourceSessionOnSuccess: true,
      })

      if (!attachResult.ok) {
        // Provider-limit failures already terminate the loop row via
        // attachLoopToSession; rolling back would delete the restartable
        // errored row and workspace, defeating loop-status restart=true.
        if (attachResult.code !== 'provider_limit') {
          await rollbackGoalStart()
        }
        return fail(attachResult.code as ForgeExecutionError['code'], 503, attachResult.message)
      }

      deps.logger.log(`handleStartGoal: goal loop ${uniqueLoopName} started; new session=${createdSessionId} worktree=${hostWorktreeDir}`)

      return ok({
        operation: 'goal.start',
        sessionId: createdSessionId,
        loopName: uniqueLoopName,
        worktreeDir: hostWorktreeDir,
        worktreeBranch,
        workspaceId: createdWorkspaceId,
        hostSessionId,
        maxIterations,
        goal,
      })
    } catch (err) {
      deps.logger.error('handleStartGoal: unexpected error', err)
      await rollbackGoalStart()
      return fail('internal_error', 500, 'Failed to start goal loop')
    }
  }

  return { handleStartLoop, handleStartGoal }
}
