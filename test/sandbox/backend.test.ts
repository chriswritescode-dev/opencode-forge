import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSandboxBackend, resolveSandboxMode, type CreateSandboxBackendInput } from '../../src/sandbox/backend'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createMockLogger } from '../helpers/logger'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  let dir = tempDirs.pop()
  while (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = tempDirs.pop()
  }
})

function makeInput(overrides: Partial<CreateSandboxBackendInput> = {}): CreateSandboxBackendInput {
  return {
    config: {},
    dataDir: makeTempDir('forge-backend-data-'),
    projectId: 'project-1',
    projectRoot: makeTempDir('forge-backend-root-'),
    logger: createMockLogger(),
    forgeClient: createFakeForgeClient().client,
    loopsRepo: { get: () => null },
    sandboxPreferences: { getDesired: () => null },
    ...overrides,
  }
}

const lumeFetch: typeof globalThis.fetch = async () =>
  new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('resolveSandboxMode', () => {
  test('defaults to msb', () => {
    expect(resolveSandboxMode({})).toBe('msb')
  })

  test('treats an unknown mode as msb', () => {
    expect(resolveSandboxMode({ sandbox: { mode: 'sbx' } } as unknown as PluginConfig)).toBe('msb')
  })

  test('returns macos for macos mode', () => {
    expect(resolveSandboxMode({ sandbox: { mode: 'macos' } })).toBe('macos')
  })
})

describe('createSandboxBackend', () => {
  test('builds the msb backend by default', () => {
    const backend = createSandboxBackend(makeInput())
    expect(backend.runtime.kind).toBe('msb')
    expect(backend.manager).not.toBeNull()
    expect(backend.manager?.runtime.kind).toBe('msb')
  })

  test('returns a runtime without a manager when the sandbox is disabled', () => {
    const backend = createSandboxBackend(makeInput({ config: { sandbox: { enabled: false } } }))
    expect(backend.runtime.kind).toBe('msb')
    expect(backend.manager).toBeNull()
  })

  test('builds the macos backend on a darwin host', () => {
    const backend = createSandboxBackend(makeInput({
      config: { sandbox: { mode: 'macos', macos: { roots: [makeTempDir('forge-backend-share-')] } } },
      platform: 'darwin',
      lumeFetch,
    }))
    expect(backend.runtime.kind).toBe('macos')
    expect(backend.manager).not.toBeNull()
    expect(backend.manager?.runtime.kind).toBe('macos')
  })

  test('refuses macos mode off a darwin host', () => {
    expect(() => createSandboxBackend(makeInput({
      config: { sandbox: { mode: 'macos', macos: { roots: [makeTempDir('forge-backend-share-')] } } },
      platform: 'linux',
      lumeFetch,
    }))).toThrow(/requires a macOS host/)
  })

  test('refuses macos mode without roots', () => {
    expect(() => createSandboxBackend(makeInput({
      config: { sandbox: { mode: 'macos', macos: { roots: [] } } },
      platform: 'darwin',
      lumeFetch,
    }))).toThrow(/at least one entry in sandbox\.macos\.roots/)
  })
})
