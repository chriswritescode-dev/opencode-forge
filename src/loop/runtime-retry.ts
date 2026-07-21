import type { RuntimeContext } from './runtime-context'
import type { LoopState } from './state'
import type { Logger } from '../types'
import type { ForgeClient } from '../client/port'
import { MAX_RETRIES } from './service'
import { classifyProviderLimit, extractErrorSignal } from './provider-limit'
import { withInFlightGuard, ConcurrentPromptError } from './in-flight-guard'
import type { PromptDispatch } from './runtime-prompt'

export interface PromptRetryOptions {
  loopName: string
  sessionId: string
  agent: 'code' | 'auditor-loop'
  /** Base label used in retry logs; inner retry errors report `retry failed ${errorContext}`. */
  errorContext: string
  /** Extra freshness predicate beyond `freshState.active`; retry aborts (throws loop_cancelled) when it returns false. */
  isRetryValid?: (fresh: LoopState) => boolean
  /** Custom retry send action. When omitted, the default `client.session.promptAsync` send with inner handlePromptError catch is used (requires promptText). */
  send?: (fresh: LoopState) => Promise<void>
  promptText?: string
}

export interface SendPromptWithRetryRecoveryOptions extends PromptRetryOptions {
  promptText: string
  model?: Parameters<PromptDispatch['sendPromptWithFallback']>[0]['model']
  variant?: string
  /** State passed to handlePromptError when the initial send fails. */
  errorState: LoopState
  /** Context for the initial-send failure; defaults to `failed to send ${errorContext}`. */
  sendErrorContext?: string
  /** Watchdog activity tag recorded on successful send. Omit to skip. */
  activityTag?: string
  /** Invoked once when the initial send fails, before retry recovery (e.g. clearPromptPending). */
  onSendError?: () => void
}

export interface PromptRetry {
  handlePromptError(loopName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void>
  buildPromptRetryFn(opts: PromptRetryOptions): () => Promise<void>
  sendPromptWithRetryRecovery(opts: SendPromptWithRetryRecoveryOptions): Promise<{ sent: boolean; usedModel?: { providerID: string; modelID: string } | undefined }>
}

export interface PromptRetryDeps {
  ctx: RuntimeContext
  logger: Logger
  client: ForgeClient
  promptDispatch: PromptDispatch
}

export function createPromptRetry(deps: PromptRetryDeps): PromptRetry {
  const { ctx, logger, client, promptDispatch } = deps
  const { sendPromptWithFallback } = promptDispatch

  async function handlePromptError(loopName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void> {
    if (err instanceof ConcurrentPromptError) {
      logger.log(`Loop: ${context} — rejected as concurrent prompt (prior guard active), skipping retry/termination`)
      return
    }

    const currentState = ctx.loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} already terminated, ignoring error: ${context}`)
      return
    }

    const signal = extractErrorSignal(err)
    const limitReason = classifyProviderLimit(signal)
    if (limitReason) {
      logger.error(`Loop: ${context} — provider limit detected, terminating without retry`)
      await ctx.terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
      return
    }

    const nextErrorCount = (currentState.errorCount ?? 0) + 1

    if (nextErrorCount < MAX_RETRIES) {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), will retry`, err)
      ctx.loopService.incrementError(loopName)
      if (retryFn) {
        const retryTimeout = setTimeout(() => {
          // Serialize the retry send and its failure/exhaustion handling with
          // phase-rotation ticks (which also acquire the per-loop state
          // lock). Without this guard, a delayed retry could fire its send
          // and (on failure) its exhausted termination concurrently with a
          // phase rotation, racing the terminal row's fromPhase against the
          // rotation's persisted phase and corrupting transition ordering.
          // Holding the lock for the duration of the retry attempt and the
          // recursive handlePromptError (which may terminate) guarantees
          // any concurrent tick queues behind us and observes the
          // authoritative post-retry state when it eventually runs. Inside
          // the lock body, handlePromptError's `terminateLoop` runs nested
          // without re-acquiring the lock (terminateLoop never wraps itself
          // in ctx.withStateLock — only its public callers do), so there is no
          // nested-lock deadlock.
          void ctx.withStateLock(loopName, async () => {
            const freshState = ctx.loopService.getActiveState(loopName)
            if (!freshState?.active) {
              logger.log(`Loop: loop cancelled, skipping retry`)
              ctx.retryTimeouts.delete(loopName)
              return
            }
            try {
              await retryFn()
            } catch (retryErr) {
              await handlePromptError(loopName, freshState, context, retryErr, retryFn)
            }
          })
        }, 2000)
        ctx.retryTimeouts.set(loopName, retryTimeout)
      }
    } else {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), giving up`, err)
      await ctx.terminateLoop(loopName, currentState, { kind: 'error_max_retries', message: context })
    }
  }

  function buildPromptRetryFn(opts: PromptRetryOptions): () => Promise<void> {
    const defaultSend = async (freshState: LoopState): Promise<void> => {
      try {
        await client.session.promptAsync({
          sessionID: opts.sessionId,
          directory: freshState.worktreeDir,
          ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
          agent: opts.agent,
          parts: [{ type: 'text' as const, text: opts.promptText ?? '' }],
        })
      } catch (err) {
        await handlePromptError(opts.loopName, freshState, `retry failed ${opts.errorContext}`, err)
      }
    }
    const send = opts.send ?? defaultSend
    return async () => {
      const freshState = ctx.loopService.getActiveState(opts.loopName)
      if (!freshState?.active || (opts.isRetryValid && !opts.isRetryValid(freshState))) throw new Error('loop_cancelled')
      try {
        await withInFlightGuard(opts.loopName, opts.sessionId, opts.agent, logger, () => send(freshState))
      } catch (err) {
        if (err instanceof ConcurrentPromptError) {
          logger.log(`Loop: ${opts.errorContext} — retry rejected as concurrent prompt (prior guard active), skipping`)
          return
        }
        throw err
      }
    }
  }

  async function sendPromptWithRetryRecovery(
    opts: SendPromptWithRetryRecoveryOptions,
  ): Promise<{ sent: boolean; usedModel?: Awaited<ReturnType<typeof sendPromptWithFallback>>['usedModel'] }> {
    const { error, usedModel } = await sendPromptWithFallback({
      loopName: opts.loopName,
      sessionId: opts.sessionId,
      promptText: opts.promptText,
      agent: opts.agent,
      model: opts.model,
      variant: opts.variant,
    })
    if (error) {
      opts.onSendError?.()
      const context = opts.sendErrorContext ?? `failed to send ${opts.errorContext}`
      logger.error(`Loop: ${context} for ${opts.loopName}`, error)
      await handlePromptError(opts.loopName, opts.errorState, context, error, buildPromptRetryFn(opts))
      return { sent: false }
    }
    if (opts.activityTag) ctx.watchdog.recordActivity(opts.loopName, opts.activityTag)
    return { sent: true, usedModel }
  }

  return { handlePromptError, buildPromptRetryFn, sendPromptWithRetryRecovery }
}
