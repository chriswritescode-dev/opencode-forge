import { z } from 'zod'
import type { Logger, SandboxResources, SandboxSecretConfig } from '../types'
import { runCommand, COMMAND_TIMEOUT_EXIT_CODE, type CommandResult } from './process'
import { MSB_SIZE_RE, SANDBOX_RESOURCE_DEFAULTS, type SandboxRuntimeSettings } from './loop-settings'

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
  hostDir: string
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

export const SANDBOX_CACHE_DIR = '/opt/forge/cache'

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

const MIB_PER_UNIT = new Map<string, number>([['k', 1 / 1024], ['m', 1], ['g', 1024]])

export function msbSizeToMib(size: string): number | undefined {
  const match = /^(?<amount>\d+(?:\.\d+)?)(?<unit>[kmg])b?$/i.exec(size.trim())
  const amount = match?.groups?.amount
  const unit = match?.groups?.unit
  if (amount === undefined || unit === undefined) return undefined
  const factor = MIB_PER_UNIT.get(unit.toLowerCase())
  if (factor === undefined) return undefined
  return Math.round(Number(amount) * factor)
}

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

function buildSecretFlags(secrets: SandboxSecretConfig[] | undefined): string[] {
  const flags: string[] = []
  for (const secret of normalizeSecrets(secrets)) {
    flags.push('--secret', `${secret.env}@${secret.hosts.join(',')}`)
  }
  return flags
}

const EGRESS_ALLOW_ALL_TOKENS = new Set(['*', '**'])

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

export function cacheDiskVolumeName(containerName: string): string {
  return `${sanitizeMsbName(containerName)}-cache-data`
}

export function buildMsbCreateArgs(
  name: string,
  workspaces: SandboxWorkspace[],
  opts: {
    image: string
    memory?: string
    cpus?: number
    networkAllow?: string[]
    restrictEgress?: boolean
    dockerDisk?: string
    cacheDisk?: string
    env?: string[]
    secrets?: SandboxSecretConfig[]
    allowLan?: boolean
  },
): string[] {
  if (workspaces.length === 0) {
    throw new Error('buildMsbCreateArgs requires at least one workspace')
  }
  const args = ['create', opts.image, '--name', name, '--quiet']
  if (opts.cpus !== undefined) args.push('-c', String(opts.cpus))
  if (opts.memory) args.push('-m', opts.memory)
  for (const ws of workspaces) {
    args.push('-v', ws.readOnly ? `${ws.hostDir}:${ws.containerDir}:ro` : `${ws.hostDir}:${ws.containerDir}`)
  }
  const dockerDisk = opts.dockerDisk || SANDBOX_RESOURCE_DEFAULTS.dockerDisk
  args.push('--mount-named', `${dockerDataVolumeName(name)}:/var/lib/docker:kind=disk,size=${dockerDisk}`)
  const cacheDisk = opts.cacheDisk || SANDBOX_RESOURCE_DEFAULTS.cacheDisk
  args.push('--mount-named', `${cacheDiskVolumeName(name)}:${SANDBOX_CACHE_DIR}:kind=disk,size=${cacheDisk}`)
  const restrictEgress =
    opts.restrictEgress === true || (opts.networkAllow ?? []).some((host) => host.trim() !== '')
  if (restrictEgress) {
    args.push('--net-default', 'deny')
    for (const host of opts.networkAllow ?? []) {
      const trimmed = host.trim()
      if (trimmed) args.push('--net-rule', `allow@${trimmed}`)
    }
    if (opts.allowLan) args.push('--net-rule', 'allow@private')
  } else if (opts.allowLan) {
    args.push('--net', 'public,private')
  }
  for (const rawName of opts.env ?? []) {
    const name = rawName.trim()
    if (!name || name.includes('=')) continue
    args.push('-e', name)
  }
  args.push(...buildSecretFlags(opts.secrets))
  return args
}

export type SandboxState = 'running' | 'stopped' | 'transient' | 'missing' | 'unknown'

export interface ImageReferenceParts {
  repository: string
  tag: string
}

const jsonValueSchema = z.json()

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
      return 'transient'
    default:
      return 'unknown'
  }
}

