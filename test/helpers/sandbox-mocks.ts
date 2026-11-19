import type {
  SandboxBackendKind,
  SandboxCapabilities,
  SandboxWorkspace,
  SandboxRuntime,
  SandboxState,
} from '../../src/sandbox/runtime'
import { MSB_CAPABILITIES } from '../../src/sandbox/runtime'
import type { SandboxResources, SandboxSecretConfig } from '../../src/types'
import type { SandboxRuntimeSettings } from '../../src/sandbox/loop-settings'
import { LumeRequestError, SPACESD_GUEST_PORT } from '../../src/sandbox/macos-lume'
import type { createLumeClient, LumeRunBody, LumeVmDetails } from '../../src/sandbox/macos-lume'

type MockCreateSandboxOpts = {
  image?: string
  resources?: SandboxResources
  networkAllow?: string[]
  env?: string[]
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
  setSandboxes(newSandboxes: string[]): void
  setRunning(name: string, running: boolean): void
  setSandboxState(name: string, state: SandboxState): void
  setAvailable(available: boolean): void
  setTemplateExists(exists: boolean): void
  setRemoveThrow(shouldThrow: boolean): void
  setCapabilities(caps: SandboxCapabilities): void
  setKind(kind: SandboxBackendKind): void
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
  let sandboxes = ['forge-foo', 'forge-bar']
  const sandboxStates = new Map<string, SandboxState>()
  let shouldBeAvailable = true
  let shouldTemplateExist = true
  let shouldRemoveThrow = false
  let kind: SandboxBackendKind = 'msb'
  let capabilities: SandboxCapabilities = MSB_CAPABILITIES

  const mock: MockSandboxRuntime = {
    get kind(): SandboxBackendKind {
      return kind
    },
    get capabilities(): SandboxCapabilities {
      return capabilities
    },
    describeUnavailable: () => 'mock unavailable',
    shimExecLine: () => 'exec mock-exec "$@"',
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
    setCapabilities: (caps: SandboxCapabilities) => {
      capabilities = caps
    },
    setKind: (nextKind: SandboxBackendKind) => {
      kind = nextKind
    },
  }
  return mock
}

type FakeLumeFailureOp = 'getVm' | 'listVms' | 'cloneVm' | 'runVm' | 'stopVm'

export interface FakeLumeControls {
  setVm(name: string, details: LumeVmDetails | null): void
  failNext(op: FakeLumeFailureOp): void
  setForwardAfterPolls(polls: number): void
  getVmCalls(): string[]
  getCloneCalls(): Array<{ source: string; target: string }>
  getRunCalls(): Array<{ name: string; body: LumeRunBody }>
  getStopCalls(): string[]
  getListVmsCalls(): number
}

export type FakeLumeClient = ReturnType<typeof createLumeClient> & FakeLumeControls

function deepCopy<T>(value: T): T {
  return structuredClone(value)
}

export function createFakeLumeClient(): FakeLumeClient {
  const vms = new Map<string, LumeVmDetails>()
  const failures: FakeLumeFailureOp[] = []
  const getVmCalls: string[] = []
  const cloneCalls: Array<{ source: string; target: string }> = []
  const runCalls: Array<{ name: string; body: LumeRunBody }> = []
  const stopCalls: string[] = []
  let listVmsCalls = 0
  let forwardAfterPolls = 0
  let pendingForwardPolls: number | null = null

  function throwIfFailing(op: FakeLumeFailureOp): void {
    const index = failures.indexOf(op)
    if (index === -1) return
    failures.splice(index, 1)
    throw new LumeRequestError(`fake lume failure: ${op}`)
  }

  const client: FakeLumeClient = {
    async getVm(name: string): Promise<LumeVmDetails | null> {
      getVmCalls.push(name)
      throwIfFailing('getVm')
      const details = vms.get(name)
      if (!details) return null
      if (pendingForwardPolls === 0) {
        details.forwards = { ...details.forwards, [String(SPACESD_GUEST_PORT)]: 45678 }
        pendingForwardPolls = null
      } else if (pendingForwardPolls !== null) {
        pendingForwardPolls -= 1
      }
      return deepCopy(details)
    },
    async listVms(): Promise<LumeVmDetails[]> {
      listVmsCalls += 1
      throwIfFailing('listVms')
      return Array.from(vms.values(), (details) => deepCopy(details))
    },
    async cloneVm(source: string, target: string): Promise<void> {
      cloneCalls.push({ source, target })
      throwIfFailing('cloneVm')
      if (!vms.has(source)) {
        throw new LumeRequestError(`fake lume failure: clone source ${source} not found`)
      }
      vms.set(target, { name: target, status: 'stopped' })
    },
    async runVm(name: string, body: LumeRunBody): Promise<void> {
      runCalls.push({ name, body: deepCopy(body) })
      throwIfFailing('runVm')
      const details = vms.get(name)
      if (!details) {
        throw new LumeRequestError(`fake lume failure: run ${name} not found`)
      }
      details.status = 'running'
      delete details.forwards
      pendingForwardPolls = forwardAfterPolls
    },
    async stopVm(name: string): Promise<void> {
      stopCalls.push(name)
      throwIfFailing('stopVm')
      const details = vms.get(name)
      if (!details) return
      details.status = 'stopped'
      delete details.forwards
    },
    setVm: (name: string, details: LumeVmDetails | null) => {
      if (details === null) {
        vms.delete(name)
      } else {
        vms.set(name, deepCopy(details))
      }
    },
    failNext: (op: FakeLumeFailureOp) => {
      failures.push(op)
    },
    setForwardAfterPolls: (polls: number) => {
      forwardAfterPolls = Math.max(0, Math.trunc(polls))
    },
    getVmCalls: () => getVmCalls,
    getCloneCalls: () => cloneCalls,
    getRunCalls: () => runCalls,
    getStopCalls: () => stopCalls,
    getListVmsCalls: () => listVmsCalls,
  }
  return client
}
