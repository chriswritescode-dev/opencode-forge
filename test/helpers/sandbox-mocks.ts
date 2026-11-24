import type { SandboxWorkspace, SandboxRuntime, SandboxState } from '../../src/sandbox/msb'
import type { SandboxResources, SandboxSecretConfig } from '../../src/types'
import type { SandboxRuntimeSettings } from '../../src/sandbox/loop-settings'

type MockCreateSandboxOpts = {
  image?: string
  resources?: SandboxResources
  networkAllow?: string[]
  env?: string[]
  vars?: Record<string, string>
  secrets?: SandboxSecretConfig[]
  secretEnv?: Record<string, string>
  restrictEgress?: boolean
  idleTimeout?: string
}

/**
 * Mock SandboxRuntime plus the test helpers used by the manager suites. Extending
 * `SandboxRuntime` keeps the object statically checked against the real runtime interface
 * while exposing recording/control methods that the production type does not have.
 */
export interface MockSandboxRuntime extends SandboxRuntime {
  getCreateSandboxCalls(): Array<[string, SandboxWorkspace[], MockCreateSandboxOpts | undefined]>
  getRefreshSecretCalls(): Array<[string, SandboxSecretConfig[], Record<string, string> | undefined]>
  getStartSandboxCalls(): Array<[string, Record<string, string> | undefined]>
  getRemoveSandboxCalls(): string[]
  getResizeCalls(): Array<[string, Pick<SandboxResources, 'cpus' | 'memory'>]>
  /** Sets what `readSandboxSettings` reports for a sandbox; `null` simulates an unreadable one. */
  setSandboxSettings(name: string, settings: SandboxRuntimeSettings | null): void
  /** Sets what `readSandboxEnv` reports for a sandbox; `null` simulates an unreadable one. */
  setSandboxEnv(name: string, env: Record<string, string> | null): void
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
  const createSandboxCalls: Array<[string, SandboxWorkspace[], MockCreateSandboxOpts | undefined]> = []
  const removeSandboxCalls: string[] = []
  const refreshSecretCalls: Array<[string, SandboxSecretConfig[], Record<string, string> | undefined]> = []
  const startSandboxCalls: Array<[string, Record<string, string> | undefined]> = []
  const resizeCalls: Array<[string, Pick<SandboxResources, 'cpus' | 'memory'>]> = []
  const sandboxSettings = new Map<string, SandboxRuntimeSettings | null>()
  const sandboxEnv = new Map<string, Record<string, string> | null>()
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
      opts?: MockCreateSandboxOpts,
    ) => {
      createSandboxCalls.push([name, workspaces, opts])
      sandboxStates.set(name, 'running')
    },
    removeSandbox: async (name: string) => {
      removeSandboxCalls.push(name)
      if (shouldRemoveThrow) {
        throw new Error('Failed to remove sandbox')
      }
      sandboxStates.delete(name)
      sandboxSettings.delete(name)
      sandboxEnv.delete(name)
    },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    getSandboxState: async (name: string) => sandboxStates.get(name) ?? 'missing',
    sandboxContainerName: (worktreeName: string) => `forge-${worktreeName}`,
    listSandboxesByPrefix: async (prefix: string) => sandboxes.filter((n) => n.startsWith(prefix)),
    refreshSandboxSecrets: async (
      name: string,
      secrets: SandboxSecretConfig[],
      secretEnv?: Record<string, string>,
    ) => {
      refreshSecretCalls.push([name, secrets, secretEnv])
      return { ok: true as const }
    },
    startSandbox: async (name: string, secretEnv?: Record<string, string>) => {
      startSandboxCalls.push([name, secretEnv])
      sandboxStates.set(name, 'running')
    },
    readSandboxSettings: async (name: string) => sandboxSettings.has(name)
      ? sandboxSettings.get(name)!
      : { cpus: 4, memoryMib: 8192, allowLan: false },
    readSandboxEnv: async (name: string) => sandboxEnv.has(name) ? sandboxEnv.get(name)! : null,
    resizeSandbox: async (name: string, resources: Pick<SandboxResources, 'cpus' | 'memory'>) => {
      resizeCalls.push([name, resources])
    },
    getCreateSandboxCalls: () => createSandboxCalls,
    getRefreshSecretCalls: () => refreshSecretCalls,
    getStartSandboxCalls: () => startSandboxCalls,
    getRemoveSandboxCalls: () => removeSandboxCalls,
    getResizeCalls: () => resizeCalls,
    setSandboxSettings: (name: string, settings: SandboxRuntimeSettings | null) => {
      sandboxSettings.set(name, settings)
    },
    setSandboxEnv: (name: string, env: Record<string, string> | null) => {
      sandboxEnv.set(name, env)
    },
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
