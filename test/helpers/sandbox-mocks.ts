import { vi } from 'vitest'
import type { CommandRunner, SandboxWorkspace, SandboxRuntime, SandboxState } from '../../src/sandbox/sbx'
import type { SandboxResources } from '../../src/types'

/** A recorded CommandRunner invocation plus the options the facade forwarded. */
export interface RecordingCall {
  args: string[]
  opts?: { timeout?: number; stdin?: string }
}

/**
 * Returns a fake CommandRunner that records every invocation (args plus forwarded timeout/stdin)
 * and optionally delegates each call to `handler`. Shared by the sbx and smolvm runtime facade
 * suites so both backends exercise the same recording seam.
 */
export function createRecordingRunner(
  handler?: (rec: RecordingCall) => { stdout: string; stderr: string; exitCode: number },
): { calls: RecordingCall[]; runner: CommandRunner } {
  const calls: RecordingCall[] = []
  const runner: CommandRunner = async (args, opts) => {
    const rec = { args, opts: { timeout: opts?.timeout, stdin: opts?.stdin } }
    calls.push(rec)
    const res = handler ? handler(rec) : { stdout: '', stderr: '', exitCode: 0 }
    return res
  }
  return { calls, runner }
}

/**
 * Mock SandboxRuntime plus the test helpers used by the manager suites. Extending
 * `SandboxRuntime` keeps the object statically checked against the real runtime interface
 * while exposing recording/control methods that the production type does not have.
 */
export interface MockSandboxRuntime extends SandboxRuntime {
  getCreateSandboxCalls(): Array<
    [string, SandboxWorkspace[], { template?: string; resources?: SandboxResources; networkAllowHosts?: string[] } | undefined]
  >
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
    [string, SandboxWorkspace[], { template?: string; resources?: SandboxResources; networkAllowHosts?: string[] } | undefined]
  > = []
  const removeSandboxCalls: string[] = []
  let sandboxes = ['forge-foo', 'forge-bar']
  const sandboxStates = new Map<string, SandboxState>()
  let shouldBeAvailable = true
  let shouldTemplateExist = true
  let shouldRemoveThrow = false

  const mock: MockSandboxRuntime = {
    checkAvailable: async () => shouldBeAvailable
      ? { available: true as const }
      : { available: false as const, reason: 'daemon-down' as const, detail: 'mock daemon down' },
    templateExists: async () => shouldTemplateExist,
    loadTemplate: async (_tar: string, _ref: string) => {},
    describeUnavailable: (result) =>
      result.reason === 'daemon-down'
        ? 'The sbx daemon is not running'
        : `Sandbox unavailable: ${result.reason}`,
    templateLoadHint: () => 'sbx template load <tar>',
    createSandbox: async (
      name: string,
      workspaces: SandboxWorkspace[],
      opts?: { template?: string; resources?: SandboxResources; networkAllowHosts?: string[] },
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
    execPipe: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    getSandboxState: async (name: string) => sandboxStates.get(name) ?? 'missing',
    sandboxContainerName: (worktreeName: string) => `forge-${worktreeName}`,
    listSandboxesByPrefix: async (prefix: string) => sandboxes.filter((n) => n.startsWith(prefix)),
    allowNetworkHost: async () => true,
    getCreateSandboxCalls: () => createSandboxCalls,
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
