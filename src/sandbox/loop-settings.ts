import type { LoopSandboxSettings, SandboxOverrides, SandboxResources } from '../types'
import { isRecord } from '../utils/is-record'

/** Size literal msb accepts for `-m` and named-disk `size=` values, e.g. `8g` or `1024m`. */
export const MSB_SIZE_RE = /^\d+(\.\d+)?[kmg]b?$/i

/** Resources a sandbox gets when neither the config nor the loop overrides them. */
export const SANDBOX_RESOURCE_DEFAULTS: Readonly<Required<SandboxResources>> = {
  memory: '8g',
  cpus: '4',
  dockerDisk: '16g',
  cacheDisk: '16g',
}

/** Workspace `extra` key that carries a loop's {@link LoopSandboxSettings} to the forge workspace adapter. */
export const LOOP_SANDBOX_EXTRA_KEY = 'loopSandbox'

const SIZE_RESOURCE_KEYS = ['memory', 'dockerDisk', 'cacheDisk'] as const

/** Whether `value` is a size msb accepts (`8g`, `512m`, `1.5gb`). */
export function isSandboxSize(value: string): boolean {
  return MSB_SIZE_RE.test(value.trim())
}

/** Whether `value` is a CPU count msb accepts: `msb create -c` is a positive integer. */
export function isSandboxCpuCount(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim())
}

/**
 * Validates untrusted per-loop sandbox settings (RPC input, workspace `extra`, a persisted JSON
 * column). Invalid fields are dropped; returns undefined when nothing valid remains so "no
 * overrides" has exactly one representation.
 */
export function readLoopSandboxSettings(value: unknown): LoopSandboxSettings | undefined {
  if (!isRecord(value)) return undefined
  const resources: SandboxResources = {}
  if (isRecord(value.resources)) {
    const raw = value.resources
    if (typeof raw.cpus === 'string' && isSandboxCpuCount(raw.cpus)) resources.cpus = raw.cpus.trim()
    for (const key of SIZE_RESOURCE_KEYS) {
      const size = raw[key]
      if (typeof size === 'string' && isSandboxSize(size)) resources[key] = size.trim().toLowerCase()
    }
  }
  const settings: LoopSandboxSettings = {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    ...(typeof value.allowLan === 'boolean' ? { allowLan: value.allowLan } : {}),
  }
  return Object.keys(settings).length > 0 ? settings : undefined
}

/** {@link readLoopSandboxSettings} without the loop-only `enabled` flag, for any sandbox's overrides. */
export function readSandboxOverrides(value: unknown): SandboxOverrides | undefined {
  const { enabled: _enabled, ...overrides } = readLoopSandboxSettings(value) ?? {}
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

/** Effective LAN access: override, then `sandbox.network.allowLan`, then off. */
export function resolveSandboxAllowLan(configAllowLan?: boolean, override?: SandboxOverrides): boolean {
  return override?.allowLan ?? configAllowLan ?? false
}

/**
 * The settings of an existing sandbox that can differ from what Forge wants: CPUs and memory
 * (changed in place by a restart) and LAN access (changed only by recreating the sandbox).
 */
export interface SandboxRuntimeSettings {
  cpus: number
  memoryMib: number
  allowLan: boolean
}

/**
 * Effective sandbox resources: loop override, then config, then {@link SANDBOX_RESOURCE_DEFAULTS}.
 * Single resolver for sandbox creation and for the defaults the TUI displays.
 */
export function resolveSandboxResources(config?: SandboxResources, override?: SandboxResources): Required<SandboxResources> {
  return {
    memory: override?.memory ?? config?.memory ?? SANDBOX_RESOURCE_DEFAULTS.memory,
    cpus: override?.cpus ?? config?.cpus ?? SANDBOX_RESOURCE_DEFAULTS.cpus,
    dockerDisk: override?.dockerDisk ?? config?.dockerDisk ?? SANDBOX_RESOURCE_DEFAULTS.dockerDisk,
    cacheDisk: override?.cacheDisk ?? config?.cacheDisk ?? SANDBOX_RESOURCE_DEFAULTS.cacheDisk,
  }
}

/** Workspace `extra` fragment that hands a loop's settings to the forge workspace adapter. */
export function loopSandboxWorkspaceExtra(settings: LoopSandboxSettings | undefined): Record<string, unknown> {
  return settings ? { [LOOP_SANDBOX_EXTRA_KEY]: settings } : {}
}
