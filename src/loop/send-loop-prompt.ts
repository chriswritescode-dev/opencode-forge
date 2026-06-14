import type { Logger } from '../types'
import { retryWithModelFallback } from '../utils/model-fallback'
import { clearPromptPending } from './idle-gate'
import { withInFlightGuard, ConcurrentPromptError, type PromptAgent } from './in-flight-guard'

export interface SendLoopPromptOptions {
  loopName: string
  sessionId: string
  agent: PromptAgent
  logger: Logger
  primaryModel?: { providerID: string; modelID: string } | null
  /** Performs ONE provider call for the given model (caller owns markPromptSent +
   *  the promptAsync/promptAuditSession call). Returns {} on success, {error} on failure. */
  performPrompt: (model: { providerID: string; modelID: string } | undefined) => Promise<{ error?: unknown }>
  /** Wrap each attempt in withInFlightGuard. Default true. (attach path passes false.) */
  useInFlightGuard?: boolean
  /** Call clearPromptPending on non-concurrent error. Default true. (restart passes false; it clears once after its transient-retry loop.) */
  clearPendingOnError?: boolean
}

export interface SendLoopPromptResult {
  result: { error?: unknown }
  usedModel?: { providerID: string; modelID: string } | undefined
}

/** Single source of truth for "send a loop prompt with model fallback + in-flight guard". */
export async function sendLoopPrompt(opts: SendLoopPromptOptions): Promise<SendLoopPromptResult> {
  const { loopName, sessionId, agent, logger, performPrompt } = opts
  const useGuard = opts.useInFlightGuard !== false
  const clearOnError = opts.clearPendingOnError !== false
  const primary = opts.primaryModel ?? undefined

  const attempt = async (
    model: { providerID: string; modelID: string } | undefined,
  ): Promise<{ error?: unknown }> => {
    if (!useGuard) return performPrompt(model)
    try {
      return await withInFlightGuard(loopName, sessionId, agent, logger, () => performPrompt(model))
    } catch (err) {
      if (err instanceof ConcurrentPromptError) return { error: err }
      throw err
    }
  }

  const { result, usedModel } = await retryWithModelFallback(
    () => attempt(primary),
    () => attempt(undefined),
    primary,
    logger,
  )

  if (result.error && !(result.error instanceof ConcurrentPromptError) && clearOnError) {
    clearPromptPending(loopName, logger)
  }

  return { result, usedModel }
}
