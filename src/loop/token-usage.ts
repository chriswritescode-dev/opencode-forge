/**
 * Shared token usage extraction and formatting utilities for loop sessions.
 * This is the single source of truth for token/cost extraction, merging, and model grouping.
 */

/** Token breakdown for a single message or aggregated usage */
export interface TokenBreakdown {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** Usage aggregated per model */
export interface ModelUsage {
  model: string
  cost: number
  tokens: TokenBreakdown
  messageCount: number
}

/** Summary of loop usage, optionally attributed to a role */
export interface LoopUsageSummary {
  totalCost: number
  totalTokens: TokenBreakdown
  perModel: ModelUsage[]
  attribution?: UsageAttribution
}

/** Attribution metadata for usage */
export interface UsageAttribution {
  role: 'code' | 'auditor' | 'unknown'
  fallbackModel?: string
}

/** Create an empty TokenBreakdown */
export function emptyTokenBreakdown(): TokenBreakdown {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

/** Normalize tokens from SDK format to TokenBreakdown */
export function normalizeTokens(
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined | null,
): TokenBreakdown {
  if (!tokens) {
    return emptyTokenBreakdown()
  }
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
  }
}

/** Add two TokenBreakdowns together */
export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/** Default model label when no metadata or fallback is available */
export const DEFAULT_MODEL_LABEL = 'default/session model'

/**
 * Extract model label from message info, falling back to provided model or default.
 * Priority:
 * 1. info.model (already includes provider if applicable)
 * 2. info.modelID or info.modelId (with providerID/provider if available, otherwise model ID as-is)
 * 3. provider/model pairs: providerID+model_name, provider+model_name
 * 4. fallbackModel parameter
 * 5. DEFAULT_MODEL_LABEL ('default/session model')
 */
export function modelLabelFromMessage(
  info: {
    role: string
    cost?: number
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    model?: string
    modelID?: string
    modelId?: string
    provider?: string
    providerID?: string
    model_name?: string
  } | undefined,
  fallbackModel?: string,
): string {
  if (!info) {
    return fallbackModel ?? DEFAULT_MODEL_LABEL
  }

  // Check direct model fields first
  if (info.model) {
    return info.model
  }
  if (info.modelID) {
    // If we have providerID, combine them
    if (info.providerID) {
      return `${info.providerID}/${info.modelID}`
    }
    // If we have provider (without ID suffix), combine them
    if (info.provider) {
      return `${info.provider}/${info.modelID}`
    }
    // No provider info available - use the model ID as-is (actual message model wins)
    return info.modelID
  }
  if (info.modelId) {
    // If we have providerID, combine them
    if (info.providerID) {
      return `${info.providerID}/${info.modelId}`
    }
    // If we have provider (without ID suffix), combine them
    if (info.provider) {
      return `${info.provider}/${info.modelId}`
    }
    // No provider info available - use the model ID as-is (actual message model wins)
    return info.modelId
  }

  // Check provider/model pairs
  if (info.providerID && info.model_name) {
    return `${info.providerID}/${info.model_name}`
  }
  if (info.provider && info.model_name) {
    return `${info.provider}/${info.model_name}`
  }

  // Fall back to provided fallback, or default
  return fallbackModel ?? DEFAULT_MODEL_LABEL
}

/**
 * Summarize assistant usage from messages, grouping by model.
 * Only processes messages with role === 'assistant'.
 * Uses actual model from message metadata when available, otherwise uses fallbackModel.
 */
export function summarizeAssistantUsage(
  messages: {
    info: {
      role: string
      cost?: number
      tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
      model?: string
      modelID?: string
      modelId?: string
      provider?: string
      providerID?: string
      model_name?: string
    }
  }[],
  attribution?: UsageAttribution,
): LoopUsageSummary {
  const modelMap = new Map<string, { cost: number; tokens: TokenBreakdown; messageCount: number }>()
  let totalCost = 0
  let totalTokens = emptyTokenBreakdown()

  const assistantMessages = messages.filter((m) => m.info.role === 'assistant')

  for (const msg of assistantMessages) {
    const cost = msg.info.cost ?? 0
    const tokens = normalizeTokens(msg.info.tokens)
    const model = modelLabelFromMessage(msg.info, attribution?.fallbackModel)

    totalCost += cost
    totalTokens = addTokens(totalTokens, tokens)

    const existing = modelMap.get(model)
    if (existing) {
      existing.cost += cost
      existing.tokens = addTokens(existing.tokens, tokens)
      existing.messageCount += 1
    } else {
      modelMap.set(model, { cost, tokens: { ...tokens }, messageCount: 1 })
    }
  }

  // Convert map to sorted array for deterministic output
  const perModel: ModelUsage[] = Array.from(modelMap.entries())
    .map(([model, data]) => ({ model, cost: data.cost, tokens: data.tokens, messageCount: data.messageCount }))
    .sort((a, b) => a.model.localeCompare(b.model))

  return {
    totalCost,
    totalTokens,
    perModel,
    attribution,
  }
}

/**
 * Merge multiple LoopUsageSummary instances into one.
 * Preserves attribution from the first summary if present.
 */
export function mergeUsageSummaries(...summaries: LoopUsageSummary[]): LoopUsageSummary {
  if (summaries.length === 0) {
    return {
      totalCost: 0,
      totalTokens: emptyTokenBreakdown(),
      perModel: [],
    }
  }

  const modelMap = new Map<string, { cost: number; tokens: TokenBreakdown; messageCount: number }>()
  let totalCost = 0
  let totalTokens = emptyTokenBreakdown()
  let attribution: UsageAttribution | undefined

  for (const summary of summaries) {
    totalCost += summary.totalCost
    totalTokens = addTokens(totalTokens, summary.totalTokens)

    if (!attribution && summary.attribution) {
      attribution = summary.attribution
    }

    for (const modelUsage of summary.perModel) {
      const existing = modelMap.get(modelUsage.model)
      if (existing) {
        existing.cost += modelUsage.cost
        existing.tokens = addTokens(existing.tokens, modelUsage.tokens)
        existing.messageCount += modelUsage.messageCount
      } else {
        modelMap.set(modelUsage.model, { cost: modelUsage.cost, tokens: { ...modelUsage.tokens }, messageCount: modelUsage.messageCount })
      }
    }
  }

  // Convert map to sorted array for deterministic output
  const perModel: ModelUsage[] = Array.from(modelMap.entries())
    .map(([model, data]) => ({ model, cost: data.cost, tokens: data.tokens, messageCount: data.messageCount }))
    .sort((a, b) => a.model.localeCompare(b.model))

  return {
    totalCost,
    totalTokens,
    perModel,
    attribution,
  }
}