const msbSandboxEntrySchema = z.looseObject({
  name: z.string().min(1),
  status: z.string().optional().catch(undefined),
})

function decodeMsbJson(stdout: string): z.infer<typeof jsonValueSchema> | undefined {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(stdout))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function parseMsbSandboxListOrNull(stdout: string): MsbSandboxEntry[] | null {
  if (stdout.trim() === '') return []
  const data = decodeMsbJson(stdout)
  if (data === undefined) return null
  const entries = z.array(z.unknown()).safeParse(data)
  if (!entries.success) return null
  const out: MsbSandboxEntry[] = []
  for (const raw of entries.data) {
    const entry = msbSandboxEntrySchema.safeParse(raw)
    if (!entry.success) continue
    const status = entry.data.status ?? ''
    out.push({ name: entry.data.name, status, state: mapMsbStatus(status) })
  }
  return out
}

export function parseMsbSandboxList(stdout: string): MsbSandboxEntry[] {
  return parseMsbSandboxListOrNull(stdout) ?? []
}

const msbInspectEnvelopeSchema = z.looseObject({
  config: z.looseObject({
    network: z.looseObject({
      secrets: jsonValueSchema.optional(),
    }),
  }),
})

const msbSecretListSchema = z.looseObject({
  secrets: z.array(z.unknown()),
})

const msbSecretEntrySchema = z.looseObject({
  env_var: z.string().min(1).optional().catch(undefined),
})

export function parseMsbInspectSecretNames(stdout: string): string[] | null {
  const data = decodeMsbJson(stdout)
  if (data === undefined) return null
  const envelope = msbInspectEnvelopeSchema.safeParse(data)
  if (!envelope.success) return null
  const secrets = envelope.data.config.network.secrets
  if (secrets === undefined || secrets === null) return []
  const list = msbSecretListSchema.safeParse(secrets)
  if (!list.success) return null
  const names: string[] = []
  for (const raw of list.data.secrets) {
    const entry = msbSecretEntrySchema.safeParse(raw)
    if (!entry.success || entry.data.env_var === undefined) continue
    names.push(entry.data.env_var)
  }
  return names
}

const msbRuntimeSettingsEnvelopeSchema = z.looseObject({
  config: z.looseObject({
    resources: z.looseObject({
      cpus: z.number(),
      memory_mib: z.number(),
    }),
    network: jsonValueSchema.optional(),
  }),
})

const msbNetworkPolicySchema = z.looseObject({
  policy: z.looseObject({
    rules: z.array(jsonValueSchema),
  }),
})

const msbPolicyRuleSchema = z.looseObject({
  action: z.string(),
  direction: z.string().optional(),
  destination: z.looseObject({
    group: z.string().optional(),
  }),
})

function isAllowLanRule(rule: z.infer<typeof jsonValueSchema>): boolean {
  const parsed = msbPolicyRuleSchema.safeParse(rule)
  return (
    parsed.success
    && parsed.data.action === 'allow'
    && parsed.data.direction !== 'ingress'
    && parsed.data.destination.group === 'private'
  )
}

export function parseMsbInspectRuntimeSettings(stdout: string): SandboxRuntimeSettings | null {
  const data = decodeMsbJson(stdout)
  if (data === undefined) return null
  const envelope = msbRuntimeSettingsEnvelopeSchema.safeParse(data)
  if (!envelope.success) return null
  const { resources, network } = envelope.data.config
  const policy = msbNetworkPolicySchema.safeParse(network)
  const rules = policy.success ? policy.data.policy.rules : []
  const allowLan = rules.some((rule) => isAllowLanRule(rule))
  return { cpus: resources.cpus, memoryMib: resources.memory_mib, allowLan }
}

const msbImageEntrySchema = z.looseObject({
  reference: z.string().min(1).optional().catch(undefined),
})

export function parseMsbImageList(stdout: string): string[] {
  const data = decodeMsbJson(stdout)
  if (data === undefined) return []
  const entries = z.array(z.unknown()).safeParse(data)
  if (!entries.success) return []
  const references: string[] = []
  for (const raw of entries.data) {
    const entry = msbImageEntrySchema.safeParse(raw)
    if (!entry.success || entry.data.reference === undefined) continue
    references.push(entry.data.reference)
  }
  return references
}

