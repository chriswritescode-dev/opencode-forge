import { vi } from 'vitest'
import type { SandboxWorkspace, SandboxRuntime } from '../../src/sandbox/sbx'
import type { SandboxResources } from '../../src/types'

/**
 * Mock SandboxRuntime plus the test helpers used by the manager suites. Extending
 * `SandboxRuntime` keeps the object statically checked against the real runtime interface
 * while exposing recording/control methods that the production type does not have.
 */
export interface MockSandboxRuntime extends SandboxRuntime {
  getCreateSandboxCalls(): Array<
    [string, SandboxWorkspace[], { template?: string; resources?: SandboxResources } | undefined]
  >
  getRemoveSandboxCalls(): string[]
  setSandboxes(newSandboxes: string[]): void
  setRunning(name: string, running: boolean): void
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
    [string, SandboxWorkspace[], { template?: string; resources?: SandboxResources } | undefined]
  > = []
  const removeSandboxCalls: string[] = []
  let sandboxes = ['forge-foo', 'forge-bar']
  let runningSandboxes = new Set<string>()
  let shouldBeAvailable = true
  let shouldTemplateExist = true
  let shouldRemoveThrow = false

  const mock: MockSandboxRuntime = {
    checkAvailable: async () => shouldBeAvailable
      ? { available: true as const }
      : { available: false as const, reason: 'daemon-down' as const, detail: 'mock daemon down' },
    templateExists: async () => shouldTemplateExist,
    loadTemplate: async () => {},
    createSandbox: async (
      name: string,
      workspaces: SandboxWorkspace[],
      opts?: { template?: string; resources?: SandboxResources },
    ) => {
      createSandboxCalls.push([name, workspaces, opts])
      runningSandboxes.add(name)
    },
    removeSandbox: async (name: string) => {
      removeSandboxCalls.push(name)
      if (shouldRemoveThrow) {
        throw new Error('Failed to remove sandbox')
      }
    },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execPipe: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    isRunning: async (name: string) => runningSandboxes.has(name),
    sandboxContainerName: (worktreeName: string) => `forge-${worktreeName}`,
    listSandboxesByPrefix: async (prefix: string) => sandboxes.filter((n) => n.startsWith(prefix)),
    allowNetworkHost: async () => true,
    getCreateSandboxCalls: () => createSandboxCalls,
    getRemoveSandboxCalls: () => removeSandboxCalls,
    setSandboxes: (newSandboxes: string[]) => {
      sandboxes = newSandboxes
    },
    setRunning: (name: string, running: boolean) => {
      if (running) runningSandboxes.add(name); else runningSandboxes.delete(name)
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
