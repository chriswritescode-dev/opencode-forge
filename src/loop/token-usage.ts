export interface TokenBreakdown {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelUsage {
  model: string
  cost: number
  tokens: TokenBreakdown
  messageCount: number
}

export type UsageRole = 'code' | 'auditor' | 'unknown'

export const USAGE_ROLE_ORDER: readonly UsageRole[] = ['code', 'auditor', 'unknown']

export interface RoleUsage {
  role: UsageRole
  cost: number
  tokens: TokenBreakdown
  messageCount: number
}

export interface LoopUsageSummary {
  totalCost: number
  totalTokens: TokenBreakdown
  perModel: ModelUsage[]
  perRole?: RoleUsage[]
  attribution?: UsageAttribution
}

export interface UsageAttribution {
  role: UsageRole
  fallbackModel?: string
}

export interface AssistantMessageInfo {
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

export function emptyTokenBreakdown(): TokenBreakdown {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

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

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

interface UsageTotals {
  cost: number
  tokens: TokenBreakdown
  messageCount: number
}

function accumulateUsage<K>(map: Map<K, UsageTotals>, key: K, entry: UsageTotals): void {
  const existing = map.get(key)
  if (existing) {
    existing.cost += entry.cost
    existing.tokens = addTokens(existing.tokens, entry.tokens)
    existing.messageCount += entry.messageCount
  } else {
    map.set(key, { cost: entry.cost, tokens: { ...entry.tokens }, messageCount: entry.messageCount })
  }
}

function sortedModelUsage(map: Map<string, UsageTotals>): ModelUsage[] {
  return Array.from(map.entries())
    .map(([model, data]) => ({ model, cost: data.cost, tokens: data.tokens, messageCount: data.messageCount }))
    .sort((a, b) => a.model.localeCompare(b.model))
}

export function mergeRoleUsage(...groups: (RoleUsage[] | undefined)[]): RoleUsage[] {
  const map = new Map<UsageRole, UsageTotals>()
  for (const group of groups) {
    for (const entry of group ?? []) {
      accumulateUsage(map, entry.role, entry)
    }
  }
  return USAGE_ROLE_ORDER.filter(r => map.has(r)).map(r => ({ role: r, ...map.get(r)! }))
}

const DEFAULT_MODEL_LABEL = 'default/session model'

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

  if (info.model) {
    return info.model
  }
  if (info.modelID) {
    if (info.providerID) {
      return `${info.providerID}/${info.modelID}`
    }
    if (info.provider) {
      return `${info.provider}/${info.modelID}`
    }
    return info.modelID
  }
  if (info.modelId) {
    if (info.providerID) {
      return `${info.providerID}/${info.modelId}`
    }
    if (info.provider) {
      return `${info.provider}/${info.modelId}`
    }
    return info.modelId
  }

  if (info.providerID && info.model_name) {
    return `${info.providerID}/${info.model_name}`
  }
  if (info.provider && info.model_name) {
    return `${info.provider}/${info.model_name}`
  }

  return fallbackModel ?? DEFAULT_MODEL_LABEL
}

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
  const modelMap = new Map<string, UsageTotals>()
  let totalCost = 0
  let totalTokens = emptyTokenBreakdown()

  const assistantMessages = messages.filter((m) => m.info.role === 'assistant')

  for (const msg of assistantMessages) {
    const cost = msg.info.cost ?? 0
    const tokens = normalizeTokens(msg.info.tokens)
    const model = modelLabelFromMessage(msg.info, attribution?.fallbackModel)

    totalCost += cost
    totalTokens = addTokens(totalTokens, tokens)

    accumulateUsage(modelMap, model, { cost, tokens, messageCount: 1 })
  }

  return {
    totalCost,
    totalTokens,
    perModel: sortedModelUsage(modelMap),
    perRole: attribution
      ? [{
          role: attribution.role,
          cost: totalCost,
          tokens: { ...totalTokens },
          messageCount: assistantMessages.length,
        }]
      : [],
    attribution,
  }
}

export function mergeUsageSummaries(...summaries: LoopUsageSummary[]): LoopUsageSummary {
  if (summaries.length === 0) {
    return {
      totalCost: 0,
      totalTokens: emptyTokenBreakdown(),
      perModel: [],
      perRole: [],
    }
  }

  const modelMap = new Map<string, UsageTotals>()
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
      accumulateUsage(modelMap, modelUsage.model, modelUsage)
    }
  }

  return {
    totalCost,
    totalTokens,
    perModel: sortedModelUsage(modelMap),
    perRole: mergeRoleUsage(...summaries.map(s => s.perRole)),
    attribution,
  }
}
