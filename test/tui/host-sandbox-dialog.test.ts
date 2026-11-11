import { describe, expect, test, vi } from 'vitest'
import type { ForgeLoopDefaults, ForgeSandboxEnv } from '../../src/host/forge-rpc'
import type { ForgeTuiHost, ForgeTuiSelectOption } from '../../src/tui/host'
import type { HostSandboxToggle } from '../../src/tui/host-sandbox'
import { buildHostSandboxOptions, editHostSandbox, editSandboxEnv } from '../../src/tui/host-sandbox-dialog'
import type { SessionSandboxPreference } from '../../src/tui/session-sandbox-store'
import type { SandboxOverrides } from '../../src/types'

const SESSION = 'ses_1'
const EMPTY_ENV: ForgeSandboxEnv = { values: {}, passthrough: [] }

const defaults: ForgeLoopDefaults = {
  maxIterations: 0,
  sandbox: { available: true, resources: { cpus: '4', memory: '8g', dockerDisk: '16g', cacheDisk: '16g' }, allowLan: false },
}

function preference(options: { running?: boolean; overrides?: SandboxOverrides } = {}): SessionSandboxPreference {
  const desired = {
    version: 1 as const,
    revision: 'rev-1',
    enabled: options.running === true,
    sessionId: SESSION,
    requestedAt: 1,
    ...(options.overrides ? { overrides: options.overrides } : {}),
  }
  return {
    desired,
    applied: { version: 1, revision: 'rev-1', enabled: options.running === true, sessionId: SESSION, error: null, appliedAt: 1 },
  }
}

function setup(
  pref: SessionSandboxPreference,
  selects: Array<string | undefined>,
  prompts: Array<string | undefined> = [],
  savedEnv: ForgeSandboxEnv | null = EMPTY_ENV,
) {
  const toasts: Array<{ message: string }> = []
  const select = vi.fn(async () => selects.shift())
  const host = {
    select,
    prompt: vi.fn(async () => prompts.shift()),
    toast: (input: { message: string }) => toasts.push(input),
  } as unknown as ForgeTuiHost
  const sandbox = {
    preference: () => pref,
    refresh: vi.fn(),
    toggle: vi.fn(async () => {}),
    applySettings: vi.fn(async () => {}),
    dispose: vi.fn(),
  } satisfies HostSandboxToggle
  const run = (sessionId: string | null = SESSION) => editHostSandbox({
    host,
    sandbox,
    currentSessionId: () => sessionId,
    loadDefaults: async () => defaults,
    loadEnv: async () => savedEnv,
  })
  return { host, select, sandbox, toasts, run }
}

function envHost(selects: Array<string | undefined>, prompts: Array<string | undefined> = []) {
  const toasts: Array<{ message: string }> = []
  const select = vi.fn(async () => selects.shift())
  const prompt = vi.fn(async () => prompts.shift())
  const host = {
    select,
    prompt,
    toast: (input: { message: string }) => toasts.push(input),
  } as unknown as ForgeTuiHost
  return { host, select, prompt, toasts }
}

function selectionOptions(select: ReturnType<typeof vi.fn>): ForgeTuiSelectOption<string>[] {
  const input = select.mock.calls[0]?.[0] as { options: ForgeTuiSelectOption<string>[] } | undefined
  return input?.options ?? []
}

describe('buildHostSandboxOptions', () => {
  test('shows the on/off row, CPUs, memory, and LAN access with their defaults', () => {
    const options = buildHostSandboxOptions(preference(), SESSION, undefined, defaults)

    expect(options.map((o) => o.value)).toEqual(['toggle', 'resource:cpus', 'resource:memory', 'allowLan', 'done'])
    expect(options.map((o) => o.title)).toEqual([
      'Sandbox: off',
      'CPUs: 4 (default)',
      'Memory: 8g (default)',
      'LAN access: blocked (default)',
      'Done',
    ])
  })

  test('offers Apply and Reset only for a changed draft, and warns what a running sandbox pays', () => {
    const options = buildHostSandboxOptions(preference({ running: true }), SESSION, { resources: { cpus: '6' } }, defaults)

    expect(options.map((o) => o.value)).toEqual(['toggle', 'resource:cpus', 'resource:memory', 'allowLan', 'reset', 'apply', 'done'])
    expect(options[0]?.title).toBe('Sandbox: on')
    expect(options[1]?.title).toBe('CPUs: 6')
    expect(options[1]?.description).toContain('restarts the sandbox')
    expect(options[3]?.description).toContain('recreates the sandbox')
    expect(options.at(-1)?.title).toBe('Discard changes')
  })

  test('shows the environment row after LAN access', () => {
    const options = buildHostSandboxOptions(preference(), SESSION, undefined, defaults, { draft: EMPTY_ENV, saved: EMPTY_ENV })

    expect(options.map((o) => o.value)).toEqual(['toggle', 'resource:cpus', 'resource:memory', 'allowLan', 'env', 'done'])
    expect(options[4]?.title).toBe('Environment: none')
    expect(options[4]?.description).toBe('Press enter to edit the variables this repository\'s sandboxes get')
  })

  test('counts literal and host variables, and an env-only change offers Apply', () => {
    const one = buildHostSandboxOptions(preference(), SESSION, undefined, defaults, {
      draft: { values: { NODE_ENV: 'test' }, passthrough: [] },
      saved: EMPTY_ENV,
    })
    expect(one[4]?.title).toBe('Environment: 1 variable')
    expect(one.map((o) => o.value)).toContain('apply')

    const three = buildHostSandboxOptions(preference(), SESSION, undefined, defaults, {
      draft: { values: { NODE_ENV: 'test', API_URL: 'http://localhost' }, passthrough: ['TOKEN'] },
      saved: EMPTY_ENV,
    })
    expect(three[4]?.title).toBe('Environment: 3 variables')
    expect(three.map((o) => o.value)).toEqual(['toggle', 'resource:cpus', 'resource:memory', 'allowLan', 'env', 'apply', 'done'])
  })

  test('an unchanged environment adds no Apply row', () => {
    const env = { values: { NODE_ENV: 'test' }, passthrough: ['TOKEN'] }
    const options = buildHostSandboxOptions(preference(), SESSION, undefined, defaults, { draft: env, saved: env })

    expect(options.map((o) => o.value)).not.toContain('apply')
  })
})

