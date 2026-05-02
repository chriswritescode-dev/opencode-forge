import { existsSync } from 'fs'
import type { ToolContext } from '../tools/types'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { isSandboxEnabled } from '../sandbox/context'
import { findPartialMatch } from '../utils/partial-match'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import type { LoopState } from './loop'
import { formatLoopSessionTitle } from '../utils/session-titles'

export type LoopControlErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'internal_error'

export interface LoopControlError {
  ok: false
  code: LoopControlErrorCode
  status: number
  message: string
  candidates?: string[]
}

export interface CancelLoopSuccess {
  ok: true
  state: LoopState
  message: string
}

export interface RestartLoopSuccess {
  ok: true
  state: LoopState
  newSessionId: string
  previousTermination?: string
  sandbox: boolean
  bindFailed: boolean
  message: string
}

export type CancelLoopResult = CancelLoopSuccess | LoopControlError
export type RestartLoopResult = RestartLoopSuccess | LoopControlError

function fail(code: LoopControlErrorCode, status: number, message: string, candidates?: string[]): LoopControlError {
  return { ok: false, code, status, message, candidates }
}

export async function cancelLoopByName(ctx: ToolContext, name?: string): Promise<CancelLoopResult> {
  const { loopService, loopHandler, config, logger } = ctx
  let state: LoopState

  if (name) {
    const { match, candidates } = loopService.findMatchByName(name)
    if (!match) {
      if (candidates.length > 0) {
        return fail('conflict', 409, `Multiple loops match "${name}". Be more specific.`, candidates.map((s) => s.loopName))
      }
      const recent = loopService.listRecent()
      const foundRecent = recent.find((s) => s.loopName === name || (s.worktreeBranch && s.worktreeBranch.toLowerCase().includes(name.toLowerCase())))
      if (foundRecent) {
        return fail('conflict', 409, `Loop "${foundRecent.loopName}" has already completed.`)
      }
      return fail('not_found', 404, `No active loop found for loop "${name}".`)
    }
    state = match
    if (!state.active) {
      return fail('conflict', 409, `Loop "${state.loopName}" has already completed.`)
    }
  } else {
    const active = loopService.listActive()
    if (active.length === 0) return fail('not_found', 404, 'No active loops.')
    if (active.length !== 1) {
      return fail('conflict', 409, 'Multiple active loops. Specify a name.', active.map((s) => s.loopName))
    }
    state = active[0]
  }

  await loopHandler.cancelBySessionId(state.sessionId)
  logger.log(`loop-cancel: cancelled loop for session=${state.sessionId} at iteration ${state.iteration}`)

  if (config.loop?.cleanupWorktree && state.worktree && state.worktreeDir) {
    await cleanupLoopWorktree({
      worktreeDir: state.worktreeDir,
      projectId: ctx.projectId,
      dataDir: ctx.dataDir,
      logPrefix: 'loop-cancel',
      logger,
    })
  }

  const modeInfo = !state.worktree ? ' (in-place)' : ''
  const branchInfo = state.worktreeBranch ? `\nBranch: ${state.worktreeBranch}` : ''
  return {
    ok: true,
    state,
    message: `Cancelled loop "${state.loopName}"${modeInfo} (was at iteration ${state.iteration}).\nDirectory: ${state.worktreeDir}${branchInfo}`,
  }
}

