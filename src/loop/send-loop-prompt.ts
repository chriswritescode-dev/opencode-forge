import type { Logger } from '../types'
import { retryWithModelFallback } from '../utils/model-fallback'
import { clearPromptPending } from './idle-gate'
import { withInFlightGuard, ConcurrentPromptError, type PromptAgent } from './in-flight-guard'
import { extractErrorSignal, classifyProviderLimit } from './provider-limit'

export interface SendLoopPromptOptions {
  projectId: string
  loopName: string
  sessionId: string
  agent: PromptAgent
  logger: Logger
  primaryModel?: { providerID: string; modelID: string } | null
  fallbackModel?: { providerID: string; modelID: string } | null
  performPrompt: (model: { providerID: string; modelID: string } | undefined) => Promise<{ error?: unknown }>
  useInFlightGuard?: boolean
  clearPendingOnError?: boolean
}

export interface SendLoopPromptResult {
  result: { error?: unknown }
  usedModel?: { providerID: string; modelID: string } | undefined
}

export async function sendLoopPrompt(opts: SendLoopPromptOptions): Promise<SendLoopPromptResult> {
  const { projectId, loopName, sessionId, agent, logger, performPrompt } = opts
  const useGuard = opts.useInFlightGuard !== false
  const clearOnError = opts.clearPendingOnError !== false
  const primary = opts.primaryModel ?? undefined
  const fallback = opts.fallbackModel ?? undefined

  const attempt = async (
    model: { providerID: string; modelID: string } | undefined,
  ): Promise<{ error?: unknown }> => {
    if (!useGuard) return performPrompt(model)
    try {
      return await withInFlightGuard(projectId, loopName, sessionId, agent, logger, () => performPrompt(model))
    } catch (err) {
      if (err instanceof ConcurrentPromptError) return { error: err }
      throw err
    }
  }

  const { result, usedModel } = await retryWithModelFallback(
    () => attempt(primary),
    () => attempt(fallback),
    primary,
    logger,
    2,
    (error) => classifyProviderLimit(extractErrorSignal(error)) !== null,
  )

  if (result.error && !(result.error instanceof ConcurrentPromptError) && clearOnError) {
    clearPromptPending(projectId, loopName, logger)
  }

  return { result, usedModel }
}
