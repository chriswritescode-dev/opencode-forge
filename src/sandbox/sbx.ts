/**
 * Pure helpers for driving the `sbx` sandbox CLI. No runtime assembly lives here;
 * these functions only shape names and argument vectors so they are trivially testable.
 */
import type { Logger, SandboxResources } from '../types'
import { runCommand, type CommandResult } from './process'
import { quoteShellArg } from './exec-fs'

/**
 * Sanitizes a raw string into a name `sbx create --name` accepts. `sbx` allows only
 * letters, numbers, hyphens, periods and plus signs. Lowercases, collapses every run of
 * disallowed characters into a single `-`, strips leading/trailing `-` and `.`, and
 * truncates to 60 characters (re-stripping any trailing `-`/`.` created by truncation).
 * Empty input returns `'sandbox'`.
 */
export function sanitizeSbxName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .substring(0, 60)
    .replace(/[-.]+$/g, '')
  return name || 'sandbox'
}

/**
 * Deterministic sandbox container name for a loop worktree. The symbol name and
 * signature are kept identical to the old Docker driver's `sandboxContainerName` so
 * existing call sites need no import change when this module takes over.
 */
export function sandboxContainerName(worktreeName: string): string {
  return `forge-${sanitizeSbxName(worktreeName)}`
}

export interface BuildSbxExecOpts {
  user?: string
  interactive?: boolean
  envFile?: string
  workdir?: string
}

/**
 * Builds an `sbx exec` argument vector. Emits `exec`, then `-i` when interactive, then
 * `-u <user>`, `--env-file <envFile>`, `-w <workdir>`, then `name`, `sh`, `-c`, `command`.
 * Flags are omitted when their option is undefined or empty.
 */
export function buildSbxExecArgs(name: string, command: string, opts?: BuildSbxExecOpts): string[] {
  const args = ['exec']
  if (opts?.interactive) args.push('-i')
  if (opts?.user) args.push('-u', opts.user)
  if (opts?.envFile) args.push('--env-file', opts.envFile)
  if (opts?.workdir) args.push('-w', opts.workdir)
  args.push(name, 'sh', '-c', command)
  return args
}

/**
 * Prefixes a command with a `cd` into `cwd`, single-quote-escaping the path so arbitrary
 * working directories (including ones containing single quotes) survive the shell round-trip.
 * A missing `cwd` returns the command unchanged. Shared with the smolvm runtime so both
 * backends apply the identical cwd semantics.
 */
export function prefixCommandWithCwd(command: string, cwd?: string): string {
  if (!cwd) return command
  return `cd ${quoteShellArg(cwd)} && ${command}`
}

/** A host directory to bind into the sandbox; `readOnly` maps to the `:ro` suffix. */
export interface SandboxWorkspace {
  hostDir: string
  readOnly?: boolean
}

const MEMORY_TOKEN_RE = /^\d+(\.\d+)?[kmg]b?$/i

/**
 * Shared memory-token normalization: accepts binary units such as `1024m` and `8g`
 * (optionally with a trailing `b`), lowercases and strips the trailing `b`. Logs and
 * returns `undefined` for anything else. `flag` names the backend flag in the log so
 * each caller's message stays accurate.
 */
export function normalizeMemoryToken(
  raw: string | undefined,
  logger: Logger,
  flag: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (!MEMORY_TOKEN_RE.test(raw)) {
    logger.log(`Sandbox: unrecognized ${flag} value ${JSON.stringify(raw)} ignored`)
    return undefined
  }
  return raw.toLowerCase().replace(/b$/, '')
}

/**
 * Coerces a raw `sbx create --cpus` value. `sbx`'s `--cpus` flag is integer-only while
 * `SandboxResources.cpus` is a string, so this parses a float and rounds down to at least 1.
 * Returns `undefined` (with a log) for non-numeric input.
 */
export function parseSbxCpus(raw: string | undefined, logger: Logger): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    logger.log(`Sandbox: non-numeric --cpus value ${JSON.stringify(raw)} ignored`)
    return undefined
  }
  const floored = Math.floor(value)
  if (floored !== value) {
    logger.log(`Sandbox: sbx --cpus is integer-only; rounding cpus="${raw}" down to ${floored}`)
  }
  return Math.max(1, floored)
}

