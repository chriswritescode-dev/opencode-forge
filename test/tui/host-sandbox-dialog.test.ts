import { describe, expect, test, vi } from 'vitest'
import type { ForgeLoopDefaults } from '../../src/host/forge-rpc'
import type { ForgeTuiHost } from '../../src/tui/host'
import type { HostSandboxToggle } from '../../src/tui/host-sandbox'
import { buildHostSandboxSettingsOptions, editHostSandboxSettings } from '../../src/tui/host-sandbox-dialog'
import type { SessionSandboxPreference } from '../../src/tui/session-sandbox-store'
import type { SandboxOverrides } from '../../src/types'

const SESSION = 'ses_1'

const defaults: ForgeLoopDefaults = {
  maxIterations: 0,
  sandbox: { available: true, resources: { cpus: '4', memory: '8g', dockerDisk: '16g', cacheDisk: '16g' }, allowLan: false },
}

function preference(options: { running?: boolean; overrides?: SandboxOverrides } = {}): SessionSandboxPreference {
  const desired = {
    version: 2 as const,
    revision: 'rev-1',
    sessions: {},
    requestedAt: 1,
    ...(options.overrides ? { overrides: options.overrides } : {}),
  }
  return {
    desired,
    applied: { version: 2, revision: 'rev-1', running: options.running === true, error: null, appliedAt: 1 },
    hostSessionsDefault: true,
  }
}

function setup(pref: SessionSandboxPreference | null, selects: Array<string | undefined>, prompts: Array<string | undefined> = []) {
  const toasts: Array<{ message: string; variant?: string }> = []
  const host = {
    select: vi.fn(async () => selects.shift()),
    prompt: vi.fn(async () => prompts.shift()),
    toast: (input: { message: string; variant?: string }) => toasts.push(input),
  } as unknown as ForgeTuiHost
  const sandbox = {
    preference: () => pref,
    refresh: vi.fn(),
    toggle: vi.fn(async () => {}),
    setOverrides: vi.fn(async () => {}),
    dispose: vi.fn(),
  } satisfies HostSandboxToggle
  const run = (sessionId: string | null = SESSION) => editHostSandboxSettings({
    host,
    sandbox,
    currentSessionId: () => sessionId,
    loadDefaults: async () => defaults,
  })
  return { host, sandbox, toasts, run }
}

describe('buildHostSandboxSettingsOptions', () => {
  test('shows CPUs, memory, and LAN access with their defaults and no toggle row', () => {
    const options = buildHostSandboxSettingsOptions(preference(), undefined, defaults)

    expect(options.map((o) => o.value)).toEqual(['resource:cpus', 'resource:memory', 'allowLan', 'done'])
    expect(options.map((o) => o.title)).toEqual([
      'CPUs: 4 (default)',
      'Memory: 8g (default)',
      'LAN access: blocked (default)',
      'Done',
    ])
  })

  test('offers Apply and Reset only for a changed draft, and warns what a running sandbox pays', () => {
    const options = buildHostSandboxSettingsOptions(preference({ running: true }), { resources: { cpus: '6' } }, defaults)

    expect(options.map((o) => o.value)).toEqual(['resource:cpus', 'resource:memory', 'allowLan', 'reset', 'apply', 'done'])
    expect(options[0]?.title).toBe('CPUs: 6')
    expect(options[0]?.description).toContain('restarts the shared sandbox for every session in this project')
    expect(options[2]?.description).toContain('recreates the shared sandbox for every session in this project')
    expect(options.at(-1)?.title).toBe('Discard changes')
  })

  test('describes stopped-sandbox changes as applying at the next start', () => {
    const options = buildHostSandboxSettingsOptions(preference(), { resources: { cpus: '6' } }, defaults)

    expect(options[0]?.description).toBe('Press enter to change; applied when the shared sandbox next starts')
    expect(options.at(-2)?.title).toBe('Apply settings')
  })
})

describe('editHostSandboxSettings', () => {
  test('several settings edits go out as one request', async () => {
    const { sandbox, run } = setup(preference(), ['resource:cpus', 'resource:memory', 'apply'], ['6', '12G'])

    await run()

    expect(sandbox.setOverrides).toHaveBeenCalledTimes(1)
    expect(sandbox.setOverrides).toHaveBeenCalledWith({ resources: { cpus: '6', memory: '12g' } })
    expect(sandbox.toggle).not.toHaveBeenCalled()
  })

  test('applying a resource change to a running sandbox needs no confirmation', async () => {
    const { host, sandbox, run } = setup(preference({ running: true }), ['resource:memory', 'apply'], ['16g'])

    await run()

    expect(sandbox.setOverrides).toHaveBeenCalledWith({ resources: { memory: '16g' } })
    expect(host.select).toHaveBeenCalledTimes(2)
  })

  test('a LAN change on a running sandbox asks before recreating it', async () => {
    const cancelled = setup(preference({ running: true }), ['allowLan', 'apply', 'cancel', 'done'])
    await cancelled.run()
    expect(cancelled.sandbox.setOverrides).not.toHaveBeenCalled()

    const confirmed = setup(preference({ running: true }), ['allowLan', 'apply', 'recreate'])
    await confirmed.run()
    expect(confirmed.sandbox.setOverrides).toHaveBeenCalledWith({ allowLan: true })
  })

  test('a LAN change on a stopped sandbox is saved without confirmation', async () => {
    const { host, sandbox, run } = setup(preference(), ['allowLan', 'apply'])

    await run()

    expect(sandbox.setOverrides).toHaveBeenCalledWith({ allowLan: true })
    expect(host.select).toHaveBeenCalledTimes(2)
  })

  test('reset sends an empty override set, and dismissing discards the draft', async () => {
    const reset = setup(preference({ overrides: { resources: { cpus: '6' } } }), ['reset', 'apply'])
    await reset.run()
    expect(reset.sandbox.setOverrides).toHaveBeenCalledWith({})

    const dismissed = setup(preference(), ['resource:cpus', undefined], ['6'])
    await dismissed.run()
    expect(dismissed.sandbox.setOverrides).not.toHaveBeenCalled()
  })

  test('warns with the unavailable reason instead of toggling', async () => {
    const { host, toasts, sandbox, run } = setup({
      desired: null,
      applied: null,
      hostSessionsDefault: true,
      unavailable: true,
      unavailableReason: 'rpc.unavailable',
    }, [])

    await run()

    expect(toasts).toEqual([{ message: 'Sandbox settings unavailable: rpc.unavailable', variant: 'warning', duration: 5000 }])
    expect(host.select).not.toHaveBeenCalled()
    expect(sandbox.toggle).not.toHaveBeenCalled()
  })

  test('warns that the sandbox is unavailable when no preference is loaded', async () => {
    const { toasts, run } = setup(null, [])

    await run()

    expect(toasts).toEqual([{ message: 'Sandbox is unavailable', variant: 'warning', duration: 5000 }])
  })

  test('asks for a session when none is open', async () => {
    const { host, toasts, run } = setup(preference(), [])

    await run(null)

    expect(toasts).toEqual([{ message: 'Open a session first', variant: 'info', duration: 3000 }])
    expect(host.select).not.toHaveBeenCalled()
  })
})
