import type { PluginInput } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopService, LoopState } from '../services/loop'
import { MAX_RETRIES, MAX_CONSECUTIVE_STALLS } from '../services/loop'
import type { Logger, PluginConfig } from '../types'
import { retryWithModelFallback, resolveDecomposerModel } from '../utils/model-fallback'
import { resolveLoopModel, resolveLoopAuditorModel } from '../utils/loop-helpers'
import type { createSandboxManager } from '../sandbox/manager'
import { buildWorktreeCompletionPayload, writeWorktreeCompletionLog } from '../services/worktree-log'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { teardownWorktreeArtifacts } from '../utils/worktree-cleanup'
import { createAuditSession, promptAuditSession } from '../utils/audit-session'
import { formatAuditSessionTitle, formatLoopSessionTitle } from '../utils/session-titles'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { extractSections } from '../utils/section-capture'
import { decomposeDeterministically } from '../services/deterministic-decomposer'

export interface LoopEventHandler {
  onEvent(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void>
  terminateAll(): void
  clearAllRetryTimeouts(): void
  startWatchdog(loopName: string): void
  getStallInfo(loopName: string): { consecutiveStalls: number; lastActivityTime: number } | null
  cancelBySessionId(sessionId: string): Promise<boolean>
  terminateLoopByName(loopName: string, reason: string): Promise<boolean>
  runExclusive<T>(loopName: string, fn: () => Promise<T>): Promise<T>
  clearLoopTimers(loopName: string): void
}



export function isWorkspaceNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /Workspace not found/i.test(msg)
}

