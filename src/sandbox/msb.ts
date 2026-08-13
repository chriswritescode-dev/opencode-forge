import type { Logger, SandboxResources, SandboxSecretConfig } from '../types'
import { runCommand, COMMAND_TIMEOUT_EXIT_CODE, type CommandResult } from './process'

export function sanitizeMsbName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .substring(0, 60)
    .replace(/[-.]+$/g, '')
  return name || 'sandbox'
}

export function sandboxContainerName(worktreeName: string): string {
  return `forge-${sanitizeMsbName(worktreeName)}`
}

export interface SandboxWorkspace {
  /**
   * Host path msb mounts from. Must already be canonicalized: msb cannot mount a host path that
   * traverses a symlink and fails the whole sandbox with `ENOTDIR`, which on macOS hits every
   * `os.tmpdir()` path because `/var` is a symlink to `private/var`.
   */
  hostDir: string
  /** Path the mount appears at inside the sandbox. Kept uncanonicalized so absolute host paths the agent was given still resolve. */
  containerDir: string
  readOnly?: boolean
}

export interface BuildMsbExecOpts {
  workdir?: string
  timeoutMs?: number
}

export function buildMsbExecArgs(name: string, command: string, opts?: BuildMsbExecOpts): string[] {
  const args = ['exec', name, '--no-tty', '--quiet']
  if (opts?.workdir) args.push('-w', opts.workdir)
  if (opts?.timeoutMs) args.push('--timeout', `${Math.ceil(opts.timeoutMs / 1000)}s`)
  args.push('--', 'sh', '-c', command)
  return args
}

const MSB_SIZE_RE = /^\d+(\.\d+)?[kmg]b?$/i
const MSB_DOCKER_DISK_DEFAULT = '16g'

export function parseMsbCpus(raw: string | undefined, logger: Logger): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    logger.log(`Sandbox: non-numeric --cpus value ${JSON.stringify(raw)} ignored`)
    return undefined
  }
  const floored = Math.floor(value)
  if (floored !== value) {
    logger.log(`Sandbox: msb --cpus is integer-only; rounding cpus="${raw}" down to ${floored}`)
  }
  return Math.max(1, floored)
}

export function normalizeMsbSize(raw: string | undefined, logger: Logger): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (!MSB_SIZE_RE.test(raw)) {
    logger.log(`Sandbox: unrecognized size value ${JSON.stringify(raw)} ignored`)
    return undefined
  }
  return raw.toLowerCase().replace(/b$/, '')
}

/**
 * Normalizes secrets into `{ env, hosts }` pairs. Entries with a blank or `=`-bearing env
 * name or an empty host list are misconfigurations that msb refuses anyway; skipping them
 * keeps credential values out of forge's argv. Single source for the create and modify
 * (secret-rotation) argument builders.
 */
function normalizeSecrets(secrets: SandboxSecretConfig[] | undefined): Array<{ env: string; hosts: string[] }> {
  const out: Array<{ env: string; hosts: string[] }> = []
  for (const secret of secrets ?? []) {
    const env = secret.env.trim()
    const hosts = secret.hosts.map((h) => h.trim()).filter(Boolean)
    if (!env || env.includes('=') || hosts.length === 0) continue
    out.push({ env, hosts })
  }
  return out
}

/** Builds `--secret <env>@<hosts>` flag pairs, one pair per normalized secret. */
function buildSecretFlags(secrets: SandboxSecretConfig[] | undefined): string[] {
  const flags: string[] = []
  for (const secret of normalizeSecrets(secrets)) {
    flags.push('--secret', `${secret.env}@${secret.hosts.join(',')}`)
  }
  return flags
}

const EGRESS_ALLOW_ALL_TOKENS = new Set(['*', '**'])

/**
 * Reports whether the configured allow-list explicitly opens sandbox egress to everything.
 * An explicit `*` or `**` must behave identically to an omitted allow-list (no net flags,
 * msb's own allow-by-default applies), because treating it as a host and flipping to
 * `--net-default deny` with zero rules silently inverts "allow everything" into a total
 * lockout. Scope is the allow list only: a secret's destination hosts declare where that
 * secret may be sent, not global egress policy, so a wildcard there remains invalid and is
 * still rejected by the host validator. Precedence: a wildcard entry anywhere in the list
 * beats narrower entries in the same list rather than intersecting with them.
 */