export async function restartLoopByName(ctx: ToolContext, name: string | undefined, force = false): Promise<RestartLoopResult> {
  const { v2, config, loopService, loopHandler, logger } = ctx
  const active = loopService.listActive()

  if (!name) {
    return fail('bad_request', 400, 'Specify a loop name to restart. Use loop-status to see available loops.')
  }

  const recent = loopService.listRecent()
  const allStates = [...active, ...recent]
  const { match: stoppedState, candidates } = findPartialMatch(name, allStates, (s) => [s.loopName, s.worktreeBranch])
  if (!stoppedState && candidates.length > 0) {
    return fail('conflict', 409, `Multiple loops match "${name}". Be more specific.`, candidates.map((s) => s.loopName))
  }
  if (!stoppedState) {
    const available = allStates.map((s) => s.loopName)
    return fail('not_found', 404, `No loop found for "${name}".`, available)
  }

  if (stoppedState.active && !force) {
    return fail('conflict', 409, `Loop "${stoppedState.loopName}" is currently active. Use force=true to force-restart a stuck loop.`)
  }

  if (stoppedState.terminationReason === 'completed') {
    return fail('conflict', 409, `Loop "${stoppedState.loopName}" completed successfully and cannot be restarted.`)
  }

  if (stoppedState.worktree && stoppedState.worktreeDir && !existsSync(stoppedState.worktreeDir)) {
    return fail('conflict', 409, `Cannot restart "${stoppedState.loopName}": worktree directory no longer exists at ${stoppedState.worktreeDir}. The worktree may have been cleaned up.`)
  }

  const restartSandbox = isSandboxEnabled(config, ctx.sandboxManager)
  const permissionRuleset = buildLoopPermissionRuleset({
    isWorktree: !!stoppedState.worktree,
    isSandbox: restartSandbox,
  })


  const previousTermination = stoppedState.terminationReason
  const previousState: LoopState = { ...stoppedState }
  let restartedState: LoopState | null = null

  type RestartOutcome =
    | { ok: true; newSessionId: string; sandbox: boolean; bindFailed: boolean }
    | { ok: false; error: string }

  let bindFailed = false

  const outcome = await loopHandler.runExclusive<RestartOutcome>(stoppedState.loopName, async () => {
    if (stoppedState.active) {
      const latestState = loopService.getActiveState(stoppedState.loopName)
      if (latestState?.active) {
        try { await v2.session.abort({ sessionID: latestState.sessionId }) } catch {}
        loopHandler.clearLoopTimers(stoppedState.loopName)
        loopService.unregisterLoopSession(latestState.sessionId)
        stoppedState.sessionId = latestState.sessionId
        stoppedState.iteration = latestState.iteration
        stoppedState.prompt = latestState.prompt
        stoppedState.worktreeDir = latestState.worktreeDir
        stoppedState.projectDir = latestState.projectDir
        stoppedState.worktreeBranch = latestState.worktreeBranch
        stoppedState.maxIterations = latestState.maxIterations
        stoppedState.executionModel = latestState.executionModel
        stoppedState.auditorModel = latestState.auditorModel
        stoppedState.workspaceId = latestState.workspaceId
        stoppedState.hostSessionId = latestState.hostSessionId
        stoppedState.sandbox = latestState.sandbox
      }
    }

    if (stoppedState.auditSessionId) {
      try {
        await v2.session.delete({ sessionID: stoppedState.auditSessionId, directory: stoppedState.worktreeDir })
        logger.log(`Loop restart: deleted stale audit session ${stoppedState.auditSessionId}`)
      } catch (err) {
        logger.error(`Loop restart: failed to delete stale audit session ${stoppedState.auditSessionId}`, err)
      }
      loopService.setAuditSessionId(stoppedState.loopName, null)
    }

    const createResult = await createLoopSessionWithWorkspace({
      v2,
      title: formatLoopSessionTitle(stoppedState.loopName),
      directory: stoppedState.worktreeDir,
      permission: permissionRuleset,
      workspaceId: stoppedState.workspaceId,
      logPrefix: 'loop-restart',
      logger,
    })

    if (!createResult) {
      return { ok: false, error: 'Failed to create new session for restart.' }
    }

    const newSessionId = createResult.sessionId

    if (createResult.bindFailed) {
      stoppedState.workspaceId = undefined
      bindFailed = true
    }

    if (restartSandbox) {
      try {
        const sbxResult = await ctx.sandboxManager!.start(stoppedState.loopName, stoppedState.worktreeDir)
        logger.log(`loop-restart: started sandbox container ${sbxResult.containerName}`)
      } catch (err) {
        logger.error('loop-restart: failed to start sandbox container', err)
        return { ok: false, error: 'Restart failed: could not start sandbox container.' }
      }
    }

    const newState: LoopState = {
      active: true,
      sessionId: newSessionId,
      loopName: stoppedState.loopName,
      worktreeDir: stoppedState.worktreeDir,
      projectDir: stoppedState.projectDir || stoppedState.worktreeDir,
      worktreeBranch: stoppedState.worktreeBranch,
      iteration: stoppedState.iteration,
      maxIterations: stoppedState.maxIterations,
      startedAt: new Date().toISOString(),
      prompt: stoppedState.prompt,
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: stoppedState.worktree,
      sandbox: restartSandbox,
      sandboxContainer: restartSandbox
        ? ctx.sandboxManager?.docker.containerName(stoppedState.loopName)
        : undefined,
      executionModel: stoppedState.executionModel,
      auditorModel: stoppedState.auditorModel,
      workspaceId: stoppedState.workspaceId,
      hostSessionId: stoppedState.hostSessionId,
    }

    restartedState = newState

    return { ok: true, newSessionId, sandbox: restartSandbox, bindFailed }
  })

  if (!outcome.ok) {
    return fail('internal_error', 500, outcome.error)
  }

  if (outcome.bindFailed) {
    publishWorkspaceDetachedToast({
      v2,
      directory: stoppedState.projectDir ?? stoppedState.worktreeDir,
      loopName: stoppedState.loopName,
      logger,
      context: 'on restart',
    })
  }

  const promptText = stoppedState.prompt ?? ''
  const loopModel = parseModelString(stoppedState.executionModel)
    ?? parseModelString(config.executionModel)

  const { result: promptResult } = await retryWithModelFallback(
    () => v2.session.promptAsync({
      sessionID: outcome.newSessionId,
      directory: stoppedState.worktreeDir,
      parts: [{ type: 'text' as const, text: promptText }],
      agent: 'code',
      model: loopModel!,
    }),
    () => v2.session.promptAsync({
      sessionID: outcome.newSessionId,
      directory: stoppedState.worktreeDir,
      parts: [{ type: 'text' as const, text: promptText }],
      agent: 'code',
    }),
    loopModel,
    logger,
  )

  if (promptResult.error) {
    logger.error('loop-restart: failed to send prompt', promptResult.error)
    loopService.deleteState(stoppedState.loopName)
    try {
      loopService.setState(previousState.loopName, previousState)
      if (previousState.active) {
        loopService.registerLoopSession(previousState.sessionId, previousState.loopName)
      }
    } catch (restoreErr) {
      logger.error('loop-restart: failed to restore previous loop state after prompt failure', restoreErr)
    }
    if (restartSandbox) {
      try {
        await ctx.sandboxManager!.stop(stoppedState.loopName)
      } catch (sbxErr) {
        logger.error('loop-restart: failed to stop sandbox on prompt failure', sbxErr)
      }
    }
    return fail('internal_error', 500, 'Restart failed: could not send prompt to new session.')
  }

  loopService.deleteState(stoppedState.loopName)
  loopService.setState(stoppedState.loopName, restartedState!)
  loopService.registerLoopSession(outcome.newSessionId, stoppedState.loopName)
  loopHandler.startWatchdog(stoppedState.loopName)

  const modeInfo = !stoppedState.worktree ? ' (in-place)' : ''
  const branchInfo = stoppedState.worktreeBranch ? `\nBranch: ${stoppedState.worktreeBranch}` : ''
  return {
    ok: true,
    state: restartedState ?? stoppedState,
    newSessionId: outcome.newSessionId,
    previousTermination,
    sandbox: outcome.sandbox,
    bindFailed: outcome.bindFailed,
    message: [
      `Restarted loop "${stoppedState.loopName}"${modeInfo}`,
      '',
      `New session: ${outcome.newSessionId}`,
      `Continuing from iteration: ${stoppedState.iteration}`,
      `Previous termination: ${previousTermination}`,
      `Directory: ${stoppedState.worktreeDir}${branchInfo}`,
    ].join('\n'),
  }
}
