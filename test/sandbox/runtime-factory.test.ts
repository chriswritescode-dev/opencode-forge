import { describe, test, expect, vi } from 'vitest'
import { createSandboxRuntime, resolveSandboxMode } from '../../src/sandbox/runtime-factory'
import type { PluginConfig, Logger } from '../../src/types'
import type { CommandRunner } from '../../src/sandbox/sbx'
import { createRecordingRunner } from '../helpers/sandbox-mocks'

const logger: Logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

describe('resolveSandboxMode', () => {
  test('undefined config defaults to sbx', () => {
    expect(resolveSandboxMode(undefined)).toBe('sbx')
  })

  test('config without sandbox section defaults to sbx', () => {
    expect(resolveSandboxMode({})).toBe('sbx')
  })

  test('explicit sbx mode resolves to sbx', () => {
    expect(resolveSandboxMode({ sandbox: { mode: 'sbx' } })).toBe('sbx')
  })

  test('explicit smolvm mode resolves to smolvm', () => {
    expect(resolveSandboxMode({ sandbox: { mode: 'smolvm' } })).toBe('smolvm')
  })

  test('unknown or legacy mode values fall back to sbx', () => {
    expect(resolveSandboxMode({ sandbox: { mode: 'docker' as never } })).toBe('sbx')
    expect(resolveSandboxMode({ sandbox: { mode: 'podman' as never } })).toBe('sbx')
  })

  test('accepts a full PluginConfig shape', () => {
    const config: PluginConfig = { sandbox: { mode: 'smolvm', enabled: true } }
    expect(resolveSandboxMode(config)).toBe('smolvm')
  })
})

describe('createSandboxRuntime', () => {
  test('sbx mode dispatches to the sbx runtime (templateLoadHint)', () => {
    const rt = createSandboxRuntime('sbx', logger)
    expect(rt.templateLoadHint('oc-forge-sandbox:latest')).toBe('sbx template load <tar>')
  })

  test('sbx mode describeUnavailable carries the sbx remediation string', () => {
    const rt = createSandboxRuntime('sbx', logger)
    expect(rt.describeUnavailable({ available: false, reason: 'not-installed' })).toMatch(/sbx login/)
  })

  test('sbx mode checkAvailable runs the sbx probe argv', async () => {
    const { calls, runner } = createRecordingRunner(() => ({ stdout: 'Status: running\n', stderr: '', exitCode: 0 }))
    const rt = createSandboxRuntime('sbx', logger, { run: runner })
    await rt.checkAvailable()
    expect(calls[0].args).toEqual(['daemon', 'status'])
  })

  test('smolvm mode dispatches to the smolvm runtime (templateLoadHint mentions the store path)', () => {
    const rt = createSandboxRuntime('smolvm', logger, { dataDir: '/forge-data' })
    expect(rt.templateLoadHint('oc-forge-sandbox:latest')).toBe(
      'cp <tar> "/forge-data/smolvm-images/oc-forge-sandbox-latest.tar"',
    )
  })

  test('smolvm mode without dataDir degrades the load hint instead of throwing', () => {
    const rt = createSandboxRuntime('smolvm', logger)
    expect(rt.templateLoadHint('oc-forge-sandbox:latest')).toBe('cp <tar> <forge-data-dir>/smolvm-images/')
  })

  test('smolvm mode describeUnavailable carries the smolvm remediation string', () => {
    const rt = createSandboxRuntime('smolvm', logger)
    expect(rt.describeUnavailable({ available: false, reason: 'not-installed' })).toMatch(/smolmachines\.com/)
  })

  test('smolvm mode checkAvailable runs the smolvm probe argv', async () => {
    const { calls, runner } = createRecordingRunner(() => ({ stdout: 'smolvm 0.1.0\n', stderr: '', exitCode: 0 }))
    const rt = createSandboxRuntime('smolvm', logger, { run: runner })
    await rt.checkAvailable()
    expect(calls[0].args).toEqual(['--version'])
  })
})
