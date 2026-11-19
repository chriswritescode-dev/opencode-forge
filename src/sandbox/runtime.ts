import type { SandboxResources, SandboxSecretConfig } from '../types'
import type { CommandResult } from './process'
import type { SandboxRuntimeSettings } from './loop-settings'

export interface SandboxWorkspace {
  hostDir: string
  containerDir: string
  readOnly?: boolean
}

export type SandboxState = 'running' | 'stopped' | 'transient' | 'missing' | 'unknown'

export interface CreateSandboxOpts {
  image: string
  resources?: SandboxResources
  networkAllow?: string[]
  restrictEgress?: boolean
  env?: string[]
  secrets?: SandboxSecretConfig[]
  secretEnv?: Record<string, string>
  allowLan?: boolean
  idleTimeout?: string
}

export interface SandboxExecOpts {
  timeout?: number
  cwd?: string
  abort?: AbortSignal
}

export type SecretRefreshResult = { ok: true } | { ok: false; reason: string }

export type SandboxAvailability =
  | { available: true }
  | { available: false; reason: 'not-installed' | 'host-unsupported' | 'unknown'; detail?: string }

export type CommandRunner = (
  args: string[],
  opts?: { timeout?: number; stdin?: string; abort?: AbortSignal; env?: Record<string, string> },
) => Promise<CommandResult>

export type SandboxBackendKind = 'msb' | 'macos'

export interface SandboxCapabilities {
  namedDisks: boolean
  secretsProxy: boolean
  lanToggle: boolean
  idleTimeout: boolean
  resize: boolean
  perSandboxInstances: boolean
  templateBuild: boolean
  docker: boolean
  codeGraph: boolean
}

export const MSB_CAPABILITIES: SandboxCapabilities = {
  namedDisks: true,
  secretsProxy: true,
  lanToggle: true,
  idleTimeout: true,
  resize: true,
  perSandboxInstances: true,
  templateBuild: true,
  docker: true,
  codeGraph: true,
}

export const MACOS_CAPABILITIES: SandboxCapabilities = {
  namedDisks: false,
  secretsProxy: false,
  lanToggle: false,
  idleTimeout: false,
  resize: false,
  perSandboxInstances: false,
  templateBuild: false,
  docker: false,
  codeGraph: false,
}

export interface SandboxRuntime {
  readonly kind: SandboxBackendKind
  readonly capabilities: SandboxCapabilities
  checkAvailable(): Promise<SandboxAvailability>
  describeUnavailable(result: Extract<SandboxAvailability, { available: false }>): string
  shimExecLine(): string
  templateExists(ref: string): Promise<boolean>
  loadTemplate(tarPath: string, ref: string): Promise<void>
  createSandbox(name: string, workspaces: SandboxWorkspace[], opts: CreateSandboxOpts): Promise<void>
  removeSandbox(name: string): Promise<void>
  exec(name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult>
  getSandboxState(name: string): Promise<SandboxState>
  sandboxContainerName(worktreeName: string): string
  listSandboxesByPrefix(prefix: string): Promise<string[]>
  refreshSandboxSecrets(
    name: string,
    secrets: SandboxSecretConfig[],
    secretEnv?: Record<string, string>,
  ): Promise<SecretRefreshResult>
  startSandbox(name: string, secretEnv?: Record<string, string>): Promise<void>
  readSandboxSettings(name: string): Promise<SandboxRuntimeSettings | null>
  resizeSandbox(name: string, resources: Pick<SandboxResources, 'cpus' | 'memory'>): Promise<void>
}
