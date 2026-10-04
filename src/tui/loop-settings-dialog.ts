import type { ForgeLoopDefaults } from '../host/forge-rpc'
import type { LoopSandboxSettings, SandboxResources } from '../types'
import { isSandboxCpuCount, isSandboxSize, readLoopSandboxSettings, resolveSandboxAllowLan, resolveSandboxResources } from '../sandbox/loop-settings'
import type { ForgeTuiHost, ForgeTuiSelectOption } from './host'

/** Loop-mode overrides chosen in the execution dialog; unset fields use the server defaults. */
export interface LoopLaunchSettings {
  maxIterations?: number
  sandbox?: LoopSandboxSettings
}

export interface ResourceField {
  key: keyof SandboxResources
  label: string
  example: string
  isValid(value: string): boolean
}

export const RESOURCE_FIELDS: ReadonlyArray<ResourceField> = [
  { key: 'cpus', label: 'CPUs', example: '8', isValid: isSandboxCpuCount },
  { key: 'memory', label: 'Memory', example: '16g', isValid: isSandboxSize },
  { key: 'dockerDisk', label: 'Docker disk', example: '32g', isValid: isSandboxSize },
  { key: 'cacheDisk', label: 'Cache disk', example: '32g', isValid: isSandboxSize },
]

export const DEFAULT_SUFFIX = ' (default)'

/** Settings-menu label for a LAN access value. */
export function formatLanAccess(allowLan: boolean): string {
  return allowLan ? 'allowed' : 'blocked'
}

/**
 * Prompts for one resource override. Returns the edited overrides (an empty entry removes the
 * override), or the unchanged ones when the prompt is dismissed or the value is invalid.
 */
export async function promptResourceOverride(
  host: ForgeTuiHost,
  resources: SandboxResources,
  defaultValue: string,
  field: ResourceField,
): Promise<SandboxResources> {
  const entered = await host.prompt({
    title: field.label,
    placeholder: `Leave empty for the default (${defaultValue}), e.g. ${field.example}`,
    value: resources[field.key] ?? '',
  })
  if (entered === undefined) return resources
  const trimmed = entered.trim().toLowerCase()
  if (trimmed && !field.isValid(trimmed)) {
    host.toast({ message: `Invalid ${field.label.toLowerCase()} "${trimmed}" (example: ${field.example})`, variant: 'error', duration: 4000 })
    return resources
  }
  const { [field.key]: _previous, ...rest } = resources
  return trimmed ? { ...rest, [field.key]: trimmed } : rest
}

function formatIterations(value: number | undefined): string {
  if (value === undefined) return 'server default'
  return value === 0 ? 'unlimited' : String(value)
}

function isSandboxOn(settings: LoopLaunchSettings, defaults: ForgeLoopDefaults | null): boolean {
  return defaults?.sandbox.available === true && settings.sandbox?.enabled !== false
}

function effectiveResources(settings: LoopLaunchSettings, defaults: ForgeLoopDefaults | null): Required<SandboxResources> {
  return resolveSandboxResources(defaults?.sandbox.resources, settings.sandbox?.resources)
}

function withSandbox(settings: LoopLaunchSettings, sandbox: LoopSandboxSettings): LoopLaunchSettings {
  const { sandbox: _previous, ...rest } = settings
  const normalized = readLoopSandboxSettings(sandbox)
  return normalized ? { ...rest, sandbox: normalized } : rest
}

/** One-line summary shown on the execution dialog's Loop settings row. */
export function formatLoopSettingsSummary(settings: LoopLaunchSettings, defaults: ForgeLoopDefaults | null): string {
  const iterations = settings.maxIterations ?? defaults?.maxIterations
  const parts = [iterations === undefined ? 'default iterations' : `${formatIterations(iterations)} iterations`]
  if (defaults?.sandbox.available) {
    if (isSandboxOn(settings, defaults)) {
      const resources = effectiveResources(settings, defaults)
      parts.push(`sandbox ${resources.cpus} CPU, ${resources.memory}${effectiveAllowLan(settings, defaults) ? ', LAN' : ''}`)
    } else {
      parts.push('sandbox off')
    }
  }
  return parts.join(' · ')
}

/**
 * The loop-launch request fields for the chosen settings. Sandbox overrides are sent only when the
 * server has a usable sandbox, and resources only while the sandbox is on for this loop.
 */
export function toLoopLaunchRequest(
  settings: LoopLaunchSettings,
  defaults: ForgeLoopDefaults | null,
): { maxIterations?: number; sandbox?: LoopSandboxSettings } {
  const sandbox = !defaults?.sandbox.available
    ? undefined
    : settings.sandbox?.enabled === false
      ? { enabled: false }
      : readLoopSandboxSettings({ resources: settings.sandbox?.resources, allowLan: settings.sandbox?.allowLan })
  return {
    ...(settings.maxIterations !== undefined ? { maxIterations: settings.maxIterations } : {}),
    ...(sandbox ? { sandbox } : {}),
  }
}

