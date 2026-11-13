import { z } from 'zod'
import type { PluginConfig } from '../types'
import type { WorkspaceForRecents } from './tui-models'

export interface ExecutionPreferences {
  mode: 'New session' | 'Execute here' | 'Loop'
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
}

export type ExecutionSelectionOverride = Partial<Omit<ExecutionPreferences, 'mode'>>

export interface ExecutionDialogDefaults {
  mode: string
  executionModel: string
  auditorModel: string
  executionVariant: string
  auditorVariant: string
}

const executionForgeLoopSchema = z.looseObject({
  executionModel: z.string().optional().catch(undefined),
  auditorModel: z.string().optional().catch(undefined),
  executionVariant: z.string().optional().catch(undefined),
  auditorVariant: z.string().optional().catch(undefined),
})

const workspaceExtraSchema = z.looseObject({
  forgeLoop: executionForgeLoopSchema.optional(),
})

function normalizeMode(mode: ExecutionPreferences['mode']): ExecutionPreferences['mode'] {
  const lower = mode.toLowerCase()
  if (lower === 'loop' || lower.startsWith('loop ') || lower.startsWith('loop-')) {
    return 'Loop'
  }
  return mode === 'New session' || mode === 'Execute here' ? mode : 'Loop'
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

export function deriveExecutionPreferencesFromWorkspaces(
  projectId: string,
  workspaces: ReadonlyArray<WorkspaceForRecents>,
): ExecutionPreferences | null {
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

  if (eligible.length === 0) return null

  const mostRecent = eligible.reduce((best, current) =>
    toFiniteNumber(current.workspace.timeUsed) > toFiniteNumber(best.workspace.timeUsed) ? current : best,
  )
  const forgeLoop = mostRecent.forgeLoop

  return {
    mode: 'Loop',
    executionModel: nonEmpty(forgeLoop.executionModel),
    auditorModel: nonEmpty(forgeLoop.auditorModel),
    executionVariant: nonEmpty(forgeLoop.executionVariant),
    auditorVariant: nonEmpty(forgeLoop.auditorVariant),
  }
}

export function resolveExecutionDialogDefaults(
  config: PluginConfig,
  storedPrefs: ExecutionPreferences | null,
  overrides?: ExecutionSelectionOverride,
): ExecutionDialogDefaults {
  const mode = normalizeMode(storedPrefs?.mode ?? 'Loop')

  const pick = (override: string | undefined, ...fallbacks: Array<string | undefined>): string => {
    if (override !== undefined) return override
    for (const f of fallbacks) if (f) return f
    return ''
  }

  const executionModel = pick(overrides?.executionModel, config.executionModel, storedPrefs?.executionModel)
  const auditorModel = pick(overrides?.auditorModel, config.auditorModel, config.executionModel, storedPrefs?.auditorModel, storedPrefs?.executionModel)
  const executionVariant = pick(overrides?.executionVariant, config.executionVariant, storedPrefs?.executionVariant)
  const auditorVariant = pick(overrides?.auditorVariant, config.auditorVariant, storedPrefs?.auditorVariant)

  return { mode, executionModel, auditorModel, executionVariant, auditorVariant }
}
