import { vi } from 'vitest'
import type { SandboxWorkspace, SandboxRuntime, SandboxState } from '../../src/sandbox/msb'
import type { SandboxResources, SandboxSecretConfig } from '../../src/types'

/**
 * Mock SandboxRuntime plus the test helpers used by the manager suites. Extending
 * `SandboxRuntime` keeps the object statically checked against the real runtime interface
 * while exposing recording/control methods that the production type does not have.
 */
export interface MockSandboxRuntime extends SandboxRuntime {
  getCreateSandboxCalls(): Array<
    [
      string,
      SandboxWorkspace[],
      { image?: string; resources?: SandboxResources; networkAllow?: string[]; env?: string[]; secrets?: SandboxSecretConfig[] } | undefined,
    ]
  >
  getRefreshSecretCalls(): Array<[string, SandboxSecretConfig[]]>
  getRemoveSandboxCalls(): string[]
  setSandboxes(newSandboxes: string[]): void
  setRunning(name: string, running: boolean): void
  setSandboxState(name: string, state: SandboxState): void
  setAvailable(available: boolean): void
  setTemplateExists(exists: boolean): void
  setRemoveThrow(shouldThrow: boolean): void
}

/**
 * Creates a mock SandboxRuntime for sandbox tests.
 * Tracks createSandbox/removeSandbox calls and maintains a running-sandboxes set.
 */
export function createMockSandboxRuntime(): MockSandboxRuntime {
  const createSandboxCalls: Array<
    [
      string,
      SandboxWorkspace[],
      { image?: string; resources?: SandboxResources; networkAllow?: string[]; env?: string[]; secrets?: SandboxSecretConfig[] } | undefined,
    ]
  > = []
  const removeSandboxCalls: string[] = []
  const refreshSecretCalls: Array<[string, SandboxSecretConfig[]]> = []
  let sandboxes = ['forge-foo', 'forge-bar']
  const sandboxStates = new Map<string, SandboxState>()
  let shouldBeAvailable = true
  let shouldTemplateExist = true
  let shouldRemoveThrow = false

  const mock: MockSandboxRuntime = {
    checkAvailable: async () => shouldBeAvailable
      ? { available: true as const }
      : { available: false as const, reason: 'host-unsupported' as const, detail: 'mock daemon down' },
    templateExists: async () => shouldTemplateExist,
    loadTemplate: async () => {},
    createSandbox: async (
      name: string,
      workspaces: SandboxWorkspace[],
      opts?: { image?: string; resources?: SandboxResources; networkAllow?: string[]; env?: string[]; secrets?: SandboxSecretConfig[] },
    ) => {
      createSandboxCalls.push([name, workspaces, opts])
      sandboxStates.set(name, 'running')
    },
    removeSandbox: async (name: string) => {
      removeSandboxCalls.push(name)
      if (shouldRemoveThrow) {
        throw new Error('Failed to remove sandbox')
      }
    },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    getSandboxState: async (name: string) => sandboxStates.get(name) ?? 'missing',
    sandboxContainerName: (worktreeName: string) => `forge-${worktreeName}`,
    listSandboxesByPrefix: async (prefix: string) => sandboxes.filter((n) => n.startsWith(prefix)),
    refreshSandboxSecrets: async (name: string, secrets: SandboxSecretConfig[]) => {
      refreshSecretCalls.push([name, secrets])
      return true
    },
    getCreateSandboxCalls: () => createSandboxCalls,
    getRefreshSecretCalls: () => refreshSecretCalls,
    getRemoveSandboxCalls: () => removeSandboxCalls,
    setSandboxes: (newSandboxes: string[]) => {
      sandboxes = newSandboxes
    },
    setRunning: (name: string, running: boolean) => {
      if (running) sandboxStates.set(name, 'running'); else sandboxStates.delete(name)
    },
    setSandboxState: (name: string, state: SandboxState) => {
      sandboxStates.set(name, state)
    },
    setAvailable: (available: boolean) => {
      shouldBeAvailable = available
    },
    setTemplateExists: (exists: boolean) => {
      shouldTemplateExist = exists
    },
    setRemoveThrow: (shouldThrow: boolean) => {
      shouldRemoveThrow = shouldThrow
    },
  }
  return mock
}

/**
 * Creates a mock Logger for sandbox tests.
 * Returns vi.fn() spies (structurally a Logger) so callers can both use it as a
 * no-op logger and assert on calls (e.g. `logger.log.mock.calls`).
 */
export function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}