describe('editSandboxEnv', () => {
  test('lists literal variables and passthrough names, sorted, with the add and done rows', async () => {
    const { host, select } = envHost(['done'])

    const result = await editSandboxEnv(host, { values: { ZED: '1', ALPHA: '2' }, passthrough: ['BETA', 'ZULU'] })

    expect(selectionOptions(select).map((o) => o.title)).toEqual([
      'ALPHA=2',
      'ZED=1',
      'BETA (from the host)',
      'ZULU (from the host)',
      'Add variable',
      'Add host variable',
      'Done',
    ])
    expect(result).toEqual({ values: { ALPHA: '2', ZED: '1' }, passthrough: ['BETA', 'ZULU'] })
  })

  test('adds a literal variable exactly as typed', async () => {
    const { host, select } = envHost(['add', 'done'], ['NODE_ENV', ' test '])

    const result = await editSandboxEnv(host, EMPTY_ENV)

    expect(select.mock.calls[1]?.[0]).toMatchObject({ current: 'add' })
    expect(result).toEqual({ values: { NODE_ENV: ' test ' }, passthrough: [] })
  })

  test('adds a host variable and removes a literal of the same name', async () => {
    const { host } = envHost(['addHost', 'done'], ['TOKEN'])

    const result = await editSandboxEnv(host, { values: { TOKEN: 'literal' }, passthrough: [] })

    expect(result).toEqual({ values: {}, passthrough: ['TOKEN'] })
  })

  test('an invalid name toasts and changes nothing', async () => {
    const { host, toasts } = envHost(['add', 'done'], ['BAD-NAME'])

    const result = await editSandboxEnv(host, EMPTY_ENV)

    expect(toasts).toEqual([{ message: 'Invalid variable name "BAD-NAME"', variant: 'error', duration: 4000 }])
    expect(result).toEqual({ values: {}, passthrough: [] })
  })

  test('edits an existing value', async () => {
    const { host } = envHost(['value:FOO', 'done'], ['next'])

    const result = await editSandboxEnv(host, { values: { FOO: 'old' }, passthrough: [] })

    expect(result).toEqual({ values: { FOO: 'next' }, passthrough: [] })
  })

  test('an empty value removes the variable', async () => {
    const { host } = envHost(['value:FOO', 'done'], [''])

    const result = await editSandboxEnv(host, { values: { FOO: 'old' }, passthrough: [] })

    expect(result).toEqual({ values: {}, passthrough: [] })
  })

  test('selecting a host variable removes it', async () => {
    const { host } = envHost(['host:TOKEN', 'done'])

    const result = await editSandboxEnv(host, { values: {}, passthrough: ['TOKEN'] })

    expect(result).toEqual({ values: {}, passthrough: [] })
  })

  test('adding a literal that is a host variable moves it out of passthrough', async () => {
    const { host } = envHost(['add', 'done'], ['TOKEN', 'value'])

    const result = await editSandboxEnv(host, { values: {}, passthrough: ['TOKEN'] })

    expect(result).toEqual({ values: { TOKEN: 'value' }, passthrough: [] })
  })

  test('does not mutate the input object', async () => {
    const input: ForgeSandboxEnv = { values: { A: '1' }, passthrough: ['B'] }
    const { host } = envHost(['value:A', 'host:B', 'done'], ['2'])

    const result = await editSandboxEnv(host, input)

    expect(input).toEqual({ values: { A: '1' }, passthrough: ['B'] })
    expect(result).toEqual({ values: { A: '2' }, passthrough: [] })
  })

  test('dismissing the menu returns the current draft and keeps the cursor', async () => {
    const { host, select } = envHost(['value:FOO', undefined], ['next'])

    const result = await editSandboxEnv(host, { values: { FOO: 'old' }, passthrough: [] })

    expect(select.mock.calls[1]?.[0]).toMatchObject({ current: 'value:FOO' })
    expect(result).toEqual({ values: { FOO: 'next' }, passthrough: [] })
  })
})

