import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Logger, SandboxMacosConfig, SandboxResources, SandboxSecretConfig } from '../types'
import { runCommand, type CommandResult } from './process'
import { MACOS_CAPABILITIES } from './runtime'
import { mapLumeVmState, type createLumeClient } from './macos-lume'
import { MACOS_VM_NAME } from './macos-shares'
import { quoteShellArg } from './exec-fs'
import type {
  SandboxAvailability,
  CommandRunner,
  CreateSandboxOpts,
  SandboxExecOpts,
  SandboxRuntime,
  SandboxState,
  SandboxWorkspace,
  SecretRefreshResult,
} from './runtime'
import type { SandboxRuntimeSettings } from './loop-settings'

export const MACOS_DEFAULT_TIMEOUT = 120000

const MACOS_DEFAULT_LUME_URL = 'http://127.0.0.1:7787'
const MACOS_NOT_INSTALLED_RE = /ENOENT|command not found/i
const MACOS_PROBE_TIMEOUT = 30000

export interface MacosStatePaths {
  root: string
  setupDir: string
  tokenFile: string
  urlFile: string
  vmStateFile: string
  netDir: string
}

export function macosStatePaths(dataDir: string): MacosStatePaths {
  const root = join(dataDir, 'macos')
  const setupDir = join(root, 'setup')
  return {
    root,
    setupDir,
    tokenFile: join(setupDir, 'env-token'),
    urlFile: join(root, 'spacesd-url'),
    vmStateFile: join(root, 'vm-state.json'),
    netDir: join(root, 'net'),
  }
}

export function ensureSpacesdToken(paths: MacosStatePaths): string {
  mkdirSync(paths.setupDir, { recursive: true, mode: 0o700 })
  let existing: string
  try {
    existing = readFileSync(paths.tokenFile, 'utf-8').trim()
  } catch {
    existing = ''
  }
  if (existing) return existing
  const token = randomBytes(32).toString('hex')
  writeFileSync(paths.tokenFile, token, { mode: 0o600 })
  return token
}

export function describeMacosUnavailable(
  result: Extract<SandboxAvailability, { available: false }>,
): string {
  switch (result.reason) {
    case 'not-installed':
      return 'The macOS sandbox needs `lume serve` from the Cua fork (default http://127.0.0.1:7787), and the `cua` and `cua-netgw` binaries on PATH or set through sandbox.macos.cuaPath and sandbox.macos.netgwPath. Set "sandbox": { "mode": "msb" } to use the msb backend instead.'
    case 'host-unsupported':
      return 'The macOS sandbox mode needs a macOS host (Apple silicon). Set "sandbox": { "mode": "msb" } to use the msb backend instead.'
    case 'unknown':
      return `Could not determine macOS sandbox availability. ${result.detail ?? 'Unknown error.'}`
  }
}

type LumeClient = ReturnType<typeof createLumeClient>

interface MacosRunOpts {
  timeout?: number
  env?: Record<string, string>
  abort?: AbortSignal
}

