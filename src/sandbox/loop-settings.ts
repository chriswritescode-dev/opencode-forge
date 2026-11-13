import { z } from 'zod'
import type { WorkspaceExtra } from '../client/port'
import type { LoopSandboxSettings, SandboxOverrides, SandboxResources } from '../types'

export const MSB_SIZE_RE = /^\d+(\.\d+)?[kmg]b?$/i

export const SANDBOX_RESOURCE_DEFAULTS: Readonly<Required<SandboxResources>> = {
  memory: '8g',
  cpus: '4',
  dockerDisk: '16g',
  cacheDisk: '16g',
}

export const LOOP_SANDBOX_EXTRA_KEY = 'loopSandbox'

const SIZE_RESOURCE_KEYS = ['memory', 'dockerDisk', 'cacheDisk'] as const

export function isSandboxSize(value: string): boolean {
  return MSB_SIZE_RE.test(value.trim())
}

export function isSandboxCpuCount(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim())
}

export type LoopSandboxSettingsInput = WorkspaceExtra['loopSandbox']

const rawLoopSandboxResourcesSchema = z.looseObject({
  memory: z.string().optional().catch(undefined),
  cpus: z.string().optional().catch(undefined),
  dockerDisk: z.string().optional().catch(undefined),
  cacheDisk: z.string().optional().catch(undefined),
})

const rawLoopSandboxSettingsSchema = z.looseObject({
  enabled: z.boolean().optional().catch(undefined),
  allowLan: z.boolean().optional().catch(undefined),
  resources: rawLoopSandboxResourcesSchema.optional().catch(undefined),
})

export function readLoopSandboxSettings(value: LoopSandboxSettingsInput): LoopSandboxSettings | undefined {
  const parsed = rawLoopSandboxSettingsSchema.safeParse(value)
  if (!parsed.success) return undefined
  const rawSettings = parsed.data
  const resources: SandboxResources = {}
  const rawResources = rawSettings.resources
  if (rawResources?.cpus !== undefined && isSandboxCpuCount(rawResources.cpus)) resources.cpus = rawResources.cpus.trim()
  for (const key of SIZE_RESOURCE_KEYS) {
    const size = rawResources?.[key]
    if (size !== undefined && isSandboxSize(size)) resources[key] = size.trim().toLowerCase()
  }
  const settings: LoopSandboxSettings = {}
  if (rawSettings.enabled !== undefined) settings.enabled = rawSettings.enabled
  if (Object.keys(resources).length > 0) settings.resources = resources
  if (rawSettings.allowLan !== undefined) settings.allowLan = rawSettings.allowLan
  return Object.keys(settings).length > 0 ? settings : undefined
}

export function readSandboxOverrides(value: LoopSandboxSettingsInput): SandboxOverrides | undefined {
  const { enabled: _enabled, ...overrides } = readLoopSandboxSettings(value) ?? {}
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

export function resolveSandboxAllowLan(configAllowLan?: boolean, override?: SandboxOverrides): boolean {
  return override?.allowLan ?? configAllowLan ?? false
}

export interface SandboxRuntimeSettings {
  cpus: number
  memoryMib: number
  allowLan: boolean
}

export function resolveSandboxResources(config?: SandboxResources, override?: SandboxResources): Required<SandboxResources> {
  return {
    memory: override?.memory ?? config?.memory ?? SANDBOX_RESOURCE_DEFAULTS.memory,
    cpus: override?.cpus ?? config?.cpus ?? SANDBOX_RESOURCE_DEFAULTS.cpus,
    dockerDisk: override?.dockerDisk ?? config?.dockerDisk ?? SANDBOX_RESOURCE_DEFAULTS.dockerDisk,
    cacheDisk: override?.cacheDisk ?? config?.cacheDisk ?? SANDBOX_RESOURCE_DEFAULTS.cacheDisk,
  }
}

export function loopSandboxWorkspaceExtra(settings: LoopSandboxSettings | undefined): WorkspaceExtra {
  return settings ? { [LOOP_SANDBOX_EXTRA_KEY]: settings } : {}
}