describe('editHostSandbox', () => {
  test('several settings edits and the toggle go out as one request', async () => {
    const { sandbox, run } = setup(preference(), ['resource:cpus', 'resource:memory', 'toggle'], ['6', '12G'])

    await run()

    expect(sandbox.toggle).toHaveBeenCalledTimes(1)
    expect(sandbox.toggle).toHaveBeenCalledWith({ overrides: { resources: { cpus: '6', memory: '12g' } } })
    expect(sandbox.applySettings).not.toHaveBeenCalled()
  })

  test('a plain toggle sends no overrides', async () => {
    const { sandbox, run } = setup(preference({ overrides: { allowLan: true } }), ['toggle'])

    await run()

    expect(sandbox.toggle).toHaveBeenCalledWith(undefined)
  })

  test('applying a resource change to a running sandbox needs no confirmation', async () => {
    const { host, sandbox, run } = setup(preference({ running: true }), ['resource:memory', 'apply'], ['16g'])

    await run()

    expect(sandbox.applySettings).toHaveBeenCalledWith({ overrides: { resources: { memory: '16g' } } })
    expect(host.select).toHaveBeenCalledTimes(2)
  })

  test('a LAN change on a running sandbox asks before recreating it', async () => {
    const cancelled = setup(preference({ running: true }), ['allowLan', 'apply', 'cancel', 'done'])
    await cancelled.run()
    expect(cancelled.sandbox.applySettings).not.toHaveBeenCalled()

    const confirmed = setup(preference({ running: true }), ['allowLan', 'apply', 'recreate'])
    await confirmed.run()
    expect(confirmed.sandbox.applySettings).toHaveBeenCalledWith({ overrides: { allowLan: true } })
  })

  test('a LAN change on a stopped sandbox is saved without confirmation', async () => {
    const { host, sandbox, run } = setup(preference(), ['allowLan', 'apply'])

    await run()

    expect(sandbox.applySettings).toHaveBeenCalledWith({ overrides: { allowLan: true } })
    expect(host.select).toHaveBeenCalledTimes(2)
  })

  test('reset sends an empty override set, and dismissing discards the draft', async () => {
    const reset = setup(preference({ overrides: { resources: { cpus: '6' } } }), ['reset', 'apply'])
    await reset.run()
    expect(reset.sandbox.applySettings).toHaveBeenCalledWith({ overrides: {} })

    const dismissed = setup(preference(), ['resource:cpus', undefined], ['6'])
    await dismissed.run()
    expect(dismissed.sandbox.applySettings).not.toHaveBeenCalled()
    expect(dismissed.sandbox.toggle).not.toHaveBeenCalled()
  })

  test('editing the environment then applying sends only env', async () => {
    const { sandbox, run } = setup(preference(), ['env', 'add', 'done', 'apply'], ['NODE_ENV', 'test'])

    await run()

    expect(sandbox.applySettings).toHaveBeenCalledWith({ env: { values: { NODE_ENV: 'test' }, passthrough: [] } })
  })

  test('editing the environment then toggling sends enabled with env', async () => {
    const { sandbox, run } = setup(preference(), ['env', 'addHost', 'done', 'toggle'], ['TOKEN'])

    await run()

    expect(sandbox.toggle).toHaveBeenCalledWith({ env: { values: {}, passthrough: ['TOKEN'] } })
  })

  test('an overrides and environment change sends both in one request', async () => {
    const { sandbox, run } = setup(preference(), ['resource:cpus', 'env', 'add', 'done', 'apply'], ['6', 'NODE_ENV', 'test'])

    await run()

    expect(sandbox.applySettings).toHaveBeenCalledWith({
      overrides: { resources: { cpus: '6' } },
      env: { values: { NODE_ENV: 'test' }, passthrough: [] },
    })
  })

  test('an unreadable environment hides the row and toggles without settings', async () => {
    const { select, sandbox, run } = setup(preference(), ['toggle'], [], null)

    await run()

    expect(selectionOptions(select).map((o) => o.value)).not.toContain('env')
    expect(sandbox.toggle).toHaveBeenCalledWith(undefined)
  })

  test('asks for a session when none is open', async () => {
    const { host, toasts, run } = setup(preference(), [])

    await run(null)

    expect(toasts).toEqual([{ message: 'Open a session first', variant: 'info', duration: 3000 }])
    expect(host.select).not.toHaveBeenCalled()
  })
})