export function createLoopEventHandler(
  loopService: LoopService,
  client: PluginInput['client'],
  v2Client: OpencodeClient,
  logger: Logger,
  getConfig: () => PluginConfig,
  sandboxManager?: ReturnType<typeof createSandboxManager>,
  _projectId?: string,
  dataDir?: string,
): LoopEventHandler {
  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryAttempts = new Map<string, number>()
  const lastActivityTime = new Map<string, number>()
  const stallWatchdogs = new Map<string, NodeJS.Timeout>()
  const consecutiveStalls = new Map<string, number>()
  const watchdogRunning = new Map<string, boolean>()
  const stateLocks = new Map<string, Promise<unknown>>()
  const lastStatusFingerprints = new Map<string, string>()

  const IDLE_RETRY_DELAY_MS = 1500
  const MAX_IDLE_RETRIES = 1

  async function createAuditSessionWithFallback(input: {
    loopName: string
    iteration: number
    worktreeDir: string
    workspaceId?: string
    isSandbox: boolean
    auditorModel?: { providerID: string; modelID: string }
    prompt: string
  }): Promise<{ auditSessionId: string; bindFailed: boolean; bindError?: unknown } | null> {
    const created = await createAuditSession({
      v2: v2Client,
      loopName: input.loopName,
      iteration: input.iteration,
      worktreeDir: input.worktreeDir,
      workspaceId: input.workspaceId,
      isSandbox: input.isSandbox,
      auditorModel: input.auditorModel,
      prompt: input.prompt,
      logger,
    })
    if (created) return { auditSessionId: created.auditSessionId, bindFailed: created.bindFailed, bindError: created.bindError }

    try {
      logger.log(`Loop: falling back to plugin client for audit session creation (${input.loopName})`)
      const result = await client.session.create({
        body: {
          title: formatAuditSessionTitle(input.loopName, input.iteration),
          ...(input.workspaceId ? { workspaceID: input.workspaceId } : {}),
        },
        query: {
          directory: input.worktreeDir,
          ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
        },
      } as Parameters<typeof client.session.create>[0])
      const session = result.data as { id?: string } | undefined
      if (!session?.id) return null
      return { auditSessionId: session.id, bindFailed: false }
    } catch (err) {
      logger.error(`Loop: plugin client audit session creation failed`, err)
      return null
    }
  }

  async function promptAuditSessionWithFallback(input: {
    sessionId: string
    worktreeDir: string
    workspaceId?: string
    prompt: string
    auditorModel?: { providerID: string; modelID: string }
  }): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const result = await promptAuditSession(v2Client, input)
    if (result.ok) return result

    try {
      logger.log(`Loop: falling back to plugin client for audit prompt (${input.sessionId})`)
      const legacyResult = await client.session.promptAsync({
        path: { id: input.sessionId },
        query: { directory: input.worktreeDir, ...(input.workspaceId ? { workspace: input.workspaceId } : {}) },
        body: {
          agent: 'auditor-loop',
          parts: [{ type: 'text' as const, text: input.prompt }],
          ...(input.auditorModel ? { model: input.auditorModel } : {}),
        },
      })
      if (legacyResult.error) return { ok: false, error: legacyResult.error }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err }
    }
  }

  function withStateLock<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    const prev = stateLocks.get(loopName) ?? Promise.resolve()
    const nextPromise = prev.catch(() => undefined).then(() => fn())
    stateLocks.set(loopName, nextPromise)
    void nextPromise.finally(() => {
      if (stateLocks.get(loopName) === nextPromise) {
        stateLocks.delete(loopName)
      }
    })
    return nextPromise
  }



  type SessionStatusSnapshot = {
    type?: string
    attempt?: number
    message?: string
    next?: number
    [key: string]: unknown
  }

  function buildStatusFingerprint(status: SessionStatusSnapshot | undefined): string {
    if (!status) return 'missing'
    const stableEntries = Object.entries(status)
      .filter(([key]) => key !== 'next')
      .sort(([a], [b]) => a.localeCompare(b))
    return JSON.stringify(stableEntries)
  }

  function isActiveSessionStatus(statusType: string | undefined): boolean {
    return statusType === 'busy' || statusType === 'retry'
  }

  function isIdleOrMissingSessionStatus(statusType: string | undefined): boolean {
    return statusType === 'idle' || statusType === undefined
  }

  async function getStatusWithRetry(directory: string, attempts = 3, backoffMs = 250): Promise<{ data: Record<string, { type: string }>; ok: boolean; error?: unknown }> {
    let lastErr: unknown = null
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await v2Client.session.status({ directory })
        return { data: (r.data ?? {}) as Record<string, { type: string }>, ok: true }
      } catch (err) {
        lastErr = err
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, backoffMs * (i + 1)))
        }
      }
    }
    return { data: {}, ok: false, error: lastErr }
  }

  function stopWatchdog(loopName: string): void {
    const interval = stallWatchdogs.get(loopName)
    if (interval) {
      clearInterval(interval)
      stallWatchdogs.delete(loopName)
    }
    lastActivityTime.delete(loopName)
    consecutiveStalls.delete(loopName)
    watchdogRunning.delete(loopName)
    lastStatusFingerprints.delete(loopName)
  }

  function startWatchdog(loopName: string): void {
    stopWatchdog(loopName)
    lastActivityTime.set(loopName, Date.now())
    consecutiveStalls.set(loopName, 0)

    const stallTimeout = loopService.getStallTimeoutMs()

    const interval = setInterval(async () => {
      if (watchdogRunning.get(loopName)) return
      watchdogRunning.set(loopName, true)
      try {
        const lastActivity = lastActivityTime.get(loopName)
        if (!lastActivity) return

        const elapsed = Date.now() - lastActivity
        if (elapsed < stallTimeout) return

        const state = loopService.getActiveState(loopName)
        if (!state?.active) {
          stopWatchdog(loopName)
          return
        }

        const sessionId = state.sessionId
        const statusResult = await getStatusWithRetry(state.worktreeDir)
        if (!statusResult.ok) {
          logger.error(`Loop watchdog: failed to check session status after retries, skipping tick`, statusResult.error)
          lastActivityTime.set(loopName, Date.now())
          return
        }

        const statuses = statusResult.data as Record<string, SessionStatusSnapshot>
        const statusSnapshot = statuses[sessionId] as SessionStatusSnapshot | undefined
        const status = statusSnapshot?.type
        const fingerprint = buildStatusFingerprint(statusSnapshot)
        const previousFingerprint = lastStatusFingerprints.get(loopName)

        if (fingerprint !== previousFingerprint) {
          lastStatusFingerprints.set(loopName, fingerprint)
          lastActivityTime.set(loopName, Date.now())
          consecutiveStalls.set(loopName, 0)
          logger.log(`Loop watchdog: loop ${loopName} observed ${state.phase} status change (${status ?? 'missing'}), resetting timer`)

          if (isActiveSessionStatus(status)) {
            return
          }

          if (isIdleOrMissingSessionStatus(status)) {
            if (state.phase === 'auditing') {
              return
            }

            const stallCount = (consecutiveStalls.get(loopName) ?? 0) + 1
            consecutiveStalls.set(loopName, stallCount)
            lastActivityTime.set(loopName, Date.now())

            if (stallCount >= MAX_CONSECUTIVE_STALLS) {
              logger.error(`Loop watchdog: loop ${loopName} exceeded max consecutive stalls (${MAX_CONSECUTIVE_STALLS}), terminating`)
              await terminateLoop(loopName, state, 'stall_timeout')
              return
            }

            logger.log(`Loop watchdog: stall #${stallCount}/${MAX_CONSECUTIVE_STALLS} for ${loopName} (phase=${state.phase}, elapsed=${elapsed}ms), re-triggering`)

            await withStateLock(loopName, async () => {
              const freshState = loopService.getActiveState(loopName)
              if (!freshState?.active) return

              try {
                if (freshState.phase === 'auditing') {
                  await handleAuditingPhase(loopName, freshState)
                } else {
                  await handleCodingPhase(loopName, freshState)
                }
              } catch (err) {
                await handlePromptError(loopName, freshState, `watchdog recovery in ${freshState.phase} phase`, err)
              }
            })
            return
          }

          if (state.phase === 'auditing' && Object.values(statuses).some(s => s.type === 'busy' && s !== statusSnapshot)) {
            return
          }
        }

        if (isActiveSessionStatus(status) || !isIdleOrMissingSessionStatus(status)) {
          const stallCount = (consecutiveStalls.get(loopName) ?? 0) + 1
          consecutiveStalls.set(loopName, stallCount)
          lastActivityTime.set(loopName, Date.now())

          if (stallCount >= MAX_CONSECUTIVE_STALLS) {
            logger.error(`Loop watchdog: loop ${loopName} exceeded max consecutive stalls (${MAX_CONSECUTIVE_STALLS}), terminating`)
            await terminateLoop(loopName, state, 'stall_timeout')
            return
          }

          logger.log(`Loop watchdog: active status unchanged stall #${stallCount}/${MAX_CONSECUTIVE_STALLS} for ${loopName} (phase=${state.phase}, status=${status}, elapsed=${elapsed}ms)`)
          return
        }

        const stallCount = (consecutiveStalls.get(loopName) ?? 0) + 1
        consecutiveStalls.set(loopName, stallCount)
        lastActivityTime.set(loopName, Date.now())

        if (stallCount >= MAX_CONSECUTIVE_STALLS) {
          logger.error(`Loop watchdog: loop ${loopName} exceeded max consecutive stalls (${MAX_CONSECUTIVE_STALLS}), terminating`)
          await terminateLoop(loopName, state, 'stall_timeout')
          return
        }

        logger.log(`Loop watchdog: stall #${stallCount}/${MAX_CONSECUTIVE_STALLS} for ${loopName} (phase=${state.phase}, elapsed=${elapsed}ms), re-triggering`)

        await withStateLock(loopName, async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) return

          try {
            if (freshState.phase === 'auditing') {
              await handleAuditingPhase(loopName, freshState)
            } else if (freshState.phase === 'decomposing') {
              await handleDecomposingPhase(loopName, freshState)
            } else if (freshState.phase === 'final_auditing') {
              await handleFinalAuditPhase(loopName, freshState)
            } else {
              await handleCodingPhase(loopName, freshState)
            }
          } catch (err) {
            await handlePromptError(loopName, freshState, `watchdog recovery in ${freshState.phase} phase`, err)
          }
        })
      } finally {
        watchdogRunning.set(loopName, false)
      }
    }, stallTimeout)

    stallWatchdogs.set(loopName, interval)
    logger.log(`Loop watchdog: started for loop ${loopName} (timeout: ${stallTimeout}ms)`)
  }

  function getStallInfo(loopName: string): { consecutiveStalls: number; lastActivityTime: number } | null {
    const lastActivity = lastActivityTime.get(loopName)
    if (lastActivity === undefined) return null
    return {
      consecutiveStalls: consecutiveStalls.get(loopName) ?? 0,
      lastActivityTime: lastActivity,
    }
  }

  async function terminateLoop(loopName: string, state: LoopState, reason: string): Promise<void> {
    const sessionId = state.sessionId
    const projectDir = state.projectDir ?? state.worktreeDir
    stopWatchdog(loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      idleRetryTimeouts.delete(loopName)
    }
    idleRetryAttempts.delete(loopName)

    const now = Date.now()
    const statusMap = (r: string): 'completed' | 'cancelled' | 'errored' | 'stalled' => {
      if (r === 'completed') return 'completed'
      if (r === 'cancelled' || r === 'user_aborted' || r === 'shutdown') return 'cancelled'
      if (r === 'max_iterations' || r === 'stall_timeout') return 'stalled'
      return 'errored'
    }
    loopService.terminate(loopName, {
      status: statusMap(reason),
      reason,
      completedAt: now,
    })

    try {
      await v2Client.session.abort({ sessionID: sessionId })
    } catch {
      // Session may already be idle
    }

    logger.log(`Loop terminated: reason="${reason}", loop="${state.loopName}", iteration=${state.iteration}`)

    logger.debug(`Loop: terminateLoop reason=${reason} worktree=${!!state.worktree} logEligible=${reason === 'completed' && !!state.worktree}`)

    // Log worktree completion if configured and loop completed successfully
    // Write directly from host context using filesystem calls
    if (reason === 'completed' && state.worktree) {
      const completionTimestamp = new Date()
      const planText = loopService.getPlanText(state.loopName, state.sessionId)

      const completionResult = buildWorktreeCompletionPayload(
        getConfig(),
        {
          projectDir,
          loopName: state.loopName,
          completionTimestamp,
          iteration: state.iteration,
          worktreeBranch: state.worktreeBranch,
          dataDir,
        },
        logger,
      )

      if (completionResult) {
        completionResult.payload.planText = planText
        const written = writeWorktreeCompletionLog(completionResult.payload, logger)
        if (written) {
          logger.log(`Loop: worktree completion log written to ${completionResult.hostPath}`)
        } else {
          logger.error(`Loop: failed to write worktree completion log to ${completionResult.hostPath}`)
        }
      } else {
        logger.log(`Loop: worktree completion logging skipped (payload build failed or disabled)`)
      }
    }

    if (v2Client.tui) {
      const toastVariant = reason === 'completed' ? 'success'
        : reason === 'cancelled' || reason === 'user_aborted' ? 'info'
        : reason === 'max_iterations' ? 'warning'
        : reason === 'stall_timeout' ? 'error'
        : 'error'

      const toastMessage = reason === 'completed' ? `Completed after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
        : reason === 'cancelled' ? 'Loop cancelled'
        : reason === 'max_iterations' ? `Reached max iterations (${state.maxIterations})`
        : reason === 'stall_timeout' ? `Stalled after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
        : reason === 'user_aborted' ? 'Loop aborted by user'
        : `Loop ended: ${reason}`

      v2Client.tui.publish({
        directory: state.projectDir ?? state.worktreeDir,
        body: {
          type: 'tui.toast.show',
          properties: {
            title: state.loopName,
            message: toastMessage,
            variant: toastVariant,
            duration: reason === 'completed' ? 5000 : 3000,
          },
        },
      }).catch((err) => {
        logger.error('Loop: failed to publish toast notification', err)
      })
    }

    if (state.worktree) {
      const reasonLabel =
        reason === 'completed' ? 'completed'
        : reason === 'cancelled' ? 'cancelled'
        : reason === 'stall_timeout' ? 'stalled'
        : reason.startsWith('error') ? 'errored'
        : reason

      const doCommit = reason !== 'missing_worktree_dir'
      const doRemoveWorktree = reason !== 'missing_worktree_dir'

      const teardown = await teardownWorktreeArtifacts({
        v2: v2Client,
        loopName: state.loopName,
        sessionId,
        workspaceId: state.workspaceId,
        worktreeDir: state.worktreeDir,
        projectDir: state.projectDir,
        worktree: true,
        doCommit,
        doRemoveWorktree,
        reasonLabel,
        worktreeBranch: state.worktreeBranch,
        iteration: state.iteration,
        logPrefix: 'Loop',
        logger,
      })

      logger.log(`Loop: teardown for ${state.loopName} sessionDeleted=${teardown.sessionDeleted} workspaceDeleted=${teardown.workspaceDeleted} worktreeRemoved=${teardown.worktreeRemoved}`)
    }

    if (state.sandbox && state.sandboxContainer && sandboxManager) {
      try {
        await sandboxManager.stop(state.loopName!)
        logger.log(`Loop: stopped sandbox container for ${state.loopName}`)
      } catch (err) {
        logger.error(`Loop: failed to stop sandbox container`, err)
      }
    }
  }

  async function handlePromptError(loopName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void> {
    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} already terminated, ignoring error: ${context}`)
      return
    }

    const nextErrorCount = (currentState.errorCount ?? 0) + 1
    
    if (nextErrorCount < MAX_RETRIES) {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), will retry`, err)
      loopService.incrementError(loopName)
      if (retryFn) {
        const retryTimeout = setTimeout(async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) {
            logger.log(`Loop: loop cancelled, skipping retry`)
            retryTimeouts.delete(loopName)
            return
          }
          try {
            await retryFn()
          } catch (retryErr) {
            await handlePromptError(loopName, freshState, context, retryErr, retryFn)
          }
        }, 2000)
        retryTimeouts.set(loopName, retryTimeout)
      }
    } else {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), giving up`, err)
      await terminateLoop(loopName, currentState, `error_max_retries: ${context}`)
    }
  }

  async function getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ text: string | null; error: string | null; lastMessageRole: string }> {
    try {
      let messagesResult = await v2Client.session.messages({
        sessionID: sessionId,
        directory: worktreeDir,
        limit: 4,
      })

      if (messagesResult.error || !messagesResult.data?.length) {
        try {
          logger.log(`Loop: falling back to plugin client for session messages (${sessionId})`)
          const legacyResult = await client.session.messages({
            path: { id: sessionId },
            query: { directory: worktreeDir, limit: 4 },
          })
          if (!legacyResult.error) {
            messagesResult = legacyResult as typeof messagesResult
          }
        } catch (fallbackErr) {
          logger.error(`Loop: plugin client session messages fallback failed for ${sessionId}`, fallbackErr)
        }
      }

      const messages = (messagesResult.data ?? []) as Array<{
        info: { role: string; finish?: string; error?: { name?: string; data?: { message?: string } } }
        parts: Array<{ type: string; text?: string }>
      }>

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
      const lastAssistant = [...messages].reverse().find((m) => m.info.role === 'assistant')

      if (!lastAssistant) {
        const role = lastMessage?.info.role ?? 'none'
        logger.log(`Loop: no assistant message found in session ${sessionId}, last message role: ${role}`)
        return { text: null, error: null, lastMessageRole: role }
      }

      if (lastAssistant.info.finish && lastAssistant.info.finish !== 'stop') {
        logger.log(`Loop: assistant message in session ${sessionId} is not final yet (finish=${lastAssistant.info.finish})`)
        return { text: null, error: null, lastMessageRole: `assistant:${lastAssistant.info.finish}` }
      }

      const text = lastAssistant.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n') || null

      const error = lastAssistant.info.error?.data?.message ?? lastAssistant.info.error?.name ?? null

      return { text, error, lastMessageRole: 'assistant' }
    } catch (err) {
      logger.error(`Loop: could not read session messages`, err)
      return { text: null, error: null, lastMessageRole: 'error' }
    }
  }

  function detachFromWorkspace(
    loopName: string,
    state: LoopState,
    context?: string,
  ): void {
    loopService.clearWorkspaceId(loopName)
    state.workspaceId = undefined
    publishWorkspaceDetachedToast({
      v2: v2Client,
      directory: state.projectDir ?? state.worktreeDir,
      loopName,
      logger,
      context,
    })
  }

  async function recoverFromMissingWorkspace(
    loopName: string,
    state: LoopState,
    sessionId: string,
    contextLabel: string,
    bindError?: unknown,
  ): Promise<{ workspaceId?: string; recovered: boolean }> {
    if (!state.workspaceId) {
      return { recovered: false }
    }

    if (bindError && !isWorkspaceNotFoundError(bindError)) {
      logger.log(`Loop: skipping workspace re-provision for ${loopName} because bind error is not "workspace not found"`)
      return { recovered: false }
    }

    detachFromWorkspace(loopName, state, contextLabel)

    const createLoopWorkspaceMod = await import('../workspace/forge-worktree')
    const newWorkspace = await createLoopWorkspaceMod.createLoopWorkspace(
      v2Client,
      {
        loopName,
        directory: state.worktreeDir,
        branch: state.worktreeBranch ?? null,
      },
      logger,
    )

    if (!newWorkspace) {
      logger.error(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      return { recovered: false }
    }

    try {
      await bindSessionToWorkspace(v2Client, newWorkspace.workspaceId, sessionId, logger)
      loopService.setWorkspaceId(loopName, newWorkspace.workspaceId)
      state.workspaceId = newWorkspace.workspaceId
      logger.log(`Loop: re-provisioned workspace ${newWorkspace.workspaceId} for ${loopName} after stale id`)
      return { workspaceId: newWorkspace.workspaceId, recovered: true }
    } catch (err) {
      logger.error(`Loop: failed to bind session to re-provisioned workspace ${newWorkspace.workspaceId}`, err)
      return { recovered: false }
    }
  }

  async function ensureWorkspaceForLoop(
    loopName: string,
    state: LoopState,
    contextLabel: string,
  ): Promise<{ workspaceId?: string }> {
    if (state.workspaceId) {
      return { workspaceId: state.workspaceId }
    }

    if (!state.worktree) {
      return {}
    }

    const createLoopWorkspaceMod = await import('../workspace/forge-worktree')
    const workspace = await createLoopWorkspaceMod.createLoopWorkspace(
      v2Client,
      {
        loopName,
        directory: state.worktreeDir,
        branch: state.worktreeBranch ?? null,
      },
      logger,
    )

    if (!workspace) {
      logger.log(`Loop: workspace creation failed for ${loopName} (${contextLabel}), continuing without workspace backing`)
      return {}
    }

    loopService.setWorkspaceId(loopName, workspace.workspaceId)
    state.workspaceId = workspace.workspaceId
    logger.log(`Loop: provisioned workspace ${workspace.workspaceId} for ${loopName} (${contextLabel})`)
    return { workspaceId: workspace.workspaceId }
  }

  /**
   * Rotates to a new session in the same workspace. Creates and binds the new session FIRST,
   * then fire-and-forget deletes the old session. This ordering ensures the workspace always
   * has at least one bound session, preventing the host from pruning it from non-focused TUIs.
   */
  async function rotateSession(loopName: string, state: LoopState): Promise<string> {
    const oldSessionId = state.sessionId
    const sessionDir = state.worktreeDir

    logger.log(
      `Loop: [perm-diag] rotate loop=${loopName} state.worktree=${String(state.worktree)} state.sandbox=${String(state.sandbox)}`
    )

    const permissionRuleset = buildLoopPermissionRuleset({
      isWorktree: !!state.worktree,
      isSandbox: !!state.sandbox,
    })

    const ensured = await ensureWorkspaceForLoop(loopName, state, 'during session rotation')

    const createResult = await createLoopSessionWithWorkspace({
      v2: v2Client,
      title: formatLoopSessionTitle(state.loopName),
      directory: sessionDir,
      permission: permissionRuleset,
      workspaceId: ensured.workspaceId ?? state.workspaceId,
      logPrefix: 'Loop',
      logger,
    })

    if (!createResult) {
      throw new Error('Failed to create new session.')
    }

    const newSessionId = createResult.sessionId

    if (createResult.bindFailed) {
      detachFromWorkspace(loopName, state, 'during session rotation')
    }

    const oldRetryTimeout = retryTimeouts.get(loopName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      retryTimeouts.delete(loopName)
    }

    loopService.registerLoopSession(newSessionId, loopName)

    stopWatchdog(loopName)
    startWatchdog(loopName)

    v2Client.session.delete({ sessionID: oldSessionId, directory: sessionDir }).catch((err) => {
      logger.error(`Loop: failed to delete old session ${oldSessionId}`, err)
    })

    logger.log(`Loop: rotated session ${oldSessionId} → ${newSessionId}`)

    if (!state.worktree && v2Client.tui) {
      v2Client.tui.selectSession({ sessionID: newSessionId }).catch((err) => {
        logger.error(`Loop: failed to navigate TUI to rotated session`, err)
      })
    }

    return newSessionId
  }

  /**
   * Shared: handle assistant error detection and model failure.
   * Returns null if the loop was terminated (caller should return).
   * Returns updated { assistantErrorDetected, currentState }.
   */
  async function detectAndHandleAssistantError(
    loopName: string,
    currentState: LoopState,
    assistantError: string | null,
    phase: string,
  ): Promise<{ assistantErrorDetected: boolean; currentState: LoopState } | null> {
    if (!assistantError) {
      return { assistantErrorDetected: false, currentState }
    }

    logger.error(`Loop: assistant error detected in ${phase} phase: ${assistantError}`)
      const isModelError = /provider|auth|model|api\s*error/i.test(assistantError)
      if (isModelError) {
        const nextErrorCount = loopService.incrementError(loopName)
        if (nextErrorCount >= MAX_RETRIES) {
          await terminateLoop(loopName, currentState, `error_max_retries: assistant error: ${assistantError}`)
          return null
        }
        loopService.setModelFailed(loopName, true)
        logger.log(`Loop: marking model as failed, will fall back to default model (error ${nextErrorCount}/${MAX_RETRIES})`)
        return { assistantErrorDetected: true, currentState: loopService.getActiveState(loopName)! }
      }

    return { assistantErrorDetected: true, currentState }
  }

  /**
   * Shared: check audit clear and terminate if ready.
   * Returns true if the loop was terminated (caller should return).
   */
  async function checkAuditClearAndTerminate(
    loopName: string,
    currentState: LoopState,
  ): Promise<boolean> {
    logger.debug(`Loop: checking audit clear loop=${loopName} auditCount=${currentState.auditCount ?? 0} loopName=${currentState.loopName ?? '(none)'}`)
    if ((currentState.auditCount ?? 0) < 1) {
      logger.debug(`Loop: audit clear gate blocked by auditCount<1`)
      return false
    }
    // For sectioned loops, require finalAuditDone === true before terminating
    if (currentState.totalSections > 0 && !currentState.finalAuditDone) {
      logger.debug(`Loop: audit clear gate blocked for sectioned loop — finalAuditDone=false`)
      return false
    }
    const findings = loopService.getOutstandingFindings(currentState.loopName)
    if (findings.length > 0) {
      logger.log(`Loop: audit complete but ${findings.length} review finding(s) remain, continuing`)
      return false
    }
    // Hard gate: refuse completion if any bug-severity findings remain
    const bugFindings = loopService.getOutstandingFindings(currentState.loopName, 'bug')
    if (bugFindings.length > 0) {
      logger.log(`Loop: refused completion — ${bugFindings.length} bug finding(s) still open`)
      return false
    }
    logger.log(`Loop: audit all-clear, terminating loop=${loopName} iteration=${currentState.iteration} audits=${currentState.auditCount ?? 0}`)
    await terminateLoop(loopName, currentState, 'completed')
    logger.log(`Loop completed: auditor all-clear at iteration ${currentState.iteration} (audits=${currentState.auditCount ?? 0})`)
    return true
  }

  /**
   * Shared: reset error count after a successful (non-error) iteration.
   */
  function resetErrorCountIfNeeded(loopName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState {
    if (!assistantErrorDetected && currentState.errorCount && currentState.errorCount > 0) {
      loopService.resetError(loopName)
      loopService.setModelFailed(loopName, false)
      logger.log(`Loop: resetting error count after successful retry in ${phase} phase`)
      return loopService.getActiveState(loopName)!
    }
    return currentState
  }

  /**
   * Shared: rotate session and send continuation prompt with model fallback.
   */
  async function rotateAndSendContinuation(
    loopName: string,
    currentState: LoopState,
    stateUpdates: Partial<LoopState>,
    continuationPrompt: string,
    assistantErrorDetected: boolean,
    errorContext: string,
  ): Promise<void> {
    let activeSessionId = currentState.sessionId
    try {
      activeSessionId = await rotateSession(loopName, currentState)
    } catch (err) {
      logger.error(`Loop: session rotation failed, continuing with existing session`, err)
    }

    loopService.replaceSession(loopName, {
      newSessionId: activeSessionId,
      phase: stateUpdates.phase ?? 'coding',
      iteration: stateUpdates.iteration ?? currentState.iteration,
      resetError: !assistantErrorDetected && currentState.errorCount > 0,
      auditCount: stateUpdates.auditCount,
      lastAuditResult: stateUpdates.lastAuditResult ?? null,
    })

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop iteration ${nextIteration} for session ${activeSessionId}`)

    const currentConfig = getConfig()
    const loopModel = resolveLoopModel(currentConfig, loopService, loopName)
    if (!loopModel) {
      logger.log(`Loop: configured model previously failed, using default model`)
    }

    const sendWithModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) {
        throw new Error('loop_cancelled')
      }
      const sessionDir = freshState.worktreeDir
      const workspaceParam = freshState.workspaceId ? { workspace: freshState.workspaceId } : {}
      logger.debug(`loop prompt: sessionID=${activeSessionId} dir=${sessionDir} agent=code model=${loopModel ? `${loopModel.providerID}/${loopModel.modelID}` : '(session default)'}`)
      const result = await v2Client.session.promptAsync({
        sessionID: activeSessionId,
        directory: sessionDir,
        ...workspaceParam,
        agent: 'code',
        parts: [{ type: 'text' as const, text: continuationPrompt }],
        model: loopModel,
      })
      return { data: result.data, error: result.error }
    }

    const sendWithoutModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) {
        throw new Error('loop_cancelled')
      }
      const sessionDir = freshState.worktreeDir
      const workspaceParam = freshState.workspaceId ? { workspace: freshState.workspaceId } : {}
      logger.debug(`loop prompt: sessionID=${activeSessionId} dir=${sessionDir} agent=code model=(default)`)
      const result = await v2Client.session.promptAsync({
        sessionID: activeSessionId,
        directory: sessionDir,
        ...workspaceParam,
        agent: 'code',
        parts: [{ type: 'text' as const, text: continuationPrompt }],
      })
      return { data: result.data, error: result.error }
    }

    const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
      sendWithModel,
      sendWithoutModel,
      loopModel,
      logger,
    )

    if (promptResult.error) {
      const retryFn = async () => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) {
          throw new Error('loop_cancelled')
        }
        const result = await sendWithoutModel()
        if (result.error) {
          await handlePromptError(loopName, currentState, `retry failed ${errorContext}`, result.error)
          return
        }
      }
      await handlePromptError(loopName, currentState, `failed to send continuation prompt ${errorContext}`, promptResult.error, retryFn)
      return
    }

    if (actualModel) {
      logger.log(`${errorContext} using model: ${actualModel.providerID}/${actualModel.modelID}`)
    } else {
      logger.log(`${errorContext} using default model (fallback)`)
    }

    consecutiveStalls.set(loopName, 0)
  }

  async function rotateToCodingAfterAuditFailure(loopName: string, state: LoopState, reason: string): Promise<void> {
    // Rotate FIRST so the new code session is created and bound to the workspace
    // before the audit session is deleted. This keeps the workspace continuously
    // populated and prevents the host from pruning it from non-focused TUIs.
    const newSessionId = await rotateSession(loopName, state)
    // rotateSession already fire-and-forgets the deletion of state.sessionId
    // (which is the audit session here) at loop.ts:632, so an explicit
    // deleteAuditSession call is redundant.
    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      resetError: false,
    })
    loopService.setLastAuditResult(loopName, state.lastAuditResult ?? '')
    const isModelError = /provider|auth|model|api\s*error/i.test(reason)
    if (isModelError) {
      loopService.setModelFailed(loopName, true)
    }
    const continuationPrompt = loopService.buildContinuationPrompt(
      { ...state, iteration: state.iteration ?? 0 },
      `\n[Auditor session failed: ${reason}. Continuing without new findings.]`,
    )
    const sendWithModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) throw new Error('loop_cancelled')
      const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
      return v2Client.session.promptAsync({
        sessionID: newSessionId,
        directory: freshState.worktreeDir,
        ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
        agent: 'code',
        parts: [{ type: 'text' as const, text: continuationPrompt }],
        model: loopModel,
      })
    }
    const sendWithoutModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) throw new Error('loop_cancelled')
      return v2Client.session.promptAsync({
        sessionID: newSessionId,
        directory: freshState.worktreeDir,
        ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
        agent: 'code',
        parts: [{ type: 'text' as const, text: continuationPrompt }],
      })
    }
    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    const { result } = await retryWithModelFallback(sendWithModel, sendWithoutModel, loopModel, logger)
    if (result.error) {
      logger.error(`rotateToCodingAfterAuditFailure: failed to send continuation prompt`, result.error)
    }
  }

  async function transitionToCoding(loopName: string, state: LoopState): Promise<void> {
    loopService.startSection(loopName, 0)
    loopService.setCurrentSectionIndex(loopName, 0)

    const updatedState = loopService.getActiveState(loopName) ?? state
    loopService.setPhase(loopName, 'coding')

    const codeSessionResult = await createLoopSessionWithWorkspace({
      v2: v2Client,
      title: formatLoopSessionTitle(loopName),
      directory: updatedState.worktreeDir,
      permission: buildLoopPermissionRuleset({ isWorktree: !!updatedState.worktree, isSandbox: !!updatedState.sandbox }),
      workspaceId: updatedState.workspaceId,
      logPrefix: 'Loop',
      logger,
    })

    if (!codeSessionResult) {
      logger.error(`Loop: failed to create code session after decomposition for ${loopName}`)
      await terminateLoop(loopName, updatedState, 'session_creation_failed')
      return
    }

    const codeSessionId = codeSessionResult.sessionId
    loopService.replaceSession(loopName, {
      newSessionId: codeSessionId,
      phase: 'coding',
      resetError: false,
    })

    const codeState = loopService.getActiveState(loopName) ?? updatedState
    const sectionPrompt = loopService.buildSectionInitialPrompt(codeState)

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    const sendWithModel = async () => {
      const fresh = loopService.getActiveState(loopName)
      if (!fresh?.active) throw new Error('loop_cancelled')
      return v2Client.session.promptAsync({
        sessionID: codeSessionId,
        directory: fresh.worktreeDir,
        ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
        agent: 'code',
        parts: [{ type: 'text' as const, text: sectionPrompt }],
        model: loopModel,
      })
    }
    const sendWithoutModel = async () => {
      const fresh = loopService.getActiveState(loopName)
      if (!fresh?.active) throw new Error('loop_cancelled')
      return v2Client.session.promptAsync({
        sessionID: codeSessionId,
        directory: fresh.worktreeDir,
        ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
        agent: 'code',
        parts: [{ type: 'text' as const, text: sectionPrompt }],
      })
    }
    const { result: promptResult } = await retryWithModelFallback(sendWithModel, sendWithoutModel, loopModel, logger)
    if (promptResult.error) {
      logger.error(`Loop: failed to send initial section prompt for ${loopName}`, promptResult.error)
      await handlePromptError(loopName, codeState, 'failed to send initial section prompt', promptResult.error)
      return
    }

    consecutiveStalls.set(loopName, 0)
  }

  async function trySalvageDecomposerTranscript(loopName: string, state: LoopState): Promise<import('../utils/section-capture').ParsedSection[] | null> {
    try {
      if (!state.decompositionSessionId) return null

      const messagesResult = await v2Client.session.messages({
        sessionID: state.decompositionSessionId,
        directory: state.worktreeDir || '',
        limit: 4,
      })
      const messages = (messagesResult.data ?? []) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string }>
      }>
      const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
      if (!lastAssistant) return null

      const transcript = lastAssistant.parts
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('\n')

      if (transcript.length === 0) return null

      const maxSections = getConfig().decomposer?.maxSections ?? 12

      const markerSections = extractSections(transcript, { maxSections })
      if (markerSections.length > 0) return markerSections

      const deterministicSections = decomposeDeterministically(transcript, { maxSections })
      if (deterministicSections.length > 0) return deterministicSections

      return null
    } catch (err) {
      logger.error(`Loop: trySalvageDecomposerTranscript failed for ${loopName}`, err)
      return null
    }
  }

  async function handleDecomposingPhase(loopName: string, _state: LoopState): Promise<void> {
    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping decomposing phase`)
      return
    }

    if (currentState.phase !== 'decomposing') {
      logger.log(`Loop: handleDecomposingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in decomposing phase, terminating`)
      await terminateLoop(loopName, currentState, 'missing_worktree_dir')
      return
    }

    const decompStatus = currentState.decompositionStatus
    const totalSections = currentState.totalSections

    if (decompStatus === 'running' || decompStatus === 'pending') {
      logger.log(`Loop: decomposing phase still running/pending for ${loopName}, waiting`)
      return
    }

    if (decompStatus === 'completed' && totalSections > 0) {
      logger.log(`Loop: decomposing phase completed with ${totalSections} sections for ${loopName}, transitioning to coding`)
      await transitionToCoding(loopName, currentState)
      return
    }

    if (decompStatus === 'completed' && totalSections === 0) {
      logger.log(`Loop: decomposition completed but produced 0 sections, falling back to legacy for ${loopName}`)
      loopService.setDecompositionStatus(loopName, 'skipped')
      loopService.setPhase(loopName, 'coding')

      const fallbackState = loopService.getActiveState(loopName) ?? currentState
      const codeSessionResult = await createLoopSessionWithWorkspace({
        v2: v2Client,
        title: formatLoopSessionTitle(loopName),
        directory: fallbackState.worktreeDir,
        permission: buildLoopPermissionRuleset({ isWorktree: !!fallbackState.worktree, isSandbox: !!fallbackState.sandbox }),
        workspaceId: fallbackState.workspaceId,
        logPrefix: 'Loop',
        logger,
      })

      if (!codeSessionResult) {
        logger.error(`Loop: failed to create code session for legacy fallback for ${loopName}`)
        await terminateLoop(loopName, fallbackState, 'session_creation_failed')
        return
      }

      loopService.replaceSession(loopName, {
        newSessionId: codeSessionResult.sessionId,
        phase: 'coding',
        resetError: false,
      })

      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...fallbackState, iteration: fallbackState.iteration ?? 0 },
        undefined,
      )
      const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
      const sendWithModel = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active) throw new Error('loop_cancelled')
        return v2Client.session.promptAsync({
          sessionID: codeSessionResult.sessionId,
          directory: fresh.worktreeDir,
          ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: continuationPrompt }],
          model: loopModel,
        })
      }
      const sendWithoutModel = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active) throw new Error('loop_cancelled')
        return v2Client.session.promptAsync({
          sessionID: codeSessionResult.sessionId,
          directory: fresh.worktreeDir,
          ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: continuationPrompt }],
        })
      }
      const { result: promptResult } = await retryWithModelFallback(sendWithModel, sendWithoutModel, loopModel, logger)
      if (promptResult.error) {
        logger.error(`Loop: failed to send legacy fallback prompt for ${loopName}`, promptResult.error)
        await handlePromptError(loopName, fallbackState, 'failed to send legacy fallback prompt', promptResult.error)
        return
      }

      consecutiveStalls.set(loopName, 0)
      return
    }

    if (decompStatus === 'failed') {
      const errorCount = currentState.errorCount ?? 0

      // Attempt transcript salvage on first failure before re-prompting
      if (errorCount === 0 && currentState.totalSections === 0) {
        const salvaged = await trySalvageDecomposerTranscript(loopName, currentState)
        if (salvaged && salvaged.length > 0) {
          loopService.bulkInsertSections(loopName, salvaged)
          loopService.setDecompositionStatus(loopName, 'completed')
          loopService.setTotalSections(loopName, salvaged.length)
          logger.log(`Loop: salvaged ${salvaged.length} sections from decomposer transcript for ${loopName}`)
          const refreshed = loopService.getActiveState(loopName)
          if (refreshed) await transitionToCoding(loopName, refreshed)
          return
        }
      }

      if (errorCount >= MAX_RETRIES) {
        logger.error(`Loop: decomposition failed after ${MAX_RETRIES} retries for ${loopName}`)
        await terminateLoop(loopName, currentState, 'decomposition_failed')
        return
      }
      loopService.incrementError(loopName)
      logger.log(`Loop: decomposition failed, retrying (attempt ${errorCount + 1}/${MAX_RETRIES}) for ${loopName}`)

      const freshState = loopService.getActiveState(loopName) ?? currentState
      loopService.setDecompositionStatus(loopName, 'running')

      const decomposerSessionResult = await createLoopSessionWithWorkspace({
        v2: v2Client,
        title: `decomposer-${loopName}`,
        directory: freshState.worktreeDir,
        permission: buildLoopPermissionRuleset({ isWorktree: !!freshState.worktree, isSandbox: !!freshState.sandbox }),
        workspaceId: freshState.workspaceId,
        logPrefix: 'Loop',
        logger,
      })

      if (!decomposerSessionResult) {
        logger.error(`Loop: failed to re-create decomposer session for ${loopName}`)
        await terminateLoop(loopName, freshState, 'session_creation_failed')
        return
      }

      const decomposerSessionId = decomposerSessionResult.sessionId
      loopService.setDecompositionSessionId(loopName, decomposerSessionId)
      loopService.registerLoopSession(decomposerSessionId, loopName)
      loopService.setPhase(loopName, 'decomposing')

      const decomposerPrompt = loopService.buildDecomposerInitialPrompt(freshState)
      try {
        await v2Client.session.promptAsync({
          sessionID: decomposerSessionId,
          directory: freshState.worktreeDir,
          ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
          agent: 'decomposer',
          parts: [{ type: 'text' as const, text: decomposerPrompt }],
          ...(() => {
            const cfg = getConfig()
            const m = resolveDecomposerModel({
              decomposerModel: cfg.decomposer?.model,
              auditorModel: freshState.auditorModel ?? cfg.auditorModel,
              executionModel: freshState.executionModel ?? cfg.executionModel,
            })
            return m ? { model: m } : {}
          })(),
        })
      } catch (err) {
        logger.error(`Loop: failed to re-prompt decomposer for ${loopName}`, err)
        await terminateLoop(loopName, freshState, 'decomposer_prompt_failed')
        return
      }

      return
    }

    logger.debug(`Loop: decomposing phase unknown state for ${loopName}: status=${decompStatus} totalSections=${totalSections}, waiting`)
  }

  async function handleFinalAuditPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping final audit phase`)
      return
    }

    if (currentState.phase !== 'final_auditing') {
      logger.log(`Loop: handleFinalAuditPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in final audit phase, terminating`)
      await terminateLoop(loopName, currentState, 'missing_worktree_dir')
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts >= MAX_IDLE_RETRIES) {
        logger.error(`Loop: final audit phase retry exhausted for ${loopName} (last message: ${lastMessageRole}), terminating`)
        idleRetryAttempts.delete(loopName)
        await terminateLoop(loopName, currentState, 'final_audit_retry_exhausted')
        return
      }
      logger.log(`Loop: final audit idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
      idleRetryAttempts.set(loopName, attempts + 1)
      const t = setTimeout(() => {
        void withStateLock(loopName, async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== 'final_auditing') return
          await handleFinalAuditPhase(loopName, fresh)
        })
      }, IDLE_RETRY_DELAY_MS)
      idleRetryTimeouts.set(loopName, t)
      return
    }

    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'final_auditing')
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'final_auditing')

    if (!assistantErrorDetected) {
      // Increment final audit attempts
      const newAttempts = loopService.incrementFinalAuditAttempts(loopName)

      // Check for clear marker
      const hasClearMarker = auditText && loopService.parseFinalAuditClear(auditText)

      // Outstanding-finding gate: block termination if there are outstanding bug findings
      const hasOutstandingFindings = loopService.hasOutstandingFindings(loopName, 'bug')

      if (hasClearMarker && !hasOutstandingFindings) {
        logger.log(`Loop: final audit clear detected for ${loopName} with no outstanding findings, completing`)
        loopService.setFinalAuditDone(loopName, true)
        await terminateLoop(loopName, currentState, 'completed')
        return
      }

      if (hasClearMarker && hasOutstandingFindings) {
        logger.log(`Loop: final audit clear detected but outstanding findings remain for ${loopName}, rewinding`)
      }

      if (newAttempts > MAX_RETRIES) {
        logger.log(`Loop: final audit attempts exhausted for ${loopName} (${newAttempts}/${MAX_RETRIES})`)
        await terminateLoop(loopName, currentState, 'final_audit_failed')
        return
      }

      // Dirty audit: rewind to the offending section
      const allFindings = loopService.getOutstandingFindings(loopName, 'bug')
      const rawOffendingIdx = allFindings.length > 0
        ? (allFindings[0].sectionIndex ?? currentState.currentSectionIndex)
        : currentState.currentSectionIndex

      // Clamp to valid section range
      const offendingIdx = (rawOffendingIdx >= 0 && rawOffendingIdx < currentState.totalSections)
        ? rawOffendingIdx
        : currentState.currentSectionIndex

      logger.log(`Loop: final audit dirty, rewinding to section ${offendingIdx} for ${loopName}`)

      // Reset offending section before building continuation prompt so stale summaries are excluded
      loopService.resetSectionForRewind(loopName, offendingIdx)

      // Build continuation prompt from a synthetic state to avoid mutating persisted state before rotation
      const synthState = { ...currentState, phase: 'coding' as const, currentSectionIndex: offendingIdx }
      const continuationPrompt = loopService.buildSectionContinuationPrompt(synthState, auditText || '')

      // Rotate to a new code session before mutating persisted state
      let newCodeSessionId: string
      try {
        newCodeSessionId = await rotateSession(loopName, currentState)
      } catch (err) {
        logger.error(`Loop: session rotation failed during final audit rewind, aborting rewind`, err)
        return
      }

      // Mutate remaining persisted state after successful session rotation
      loopService.setCurrentSectionIndex(loopName, offendingIdx)
      loopService.setPhase(loopName, 'coding')

      loopService.replaceSession(loopName, {
        newSessionId: newCodeSessionId,
        phase: 'coding',
        iteration: currentState.iteration,
        resetError: currentState.errorCount > 0,
      })

      const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
      const sendWithModel = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active) throw new Error('loop_cancelled')
        return v2Client.session.promptAsync({
          sessionID: newCodeSessionId,
          directory: fresh.worktreeDir,
          ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: continuationPrompt }],
          model: loopModel,
        })
      }
      const sendWithoutModel = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active) throw new Error('loop_cancelled')
        return v2Client.session.promptAsync({
          sessionID: newCodeSessionId,
          directory: fresh.worktreeDir,
          ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: continuationPrompt }],
        })
      }
      const { result: promptResult } = await retryWithModelFallback(sendWithModel, sendWithoutModel, loopModel, logger)
      if (promptResult.error) {
        logger.error(`Loop: failed to send rewind continuation prompt for ${loopName}`, promptResult.error)
        await handlePromptError(loopName, currentState, 'failed to send rewind continuation', promptResult.error)
        return
      }

      consecutiveStalls.set(loopName, 0)
    }
  }

  async function handleCodingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping coding phase`)
      return
    }

    if (currentState.phase !== 'coding') {
      logger.log(`Loop: handleCodingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in coding phase, terminating`)
      await terminateLoop(loopName, currentState, 'missing_worktree_dir')
      return
    }

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
    let assistantError = assistantInfo.error
    const lastMessageRole = assistantInfo.lastMessageRole
    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts < MAX_IDLE_RETRIES) {
        logger.log(`Loop: coding idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
        idleRetryAttempts.set(loopName, attempts + 1)
        const sessionId = currentState.sessionId
        const t = setTimeout(async () => {
          idleRetryTimeouts.delete(loopName)
          await withStateLock(loopName, async () => {
            const retryState = loopService.getActiveState(loopName)
            if (!retryState?.active || retryState.phase !== 'coding' || retryState.sessionId !== sessionId) return
            await handleCodingPhase(loopName, retryState)
          })
        }, IDLE_RETRY_DELAY_MS)
        idleRetryTimeouts.set(loopName, t)
        return
      }

      logger.log(`Loop: coding phase proceeding without assistant message for ${loopName} after retry (last message: ${lastMessageRole})`)
      assistantError = null
      const pending = idleRetryTimeouts.get(loopName)
      if (pending) {
        clearTimeout(pending)
        idleRetryTimeouts.delete(loopName)
      }
      if (idleRetryAttempts.has(loopName)) {
        idleRetryAttempts.delete(loopName)
      }
    }

    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'coding')
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'coding')

    const currentConfig = getConfig()
    const auditorModel = resolveLoopAuditorModel(currentConfig, loopService, loopName, logger)
    const auditPrompt = loopService.buildAuditPrompt(currentState)
    const codeSessionId = currentState.sessionId

    // Create audit session with retry
    async function createAuditWithRetry(input: {
      loopName: string
      iteration: number
      worktreeDir: string
      workspaceId?: string
      isSandbox: boolean
      auditorModel?: { providerID: string; modelID: string }
      prompt: string
    }, attempts = MAX_RETRIES): Promise<{ auditSessionId: string; bindFailed: boolean; bindError?: unknown } | null> {
      for (let i = 0; i < attempts; i++) {
        const created = await createAuditSessionWithFallback(input)
        if (created) return created
        loopService.incrementError(loopName)
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return null
        if ((state.errorCount ?? 0) >= MAX_RETRIES) return null
        await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      }
      return null
    }

    // Create new audit session in the SAME workspace (with retry)
    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before audit creation')
    const created = await createAuditWithRetry({
      loopName,
      iteration: currentState.iteration ?? 0,
      worktreeDir: currentState.worktreeDir,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      isSandbox: currentState.sandbox ?? false,
      auditorModel,
      prompt: auditPrompt,
    })

    if (!created) {
      // Audit creation failed after retries - rotate to fresh code session instead of erroring
      logger.error(`Loop: audit session creation failed after ${MAX_RETRIES} attempts for ${loopName}, rotating to fresh code session`)
      try {
        const rotatedSessionId = await rotateSession(loopName, currentState)
        loopService.replaceSession(loopName, {
          newSessionId: rotatedSessionId,
          phase: 'coding',
          resetError: false,
        })
        const continuationPrompt = loopService.buildContinuationPrompt(
          { ...currentState, iteration: currentState.iteration ?? 0 },
          'Audit could not be started after retries — continue iterating, the auditor will be reattempted next round.',
        )
        const sendWithModel = async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) throw new Error('loop_cancelled')
          return v2Client.session.promptAsync({
            sessionID: rotatedSessionId,
            directory: freshState.worktreeDir,
            ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
            agent: 'code',
            parts: [{ type: 'text' as const, text: continuationPrompt }],
            model: resolveLoopModel(currentConfig, loopService, loopName),
          })
        }
        const sendWithoutModel = async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) throw new Error('loop_cancelled')
          return v2Client.session.promptAsync({
            sessionID: rotatedSessionId,
            directory: freshState.worktreeDir,
            ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
            agent: 'code',
            parts: [{ type: 'text' as const, text: continuationPrompt }],
          })
        }
        const { result: promptResult } = await retryWithModelFallback(
          sendWithModel,
          sendWithoutModel,
          resolveLoopModel(currentConfig, loopService, loopName),
          logger,
        )
        if (promptResult.error) {
          logger.error(`Loop: failed to send continuation prompt after audit creation failure`, promptResult.error)
        }
        return
      } catch (err) {
        logger.error(`Loop: failed to rotate after audit creation failure`, err)
        await handlePromptError(loopName, currentState, 'failed to rotate after audit creation failure', err)
        return
      }
    }

    // Workspace recovery if bind failed (symmetric path)
    if (created.bindFailed && currentState.workspaceId) {
      const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit bind', created.bindError)
      currentState = loopService.getActiveState(loopName) ?? currentState
      if (!recovered.recovered) {
        logger.log(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      }
    }

    // ATOMIC transition: phase=auditing AND current_session_id=auditSessionId in one write
    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'auditing',
    })

    // Delete the code session AFTER audit session creation succeeds (best-effort)
    v2Client.session.delete({ sessionID: codeSessionId, directory: currentState.worktreeDir }).catch((err) => {
      logger.error(`Loop: failed to delete code session ${codeSessionId} after audit creation`, err)
    })

    const sendAuditWithModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) {
        throw new Error('loop_cancelled')
      }
      const result = await promptAuditSessionWithFallback({
        sessionId: created.auditSessionId,
        worktreeDir: freshState.worktreeDir,
        workspaceId: freshState.workspaceId,
        prompt: loopService.buildAuditPrompt(freshState),
        auditorModel,
      })
      return result.ok ? { data: true } : { error: result.error }
    }

    const sendAuditWithoutModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) {
        throw new Error('loop_cancelled')
      }
      const result = await promptAuditSessionWithFallback({
        sessionId: created.auditSessionId,
        worktreeDir: freshState.worktreeDir,
        workspaceId: freshState.workspaceId,
        prompt: loopService.buildAuditPrompt(freshState),
      })
      return result.ok ? { data: true } : { error: result.error }
    }

    const { result: promptResult, usedModel: actualAuditorModel } = await retryWithModelFallback(
      sendAuditWithModel,
      sendAuditWithoutModel,
      auditorModel,
      logger,
    )

    if (promptResult.error) {
      if (isWorkspaceNotFoundError(promptResult.error) && currentState.workspaceId) {
        const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit prompt recovery')
        currentState = loopService.getActiveState(loopName) ?? currentState
        if (recovered.recovered || !currentState.workspaceId) {
          const retryResult = await sendAuditWithoutModel()
          if ('data' in retryResult && retryResult.data === true) {
            logger.log(`Loop: recovered audit prompt after workspace re-bind for ${loopName}`)
            consecutiveStalls.set(loopName, 0)
            return
          }
        }
      }
      const retryFn = async () => {
        const retry = await sendAuditWithoutModel()
        if ('error' in retry) throw retry.error
      }
      await handlePromptError(loopName, { ...currentState, phase: 'auditing' }, 'failed to send audit prompt', promptResult.error, retryFn)
      return
    }

    if (actualAuditorModel) {
      logger.log(`auditor using model: ${actualAuditorModel.providerID}/${actualAuditorModel.modelID} (session ${created.auditSessionId})`)
    } else {
      logger.log(`auditor using default model (fallback) (session ${created.auditSessionId})`)
    }

    consecutiveStalls.set(loopName, 0)
  }

  async function handleAuditingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping auditing phase`)
      return
    }

    if (currentState.phase !== 'auditing') {
      logger.log(`Loop: handleAuditingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in auditing phase, terminating`)
      await terminateLoop(loopName, currentState, 'missing_worktree_dir')
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts >= MAX_IDLE_RETRIES) {
        logger.error(`Loop: auditing phase retry exhausted for ${loopName} (last message: ${lastMessageRole}), terminating`)
        idleRetryAttempts.delete(loopName)
        await terminateLoop(loopName, currentState, 'audit_retry_exhausted')
        return
      }
      logger.log(`Loop: auditing idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
      idleRetryAttempts.set(loopName, attempts + 1)
      const t = setTimeout(() => {
        void withStateLock(loopName, async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== 'auditing') return
          await handleAuditingPhase(loopName, fresh)
        })
      }, IDLE_RETRY_DELAY_MS)
      idleRetryTimeouts.set(loopName, t)
      return
    }
    
    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'auditing')
    if (!errorResult) {
      // Loop already terminated; teardown handles audit session abort/cleanup.
      return
    }
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'auditing')

    // NOTE: do NOT delete the audit session here. rotateSession (called via
    // rotateAndSendContinuation below) will create+bind the new code session
    // FIRST, then fire-and-forget delete the old (audit) session — keeping the
    // workspace continuously populated and preventing the host from pruning it.

    // Only increment audit count and check termination if the audit was successful (no error)
    if (!assistantErrorDetected) {
      const newAuditCount = (currentState.auditCount ?? 0) + 1
      logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

      // For sectioned loops: advance sections and handle final-audit routing
      if (currentState.totalSections > 0) {
        const idx = currentState.currentSectionIndex
        const sectionSummary = loopService.parseSectionSummary(auditText || '')
        const sectionBugFindings = loopService.getOutstandingFindings(loopName, 'bug')
          .filter(f => f.sectionIndex === idx)

        if (sectionSummary && sectionBugFindings.length === 0) {
          logger.log(`Loop: section ${idx} audit clean, marking completed`)

          loopService.setLastAuditResult(loopName, auditText || '')
          loopService.completeSection(loopName, idx, sectionSummary)

          // Rewind-completion shortcut: if all sections now completed, jump to final audit
          if (currentState.finalAuditAttempts > 0 && idx < currentState.totalSections - 1) {
            const allCompleted = loopService.getCompletedSectionDigest(currentState).length === currentState.totalSections
            if (allCompleted) {
              logger.log(`Loop: all ${currentState.totalSections} sections completed after rewind, jumping straight to final audit`)

              const finalAuditState = loopService.getActiveState(loopName) ?? { ...currentState, phase: 'final_auditing' }
              const finalAuditPrompt = loopService.buildFinalAuditPrompt(finalAuditState)
              const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName, logger)

              const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before final audit creation')
              const created = await createAuditSessionWithFallback({
                loopName,
                iteration: currentState.iteration ?? 0,
                worktreeDir: currentState.worktreeDir,
                workspaceId: ensured.workspaceId ?? currentState.workspaceId,
                isSandbox: currentState.sandbox ?? false,
                auditorModel,
                prompt: finalAuditPrompt,
              })
              if (!created) {
                logger.error(`Loop: final audit session creation failed for ${loopName}`)
                await handlePromptError(loopName, finalAuditState, 'failed to create final audit session', new Error('audit session creation failed'))
                return
              }

              loopService.setPhaseAndResetError(loopName, 'final_auditing')

              loopService.replaceSession(loopName, {
                newSessionId: created.auditSessionId,
                phase: 'final_auditing',
              })

              v2Client.session.delete({ sessionID: currentState.sessionId, directory: currentState.worktreeDir }).catch((err) => {
                logger.error(`Loop: failed to delete old code session ${currentState.sessionId} after final audit creation`, err)
              })

              const sendFinalAuditWithModel = async () => {
                const freshState = loopService.getActiveState(loopName)
                if (!freshState?.active) throw new Error('loop_cancelled')
                const result = await promptAuditSessionWithFallback({
                  sessionId: created.auditSessionId,
                  worktreeDir: freshState.worktreeDir,
                  workspaceId: freshState.workspaceId,
                  prompt: loopService.buildFinalAuditPrompt(freshState),
                  auditorModel,
                })
                return result.ok ? { data: true } : { error: result.error }
              }

              const sendFinalAuditWithoutModel = async () => {
                const freshState = loopService.getActiveState(loopName)
                if (!freshState?.active) throw new Error('loop_cancelled')
                const result = await promptAuditSessionWithFallback({
                  sessionId: created.auditSessionId,
                  worktreeDir: freshState.worktreeDir,
                  workspaceId: freshState.workspaceId,
                  prompt: loopService.buildFinalAuditPrompt(freshState),
                })
                return result.ok ? { data: true } : { error: result.error }
              }

              const { result: finalAuditPromptResult } = await retryWithModelFallback(
                sendFinalAuditWithModel,
                sendFinalAuditWithoutModel,
                auditorModel,
                logger,
              )

              if (finalAuditPromptResult.error) {
                logger.error(`Loop: failed to send final audit prompt for ${loopName}`, finalAuditPromptResult.error)
                await handlePromptError(loopName, finalAuditState, 'failed to send final audit prompt', finalAuditPromptResult.error)
                return
              }

              consecutiveStalls.set(loopName, 0)
              return
            }
          }

          const nextIdx = idx + 1
          if (nextIdx < currentState.totalSections) {
            // Advance to next section
            logger.log(`Loop: advancing from section ${idx} to section ${nextIdx}`)
            loopService.setCurrentSectionIndex(loopName, nextIdx)
            loopService.startSection(loopName, nextIdx)

            loopService.replaceSession(loopName, {
              newSessionId: currentState.sessionId,
              phase: 'coding',
              iteration: currentState.iteration,
            })

            const updatedState = loopService.getActiveState(loopName) ?? { ...currentState, currentSectionIndex: nextIdx }
            const continuationPrompt = loopService.buildSectionInitialPrompt(updatedState)
            await rotateAndSendContinuation(
              loopName,
              currentState,
              {
                iteration: currentState.iteration,
                phase: 'coding',
                lastAuditResult: auditText || undefined,
                auditCount: newAuditCount,
              },
              continuationPrompt,
              assistantErrorDetected,
              'section coding continuation',
            )
            return
          } else {
            // Last section cleared, transition to final-audit
            logger.log(`Loop: all ${currentState.totalSections} sections completed, transitioning to final-audit`)

            const finalAuditState = loopService.getActiveState(loopName) ?? { ...currentState, phase: 'final_auditing' }
            const finalAuditPrompt = loopService.buildFinalAuditPrompt(finalAuditState)
            const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName, logger)

            const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before final audit creation')
            const created = await createAuditSessionWithFallback({
              loopName,
              iteration: currentState.iteration ?? 0,
              worktreeDir: currentState.worktreeDir,
              workspaceId: ensured.workspaceId ?? currentState.workspaceId,
              isSandbox: currentState.sandbox ?? false,
              auditorModel,
              prompt: finalAuditPrompt,
            })
            if (!created) {
              logger.error(`Loop: final audit session creation failed for ${loopName}`)
              await handlePromptError(loopName, finalAuditState, 'failed to create final audit session', new Error('audit session creation failed'))
              return
            }

            loopService.setPhaseAndResetError(loopName, 'final_auditing')

            loopService.replaceSession(loopName, {
              newSessionId: created.auditSessionId,
              phase: 'final_auditing',
            })

            v2Client.session.delete({ sessionID: currentState.sessionId, directory: currentState.worktreeDir }).catch((err) => {
              logger.error(`Loop: failed to delete old code session ${currentState.sessionId} after final audit creation`, err)
            })

            const sendFinalAuditWithModel = async () => {
              const freshState = loopService.getActiveState(loopName)
              if (!freshState?.active) throw new Error('loop_cancelled')
              const result = await promptAuditSessionWithFallback({
                sessionId: created.auditSessionId,
                worktreeDir: freshState.worktreeDir,
                workspaceId: freshState.workspaceId,
                prompt: loopService.buildFinalAuditPrompt(freshState),
                auditorModel,
              })
              return result.ok ? { data: true } : { error: result.error }
            }

            const sendFinalAuditWithoutModel = async () => {
              const freshState = loopService.getActiveState(loopName)
              if (!freshState?.active) throw new Error('loop_cancelled')
              const result = await promptAuditSessionWithFallback({
                sessionId: created.auditSessionId,
                worktreeDir: freshState.worktreeDir,
                workspaceId: freshState.workspaceId,
                prompt: loopService.buildFinalAuditPrompt(freshState),
              })
              return result.ok ? { data: true } : { error: result.error }
            }

            const { result: finalAuditPromptResult } = await retryWithModelFallback(
              sendFinalAuditWithModel,
              sendFinalAuditWithoutModel,
              auditorModel,
              logger,
            )

            if (finalAuditPromptResult.error) {
              logger.error(`Loop: failed to send final audit prompt for ${loopName}`, finalAuditPromptResult.error)
              await handlePromptError(loopName, finalAuditState, 'failed to send final audit prompt', finalAuditPromptResult.error)
              return
            }

            consecutiveStalls.set(loopName, 0)
            return
          }
        }

        // Dirty section audit: retry same section (no mid-loop rewind)
        logger.log(`Loop: section ${idx} audit dirty, retrying same section`)

        loopService.incrementSectionAttempts(loopName, idx)
        const sectionPlan = loopService.getSectionPlan(currentState, idx)
        if (sectionPlan && sectionPlan.attempts >= MAX_RETRIES) {
          logger.log(`Loop: section ${idx} exceeded max retries (${sectionPlan.attempts}/${MAX_RETRIES}), terminating`)
          await terminateLoop(loopName, currentState, `section_failed: ${idx}`)
          return
        }

        loopService.setLastAuditResult(loopName, auditText || '')
        loopService.replaceSession(loopName, {
          newSessionId: currentState.sessionId,
          phase: 'coding',
          iteration: currentState.iteration,
        })

        const continuationPrompt = loopService.buildSectionContinuationPrompt(currentState, auditText || '')
        await rotateAndSendContinuation(
          loopName,
          currentState,
          {
            iteration: currentState.iteration,
            phase: 'coding',
            lastAuditResult: auditText || undefined,
            auditCount: newAuditCount,
          },
          continuationPrompt,
          assistantErrorDetected,
          'section retry continuation',
        )
        return
      }

      // Check clear first
      const candidateState = { ...currentState, auditCount: newAuditCount }
      if (await checkAuditClearAndTerminate(loopName, candidateState)) return

      const nextIteration = (currentState.iteration ?? 0) + 1
      if ((currentState.maxIterations ?? 0) > 0 && nextIteration > (currentState.maxIterations ?? 0)) {
        await terminateLoop(loopName, currentState, 'max_iterations')
        return
      }

      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
      )

      await rotateAndSendContinuation(
        loopName,
        currentState,
        {
          iteration: nextIteration,
          phase: 'coding',
          lastAuditResult: auditText || undefined,
          auditCount: newAuditCount,
        },
        continuationPrompt,
        assistantErrorDetected,
        'coding continuation',
      )
    } else {
      logger.log(`Loop: audit error detected, continuing without incrementing audit count`)
      const nextIteration = (currentState.iteration ?? 0) + 1
      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
      )
      await rotateAndSendContinuation(
        loopName,
        currentState,
        {
          iteration: nextIteration,
          phase: 'coding',
          lastAuditResult: auditText || undefined,
          auditCount: currentState.auditCount ?? 0,
        },
        continuationPrompt,
        assistantErrorDetected,
        'coding continuation',
      )
    }
  }

  async function onEvent(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> {
    const { event } = input

    if (event.type === 'worktree.failed') {
      const message = event.properties?.message as string
      const directory = event.properties?.directory as string
      logger.error(`Loop: worktree failed: ${message}`)
      
      if (directory) {
        const activeLoops = loopService.listActive()
        const affectedLoop = activeLoops.find((s) => s.worktreeDir === directory)
        if (affectedLoop) {
          await terminateLoop(affectedLoop.loopName!, affectedLoop, `worktree_failed: ${message}`)
        }
      }
      return
    }

    if (event.type === 'session.error') {
      const errorProps = event.properties as { sessionID?: string; error?: { name?: string; data?: { message?: string } } }
      const eventSessionId = errorProps?.sessionID
      const errorName = errorProps?.error?.name
      const isAbort = errorName === 'MessageAbortedError' || errorName === 'AbortError'

      if (!eventSessionId) return

      if (isAbort) {
        const loopName = loopService.resolveLoopName(eventSessionId)
        if (!loopName) return
        await withStateLock(loopName, async () => {
          const state = loopService.getActiveState(loopName)
          if (!state?.active) return
          const isCurrentSession = state.sessionId === eventSessionId
          if (!isCurrentSession) {
            logger.log(`Loop: ignoring stale aborted event for session ${eventSessionId} (current=${state.sessionId})`)
            return
          }
          if (state.phase === 'auditing') {
            const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
            if (lastMessageRole === 'assistant') {
              logger.log(`Loop: audit session ${eventSessionId} aborted after assistant response, processing audit result`)
              await handleAuditingPhase(loopName, state)
              return
            }
            logger.log(`Loop: audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`)
            await rotateToCodingAfterAuditFailure(loopName, state, 'aborted')
            return
          }
          if (state.phase === 'decomposing') {
            logger.log(`Loop: decomposer session ${eventSessionId} aborted, terminating loop`)
            await terminateLoop(loopName, state, 'user_aborted')
            return
          }
          if (state.phase === 'final_auditing') {
            const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
            if (lastMessageRole === 'assistant') {
              logger.log(`Loop: final audit session ${eventSessionId} aborted after assistant response, processing audit result`)
              await handleFinalAuditPhase(loopName, state)
              return
            }
            logger.log(`Loop: final audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`)
            await rotateToCodingAfterAuditFailure(loopName, state, 'aborted')
            return
          }
          logger.log(`Loop: session ${eventSessionId} aborted, terminating loop`)
          await terminateLoop(loopName, state, 'user_aborted')
        })
        return
      }

      const loopName = loopService.resolveLoopName(eventSessionId)
      if (!loopName) return
      await withStateLock(loopName, async () => {
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return
        const isCurrentSession = state.sessionId === eventSessionId
        if (!isCurrentSession) {
          logger.log(`Loop: ignoring stale error event for session ${eventSessionId} (current=${state.sessionId})`)
          return
        }
        if (state.phase === 'auditing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          logger.error(`Loop: audit session error for ${eventSessionId}: ${errorMessage}, cleaning up and rolling back to coding`)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage)
          return
        }
        if (state.phase === 'decomposing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          logger.error(`Loop: decomposer session error for ${eventSessionId}: ${errorMessage}, terminating loop`)
          await terminateLoop(loopName, state, `decomposer_error: ${errorMessage}`)
          return
        }
        if (state.phase === 'final_auditing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
          if (lastMessageRole === 'assistant') {
            logger.log(`Loop: final audit session ${eventSessionId} error after assistant response, processing audit result`)
            await handleFinalAuditPhase(loopName, state)
            return
          }
          logger.error(`Loop: final audit session error for ${eventSessionId}: ${errorMessage}, cleaning up and rolling back to coding`)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage)
          return
        }
        const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
        logger.error(`Loop: session error for ${eventSessionId}: ${errorMessage}`)
        const isModelError = /provider|auth|model|api\s*error/i.test(errorMessage)
        if (isModelError && !state.modelFailed) {
          logger.log(`Loop: marking model as failed, will fall back to default on next iteration`)
          loopService.setModelFailed(loopName, true)
        }
      })
      return
    }

    if (event.type !== 'session.status') return

    const status = event.properties?.status as { type?: string } | undefined
    if (status?.type !== 'idle') return

    const sessionId = event.properties?.sessionID as string
    if (!sessionId) return

    logger.debug(`Loop: received idle event for session=${sessionId}`)

    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) {
      logger.debug(`Loop: no loop found for session=${sessionId}, ignoring idle event`)
      return
    }
    logger.debug(`Loop: idle event matched loop=${loopName}`)

    await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state || !state.active) return

      const isCurrentSession = state.sessionId === sessionId
      if (!isCurrentSession) {
        logger.log(`Loop: ignoring stale idle event for session ${sessionId} (current=${state.sessionId})`)
        return
      }

      try {
        startWatchdog(loopName)
        
        if (state.phase === 'auditing') {
          await handleAuditingPhase(loopName, state)
        } else if (state.phase === 'decomposing') {
          await handleDecomposingPhase(loopName, state)
        } else if (state.phase === 'final_auditing') {
          await handleFinalAuditPhase(loopName, state)
        } else {
          await handleCodingPhase(loopName, state)
        }
      } catch (err) {
        const freshState = loopService.getActiveState(loopName)
        await handlePromptError(loopName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
      }
    })
  }

  async function terminateAll(): Promise<void> {
    await loopService.terminateAll()
  }

  function clearAllRetryTimeouts(): void {
    for (const [worktreeName, timeout] of retryTimeouts.entries()) {
      clearTimeout(timeout)
      retryTimeouts.delete(worktreeName)
    }
    for (const [worktreeName, timeout] of idleRetryTimeouts.entries()) {
      clearTimeout(timeout)
      idleRetryTimeouts.delete(worktreeName)
    }
    idleRetryAttempts.clear()
    for (const [worktreeName, interval] of stallWatchdogs.entries()) {
      clearInterval(interval)
      stallWatchdogs.delete(worktreeName)
    }
    lastActivityTime.clear()
    consecutiveStalls.clear()
    watchdogRunning.clear()
    lastStatusFingerprints.clear()
    stateLocks.clear()
    logger.log('Loop: cleared all retry timeouts')
  }

  async function cancelBySessionId(sessionId: string): Promise<boolean> {
    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) return false
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, 'cancelled')
    return true
  }

  async function terminateLoopByName(loopName: string, reason: string): Promise<boolean> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, reason)
    return true
  }

  function clearLoopTimers(loopName: string): void {
    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      idleRetryTimeouts.delete(loopName)
    }
    idleRetryAttempts.delete(loopName)
    lastStatusFingerprints.delete(loopName)
  }

  function runExclusive<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    return withStateLock<T>(loopName, fn)
  }

  return {
    onEvent,
    terminateAll,
    clearAllRetryTimeouts,
    startWatchdog,
    getStallInfo,
    cancelBySessionId,
    terminateLoopByName,
    runExclusive,
    clearLoopTimers,
  }
}