export function egressAllowsAll(allow: string[] | undefined): boolean {
  return (allow ?? []).some((entry) => EGRESS_ALLOW_ALL_TOKENS.has(entry.trim()))
}

function egressHostRejectionReason(host: string): string | undefined {
  if (host.includes(',')) return 'commas separate rule tokens, not hosts'
  if (host.includes(':')) return 'port-qualified hosts need the tcp/udp rule form'
  if (host.includes('@')) return 'the @ character is reserved for rule targets'
  if (host === '*') return 'the bare wildcard is not a valid egress host'
  if (host.startsWith('*.') && host.slice(2).split('.').filter(Boolean).length < 2) {
    return 'wildcard suffixes need at least two labels'
  }
  if (host.startsWith('suffix=') && host.slice(7).split('.').filter(Boolean).length < 2) {
    return 'suffix= domains need at least two labels'
  }
  if (!host.includes('.') && !host.startsWith('domain=')) {
    return 'bare single-label hosts are ambiguous; use domain=name'
  }
  return undefined
}

function collectEgressHostTokens(allow: string[] | undefined, secrets: SandboxSecretConfig[] | undefined): string[] {
  const tokens: string[] = []
  for (const raw of allow ?? []) {
    const host = raw.trim()
    if (host) tokens.push(host)
  }
  for (const secret of normalizeSecrets(secrets)) {
    for (const host of secret.hosts) {
      const trimmed = host.trim()
      if (trimmed) tokens.push(trimmed)
    }
  }
  return tokens
}

/**
 * Unions the configured egress allow-list with the destination hosts of the configured secrets
 * and validates each token. Egress restriction is opt-in: an empty configuration emits no network
 * flags and msb's own allow-by-default applies, while any configured token flips the sandbox to
 * deny-by-default, so a secret whose hosts are not also allow-listed could never reach its
 * destination. An explicit allow-all wildcard (`*` or `**`) short-circuits to an empty rule set,
 * leaving egress unrestricted exactly as an omitted allow-list would. Entries are trimmed, blanks
 * dropped, and the result deduplicated.
 */
export function buildNetworkAllow(
  allow: string[] | undefined,
  secrets: SandboxSecretConfig[] | undefined,
  logger?: Logger,
): string[] {
  if (egressAllowsAll(allow)) {
    logger?.log('Sandbox: wildcard allow-list leaves sandbox egress unrestricted')
    return []
  }
  const tokens = collectEgressHostTokens(allow, secrets)
  const hosts = new Set<string>()
  for (const host of tokens) {
    const reason = egressHostRejectionReason(host)
    if (reason) {
      logger?.log(`Sandbox: skipping egress host ${JSON.stringify(host)}: ${reason}`)
      continue
    }
    hosts.add(host)
  }
  const result = [...hosts]
  if (logger && tokens.length > 0 && result.length === 0) {
    logger.log('Sandbox: every configured egress host was rejected as invalid; sandbox egress is fully denied')
  }
  return result
}

export function egressRestrictionRequested(
  allow: string[] | undefined,
  secrets: SandboxSecretConfig[] | undefined,
): boolean {
  if (egressAllowsAll(allow)) return false
  return collectEgressHostTokens(allow, secrets).length > 0
}

export function dockerDataVolumeName(containerName: string): string {
  return `${sanitizeMsbName(containerName)}-docker-data`
}

