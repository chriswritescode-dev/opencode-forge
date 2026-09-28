import type { ForgeLoopDefaults } from '../host/forge-rpc'
import type { SandboxOverrides } from '../types'
import { readSandboxOverrides, resolveSandboxAllowLan, resolveSandboxResources } from '../sandbox/loop-settings'
import type { ForgeTuiHost, ForgeTuiSelectOption } from './host'
import type { HostSandboxToggle } from './host-sandbox'
import { DEFAULT_SUFFIX, RESOURCE_FIELDS, formatLanAccess, promptResourceOverride } from './loop-settings-dialog'
import { deriveSessionSandboxAcknowledged, deriveSessionSandboxDisplayStatus, type SessionSandboxPreference } from './session-sandbox-store'

/** The host sandbox exposes only the settings msb can change on an existing sandbox. */
const HOST_RESOURCE_FIELDS = RESOURCE_FIELDS.filter((field) => field.key === 'cpus' || field.key === 'memory')

const STATUS_LABELS = { enabled: 'on', disabled: 'off', loading: 'starting', failed: 'failed' } as const

export interface HostSandboxDialogDeps {
  host: ForgeTuiHost
  sandbox: HostSandboxToggle
  currentSessionId(): string | null
  /** Server defaults for the settings rows; null shows the rows without default values. */
  loadDefaults(): Promise<ForgeLoopDefaults | null>
}

function overridesEqual(a: SandboxOverrides | undefined, b: SandboxOverrides | undefined): boolean {
  return JSON.stringify(readSandboxOverrides(a) ?? {}) === JSON.stringify(readSandboxOverrides(b) ?? {})
}

function effectiveAllowLan(overrides: SandboxOverrides | undefined, defaults: ForgeLoopDefaults | null): boolean {
  return resolveSandboxAllowLan(defaults?.sandbox.allowLan, overrides)
}

/** Whether the project's host sandbox is currently running for some session. */
function isHostSandboxRunning(preference: SessionSandboxPreference): boolean {
  return deriveSessionSandboxAcknowledged(preference) !== null
}

/** Options for the host sandbox menu: the session's on/off row, then the drafted settings. */
export function buildHostSandboxOptions(
  preference: SessionSandboxPreference,
  sessionId: string,
  draft: SandboxOverrides | undefined,
  defaults: ForgeLoopDefaults | null,
): ForgeTuiSelectOption<string>[] {
  const status = deriveSessionSandboxDisplayStatus(preference, sessionId)
  const on = status === 'enabled' || status === 'loading'
  const running = isHostSandboxRunning(preference)
  const saved = preference.desired?.overrides
  const changed = !overridesEqual(draft, saved)
  const options: ForgeTuiSelectOption<string>[] = [{
    title: `Sandbox: ${STATUS_LABELS[status]}`,
    value: 'toggle',
    description: on
      ? 'Press enter to run this session\'s agent shell, glob, and grep calls back on the host'
      : `Press enter to run this session's agent shell, glob, and grep calls in the sandbox${changed ? ' with the settings below' : ''}`,
  }]
  const resources = resolveSandboxResources(defaults?.sandbox.resources, draft?.resources)
  for (const field of HOST_RESOURCE_FIELDS) {
    options.push({
      title: `${field.label}: ${resources[field.key]}${draft?.resources?.[field.key] === undefined ? DEFAULT_SUFFIX : ''}`,
      value: `resource:${field.key}`,
      description: running
        ? 'Press enter to change; applying restarts the sandbox (files kept, running processes stop)'
        : 'Press enter to change; applied when the sandbox is turned on',
    })
  }
  options.push({
    title: `LAN access: ${formatLanAccess(effectiveAllowLan(draft, defaults))}${draft?.allowLan === undefined ? DEFAULT_SUFFIX : ''}`,
    value: 'allowLan',
    description: running
      ? 'Press enter to change; applying recreates the sandbox (in-sandbox state is lost)'
      : 'Press enter to change whether the sandbox can reach private (LAN) addresses',
  })
  if (readSandboxOverrides(draft)) {
    options.push({ title: 'Reset to defaults', value: 'reset', description: 'Clear every host sandbox setting override' })
  }
  if (changed) {
    options.push({
      title: 'Apply settings',
      value: 'apply',
      description: running ? 'Apply the changed settings to the running sandbox now' : 'Save the changed settings for the next time the sandbox is turned on',
    })
  }
  options.push({ title: changed ? 'Discard changes' : 'Done', value: 'done', description: 'Close without sending anything' })
  return options
}

/**
 * Asks before a change that recreates the running sandbox: msb fixes network policy at create
 * time, so a LAN access change on an existing sandbox loses everything outside the mounts.
 */
async function confirmRecreate(
  host: ForgeTuiHost,
  preference: SessionSandboxPreference,
  draft: SandboxOverrides | undefined,
  defaults: ForgeLoopDefaults | null,
): Promise<boolean> {
  if (!isHostSandboxRunning(preference)) return true
  if (effectiveAllowLan(draft, defaults) === effectiveAllowLan(preference.desired?.overrides, defaults)) return true
  const choice = await host.select({
    title: 'Recreate the host sandbox?',
    options: [
      { title: 'Recreate', value: 'recreate', description: 'LAN access can only change on a new sandbox: installed packages, Docker data, caches, and running processes are lost' },
      { title: 'Cancel', value: 'cancel', description: 'Keep the running sandbox unchanged' },
    ],
  })
  return choice === 'recreate'
}

/**
 * Runs the host sandbox menu for the current session. Settings edits stay in a draft until the
 * user turns the sandbox on or off (which sends them along) or applies them, so several edits
 * cost one restart rather than one each.
 */
export async function editHostSandbox(deps: HostSandboxDialogDeps): Promise<void> {
  const { host, sandbox } = deps
  const sessionId = deps.currentSessionId()
  if (!sessionId) {
    host.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
    return
  }
  const defaults = await deps.loadDefaults()
  let draft = sandbox.preference()?.desired?.overrides
  let current: string | undefined
  for (;;) {
    const preference = sandbox.preference()
    if (!preference || preference.unavailable) {
      await sandbox.toggle()
      return
    }
    const choice = await host.select({
      title: 'Host sandbox',
      options: buildHostSandboxOptions(preference, sessionId, draft, defaults),
      current,
    })
    if (choice === undefined || choice === 'done') return
    current = choice
    if (choice === 'toggle' || choice === 'apply') {
      const changed = !overridesEqual(draft, preference.desired?.overrides)
      if (changed && !(await confirmRecreate(host, preference, draft, defaults))) continue
      const overrides = changed ? (readSandboxOverrides(draft) ?? {}) : undefined
      if (choice === 'toggle') await sandbox.toggle(overrides)
      else if (overrides) await sandbox.setOverrides(overrides)
      return
    }
    if (choice === 'reset') {
      draft = undefined
      continue
    }
    if (choice === 'allowLan') {
      const next = !effectiveAllowLan(draft, defaults)
      const { allowLan: _previous, ...rest } = draft ?? {}
      draft = readSandboxOverrides(next === (defaults?.sandbox.allowLan ?? false) ? rest : { ...rest, allowLan: next })
      continue
    }
    const field = HOST_RESOURCE_FIELDS.find((candidate) => choice === `resource:${candidate.key}`)
    if (field) {
      const defaultValue = resolveSandboxResources(defaults?.sandbox.resources)[field.key]
      const resources = await promptResourceOverride(host, draft?.resources ?? {}, defaultValue, field)
      draft = readSandboxOverrides({ ...draft, resources })
    }
  }
}
