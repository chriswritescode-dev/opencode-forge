import type { ProviderList } from '../client/port'
import { z } from 'zod'

export interface ModelVariantConfig {
  name?: string
  description?: string
  disabled?: boolean
  reasoningEffort?: string | number | boolean
  reasoning_effort?: string | number | boolean
  thinking?: string | number | boolean
  thinkingBudget?: string | number | boolean
  thinking_budget?: string | number | boolean
}

const variantTextSchema = z.union([z.string(), z.number(), z.boolean()])

const modelVariantConfigSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  disabled: z.boolean().optional().catch(undefined),
  reasoningEffort: variantTextSchema.optional().catch(undefined),
  reasoning_effort: variantTextSchema.optional().catch(undefined),
  thinking: variantTextSchema.optional().catch(undefined),
  thinkingBudget: variantTextSchema.optional().catch(undefined),
  thinking_budget: variantTextSchema.optional().catch(undefined),
})

const forgeLoopExtraSchema = z.looseObject({
  executionModel: z.string().optional().catch(undefined),
  auditorModel: z.string().optional().catch(undefined),
  executionVariant: z.string().optional().catch(undefined),
  auditorVariant: z.string().optional().catch(undefined),
})

const workspaceExtraSchema = z.looseObject({
  forgeLoop: forgeLoopExtraSchema.optional(),
})

export interface ModelInfo {
  id: string
  name: string
  providerID: string
  providerName: string
  fullName: string
  releaseDate?: string
  capabilities?: {
    temperature?: boolean
    toolcall?: boolean
    reasoning?: boolean
    attachment?: boolean
  }
  cost?: {
    input?: number
    output?: number
  }
  variants?: Record<string, ModelVariantConfig>
}

export interface ProviderInfo {
  id: string
  name: string
  models: ModelInfo[]
}

export interface ProviderSnapshot {
  providers: ProviderInfo[]
  connectedProviderIds: string[]
}

export interface ModelSortOptions {
  recents?: string[]
  connectedProviderIds?: string[]
  configuredProviderIds?: string[]
}

export type LoopInfo = {
  name: string
  status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
  phase: string
  iteration: number
  maxIterations: number
  sessionId: string
  restartable: boolean
  restartRequiresForce: boolean
  restartBlockedMessage?: string
  startedAt?: string
  executionModel?: string
  executionVariant?: string
  auditorModel?: string
  auditorVariant?: string
  branch?: string
}

function parseModelVariants(raw: ModelInfo['variants']): ModelInfo['variants'] {
  if (!raw) return undefined
  const variants: Record<string, ModelVariantConfig> = {}
  for (const [key, config] of Object.entries(raw)) {
    const parsed = modelVariantConfigSchema.safeParse(config)
    if (!parsed.success) continue
    variants[key] = parsed.data
  }
  return variants
}

export function providersFromProviderList(data: ProviderList): ProviderSnapshot {
  const providers: ProviderInfo[] = []
  const allModels = data.all || []
  const connected = data.connected || []
  for (const provider of allModels) {
    if (!connected.includes(provider.id)) continue
    const models: ModelInfo[] = []
    if (provider.models) {
      for (const modelData of Object.values(provider.models)) {
        models.push({
          id: modelData.id,
          name: modelData.name,
          providerID: provider.id,
          providerName: provider.name,
          fullName: `${provider.id}/${modelData.id}`,
          releaseDate: modelData.release_date,
          capabilities: {
            temperature: modelData.capabilities?.temperature,
            toolcall: modelData.capabilities?.toolcall,
            reasoning: modelData.capabilities?.reasoning,
            attachment: modelData.capabilities?.attachment,
          },
          cost: modelData.cost,
          variants: parseModelVariants(modelData.variants),
        })
      }
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      models,
    })
  }
  return { providers, connectedProviderIds: connected }
}