export function buildMsbCreateArgs(
  name: string,
  workspaces: SandboxWorkspace[],
  opts: {
    image: string
    memory?: string
    maxMemory?: string
    cpus?: number
    maxCpus?: number
    networkAllow?: string[]
    restrictEgress?: boolean
    dockerDisk?: string
    env?: string[]
    secrets?: SandboxSecretConfig[]
  },
): string[] {
  if (workspaces.length === 0) {
    throw new Error('buildMsbCreateArgs requires at least one workspace')
  }
  const args = ['create', opts.image, '--name', name, '--quiet']
  if (opts.cpus !== undefined) args.push('-c', String(opts.cpus))
  if (opts.maxCpus !== undefined) args.push('--max-cpus', String(opts.maxCpus))
  if (opts.memory) args.push('-m', opts.memory)
  if (opts.maxMemory) args.push('--max-memory', opts.maxMemory)
  for (const ws of workspaces) {
    args.push('-v', ws.readOnly ? `${ws.hostDir}:${ws.containerDir}:ro` : `${ws.hostDir}:${ws.containerDir}`)
  }
  const dockerDisk = opts.dockerDisk || MSB_DOCKER_DISK_DEFAULT
  args.push('--mount-named', `${dockerDataVolumeName(name)}:/var/lib/docker:kind=disk,size=${dockerDisk}`)
  const restrictEgress =
    opts.restrictEgress === true || (opts.networkAllow ?? []).some((host) => host.trim() !== '')
  if (restrictEgress) {
    args.push('--net-default', 'deny')
    for (const host of opts.networkAllow ?? []) {
      const trimmed = host.trim()
      if (trimmed) args.push('--net-rule', `allow@${trimmed}`)
    }
  }
  // Bare `-e <NAME>` only: msb resolves the key from its own environment at start, so the value
  // never appears in forge's argv (and never in `ps` output), unlike `-e NAME=VALUE`.
  for (const rawName of opts.env ?? []) {
    const name = rawName.trim()
    if (!name || name.includes('=')) continue
    args.push('-e', name)
  }
  // Reference form only (`env@host[,host...]`): msb rejects the inline `ENV=VALUE@HOST` form
  // outright, and a secret with no allowed destination is refused, so blank or `=`-bearing env
  // names and empty host lists are skipped.
  args.push(...buildSecretFlags(opts.secrets))
  return args
}

export type SandboxState = 'running' | 'stopped' | 'transient' | 'missing' | 'unknown'

export interface MsbSandboxEntry {
  name: string
  status: string
  state: SandboxState
}

export function mapMsbStatus(status: string): SandboxState {
  switch (status.toLowerCase()) {
    case 'running':
      return 'running'
    case 'stopped':
    case 'crashed':
      return 'stopped'
    case 'created':
    case 'starting':
    case 'draining':
    case 'paused':
      // Known msb states that are not directly executable but prove the sandbox exists
      // (`Created`/`Starting` are cloud-only upstream today; `Draining`/`Paused` occur on local
      // runtimes). They must never collapse into `unknown`, which callers read as a query failure
      // and refuse to act on.
      return 'transient'
    default:
      // An unrecognized status string is not evidence of any particular state: keep it on the
      // fail-closed `unknown` path rather than trusting it as usable or absent.
      return 'unknown'
  }
}

export function parseMsbSandboxListOrNull(stdout: string): MsbSandboxEntry[] | null {
  if (stdout.trim() === '') return []
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const out: MsbSandboxEntry[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!name) continue
    const status = typeof entry.status === 'string' ? entry.status : ''
    out.push({ name, status, state: mapMsbStatus(status) })
  }
  return out
}

export function parseMsbSandboxList(stdout: string): MsbSandboxEntry[] {
  return parseMsbSandboxListOrNull(stdout) ?? []
}

/**
 * Extracts the env names of the secrets currently bound to a sandbox from
 * `msb inspect --format json` (`config.network.secrets.secrets[].env_var`). Returns `null`
 * when the payload cannot be trusted; an absent secrets section means no secrets are bound
 * and yields `[]`.
 */
export function parseMsbInspectSecretNames(stdout: string): string[] | null {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const config = (data as Record<string, unknown>).config
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const network = (config as Record<string, unknown>).network
  if (!network || typeof network !== 'object' || Array.isArray(network)) return null
  const secrets = (network as Record<string, unknown>).secrets
  if (secrets === undefined || secrets === null) return []
  if (typeof secrets !== 'object' || Array.isArray(secrets)) return null
  const list = (secrets as Record<string, unknown>).secrets
  if (!Array.isArray(list)) return null
  const names: string[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const envVar = (raw as Record<string, unknown>).env_var
    if (typeof envVar === 'string' && envVar) names.push(envVar)
  }
  return names
}