/** Options for the Loop settings submenu, reflecting the current overrides over the server defaults. */
export function buildLoopSettingsOptions(settings: LoopLaunchSettings, defaults: ForgeLoopDefaults | null): ForgeTuiSelectOption<string>[] {
  const options: ForgeTuiSelectOption<string>[] = [{
    title: `Max iterations: ${formatIterations(settings.maxIterations ?? defaults?.maxIterations)}${settings.maxIterations === undefined ? DEFAULT_SUFFIX : ''}`,
    value: 'maxIterations',
    description: 'Press enter to change; 0 runs until the plan completes',
  }]
  if (defaults?.sandbox.available) {
    const on = isSandboxOn(settings, defaults)
    options.push({
      title: `Sandbox: ${on ? 'on' : 'off'}`,
      value: 'sandbox',
      description: on ? 'Press enter to run this loop in the worktree without the sandbox' : 'Press enter to run this loop in the sandbox',
    })
    if (on) {
      const resources = effectiveResources(settings, defaults)
      for (const field of RESOURCE_FIELDS) {
        options.push({
          title: `${field.label}: ${resources[field.key]}${settings.sandbox?.resources?.[field.key] === undefined ? DEFAULT_SUFFIX : ''}`,
          value: `resource:${field.key}`,
          description: 'Press enter to change; applied when the loop sandbox is created',
        })
      }
      const allowLan = effectiveAllowLan(settings, defaults)
      options.push({
        title: `LAN access: ${formatLanAccess(allowLan)}${settings.sandbox?.allowLan === undefined ? DEFAULT_SUFFIX : ''}`,
        value: 'allowLan',
        description: allowLan
          ? 'Press enter to block this loop sandbox from private (LAN) addresses'
          : 'Press enter to let this loop sandbox reach private (LAN) addresses',
      })
    }
  }
  if (settings.maxIterations !== undefined || settings.sandbox) {
    options.push({ title: 'Reset to defaults', value: 'reset', description: 'Clear every loop setting override' })
  }
  options.push({ title: 'Done', value: 'done', description: 'Return to the execution dialog' })
  return options
}

async function promptMaxIterations(host: ForgeTuiHost, settings: LoopLaunchSettings): Promise<LoopLaunchSettings> {
  const entered = await host.prompt({
    title: 'Max iterations',
    placeholder: 'Leave empty for the server default; 0 is unlimited',
    value: settings.maxIterations === undefined ? '' : String(settings.maxIterations),
  })
  if (entered === undefined) return settings
  const trimmed = entered.trim()
  const { maxIterations: _previous, ...rest } = settings
  if (!trimmed) return rest
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    host.toast({ message: `Max iterations must be a whole number, got "${trimmed}"`, variant: 'error', duration: 4000 })
    return settings
  }
  return { ...rest, maxIterations: Number(trimmed) }
}

async function promptResource(
  host: ForgeTuiHost,
  settings: LoopLaunchSettings,
  defaults: ForgeLoopDefaults | null,
  field: ResourceField,
): Promise<LoopLaunchSettings> {
  const resources = await promptResourceOverride(host, settings.sandbox?.resources ?? {}, effectiveResources({}, defaults)[field.key], field)
  return withSandbox(settings, { ...settings.sandbox, resources })
}

function effectiveAllowLan(settings: LoopLaunchSettings, defaults: ForgeLoopDefaults | null): boolean {
  return resolveSandboxAllowLan(defaults?.sandbox.allowLan, settings.sandbox)
}

/** Flips LAN access, dropping the override when the new value is the config default. */
function toggleLoopAllowLan(settings: LoopLaunchSettings, defaults: ForgeLoopDefaults | null): LoopLaunchSettings {
  const next = !effectiveAllowLan(settings, defaults)
  const { allowLan: _previous, ...sandbox } = settings.sandbox ?? {}
  return withSandbox(settings, next === (defaults?.sandbox.allowLan ?? false) ? sandbox : { ...sandbox, allowLan: next })
}

async function applyLoopSettingsChoice(
  host: ForgeTuiHost,
  settings: LoopLaunchSettings,
  defaults: ForgeLoopDefaults | null,
  choice: string,
): Promise<LoopLaunchSettings> {
  if (choice === 'maxIterations') return promptMaxIterations(host, settings)
  if (choice === 'reset') return {}
  if (choice === 'allowLan') return toggleLoopAllowLan(settings, defaults)
  if (choice === 'sandbox') {
    const { enabled: _previous, ...sandbox } = settings.sandbox ?? {}
    return withSandbox(settings, isSandboxOn(settings, defaults) ? { ...sandbox, enabled: false } : sandbox)
  }
  const field = RESOURCE_FIELDS.find((candidate) => choice === `resource:${candidate.key}`)
  return field ? promptResource(host, settings, defaults, field) : settings
}

/**
 * Runs the Loop settings submenu until the user picks Done or dismisses it, returning the edited
 * overrides. Each edit reopens the submenu with the edited row selected.
 */
export async function editLoopSettings(
  host: ForgeTuiHost,
  initial: LoopLaunchSettings,
  defaults: ForgeLoopDefaults | null,
): Promise<LoopLaunchSettings> {
  let settings = initial
  let current: string | undefined
  for (;;) {
    const choice = await host.select({ title: 'Loop settings', options: buildLoopSettingsOptions(settings, defaults), current })
    if (choice === undefined || choice === 'done') return settings
    current = choice
    settings = await applyLoopSettingsChoice(host, settings, defaults, choice)
  }
}