function splitImageReference(ref: string): ImageReferenceParts {
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

export const MSB_INSTALL_COMMAND = 'curl -fsSL https://install.microsandbox.dev | sh'

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
      return `The msb sandbox CLI is not installed. Install it with \`${MSB_INSTALL_COMMAND}\`, then try again.`
    case 'host-unsupported':
      return 'This host cannot run microVMs. Run `msb doctor` for details, then try again.'
    case 'unknown':
      return `Could not determine sandbox availability. ${result.detail ?? 'Unknown error.'}`
  }
}

export const MSB_DEFAULT_TIMEOUT = 120000

export interface CreateSandboxOpts {
  image: string
  resources?: SandboxResources
  networkAllow?: string[]
  restrictEgress?: boolean
  env?: string[]
  secrets?: SandboxSecretConfig[]
  allowLan?: boolean
}

export interface SandboxExecOpts {
  timeout?: number
  cwd?: string
  abort?: AbortSignal
}

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
  refreshSandboxSecrets(name: string, secrets: SandboxSecretConfig[]): Promise<boolean>
  readSandboxSettings(name: string): Promise<SandboxRuntimeSettings | null>
  resizeSandbox(name: string, resources: Pick<SandboxResources, 'cpus' | 'memory'>): Promise<void>
}

const MSB_TEMPLATE_LOAD_TIMEOUT = 600000
const MSB_REMOVE_MISSING_RE = /not found|no such sandbox|unknown sandbox|does not exist/i
const MSB_VOLUME_REMOVE_MISSING_RE = /not found|no such volume|unknown volume|does not exist/i

const MSB_CREATE_EXISTS_RE = /already exists/i

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
      cpus: parseMsbCpus(opts.resources?.cpus, logger),
      networkAllow: opts.networkAllow,
      restrictEgress: opts.restrictEgress,
      dockerDisk: normalizeMsbSize(opts.resources?.dockerDisk, logger),
      cacheDisk: normalizeMsbSize(opts.resources?.cacheDisk, logger),
      env: opts.env,
      secrets: opts.secrets,
      allowLan: opts.allowLan,
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

  async function removeNamedVolumes(volumes: string[]): Promise<void> {
    const result = await run(['volume', 'rm', ...volumes])
    if (result.exitCode !== 0 && !MSB_VOLUME_REMOVE_MISSING_RE.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`Failed to remove named volumes: ${result.stderr}`)
    }
  }

  async function removeSandbox(name: string): Promise<void> {
    const result = await run(['rm', '--force', name, '--quiet'])
    if (result.exitCode !== 0 && !MSB_REMOVE_MISSING_RE.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`Failed to remove sandbox: ${result.stderr}`)
    }
    const volumes = [dockerDataVolumeName(name), cacheDiskVolumeName(name)]
    try {
      await removeNamedVolumes(volumes)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox: failed to remove named volumes ${volumes.join(', ')} for ${name}: ${errMsg}`)
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

  async function readSandboxSettings(name: string): Promise<SandboxRuntimeSettings | null> {
    try {
      const result = await run(['inspect', name, '--format', 'json'], { timeout: MSB_QUERY_TIMEOUT })
      return result.exitCode === 0 ? parseMsbInspectRuntimeSettings(result.stdout) : null
    } catch {
      return null
    }
  }

  async function resizeSandbox(name: string, resources: Pick<SandboxResources, 'cpus' | 'memory'>): Promise<void> {
    const cpus = parseMsbCpus(resources.cpus, logger)
    const memory = normalizeMsbSize(resources.memory, logger)
    if (cpus === undefined && memory === undefined) return
    const args = ['modify', name, '--restart']
    if (cpus !== undefined) args.push('--cpus', String(cpus))
    if (memory !== undefined) args.push('--memory', memory)
    const result = await run(args, { timeout: MSB_DEFAULT_TIMEOUT })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to resize sandbox ${name}: ${result.stderr || result.stdout}`)
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
    readSandboxSettings,
    resizeSandbox,
  }
}