/**
 * Normalizes a raw `sbx create --memory` value. Accepts binary units such as `1024m` and `8g`
 * (optionally with a trailing `b`), lowercased and without the trailing `b`. Logs and returns
 * `undefined` for anything else.
 */
export function normalizeSbxMemory(raw: string | undefined, logger: Logger): string | undefined {
  return normalizeMemoryToken(raw, logger, '--memory')
}

/**
 * Builds an `sbx create` argument vector for a shell sandbox. Emits `create shell --quiet
 * --name <name>`, then `--template`, `--memory`, `--cpus` when present, then one positional
 * per workspace (`hostDir` for read-write, `${hostDir}:ro` for read-only). The primary
 * (worktree) workspace is required, so an empty array throws.
 */
export function buildSbxCreateArgs(
  name: string,
  workspaces: SandboxWorkspace[],
  opts: { template?: string; memory?: string; cpus?: number } = {},
): string[] {
  if (workspaces.length === 0) {
    throw new Error('buildSbxCreateArgs requires at least one workspace')
  }
  const args = ['create', 'shell', '--quiet', '--name', name]
  if (opts.template) args.push('--template', opts.template)
  if (opts.memory) args.push('--memory', opts.memory)
  if (opts.cpus !== undefined) args.push('--cpus', String(opts.cpus))
  for (const ws of workspaces) {
    args.push(ws.readOnly ? `${ws.hostDir}:ro` : ws.hostDir)
  }
  return args
}

/** A single sandbox reported by `sbx ls --json`, with the raw status and liveness derived from it. */
export interface SbxSandboxEntry {
  name: string
  status: string
  running: boolean
}

/**
 * Parses `sbx ls --json` output into sandbox entries. The JSON shape is not contractually
 * pinned, so this is defensive: `JSON.parse` failures return `[]`; it accepts either a bare
 * array or an object whose first array-valued property holds the entries (covers the observed
 * `{"sandboxes":[]}` shape without hardcoding the key). For each element it reads `name` from
 * `name`/`Name`/`sandbox` and the raw status from `status`/`Status`/`state`/`State` (kept on the
 * entry so callers can tell a suspended sandbox from a dead one); `running` is true only when the
 * lowercased status starts with `running`. Entries without a non-empty string name are dropped.
 */
export function parseSbxSandboxList(stdout: string): SbxSandboxEntry[] {
  return parseSbxSandboxListOrNull(stdout) ?? []
}

/**
 * Same parse as `parseSbxSandboxList` but distinguishes "parsed, nothing matched" from "could not
 * parse at all", which `getSandboxState` needs: a `sbx ls` that exits 0 while emitting truncated or
 * schema-changed output says nothing about the sandbox, and reporting `missing` there would let a
 * caller destroy or duplicate a live sandbox. Empty output is a legitimately empty list, not a
 * parse failure, so a genuinely absent sandbox can still be created.
 */
function parseSbxSandboxListOrNull(stdout: string): SbxSandboxEntry[] | null {
  if (stdout.trim() === '') return []
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  let entries: unknown[] | null = null
  if (Array.isArray(data)) {
    entries = data
  } else if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        entries = value
        break
      }
    }
  }
  // Valid JSON in an unrecognized shape (an error object, a scalar, a future nested schema) is a
  // failure to read the inventory, not an empty inventory. Reporting it as an empty list would let
  // callers conclude `missing` and destroy or duplicate a live sandbox.
  if (!entries) return null
  const out: SbxSandboxEntry[] = []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name
      : typeof entry.Name === 'string' ? entry.Name
      : typeof entry.sandbox === 'string' ? entry.sandbox
      : ''
    if (!name) continue
    const status = typeof entry.status === 'string' ? entry.status
      : typeof entry.Status === 'string' ? entry.Status
      : typeof entry.state === 'string' ? entry.state
      : typeof entry.State === 'string' ? entry.State
      : ''
    out.push({ name, status, running: status.toLowerCase().startsWith('running') })
  }
  return out
}

/** A template row reported by `sbx template ls` (whitespace-aligned table, no JSON flag). */
export interface SbxTemplateEntry {
  repository: string
  tag: string
}