export function parseMsbImageList(stdout: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const references: string[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const reference = (raw as Record<string, unknown>).reference
    if (typeof reference === 'string' && reference) references.push(reference)
  }
  return references
}

/**
 * Splits an image reference into repository and tag. A colon is only a tag separator when it
 * appears after the last `/`; a colon before that is part of a registry authority (e.g.
 * `localhost:5000/oc-forge-sandbox`), so such a tagless reference keeps the full string as the
 * repository and defaults the tag to `latest`.
 */
function splitImageReference(ref: string): { repository: string; tag: string } {
  const lastSlash = ref.lastIndexOf('/')
  const lastColon = ref.lastIndexOf(':')
  if (lastColon > lastSlash) {
    return { repository: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) }
  }
  return { repository: ref, tag: 'latest' }
}

export function msbImageMatches(references: string[], ref: string): boolean {
  const { repository: name, tag } = splitImageReference(ref)
  return references.some((reference) => {
    const { repository, tag: entryTag } = splitImageReference(reference)
    return entryTag === tag && (repository === name || repository.endsWith(`/${name}`))
  })
}

export type MsbAvailability =
  | { available: true }
  | { available: false; reason: 'not-installed' | 'host-unsupported' | 'unknown'; detail?: string }

export type CommandRunner = (
  args: string[],
  opts?: { timeout?: number; stdin?: string; abort?: AbortSignal },
) => Promise<CommandResult>

const MSB_QUERY_TIMEOUT = 30000
const MSB_NOT_INSTALLED_RE = /ENOENT|command not found/i