export function createMacosRuntime(input: {
  dataDir: string
  config: SandboxMacosConfig
  lume: LumeClient
  logger: Logger
  run?: CommandRunner
}): SandboxRuntime {
  const paths = macosStatePaths(input.dataDir)
  const lumeUrl = input.config.lumeUrl ?? MACOS_DEFAULT_LUME_URL
  const cuaPath = input.config.cuaPath ?? 'cua'
  const netgwPath = input.config.netgwPath ?? 'cua-netgw'
  const injected = input.run
  const run: (
    command: string,
    args: string[],
    opts?: MacosRunOpts,
  ) => Promise<CommandResult> = injected
    ? (command, args, opts) => injected([command, ...args], opts)
    : (command, args, opts) =>
        runCommand(command, args, { ...opts, logger: input.logger, logLabel: 'cua' })

  async function probe(
    command: string,
    args: string[],
    label: string,
    path: string,
  ): Promise<Extract<SandboxAvailability, { available: false }> | undefined> {
    let result: CommandResult
    try {
      result = await run(command, args, { timeout: MACOS_PROBE_TIMEOUT })
    } catch {
      return { available: false, reason: 'unknown' }
    }
    if (result.exitCode === 0) return undefined
    const combined = `${result.stdout}\n${result.stderr}`
    if (MACOS_NOT_INSTALLED_RE.test(combined)) {
      return { available: false, reason: 'not-installed', detail: `\`${label}\` is not available at ${path}` }
    }
    return { available: false, reason: 'unknown', detail: combined.trim() }
  }

  async function checkAvailable(): Promise<SandboxAvailability> {
    try {
      await input.lume.listVms()
    } catch {
      return {
        available: false,
        reason: 'not-installed',
        detail: `Lume API not reachable at ${lumeUrl}`,
      }
    }
    const cuaFailure = await probe(cuaPath, ['--version'], 'cua', cuaPath)
    if (cuaFailure) return cuaFailure
    const netgwFailure = await probe(netgwPath, ['-h'], 'cua-netgw', netgwPath)
    if (netgwFailure) return netgwFailure
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'host-unsupported' }
    }
    return { available: true }
  }

  async function templateExists(ref: string): Promise<boolean> {
    try {
      return (await input.lume.getVm(ref)) !== null
    } catch {
      return false
    }
  }

  async function loadTemplate(_tarPath: string, _ref: string): Promise<void> {
    throw new Error('loadTemplate is not supported in the macOS sandbox mode')
  }

  async function createSandbox(
    _name: string,
    _workspaces: SandboxWorkspace[],
    _opts: CreateSandboxOpts,
  ): Promise<void> {
    throw new Error('createSandbox is not supported in the macOS sandbox mode')
  }

  async function removeSandbox(name: string): Promise<void> {
    input.logger.log(`Sandbox: not removing the shared macOS VM ${name}`)
  }

  async function exec(_name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult> {
    let url: string
    try {
      url = readFileSync(paths.urlFile, 'utf-8').trim()
    } catch {
      url = ''
    }
    if (!url) throw new Error('macOS sandbox is not ready (no spacesd endpoint)')
    const token = ensureSpacesdToken(paths)
    const timeout = opts?.timeout ?? MACOS_DEFAULT_TIMEOUT
    const args = ['spacesd', 'exec']
    if (opts?.cwd) args.push('--cwd', opts.cwd)
    args.push('--timeout', String(Math.ceil(timeout / 1000)), url, '/bin/bash', '-c', `umask 022; ${command}`)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    env.CUA_SPACESD_TOKEN = token
    return run(cuaPath, args, { timeout, env, abort: opts?.abort })
  }

  async function getSandboxState(name: string): Promise<SandboxState> {
    try {
      return mapLumeVmState(await input.lume.getVm(name))
    } catch {
      return 'unknown'
    }
  }

  function sandboxContainerName(): string {
    return MACOS_VM_NAME
  }

  async function listSandboxesByPrefix(): Promise<string[]> {
    return []
  }

  async function refreshSandboxSecrets(
    _name: string,
    secrets: SandboxSecretConfig[],
    _secretEnv?: Record<string, string>,
  ): Promise<SecretRefreshResult> {
    if (secrets.length === 0) return { ok: true }
    return { ok: false, reason: 'secrets are not supported in the macOS sandbox mode' }
  }

  async function startSandbox(_name: string, _secretEnv?: Record<string, string>): Promise<void> {
    throw new Error('startSandbox is not supported in the macOS sandbox mode')
  }

  async function readSandboxSettings(name: string): Promise<SandboxRuntimeSettings | null> {
    try {
      const details = await input.lume.getVm(name)
      if (!details || details.cpuCount === undefined || details.memorySize === undefined) return null
      return {
        cpus: details.cpuCount,
        memoryMib: Math.round(details.memorySize / (1024 * 1024)),
        allowLan: false,
      }
    } catch {
      return null
    }
  }

  async function resizeSandbox(
    _name: string,
    _resources: Pick<SandboxResources, 'cpus' | 'memory'>,
  ): Promise<void> {
    throw new Error('resizeSandbox is not supported in the macOS sandbox mode')
  }

  function shimExecLine(): string {
    const tokenFile = quoteShellArg(paths.tokenFile)
    const urlFile = quoteShellArg(paths.urlFile)
    const cua = quoteShellArg(cuaPath)
    return [
      `if [ ! -r ${tokenFile} ] || [ ! -r ${urlFile} ]; then echo "forge: macOS sandbox is not ready; refusing to run on the host" >&2; exit 125; fi`,
      `CUA_SPACESD_TOKEN="$(cat ${tokenFile})"; export CUA_SPACESD_TOKEN`,
      `exec ${cua} spacesd exec -i --cwd "$PWD" "$(cat ${urlFile})" /bin/bash -c 'umask 022; exec /bin/bash "$@"' bash "$@"`,
    ].join('\n')
  }

  return {
    kind: 'macos',
    capabilities: MACOS_CAPABILITIES,
    checkAvailable,
    describeUnavailable: describeMacosUnavailable,
    shimExecLine,
    templateExists,
    loadTemplate,
    createSandbox,
    removeSandbox,
    exec,
    getSandboxState,
    sandboxContainerName,
    listSandboxesByPrefix,
    refreshSandboxSecrets,
    startSandbox,
    readSandboxSettings,
    resizeSandbox,
  }
}
