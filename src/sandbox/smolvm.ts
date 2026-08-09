/**
 * Pure helpers plus the runtime facade for driving the `smolvm` sandbox CLI
 * (smolmachines.com). The helper functions shape argument vectors and map values so they
 * are trivially testable; `createSmolvmRuntime` assembles them into a `SandboxRuntime`
 * over an injectable `CommandRunner`. Shared pieces come from `./sbx` — never duplicated:
 * the availability probe, the liveness inventory, remove-tolerance, name sanitizing and
 * the workspace/env-passthrough conventions.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../types'
import { runCommand, type CommandResult } from './process'
import { isSameOrDescendantPath, resolveSandboxEnvDir } from './path'
import {
  createSandboxInventory,
  normalizeMemoryToken,
  parseSbxCpus,
  prefixCommandWithCwd,
  probeCliAvailability,
  removeSandboxWith,
  sandboxContainerName,
  sanitizeSbxName,
  SBX_DEFAULT_TIMEOUT,
  type CommandRunner,
  type CreateSandboxOpts,
  type SandboxExecOpts,
  type SandboxRuntime,
  type SbxAvailability,
  type SandboxWorkspace,
} from './sbx'
import { buildEnvFileExportLoop, quoteShellArg } from './exec-fs'

/** Install command surfaced when the smolvm CLI is missing. */
export const SMOLVM_INSTALL_HINT = 'curl -sSL https://smolmachines.com/install.sh | bash'

/**
 * Probes smolvm availability by running `smolvm --version` through the shared availability
 * skeleton. A zero exit yields `{ available: true }` — smolvm links libkrun into the binary
 * and has no daemon to check, so there is no `daemon-down` state.
 */
export function checkSmolvmAvailability(run: CommandRunner): Promise<SbxAvailability> {
  return probeCliAvailability(run, {
    args: ['--version'],
    isAvailable: (result) => result.exitCode === 0,
    fallbackReason: 'unknown',
  })
}

/** The single source of the user-facing remediation message for an unavailable smolvm CLI. */
export function describeSmolvmUnavailable(
  result: Extract<SbxAvailability, { available: false }>,
): string {
  switch (result.reason) {
    case 'not-installed':
      return `The smolvm CLI is not installed. Install it with: ${SMOLVM_INSTALL_HINT}, then try again.`
    case 'daemon-down':
    case 'unknown':
      return `Could not determine smolvm availability. ${result.detail ?? 'Unknown error.'}`
  }
}

/**
 * Coerces a raw `smolvm create --mem` value to integer MiB. Accepts binary units such
 * as `1024m` and `8g` (optionally with a trailing `b`), converting `k` down and `g` up
 * by 1024, rounding to a whole number and flooring at 1. Logs and returns `undefined`
 * for anything else.
 */
export function normalizeSmolvmMemoryMiB(raw: string | undefined, logger: Logger): number | undefined {
  const token = normalizeMemoryToken(raw, logger, '--mem')
  if (token === undefined) return undefined
  const value = parseFloat(token)
  const unit = token[token.length - 1]
  let miB: number
  if (unit === 'k') miB = value / 1024
  else if (unit === 'g') miB = value * 1024
  else miB = value
  return Math.max(1, Math.round(miB))
}

/**
 * Builds a `smolvm machine create` argument vector for a shell sandbox. Emits
 * `machine create --name <name> --net`, then `--image`, one `--allow-host` per trimmed
 * non-empty entry, `--cpus` and `--mem` (MiB) when set, then one `-v HOST:HOST` volume
 * per workspace (`:ro` suffix when read-only). Identical-path mounting is a repo
 * invariant: exec-fs and the shim rely on host paths resolving unchanged in-guest. The
 * primary (worktree) workspace is required, so an empty array throws.
 */
export function buildSmolvmCreateArgs(
  name: string,
  workspaces: SandboxWorkspace[],
  opts: { image?: string; cpus?: number; memMiB?: number; allowHosts?: string[] } = {},
): string[] {
  if (workspaces.length === 0) {
    throw new Error('buildSmolvmCreateArgs requires at least one workspace')
  }
  const args = ['machine', 'create', '--name', name, '--net']
  if (opts.image) args.push('--image', opts.image)
  for (const host of opts.allowHosts ?? []) {
    const trimmed = host.trim()
    if (trimmed) args.push('--allow-host', trimmed)
  }
  if (opts.cpus !== undefined) args.push('--cpus', String(opts.cpus))
  if (opts.memMiB !== undefined) args.push('--mem', String(opts.memMiB))
  for (const ws of workspaces) {
    args.push('-v', ws.readOnly ? `${ws.hostDir}:${ws.hostDir}:ro` : `${ws.hostDir}:${ws.hostDir}`)
  }
  return args
}