/**
 * Parses `sbx template ls` table output into template entries. The table has a
 * `REPOSITORY TAG IMAGE ID FLAVOR CREATED` header and whitespace-aligned columns, so
 * this skips blank lines and the header row (first field `REPOSITORY`), splits each
 * remaining line on runs of whitespace, and reads fields `[0]` and `[1]` as repository
 * and tag, dropping lines with fewer than two fields.
 */
export function parseSbxTemplateList(stdout: string): SbxTemplateEntry[] {
  const entries: SbxTemplateEntry[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const fields = trimmed.split(/\s+/)
    if (fields[0] === 'REPOSITORY' || fields.length < 2) continue
    entries.push({ repository: fields[0], tag: fields[1] })
  }
  return entries
}

/**
 * Whether any template matches a reference like `oc-forge-sandbox:latest`. Splits `ref` on
 * the last `:` into name and tag (defaulting the tag to `latest`); matches when the tag is
 * equal and the entry repository equals the name or ends with `/${name}`, so a bare
 * `oc-forge-sandbox:latest` matches a registry-qualified `docker.io/library/oc-forge-sandbox`.
 */
export function sbxTemplateMatches(entries: SbxTemplateEntry[], ref: string): boolean {
  const lastColon = ref.lastIndexOf(':')
  const name = lastColon === -1 ? ref : ref.slice(0, lastColon)
  const tag = lastColon === -1 ? 'latest' : ref.slice(lastColon + 1)
  return entries.some(
    (e) => e.tag === tag && (e.repository === name || e.repository.endsWith(`/${name}`)),
  )
}

/** Result of probing whether the `sbx` sandbox daemon is usable. */
export type SbxAvailability =
  | { available: true }
  | { available: false; reason: 'not-installed' | 'daemon-down' | 'unknown'; detail?: string }

/**
 * Injectable command seam used by the runtime helpers so every method is testable without
 * spawning a real `sbx` binary. `args` is the full vector (e.g. `['daemon', 'status']`).
 */
export type CommandRunner = (
  args: string[],
  opts?: { timeout?: number; stdin?: string; abort?: AbortSignal },
) => Promise<CommandResult>

const SBX_RUNNING_RE = /^\s*status:\s*running/im
/** Matches the combined output of a CLI that could not be spawned at all. Backend-neutral: shared with the smolvm runtime. */
const NOT_INSTALLED_RE = /ENOENT|not found|command not found/i

/**
 * Shared availability probe used by both backends: runs `args` with a short timeout, treats
 * `isAvailable` as the health predicate, distinguishes a missing CLI from a failing one via
 * `NOT_INSTALLED_RE`, and maps everything else to `fallbackReason` (`daemon-down` for sbx's
 * stopped daemon, `unknown` for smolvm which has no daemon).
 */
export async function probeCliAvailability(
  run: CommandRunner,
  opts: {
    args: string[]
    isAvailable: (result: CommandResult) => boolean
    fallbackReason: 'daemon-down' | 'unknown'
  },
): Promise<SbxAvailability> {
  let result: CommandResult
  try {
    result = await run(opts.args, { timeout: SBX_PROBE_TIMEOUT })
  } catch {
    return { available: false, reason: 'unknown' }
  }
  if (opts.isAvailable(result)) return { available: true }
  const combined = `${result.stdout}\n${result.stderr}`
  if (NOT_INSTALLED_RE.test(combined)) {
    return { available: false, reason: 'not-installed' }
  }
  return { available: false, reason: opts.fallbackReason, detail: combined.trim() }
}

/**
 * Probes sandbox availability by running `sbx daemon status`. A zero exit with a
 * `Status: running` line yields `{ available: true }`; a missing CLI is distinguished from a
 * stopped daemon because they need different remediation.
 */
export function checkSbxAvailability(run: CommandRunner): Promise<SbxAvailability> {
  return probeCliAvailability(run, {
    args: ['daemon', 'status'],
    isAvailable: (result) => result.exitCode === 0 && SBX_RUNNING_RE.test(result.stdout),
    fallbackReason: 'daemon-down',
  })
}