export function flattenProviders(providers: ProviderInfo[]): ModelInfo[] {
  const allModels: ModelInfo[] = []
  for (const provider of providers) {
    allModels.push(...provider.models)
  }
  return sortModelsByPriority(allModels, {})
}

export function buildDialogSelectOptions(
  models: ModelInfo[],
  recents: string[] = [],
): Array<{ title: string; value: string; description?: string; category?: string }> {
  const defaultOption = {
    title: 'Use default',
    value: '',
    description: 'Use config default',
  }

  const modelMap = new Map(models.map(m => [m.fullName, m]))
  const usedInSections = new Set<string>()

  const recentOptions = recents
    .filter(fn => !usedInSections.has(fn))
    .map(fn => modelMap.get(fn))
    .filter((m): m is ModelInfo => !!m)
    .map(m => {
      usedInSections.add(m.fullName)
      return {
        title: m.name,
        value: m.fullName,
        description: m.providerName,
        category: 'Recent',
      }
    })

  const providerOptions = models
    .filter(m => !usedInSections.has(m.fullName))
    .map(m => ({
      title: m.name,
      value: m.fullName,
      description: m.capabilities?.reasoning ? 'Reasoning' : undefined,
      category: m.providerName,
    }))

  return [defaultOption, ...recentOptions, ...providerOptions]
}

export function getModelDisplayLabel(
  value: string,
  models: ModelInfo[],
  fallbackFullName?: string,
): string {
  if (value) {
    const model = models.find(m => m.fullName === value)
    return model ? model.name : value
  }
  if (fallbackFullName) {
    const fallbackModel = models.find(m => m.fullName === fallbackFullName)
    return fallbackModel ? fallbackModel.name : fallbackFullName
  }
  return 'default'
}

const RECENT_MODELS_MAX = 10

export interface WorkspaceForRecents {
  type: string
  projectID?: string
  timeUsed?: number | string
  extra?: unknown | null
}

export function deriveRecentModelsFromWorkspaces(
  projectId: string,
  workspaces: ReadonlyArray<WorkspaceForRecents>,
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? RECENT_MODELS_MAX
  if (max <= 0) return []

  const toFiniteNumber = (value: number | string | undefined): number => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }

  const eligible = workspaces.flatMap((workspace) => {
    if (workspace.type !== 'forge') return []
    if (workspace.projectID !== undefined && workspace.projectID !== projectId) return []
    const extra = workspaceExtraSchema.safeParse(workspace.extra)
    if (!extra.success || extra.data.forgeLoop === undefined) return []
    return [{ workspace, forgeLoop: extra.data.forgeLoop }]
  })

  const sorted = [...eligible].sort((a, b) => toFiniteNumber(b.workspace.timeUsed) - toFiniteNumber(a.workspace.timeUsed))

  const recents: string[] = []
  const seen = new Set<string>()

  const pushModel = (raw: string | undefined): boolean => {
    if (raw === undefined || raw.length === 0) return false
    if (seen.has(raw)) return false
    seen.add(raw)
    recents.push(raw)
    return recents.length >= max
  }

  for (const { forgeLoop } of sorted) {
    if (pushModel(forgeLoop.executionModel)) return recents
    if (pushModel(forgeLoop.auditorModel)) return recents
  }

  return recents
}

export interface SessionForRecents {
  projectID: string
  model?: { providerID: string; id: string; variant?: string } | null
  time: { updated: number }
}

export interface DeriveRecentModelsInputs {
  sessions: ReadonlyArray<SessionForRecents>
  workspaces: ReadonlyArray<WorkspaceForRecents>
  openCodeFavorites: ReadonlyArray<string>
  openCodeDefault: string | undefined
}