/** Builds a `smolvm machine start` argument vector. */
export function buildSmolvmStartArgs(name: string): string[] {
  return ['machine', 'start', '--name', name]
}

/**
 * Builds a `smolvm machine exec` argument vector. Emits `machine exec`, then `-i` when
 * interactive, then `--name <name> --` and the command through `sh -c`.
 */
export function buildSmolvmExecArgs(
  name: string,
  command: string,
  opts?: { interactive?: boolean },
): string[] {
  return [
    'machine',
    'exec',
    ...(opts?.interactive ? ['-i'] : []),
    '--name',
    name,
    '--',
    'sh',
    '-c',
    command,
  ]
}

/** Builds a `smolvm machine delete` argument vector with force removal. */
export function buildSmolvmDeleteArgs(name: string): string[] {
  return ['machine', 'delete', '--name', name, '-f']
}

/**
 * Builds a POSIX-sh preamble that exports each non-empty `KEY=value` line of the env
 * file inside the guest without shell-interpreting values. `smolvm machine exec` has no
 * `--env-file` flag; the file is host-written by the manager and visible in-guest via
 * the env-dir mount. The path is single-quote-escaped so arbitrary paths survive the
 * shell round-trip.
 */
export function buildEnvFilePreamble(envFile: string): string {
  return buildEnvFileExportLoop(quoteShellArg(envFile))
}

/** The forge-managed store path for a ref's `docker save` tar, e.g. `oc-forge-sandbox:latest` → `<store>/oc-forge-sandbox-latest.tar`. */
export function smolvmImageTarPath(imageStoreDir: string, ref: string): string {
  return join(imageStoreDir, `${sanitizeSbxName(ref)}.tar`)
}

/**
 * Resolves the `--image` argument for a ref: a store tar that already exists (smolvm
 * accepts a `docker save` archive directly), else a registry-qualified ref containing
 * `/` (pull-through), else `null` for an unbuilt local template.
 */
export function resolveSmolvmImageArg(imageStoreDir: string | undefined, ref: string): string | null {
  if (imageStoreDir && existsSync(smolvmImageTarPath(imageStoreDir, ref))) {
    return smolvmImageTarPath(imageStoreDir, ref)
  }
  if (ref.includes('/')) return ref
  return null
}

/** Matches the combined output of a `smolvm machine exec` aimed at a stopped machine. */
const STOPPED_MACHINE_RE = /not running|is stopped|machine stopped|start the machine/i
const SMOLVM_REMOVE_MISSING_RE = /not found|no such machine|unknown machine|does not exist/i

/**
 * Assembles a `SandboxRuntime` from the pure smolvm helpers, routing every method through an
 * injectable `CommandRunner`. The default runner spawns the `smolvm` binary; tests inject a fake.
 * `dataDir` enables the two forge-managed paths: the image store (`<dataDir>/smolvm-images`, the
 * `docker save` tar is passed to `machine create --image` per create — smolvm has no template
 * store) and the env-passthrough directory (`<dataDir>/sandbox-env`, mounted read-only at its
 * identical path so execs can source the per-sandbox env file the manager wrote).
 */