/** The single source of the user-facing remediation message for an unavailable sandbox. */
export function describeSbxUnavailable(
  result: Extract<SbxAvailability, { available: false }>,
): string {
  switch (result.reason) {
    case 'not-installed':
      return 'The sbx sandbox CLI is not installed. Install the sbx CLI and run `sbx login` to authenticate, then try again.'
    case 'daemon-down':
      return 'The sbx daemon is not running. Start it with `sbx daemon start`, then try again.'
    case 'unknown':
      return `Could not determine sandbox availability. ${result.detail ?? 'Unknown error.'}`
  }
}

/** Options for creating a sandbox. */
export interface CreateSandboxOpts {
  template?: string
  resources?: SandboxResources
  /** Per-create egress allowlist; the sbx runtime ignores it (egress policy is global via `allowNetworkHost`). */
  networkAllowHosts?: string[]
}

/** Options for a non-piped sandbox exec. */
export interface SandboxExecOpts {
  timeout?: number
  cwd?: string
  abort?: AbortSignal
  envFile?: string
}

/**
 * Lifecycle state of a named sandbox. `stopped` is a normal suspended microVM that `sbx exec`
 * resumes in place, so it must never be treated as gone. `unknown` means the status query itself
 * failed and carries no information about the sandbox — callers must not destroy anything on it.
 */
export type SandboxState = 'running' | 'stopped' | 'missing' | 'unknown'