export function deriveRecentModels(
  projectId: string,
  inputs: DeriveRecentModelsInputs,
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? RECENT_MODELS_MAX
  if (max <= 0) return []

  const recents: string[] = []
  const seen = new Set<string>()

  const tryPush = (fullname: string | undefined): boolean => {
    if (fullname === undefined || fullname.length === 0) return false
    if (seen.has(fullname)) return false
    seen.add(fullname)
    recents.push(fullname)
    return recents.length >= max
  }

  const toFiniteNumber = (value: number | string | undefined): number => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }

  const sessionsForProject = inputs.sessions
    .filter((s) => s.projectID === projectId && s.model)
    .sort((a, b) => toFiniteNumber(b.time?.updated) - toFiniteNumber(a.time?.updated))

  for (const session of sessionsForProject) {
    const model = session.model
    if (!model) continue
    if (model.providerID.length === 0 || model.id.length === 0) continue
    if (tryPush(`${model.providerID}/${model.id}`)) return recents
  }

  for (const fullname of deriveRecentModelsFromWorkspaces(projectId, inputs.workspaces, { max })) {
    if (tryPush(fullname)) return recents
  }

  for (const fullname of inputs.openCodeFavorites) {
    if (tryPush(fullname)) return recents
  }

  tryPush(inputs.openCodeDefault)

  return recents
}

export function sortModelsByPriority(
  models: ModelInfo[],
  options: ModelSortOptions = {}
): ModelInfo[] {
  const recentSet = new Set(options.recents ?? [])
  const connectedProviderSet = new Set(options.connectedProviderIds ?? [])
  const configuredProviderSet = new Set(options.configuredProviderIds ?? [])

  const sortable = [...models]

  const getProviderPriority = (model: ModelInfo) => {
    if (connectedProviderSet.has(model.providerID)) return 0
    if (configuredProviderSet.has(model.providerID)) return 1
    return 2
  }
  
  return sortable.sort((a, b) => {
    const aIsRecent = recentSet.has(a.fullName)
    const bIsRecent = recentSet.has(b.fullName)

    if (aIsRecent && !bIsRecent) return -1
    if (!aIsRecent && bIsRecent) return 1

    const providerPriorityDiff = getProviderPriority(a) - getProviderPriority(b)
    if (providerPriorityDiff !== 0) return providerPriorityDiff

    const providerNameDiff = a.providerName.localeCompare(b.providerName)
    if (providerNameDiff !== 0) return providerNameDiff
    
    return a.name.localeCompare(b.name)
  })
}

export interface ModelVariantInfo {
  id: string
  label: string
  description?: string
}

function variantKeyToLabel(key: string): string {
  return key
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function variantDescription(config: ModelVariantConfig): string | undefined {
  if (config.description !== undefined) return config.description

  const reasoning = config.reasoningEffort ?? config.reasoning_effort
  if (reasoning !== undefined) return `Reasoning: ${reasoning}`

  const thinking = config.thinking
  if (thinking !== undefined) return `Thinking: ${thinking}`

  const budget = config.thinkingBudget ?? config.thinking_budget
  if (budget !== undefined) return `Thinking budget: ${budget}`

  return undefined
}

export function getAvailableModelVariants(model?: ModelInfo | null): ModelVariantInfo[] {
  if (!model?.variants) return []

  return Object.entries(model.variants)
    .filter(([, cfg]) => !cfg.disabled)
    .map(([key, cfg]) => ({
      id: key,
      label: cfg.name ?? variantKeyToLabel(key),
      description: variantDescription(cfg),
    }))
}

export function getVariantDisplayLabel(
  variant: string | undefined,
  model?: ModelInfo | null,
): string {
  if (!variant) return 'default'

  const available = getAvailableModelVariants(model)
  const found = available.find(v => v.id === variant)
  if (found) return found.label

  return variant
}

export function normalizeVariantForModel(
  variant: string | undefined,
  model?: ModelInfo | null,
): string {
  if (!variant) return ''
  if (!model?.variants) return ''

  const available = getAvailableModelVariants(model)
  return available.some(v => v.id === variant) ? variant : ''
}