export function createSmolvmRuntime(
  logger: Logger,
  opts?: { run?: CommandRunner; dataDir?: string },
): SandboxRuntime {
  const run: CommandRunner =
    opts?.run ?? ((args, o) => runCommand('smolvm', args, { ...o, logger, logLabel: 'smolvm' }))
  const imageStoreDir = opts?.dataDir ? join(opts.dataDir, 'smolvm-images') : undefined
  const envDir = opts?.dataDir ? resolveSandboxEnvDir(opts.dataDir) : undefined
  const inventory = createSandboxInventory(run, ['machine', 'ls', '--json'])

  async function checkAvailable(): Promise<SbxAvailability> {
    return checkSmolvmAvailability(run)
  }

  function describeUnavailable(result: Extract<SbxAvailability, { available: false }>): string {
    return describeSmolvmUnavailable(result)
  }

  async function templateExists(ref: string): Promise<boolean> {
    return resolveSmolvmImageArg(imageStoreDir, ref) !== null
  }

  function templateLoadHint(ref: string): string {
    if (imageStoreDir) return `cp <tar> "${smolvmImageTarPath(imageStoreDir, ref)}"`
    return 'cp <tar> <forge-data-dir>/smolvm-images/'
  }

  async function loadTemplate(tarPath: string, ref: string): Promise<void> {
    if (!imageStoreDir) {
      throw new Error(
        `Cannot load sandbox template "${ref}": the smolvm runtime has no dataDir, so there is no image store to copy the tar into`,
      )
    }
    mkdirSync(imageStoreDir, { recursive: true })
    copyFileSync(tarPath, smolvmImageTarPath(imageStoreDir, ref))
  }

  async function startMachine(name: string): Promise<void> {
    const startResult = await run(buildSmolvmStartArgs(name), { timeout: SBX_DEFAULT_TIMEOUT })
    if (startResult.exitCode !== 0) {
      throw new Error(`Failed to start sandbox: ${startResult.stderr}`)
    }
  }

  async function createSandbox(
    name: string,
    workspaces: SandboxWorkspace[],
    opts?: CreateSandboxOpts,
  ): Promise<void> {
    const image = opts?.template !== undefined ? resolveSmolvmImageArg(imageStoreDir, opts.template) : undefined
    if (opts?.template !== undefined && image === null) {
      throw new Error(`Sandbox template "${opts.template}" not found in the smolvm image store`)
    }
    const allWorkspaces = [...workspaces]
    if (envDir && !allWorkspaces.some((ws) => isSameOrDescendantPath(envDir, ws.hostDir))) {
      mkdirSync(envDir, { recursive: true })
      allWorkspaces.push({ hostDir: envDir, readOnly: true })
    }
    const createResult = await run(
      buildSmolvmCreateArgs(name, allWorkspaces, {
        image: image ?? undefined,
        cpus: parseSbxCpus(opts?.resources?.cpus, logger),
        memMiB: normalizeSmolvmMemoryMiB(opts?.resources?.memory, logger),
        allowHosts: opts?.networkAllowHosts,
      }),
      { timeout: SBX_DEFAULT_TIMEOUT },
    )
    if (createResult.exitCode !== 0) {
      throw new Error(`Failed to create sandbox: ${createResult.stderr}`)
    }
    await startMachine(name)
  }

  async function removeSandbox(name: string): Promise<void> {
    return removeSandboxWith(run, buildSmolvmDeleteArgs(name), SMOLVM_REMOVE_MISSING_RE)
  }

  /**
   * Runs a machine exec and absorbs the smolvm create/start split: smolvm does not auto-resume a
   * stopped machine like `sbx` does, so a stopped-machine exec failure triggers exactly one
   * `machine start` followed by one retry. The failure message is only a pre-filter: the restart
   * happens only when the shared liveness inventory confirms the machine is `'stopped'`, so a
   * guest command that happens to print e.g. "not running" never triggers a restart, and a missing
   * machine surfaces its original error. A failed restart throws rather than looping.
   */
  async function execWithRecovery(
    name: string,
    command: string,
    opts: { interactive: boolean; timeout?: number; abort?: AbortSignal; stdin?: string },
  ): Promise<CommandResult> {
    const runOnce = (): Promise<CommandResult> =>
      run(buildSmolvmExecArgs(name, command, { interactive: opts.interactive }), {
        timeout: opts.timeout ?? SBX_DEFAULT_TIMEOUT,
        abort: opts.abort,
        stdin: opts.stdin,
      })
    const first = await runOnce()
    if (first.exitCode !== 0 && STOPPED_MACHINE_RE.test(`${first.stdout}\n${first.stderr}`)) {
      if ((await inventory.getSandboxState(name)) !== 'stopped') return first
      await startMachine(name)
      return runOnce()
    }
    return first
  }

  async function exec(name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult> {
    const fullCommand =
      (opts?.envFile ? buildEnvFilePreamble(opts.envFile) : '') + prefixCommandWithCwd(command, opts?.cwd)
    return execWithRecovery(name, fullCommand, { interactive: false, timeout: opts?.timeout, abort: opts?.abort })
  }

  async function execPipe(
    name: string,
    command: string,
    stdin: string,
    opts?: { timeout?: number; abort?: AbortSignal; envFile?: string },
  ): Promise<CommandResult> {
    const fullCommand = (opts?.envFile ? buildEnvFilePreamble(opts.envFile) : '') + command
    return execWithRecovery(name, fullCommand, {
      interactive: true,
      timeout: opts?.timeout,
      abort: opts?.abort,
      stdin,
    })
  }

  async function allowNetworkHost(host: string): Promise<boolean> {
    logger.log(`Sandbox: smolvm applies egress policy per machine at create time; ignoring allowNetworkHost("${host}")`)
    return true
  }

  return {
    checkAvailable,
    describeUnavailable,
    templateExists,
    templateLoadHint,
    loadTemplate,
    createSandbox,
    removeSandbox,
    exec,
    execPipe,
    getSandboxState: inventory.getSandboxState,
    sandboxContainerName,
    listSandboxesByPrefix: inventory.listSandboxesByPrefix,
    allowNetworkHost,
  }
}