export async function checkMsbAvailability(run: CommandRunner): Promise<MsbAvailability> {
  let result: CommandResult
  try {
    result = await run(['doctor'], { timeout: MSB_QUERY_TIMEOUT })
  } catch {
    return { available: false, reason: 'unknown' }
  }
  if (result.exitCode === 0) {
    return { available: true }
  }
  if (result.exitCode === COMMAND_TIMEOUT_EXIT_CODE) {
    return {
      available: false,
      reason: 'unknown',
      detail: `\`msb doctor\` did not answer within ${MSB_QUERY_TIMEOUT}ms`,
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`
  if (MSB_NOT_INSTALLED_RE.test(combined)) {
    return { available: false, reason: 'not-installed' }
  }
  return { available: false, reason: 'host-unsupported', detail: combined.trim() }
}

export function describeMsbUnavailable(
  result: Extract<MsbAvailability, { available: false }>,
): string {
  switch (result.reason) {
    case 'not-installed':
      return 'The msb sandbox CLI is not installed. Install it with `curl -fsSL https://install.microsandbox.dev | sh`, then try again.'
    case 'host-unsupported':
      return 'This host cannot run microVMs. Run `msb doctor` for details, then try again.'
    case 'unknown':
      return `Could not determine sandbox availability. ${result.detail ?? 'Unknown error.'}`
  }
}

export const MSB_DEFAULT_TIMEOUT = 120000

/** Options for creating a sandbox. Network egress is expressed here, at create time,
 *  because msb network rules are per sandbox rather than daemon-global. */
export interface CreateSandboxOpts {
  image: string
  resources?: SandboxResources
  networkAllow?: string[]
  restrictEgress?: boolean
  /** Host environment variable names injected into the guest via bare `-e <NAME>`. */
  env?: string[]
  /** Host-held credentials bound via `--secret <env>@<hosts>`; values never enter the guest. */
  secrets?: SandboxSecretConfig[]
}

/** Options for a non-piped sandbox exec. `cwd` maps to the native `-w` flag, so no
 *  `cd '<cwd>' &&` prefix is needed in the command string. */
export interface SandboxExecOpts {
  timeout?: number
  cwd?: string
  abort?: AbortSignal
}

/** Runtime facade over the `msb` CLI. Deliberately lean: no stdin-pipe exec (no production
 *  caller, and `msb exec` has no stdin-pipe flag) and no daemon-global policy calls (network
 *  rules live in `CreateSandboxOpts.networkAllow`). */
export interface SandboxRuntime {
  checkAvailable(): Promise<MsbAvailability>
  templateExists(ref: string): Promise<boolean>
  loadTemplate(tarPath: string, ref: string): Promise<void>
  createSandbox(name: string, workspaces: SandboxWorkspace[], opts: CreateSandboxOpts): Promise<void>
  removeSandbox(name: string): Promise<void>
  exec(name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult>
  getSandboxState(name: string): Promise<SandboxState>
  sandboxContainerName(worktreeName: string): string
  listSandboxesByPrefix(prefix: string): Promise<string[]>
  /** Converges the secrets bound to an existing sandbox to `secrets` via `msb modify`:
   *  `--secret-rm` for names no longer desired, `--secret` for the desired set, and `--restart`
   *  only when a new name is introduced (msb classifies placeholder additions as restart-required
   *  while rotations and removals apply live). Returns `false` on a non-zero exit or a throw;
   *  never rejects. A no-op (nothing bound and nothing desired) returns `true` without invoking
   *  `msb modify`. */
  refreshSandboxSecrets(name: string, secrets: SandboxSecretConfig[]): Promise<boolean>
}

const MSB_TEMPLATE_LOAD_TIMEOUT = 600000
const MSB_REMOVE_MISSING_RE = /not found|no such sandbox|unknown sandbox|does not exist/i
const MSB_VOLUME_REMOVE_MISSING_RE = /not found|no such volume|unknown volume|does not exist/i

/**
 * Matches msb's "already exists" failure from `create`. A create that fails partway through leaves
 * an orphaned sandbox directory that msb still counts as existing, while `ls` omits it and `rm`
 * reports it as missing. `getSandboxState` therefore resolves `missing`, so every retry fails
 * identically and the sandbox is permanently unusable until the directory is deleted by hand.
 * Recreating with `--replace` is msb's own documented way out.
 */
const MSB_CREATE_EXISTS_RE = /already exists/i

/**
 * Assembles a `SandboxRuntime` from the pure `msb` helpers, routing every method through an
 * injectable `CommandRunner`. The default runner spawns the `msb` binary; tests inject a fake.
 */
export function createMsbRuntime(logger: Logger, opts?: { run?: CommandRunner }): SandboxRuntime {
  const run: CommandRunner =
    opts?.run ?? ((args, o) => runCommand('msb', args, { ...o, logger, logLabel: 'msb' }))

  async function checkAvailable(): Promise<MsbAvailability> {
    return checkMsbAvailability(run)
  }

  async function templateExists(ref: string): Promise<boolean> {
    try {
      const result = await run(['images', '--format', 'json'])
      if (result.exitCode !== 0) return false
      return msbImageMatches(parseMsbImageList(result.stdout), ref)
    } catch {
      return false
    }
  }

  async function loadTemplate(tarPath: string, ref: string): Promise<void> {
    const result = await run(['load', '--input', tarPath, '--tag', ref, '--quiet'], {
      timeout: MSB_TEMPLATE_LOAD_TIMEOUT,
    })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to load sandbox template: ${result.stderr || result.stdout}`)
    }
  }

  async function createSandbox(
    name: string,
    workspaces: SandboxWorkspace[],
    opts: CreateSandboxOpts,
  ): Promise<void> {
    const args = buildMsbCreateArgs(name, workspaces, {
      image: opts.image,
      memory: normalizeMsbSize(opts.resources?.memory, logger),
      maxMemory: normalizeMsbSize(opts.resources?.maxMemory, logger),
      cpus: parseMsbCpus(opts.resources?.cpus, logger),
      maxCpus: parseMsbCpus(opts.resources?.maxCpus, logger),
      networkAllow: opts.networkAllow,
      restrictEgress: opts.restrictEgress,
      dockerDisk: normalizeMsbSize(opts.resources?.dockerDisk, logger),
      env: opts.env,
      secrets: opts.secrets,
    })
    const result = await run(args, { timeout: MSB_DEFAULT_TIMEOUT })
    if (result.exitCode === 0) return
    if (!MSB_CREATE_EXISTS_RE.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`Failed to create sandbox: ${result.stderr}`)
    }
    logger.log(
      `Sandbox: msb reports ${name} already exists but it was not reusable (orphaned state); recreating with --replace`,
    )
    const replaced = await run([...args, '--replace'], { timeout: MSB_DEFAULT_TIMEOUT })
    if (replaced.exitCode !== 0) {
      throw new Error(`Failed to create sandbox: ${replaced.stderr}`)
    }
  }

  async function removeDockerDataVolume(name: string): Promise<void> {
    const volume = dockerDataVolumeName(name)
    const result = await run(['volume', 'rm', volume])
    if (result.exitCode !== 0 && !MSB_VOLUME_REMOVE_MISSING_RE.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`Failed to remove docker data volume: ${result.stderr}`)
    }
  }

  async function removeSandbox(name: string): Promise<void> {
    const result = await run(['rm', '--force', name, '--quiet'])
    if (result.exitCode !== 0 && !MSB_REMOVE_MISSING_RE.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`Failed to remove sandbox: ${result.stderr}`)
    }
    try {
      await removeDockerDataVolume(name)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox: failed to remove docker data volume for ${name}: ${errMsg}`)
    }
  }

  async function exec(name: string, command: string, opts?: SandboxExecOpts): Promise<CommandResult> {
    const timeout = opts?.timeout ?? MSB_DEFAULT_TIMEOUT
    const args = buildMsbExecArgs(name, command, { workdir: opts?.cwd, timeoutMs: timeout })
    return run(args, { timeout, abort: opts?.abort })
  }

  async function getSandboxState(name: string): Promise<SandboxState> {
    let result: CommandResult
    try {
      result = await run(['ls', '--format', 'json'], { timeout: MSB_QUERY_TIMEOUT })
    } catch {
      return 'unknown'
    }
    if (result.exitCode !== 0) return 'unknown'
    const entries = parseMsbSandboxListOrNull(result.stdout)
    if (!entries) return 'unknown'
    const entry = entries.find((e) => e.name === name)
    if (!entry) return 'missing'
    return entry.state
  }

  async function listSandboxesByPrefix(prefix: string): Promise<string[]> {
    try {
      const result = await run(['ls', '--format', 'json'], { timeout: MSB_QUERY_TIMEOUT })
      if (result.exitCode !== 0) return []
      return parseMsbSandboxList(result.stdout)
        .map((e) => e.name)
        .filter((n) => n.startsWith(prefix))
    } catch {
      return []
    }
  }

  async function refreshSandboxSecrets(name: string, secrets: SandboxSecretConfig[]): Promise<boolean> {
    // `msb modify --secret` is per-flag additive, so the current bound set must be read back
    // before applying changes; otherwise a secret removed from config stays bound forever.
    // A failed or unparseable inspect carries no information, so refuse to touch anything.
    let current: string[]
    try {
      const inspect = await run(['inspect', name, '--format', 'json'], { timeout: MSB_QUERY_TIMEOUT })
      if (inspect.exitCode !== 0) return false
      const parsed = parseMsbInspectSecretNames(inspect.stdout)
      if (parsed === null) return false
      current = parsed
    } catch {
      return false
    }

    const desired = normalizeSecrets(secrets)
    const desiredNames = new Set(desired.map((s) => s.env))
    const currentNames = new Set(current)
    const stale = current.filter((n) => !desiredNames.has(n))
    if (stale.length === 0 && desired.length === 0) return true

    // Introducing a new env name installs a new placeholder, which msb classifies as
    // restart-required ("placeholder changes need a restart"); without `--restart` the whole
    // modification is rejected and nothing applies. Rotations of an existing name and removals
    // apply live, so they stay restart-free.
    const introduced = desired.some((s) => !currentNames.has(s.env))
    const args = ['modify', name]
    if (introduced) args.push('--restart')
    for (const staleName of stale) args.push('--secret-rm', staleName)
    args.push(...buildSecretFlags(secrets))
    try {
      const result = await run(args, { timeout: introduced ? MSB_DEFAULT_TIMEOUT : MSB_QUERY_TIMEOUT })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  return {
    checkAvailable,
    templateExists,
    loadTemplate,
    createSandbox,
    removeSandbox,
    exec,
    getSandboxState,
    sandboxContainerName,
    listSandboxesByPrefix,
    refreshSandboxSecrets,
  }
}