/** Runtime facade over the `sbx` CLI — the sandbox analog of the old Docker driver. */
export interface SandboxRuntime {
  checkAvailable(): Promise<SbxAvailability>
  describeUnavailable(result: Extract<SbxAvailability, { available: false }>): string
  templateExists(ref: string): Promise<boolean>
  templateLoadHint(ref: string): string
  loadTemplate(tarPath: string, ref: string): Promise<void>
  createSandbox(name: string, workspaces: SandboxWorkspace[], opts?: CreateSandboxOpts): Promise<void>
  removeSandbox(name: string): Promise<void>
  exec(name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult>
  execPipe(name: string, command: string, stdin: string, opts?: { timeout?: number; abort?: AbortSignal; envFile?: string }): Promise<CommandResult>
  getSandboxState(name: string): Promise<SandboxState>
  sandboxContainerName(worktreeName: string): string
  listSandboxesByPrefix(prefix: string): Promise<string[]>
  allowNetworkHost(host: string): Promise<boolean>
}

/**
 * Upper bound for a single `sbx` invocation, including `sbx create`. Provisioning a microVM
 * sandbox is far slower than the old container start, so this is also the only correct bound
 * for anything that waits on a sandbox becoming available (see `waitForSandboxReady`).
 */
export const SBX_DEFAULT_TIMEOUT = 120000
const SBX_TEMPLATE_LOAD_TIMEOUT = 600000
/** Quick CLI round-trip bound for the availability probe; shared by both backends. */
const SBX_PROBE_TIMEOUT = 5000
/** Quick CLI round-trip bound for the inventory listing; shared by both backends. */
const SBX_LIST_TIMEOUT = 5000
const SBX_REMOVE_MISSING_RE = /not found|no such sandbox|unknown sandbox/i

/**
 * Runs a backend `remove` command, tolerating non-zero exits that mean the sandbox is already
 * gone. The missing-regex is backend-specific (`sbx` says `no such sandbox`, smolvm `unknown
 * machine`); any other failure throws with the CLI stderr.
 */
export async function removeSandboxWith(run: CommandRunner, argv: string[], missingRe: RegExp): Promise<void> {
  const result = await run(argv)
  if (result.exitCode !== 0 && !missingRe.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to remove sandbox: ${result.stderr}`)
  }
}

/**
 * Shared liveness inventory backed by a backend `ls --json` invocation. `getSandboxState` is the
 * only liveness primitive: a failed or unparseable listing yields `'unknown'` (never `'missing'`,
 * which would let callers destroy or duplicate a live sandbox), a parsed-but-absent entry
 * `'missing'`, and `'running'`/`'stopped'` from the raw status. `listSandboxesByPrefix` degrades
 * to `[]` on any failure.
 */
export function createSandboxInventory(
  run: CommandRunner,
  listArgs: string[],
): {
  getSandboxState(name: string): Promise<SandboxState>
  listSandboxesByPrefix(prefix: string): Promise<string[]>
} {
  async function getSandboxState(name: string): Promise<SandboxState> {
    let result: CommandResult
    try {
      result = await run(listArgs, { timeout: SBX_LIST_TIMEOUT })
    } catch {
      return 'unknown'
    }
    if (result.exitCode !== 0) return 'unknown'
    const entries = parseSbxSandboxListOrNull(result.stdout)
    if (!entries) return 'unknown'
    const entry = entries.find((e) => e.name === name)
    if (!entry) return 'missing'
    return entry.running ? 'running' : 'stopped'
  }

  async function listSandboxesByPrefix(prefix: string): Promise<string[]> {
    try {
      const result = await run(listArgs, { timeout: SBX_LIST_TIMEOUT })
      if (result.exitCode !== 0) return []
      return parseSbxSandboxList(result.stdout)
        .map((e) => e.name)
        .filter((n) => n.startsWith(prefix))
    } catch {
      return []
    }
  }

  return { getSandboxState, listSandboxesByPrefix }
}

/**
 * Assembles a `SandboxRuntime` from the pure `sbx` helpers, routing every method through an
 * injectable `CommandRunner`. The default runner spawns the `sbx` binary; tests inject a fake.
 */
export function createSbxRuntime(logger: Logger, opts?: { run?: CommandRunner }): SandboxRuntime {
  const run: CommandRunner =
    opts?.run ?? ((args, o) => runCommand('sbx', args, { ...o, logger, logLabel: 'sbx' }))
  const inventory = createSandboxInventory(run, ['ls', '--json'])

  async function checkAvailable(): Promise<SbxAvailability> {
    return checkSbxAvailability(run)
  }

  function describeUnavailable(result: Extract<SbxAvailability, { available: false }>): string {
    return describeSbxUnavailable(result)
  }

  async function templateExists(ref: string): Promise<boolean> {
    try {
      const result = await run(['template', 'ls'])
      if (result.exitCode !== 0) return false
      return sbxTemplateMatches(parseSbxTemplateList(result.stdout), ref)
    } catch {
      return false
    }
  }

  function templateLoadHint(_ref: string): string {
    return 'sbx template load <tar>'
  }

  async function loadTemplate(tarPath: string, _ref: string): Promise<void> {
    const result = await run(['template', 'load', tarPath], { timeout: SBX_TEMPLATE_LOAD_TIMEOUT })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to load sandbox template: ${result.stderr || result.stdout}`)
    }
  }

  async function createSandbox(
    name: string,
    workspaces: SandboxWorkspace[],
    opts?: CreateSandboxOpts,
  ): Promise<void> {
    const args = buildSbxCreateArgs(name, workspaces, {
      template: opts?.template,
      memory: normalizeSbxMemory(opts?.resources?.memory, logger),
      cpus: parseSbxCpus(opts?.resources?.cpus, logger),
    })
    const result = await run(args, { timeout: SBX_DEFAULT_TIMEOUT })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create sandbox: ${result.stderr}`)
    }
  }

  async function removeSandbox(name: string): Promise<void> {
    return removeSandboxWith(run, ['rm', '--force', name], SBX_REMOVE_MISSING_RE)
  }

  async function exec(name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult> {
    const args = buildSbxExecArgs(name, prefixCommandWithCwd(command, opts?.cwd), { envFile: opts?.envFile })
    return run(args, { timeout: opts?.timeout ?? SBX_DEFAULT_TIMEOUT, abort: opts?.abort })
  }

  async function execPipe(
    name: string,
    command: string,
    stdin: string,
    opts?: { timeout?: number; abort?: AbortSignal; envFile?: string },
  ): Promise<CommandResult> {
    const args = buildSbxExecArgs(name, command, { interactive: true, envFile: opts?.envFile })
    return run(args, { timeout: opts?.timeout ?? SBX_DEFAULT_TIMEOUT, stdin, abort: opts?.abort })
  }

  async function allowNetworkHost(host: string): Promise<boolean> {
    try {
      const result = await run(['policy', 'allow', 'network', host])
      return result.exitCode === 0
    } catch {
      return false
    }
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
