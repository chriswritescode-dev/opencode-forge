import { describe, expect, test, vi } from 'vitest'
import type { ForgeLoopDefaults } from '../../src/host/forge-rpc'
import type { ForgeTuiHost } from '../../src/tui/host'
import {
  buildLoopSettingsOptions,
  editLoopSettings,
  formatLoopSettingsSummary,
  toLoopLaunchRequest,
} from '../../src/tui/loop-settings-dialog'

const defaults: ForgeLoopDefaults = {
  maxIterations: 50,
  sandbox: { available: true, resources: { cpus: '4', memory: '8g', dockerDisk: '16g', cacheDisk: '16g' } },
}

const noSandbox: ForgeLoopDefaults = { ...defaults, sandbox: { ...defaults.sandbox, available: false } }

function scriptedHost(selects: Array<string | undefined>, prompts: Array<string | undefined> = []) {
  const toasts: Array<{ message: string }> = []
  const host = {
    select: vi.fn(async () => selects.shift()),
    prompt: vi.fn(async () => prompts.shift()),
    toast: (input: { message: string }) => toasts.push(input),
  } as unknown as ForgeTuiHost
  return { host, toasts }
}

describe('formatLoopSettingsSummary', () => {
  test('shows server defaults when nothing is overridden', () => {
    expect(formatLoopSettingsSummary({}, defaults)).toBe('50 iterations · sandbox 4 CPU, 8g')
  })

  test('shows overrides, unlimited iterations, and an opted-out sandbox', () => {
    expect(formatLoopSettingsSummary({ maxIterations: 0, sandbox: { enabled: false } }, defaults)).toBe('unlimited iterations · sandbox off')
    expect(formatLoopSettingsSummary({ sandbox: { resources: { cpus: '8', memory: '32g' } } }, defaults)).toBe('50 iterations · sandbox 8 CPU, 32g')
  })

  test('omits the sandbox when the server has none and tolerates missing defaults', () => {
    expect(formatLoopSettingsSummary({ maxIterations: 5 }, noSandbox)).toBe('5 iterations')
    expect(formatLoopSettingsSummary({}, null)).toBe('default iterations')
  })
})

describe('toLoopLaunchRequest', () => {
  test('sends nothing without overrides', () => {
    expect(toLoopLaunchRequest({}, defaults)).toEqual({})
  })

  test('sends only the opt-out when the sandbox is off, dropping stale resources', () => {
    expect(toLoopLaunchRequest({ sandbox: { enabled: false, resources: { cpus: '8' } } }, defaults)).toEqual({ sandbox: { enabled: false } })
  })

  test('sends resource overrides and iterations', () => {
    expect(toLoopLaunchRequest({ maxIterations: 3, sandbox: { resources: { memory: '16g' } } }, defaults))
      .toEqual({ maxIterations: 3, sandbox: { resources: { memory: '16g' } } })
  })

  test('never sends sandbox settings when the server has no usable sandbox', () => {
    expect(toLoopLaunchRequest({ sandbox: { enabled: false } }, noSandbox)).toEqual({})
    expect(toLoopLaunchRequest({ sandbox: { enabled: false } }, null)).toEqual({})
  })
})

describe('buildLoopSettingsOptions', () => {
  test('lists resource rows only while the sandbox is on', () => {
    expect(buildLoopSettingsOptions({}, defaults).map((o) => o.value))
      .toEqual(['maxIterations', 'sandbox', 'resource:cpus', 'resource:memory', 'resource:dockerDisk', 'resource:cacheDisk', 'done'])
    expect(buildLoopSettingsOptions({ sandbox: { enabled: false } }, defaults).map((o) => o.value))
      .toEqual(['maxIterations', 'sandbox', 'reset', 'done'])
    expect(buildLoopSettingsOptions({}, noSandbox).map((o) => o.value)).toEqual(['maxIterations', 'done'])
  })

  test('marks values that come from the defaults', () => {
    const titles = buildLoopSettingsOptions({ sandbox: { resources: { cpus: '8' } } }, defaults).map((o) => o.title)
    expect(titles).toContain('CPUs: 8')
    expect(titles).toContain('Memory: 8g (default)')
    expect(titles).toContain('Max iterations: 50 (default)')
  })
})

describe('editLoopSettings', () => {
  test('edits iterations, resources, and the sandbox toggle until Done', async () => {
    const { host } = scriptedHost(
      ['maxIterations', 'resource:cpus', 'resource:memory', 'sandbox', 'sandbox', 'done'],
      ['12', '8', '16GB'],
    )

    const result = await editLoopSettings(host, {}, defaults)

    expect(result).toEqual({ maxIterations: 12, sandbox: { resources: { cpus: '8', memory: '16gb' } } })
  })

  test('rejects invalid input with a toast and keeps the previous value', async () => {
    const { host, toasts } = scriptedHost(['maxIterations', 'resource:cpus', 'resource:memory', undefined], ['-1', '2.5', 'lots'])

    const result = await editLoopSettings(host, { maxIterations: 4 }, defaults)

    expect(result).toEqual({ maxIterations: 4 })
    expect(toasts).toHaveLength(3)
  })

  test('an empty entry clears the override and reset clears everything', async () => {
    const cleared = await editLoopSettings(scriptedHost(['maxIterations', 'resource:cpus', 'done'], ['', '']).host, { maxIterations: 9, sandbox: { resources: { cpus: '8' } } }, defaults)
    expect(cleared).toEqual({})

    const reset = await editLoopSettings(scriptedHost(['reset', 'done']).host, { maxIterations: 9, sandbox: { enabled: false } }, defaults)
    expect(reset).toEqual({})
  })

  test('a cancelled prompt leaves the settings unchanged', async () => {
    const { host } = scriptedHost(['resource:memory', 'done'], [undefined])
    expect(await editLoopSettings(host, { sandbox: { resources: { memory: '4g' } } }, defaults)).toEqual({ sandbox: { resources: { memory: '4g' } } })
  })
})
