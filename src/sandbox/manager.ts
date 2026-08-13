import type { SandboxRuntime, SandboxWorkspace } from './msb'
import { buildNetworkAllow, egressRestrictionRequested, describeMsbUnavailable, type MsbAvailability } from './msb'
import type { Logger, SandboxResources, SandboxMountConfig, SandboxSecretConfig } from '../types'
import { resolve, join, isAbsolute, posix as posixPath } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { defaultGitService, type GitService } from '../utils/git-service'
import { canonicalizePath, isSameOrDescendantPath, type SandboxMount } from './path'
import { formatTemplateBuildCommands } from './template'

export interface SandboxManagerConfig {
  image: string
  resources?: SandboxResources
  sourceProjectDir?: string
  mountProjectReadonly?: boolean
  customMounts?: SandboxMountConfig[]
  buildContextDir?: string
  browserControl?: boolean
  /**
   * Host path of opencode's tool-output (truncation) directory. When set and present, it is
   * bind-mounted read-only at the identical container path so the agent's in-container tools
   * (`sh`, `glob`, `grep`) can read overflow files that opencode references by absolute host path.
   */
  toolOutputDir?: string
  /**
   * Host path of the shared loop scratch/temp directory. When set, it is created if missing and
   * bind-mounted read-WRITE at the identical container path, so absolute temp paths resolve
   * unchanged inside the container and match the host (worktree-only) view.
   */
  tmpDir?: string
  /**
   * Network policy for the msb sandbox. `env` lists host environment variable names to inject
   * into the guest at create time (bare `-e <NAME>`, so values stay off the command line).
   * `secrets` lists host-held credentials that never enter the guest (msb substitutes them only
   * for the listed hosts at the network boundary). `allow` opts into egress restriction: when it
   * is empty msb's own allow-public default applies, and configuring any host switches the
   * sandbox to deny-by-default with one allow rule per validated host.
   */
  network?: { env?: string[]; allow?: string[]; secrets?: SandboxSecretConfig[] }
}

const DEFAULT_RESOURCES: Required<Pick<SandboxResources, 'memory' | 'cpus'>> = {
  memory: '8g',
  cpus: '4',
}

function normalizeContainerPath(path: string): string {
  const normalized = posixPath.normalize(path)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function containerPathsOverlap(a: string, b: string): boolean {
  const left = normalizeContainerPath(canonicalizePath(a))
  const right = normalizeContainerPath(canonicalizePath(b))
  return isSameOrDescendantPath(left, right) || isSameOrDescendantPath(right, left)
}

function findContainerPathCollision(container: string, used: ReadonlySet<string>): string | undefined {
  for (const existing of used) {
    if (containerPathsOverlap(container, existing)) return existing
  }
  return undefined
}

function isStrictDescendantPath(path: string, prefix: string): boolean {
  const resolved = normalizeContainerPath(canonicalizePath(path))
  const base = normalizeContainerPath(canonicalizePath(prefix))
  return resolved !== base && resolved.startsWith(base + '/')
}

/**
 * Whether a new workspace cannot coexist with an already-accepted one on an overlapping path.
 * msb accepts nested workspace mounts, but a read-only mount applies to its whole subtree, so
 * flags cannot differ across a nesting boundary: a read-only ancestor silently makes a
 * read-write descendant read-only, and a read-write descendant of a read-only mount never takes
 * effect. The one safe flag mismatch is a read-only mount strictly inside a read-write mount,
 * which merely restricts that subtree. Matching flags always coexist.
 */
function mountConflictsWith(next: SandboxMount, accepted: SandboxMount): boolean {
  if (!containerPathsOverlap(next.hostDir, accepted.hostDir)) return false
  const nextReadOnly = next.readOnly === true
  const acceptedReadOnly = accepted.readOnly === true
  if (nextReadOnly === acceptedReadOnly) return false
  if (nextReadOnly) {
    return !isStrictDescendantPath(next.hostDir, accepted.hostDir)
  }
  return true
}

/** Whether an accepted mount with the same access already covers `next`, making it redundant. */
function mountAlreadyCovered(next: SandboxMount, accepted: SandboxMount): boolean {
  if ((next.readOnly === true) !== (accepted.readOnly === true)) return false
  return isSameOrDescendantPath(
    normalizeContainerPath(canonicalizePath(next.hostDir)),
    normalizeContainerPath(canonicalizePath(accepted.hostDir)),
  )
}

export function resolveCustomMounts(
  raw: SandboxMountConfig[] | undefined,
  reservedHostPaths: ReadonlySet<string>,
  logger: Logger,
): SandboxMount[] {
  if (!raw || raw.length === 0) return []
  const resolved: SandboxMount[] = []
  const used = new Set<string>(reservedHostPaths)
  for (const entry of raw) {
    const host = entry?.host?.trim()
    if (!host) {
      logger.log(`Sandbox: skipping custom mount with missing host path: ${JSON.stringify(entry)}`)
      continue
    }
    if (!isAbsolute(host)) {
      logger.log(`Sandbox: skipping custom mount; host path must be absolute: ${host}`)
      continue
    }
    const hostDir = resolve(host)
    if (!existsSync(hostDir)) {
      logger.log(`Sandbox: skipping custom mount; host path does not exist: ${hostDir}`)
      continue
    }
    const collision = findContainerPathCollision(hostDir, used)
    if (collision) {
      logger.log(`Sandbox: skipping custom mount; host path already in use: ${hostDir} conflicts with ${collision}`)
      continue
    }
    used.add(hostDir)
    resolved.push({ hostDir, containerDir: hostDir, readOnly: entry.readonly !== false })
  }
  return resolved
}

const DOCKER_AVAILABLE_TTL = 30_000
const LIVENESS_CHECK_TTL = 2_000

export interface ActiveSandbox {
  containerName: string
  projectDir: string
  startedAt: string
  mounts: SandboxMount[]
}

export interface SandboxManager {
  runtime: SandboxRuntime
  start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
  isActive(worktreeName: string): boolean
  isLive(worktreeName: string): Promise<boolean>
  cleanupOrphans(preserveWorktrees?: string[]): Promise<number>
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
}

function dropConflictingMounts(mounts: SandboxMount[], logger: Logger): SandboxMount[] {
  const accepted: SandboxMount[] = []
  const kept: SandboxMount[] = []
  for (const mount of mounts) {
    if (accepted.some((existing) => mountConflictsWith(mount, existing))) {
      logger.log(`Sandbox: dropping workspace ${mount.hostDir} because it overlaps an already-mounted host dir with conflicting permissions`)
      continue
    }
    if (accepted.some((existing) => mountAlreadyCovered(mount, existing))) continue
    accepted.push(mount)
    kept.push(mount)
  }
  return kept
}

/**
 * Maps the resolved mount plan to `msb create` workspaces. msb accepts nested workspace
 * mounts, so overlapping read-write mounts (worktree + git dirs) coexist; a mount is dropped
 * only when its read-only flag conflicts with an accepted mount's (see `mountConflictsWith`).
 * Callers must still pass mounts in priority order (worktree → git dirs → read-only project →
 * tool-output → temp → custom) so the first-accepted flag wins when a conflict is unavoidable.
 *
 * Host paths are canonicalized here because msb refuses to mount a host path that traverses a
 * symlink, failing the entire sandbox with `ENOTDIR`. On macOS that breaks every `os.tmpdir()`
 * mount, since `/var` is a symlink to `private/var`. The container path is deliberately left
 * uncanonicalized so absolute paths handed to the agent resolve identically inside the sandbox.
 */
export function buildSandboxWorkspaces(mounts: SandboxMount[], logger: Logger): SandboxWorkspace[] {
  return dropConflictingMounts(mounts, logger).map((mount) => ({
    hostDir: canonicalizePath(mount.hostDir),
    containerDir: mount.containerDir,
    readOnly: mount.readOnly,
  }))
}

export function createSandboxManager(
  runtime: SandboxRuntime,
  config: SandboxManagerConfig,
  logger: Logger,
  git: GitService = defaultGitService,
): SandboxManager {
  const activeSandboxes = new Map<string, ActiveSandbox>()
  const lastLivenessCheck = new Map<string, number>()
  const ensureRunningInFlight = new Map<string, Promise<string>>()
  const gitMountCache = new Map<string, SandboxMount[]>()
  const convergedSecrets = new Set<string>()
  const handledSecretEnvs = new Map<string, Set<string>>()
  const warnedUnsetSecretEnv = new Set<string>()
  let runtimeAvailableCache: { value: MsbAvailability; at: number } | null = null
  let imageReady = false

  async function ensureRuntimeAvailable(): Promise<void> {
    const now = Date.now()
    if (runtimeAvailableCache && (now - runtimeAvailableCache.at) < DOCKER_AVAILABLE_TTL) {
      if (!runtimeAvailableCache.value.available) {
        throw new Error(describeMsbUnavailable(runtimeAvailableCache.value))
      }
      return
    }
    const result = await runtime.checkAvailable()
    // An inconclusive probe says nothing about availability: the probe can exhaust its query
    // bound under startup load (every worktree probes independently), so a timeout or throw is
    // not evidence the runtime is unusable. Failing on it would block loop launches under
    // exactly the concurrency forge exists to provide, and caching it would extend one slow probe
    // into a window of refusals. Proceed instead and let the real operation report authoritatively.
    if (!result.available && result.reason === 'unknown') {
      logger.log(`Sandbox: could not determine daemon availability (${result.detail ?? 'no detail'}); continuing`)
      return
    }
    runtimeAvailableCache = { value: result, at: now }
    if (!result.available) {
      throw new Error(describeMsbUnavailable(result))
    }
  }

  async function ensureTemplate(): Promise<void> {
    if (imageReady) return
    const exists = await runtime.templateExists(config.image)
    if (!exists) {
      // A runtime that cannot answer `msb images` is indistinguishable from a missing template,
      // so confirm it is really reachable before telling the user to rebuild the image.
      const availability = await runtime.checkAvailable()
      if (!availability.available) {
        if (availability.reason === 'unknown') return
        throw new Error(describeMsbUnavailable(availability))
      }
      const buildHint = `  ${formatTemplateBuildCommands(
        config.buildContextDir ?? '<build-context-dir>',
        config.image,
        { browserControl: config.browserControl },
      )}`
      throw new Error(
        `Sandbox template "${config.image}" not found. Build and load it first:\n${buildHint}\n\n` +
        `To disable the sandbox, set "sandbox": { "enabled": false } in your forge config.`
      )
    }
    imageReady = true
  }

  function buildMountPlan(projectDir: string): { mounts: SandboxMount[] } {
    const absolute = resolve(projectDir)
    // `msb` mounts every workspace at its identical host path (there is no separate
    // `/workspace` container path), so the primary worktree mount is hostDir == containerDir.
    const worktreeMount: SandboxMount = { hostDir: absolute, containerDir: absolute }

    const gitMounts = detectGitMount(absolute)
    // Outer/common dir first so it survives the overlap drop and keeps the whole git metadata
    // region writable (the nested worktree git dir is swallowed by its common dir).
    const orderedGitMounts = [...gitMounts].sort((a, b) => a.hostDir.length - b.hostDir.length)

    const sourceProjectDir = config.sourceProjectDir
    const resolvedSourceProjectDir = sourceProjectDir ? resolve(sourceProjectDir) : undefined
    const hasProjectMount = config.mountProjectReadonly !== false
      && !!resolvedSourceProjectDir
      && resolvedSourceProjectDir !== absolute
      && existsSync(resolvedSourceProjectDir)
    const projectMount: SandboxMount | undefined = hasProjectMount
      ? { hostDir: resolvedSourceProjectDir, containerDir: resolvedSourceProjectDir, readOnly: true }
      : undefined

    const toolOutputMount = resolveToolOutputMount(absolute)
    const tmpMount = resolveTempMount(absolute)

    const reserved = new Set<string>([worktreeMount.containerDir, ...orderedGitMounts.map((m) => m.containerDir)])
    if (projectMount) reserved.add(projectMount.containerDir)
    if (toolOutputMount) reserved.add(toolOutputMount.containerDir)
    if (tmpMount) reserved.add(tmpMount.containerDir)
    const customMounts = resolveCustomMounts(config.customMounts, reserved, logger)

    // Priority order is load-bearing: worktree first, then git dirs (outer/common dir first so
    // it survives any conflict and keeps the whole git metadata region writable), then the
    // read-only project mount, then tool-output/temp/custom. msb accepts nested workspaces, so
    // read-write mounts (worktree + git dirs) all mount even when one nests inside another; the
    // read-only project workspace is dropped because it is an ancestor of the writable git
    // workspaces and a read-only ancestor silently makes them read-only inside the sandbox.
    // Never resolve that conflict by making the project workspace read-write — that would let a
    // sandboxed agent modify the user's main checkout.
    const candidates: SandboxMount[] = [
      worktreeMount,
      ...orderedGitMounts,
      ...(projectMount ? [projectMount] : []),
      ...(toolOutputMount ? [toolOutputMount] : []),
      ...(tmpMount ? [tmpMount] : []),
      ...customMounts,
    ]

    const mounts = dropConflictingMounts(candidates, logger)

    return { mounts }
  }

  function resolveToolOutputMount(workspaceDir: string): SandboxMount | undefined {
    const dir = config.toolOutputDir
    if (!dir) return undefined
    const resolved = resolve(dir)
    if (!existsSync(resolved)) {
      logger.log(`Sandbox: skipping tool-output mount; directory does not exist: ${resolved}`)
      return undefined
    }
    if (resolved === workspaceDir || resolved.startsWith(workspaceDir + '/')) return undefined
    return { hostDir: resolved, containerDir: resolved, readOnly: true }
  }

  function resolveTempMount(workspaceDir: string): SandboxMount | undefined {
    const dir = config.tmpDir
    if (!dir) return undefined
    const resolved = resolve(dir)
    try {
      mkdirSync(resolved, { recursive: true })
    } catch (err) {
      logger.log(`Sandbox: skipping temp mount; could not create ${resolved}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
    if (resolved === workspaceDir || resolved.startsWith(workspaceDir + '/')) return undefined
    return { hostDir: resolved, containerDir: resolved, readOnly: false }
  }

  function detectGitMount(projectDir: string): SandboxMount[] {
    const cached = gitMountCache.get(projectDir)
    if (cached) return cached

    const gitDirResult = git.revParseGitDir(projectDir)
    const commonDirResult = git.revParseGitCommonDir(projectDir)
    if (!gitDirResult.ok || !commonDirResult.ok || !gitDirResult.stdout || !commonDirResult.stdout) {
      gitMountCache.set(projectDir, [])
      return []
    }

    const paths = new Set<string>()
    const resolvedGitDir = resolve(projectDir, gitDirResult.stdout.trim())
    const resolvedCommonDir = resolve(projectDir, commonDirResult.stdout.trim())

    if (!isSameOrDescendantPath(canonicalizePath(resolvedGitDir), canonicalizePath(projectDir))) {
      paths.add(resolvedGitDir)
    }

    if (!isSameOrDescendantPath(canonicalizePath(resolvedCommonDir), canonicalizePath(projectDir))) {
      paths.add(resolvedCommonDir)
    }

    const result: SandboxMount[] = [...paths].map((hostDir) => ({ hostDir, containerDir: hostDir, readOnly: false }))

    // The git metadata region is mounted read-write so in-sandbox git works, which would also let
    // the sandbox plant a hook that runs on the host under the user's account. Forge's own git
    // disables hooksPath (see `git-service`), but the user's git in the same repository does not,
    // so the hooks directory is re-mounted read-only inside the writable region. `msb` workspaces
    // are directories only, so the repo-local config file cannot be protected the same way.
    const hooksDir = join(resolvedCommonDir, 'hooks')
    if (existsSync(hooksDir)) {
      result.push({ hostDir: hooksDir, containerDir: hooksDir, readOnly: true })
    }

    gitMountCache.set(projectDir, result)
    return result
  }

  /**
   * Single point that records a usable sandbox in the active map, shared by the create and
   * adopt paths in `start` and by `resolveUsableSandbox`. An existing entry's `startedAt` wins
   * so adopting a sandbox never resets the time it actually came up. A precomputed mount plan
   * is reused when provided so the create path does not run it twice.
   */
  function registerActiveSandbox(worktreeName: string, containerName: string, projectDir: string, startedAt?: string, mounts?: SandboxMount[]): void {
    const active = activeSandboxes.get(worktreeName)
    activeSandboxes.set(worktreeName, {
      containerName,
      projectDir: resolve(projectDir),
      startedAt: active?.startedAt ?? startedAt ?? new Date().toISOString(),
      mounts: mounts ?? buildMountPlan(projectDir).mounts,
    })
  }

  /**
   * Resolves the configured env passthrough against the live host environment. msb fails the
   * create when a bare `-e NAME` references an unset host variable, so only defined values are
   * forwarded and the omission is logged.
   */
  function resolvePassthroughEnv(): string[] {
    return (config.network?.env ?? []).filter((name) => {
      if (process.env[name] === undefined) {
        logger.log(`Sandbox: skipping env passthrough ${name}: host variable is not set`)
        return false
      }
      return true
    })
  }

  /**
   * Resolves the configured secrets against the live host environment. Entries without an env
   * name or allowed hosts are misconfigurations, and msb refuses a secret whose host variable is
   * unset at create, so each skipped entry is logged with its reason.
   */
  function resolveSandboxSecrets(): SandboxSecretConfig[] {
    const resolved: SandboxSecretConfig[] = []
    for (const raw of config.network?.secrets ?? []) {
      const env = raw.env.trim()
      if (!env) {
        logger.log('Sandbox: skipping secret: missing env name')
        continue
      }
      const hosts = (raw.hosts ?? []).map((h) => h.trim()).filter(Boolean)
      if (hosts.length === 0) {
        logger.log(`Sandbox: skipping secret ${env}: no allowed hosts`)
        continue
      }
      if (process.env[env] === undefined) {
        if (!warnedUnsetSecretEnv.has(env)) {
          warnedUnsetSecretEnv.add(env)
          logger.log(`Sandbox: skipping secret ${env}: host variable is not set; sandboxed shell commands will fail until the variable is exported in the environment that launches opencode (configured under sandbox.network.secrets)`)
        }
        continue
      }
      resolved.push({ env, hosts })
    }
    return resolved
  }

  /**
   * Rotates the configured host-held secrets on a sandbox forge is adopting. Create-time
   * bindings are captured once, but adoption reuses a long-lived container across plugin
   * restarts, so a rotated host token would otherwise stay stale for the life of the sandbox.
   * Runs only on adopt paths: the fresh-create path already bound the same filtered list.
   * A failure is logged and swallowed so a rotation failure cannot block a loop from starting.
   */
  async function refreshSecrets(containerName: string): Promise<void> {
    if (convergedSecrets.has(containerName)) return
    const secrets = resolveSandboxSecrets()
    if (secrets.length === 0) {
      convergedSecrets.add(containerName)
      return
    }
    warnUncoveredSecretHosts(containerName, secrets)
    if (!(await runtime.refreshSandboxSecrets(containerName, secrets))) {
      logger.log(`Sandbox: failed to refresh secrets for ${containerName}`)
    }
    convergedSecrets.add(containerName)
    recordHandledSecretEnvs(containerName, secrets)
  }

  function recordHandledSecretEnvs(containerName: string, secrets: SandboxSecretConfig[]): void {
    const known = handledSecretEnvs.get(containerName) ?? new Set<string>()
    for (const secret of secrets) known.add(secret.env)
    handledSecretEnvs.set(containerName, known)
  }

  function warnUncoveredSecretHosts(containerName: string, secrets: SandboxSecretConfig[]): void {
    const known = handledSecretEnvs.get(containerName)
    const introduced = known ? secrets.filter((s) => !known.has(s.env)) : secrets
    if (introduced.length === 0) return
    logger.log(`Sandbox: egress for secret host(s) of ${introduced.map((s) => s.env).join(', ')} may be unreachable in ${containerName}: msb cannot change egress rules on an existing sandbox, so recreate the sandbox for the new host(s) to be allowed`)
  }

  async function start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }> {
    await ensureRuntimeAvailable()
    await ensureTemplate()

    const containerName = runtime.sandboxContainerName(worktreeName)

    const absoluteProjectDir = resolve(projectDir)
    const state = await runtime.getSandboxState(containerName)
    // `unknown` means the state query failed and says nothing about the sandbox: adopting
    // could register a non-existent container as usable, and creating could collide with a
    // live one. Fail closed and let the caller surface the indeterminate state.
    if (state === 'unknown') {
      throw new Error(
        `Could not determine whether sandbox ${containerName} exists (state query failed); refusing to start`,
      )
    }
    if (state !== 'missing') {
      logger.log(`Sandbox ${containerName} already exists (${state}), adopting`)
      await refreshSecrets(containerName)
      registerActiveSandbox(worktreeName, containerName, projectDir, startedAt)
      return { containerName }
    }

    const { mounts } = buildMountPlan(absoluteProjectDir)
    const workspaces = buildSandboxWorkspaces(mounts, logger)
    const resources: SandboxResources = {
      memory: config.resources?.memory ?? DEFAULT_RESOURCES.memory,
      maxMemory: config.resources?.maxMemory,
      cpus: config.resources?.cpus ?? DEFAULT_RESOURCES.cpus,
      maxCpus: config.resources?.maxCpus,
      dockerDisk: config.resources?.dockerDisk,
    }
    // Secret destinations are unioned into the egress allow-list: msb's proxy is deny-by-default
    // at the sandbox level, so a secrets-only configuration would otherwise never reach its hosts.
    const secrets = resolveSandboxSecrets()
    const memoryLabel = resources.maxMemory ? `${resources.memory}/max ${resources.maxMemory}` : resources.memory
    const cpusLabel = resources.maxCpus ? `${resources.cpus}/max ${resources.maxCpus}` : resources.cpus
    logger.log(`Creating sandbox ${containerName} for ${absoluteProjectDir} (memory=${memoryLabel} cpus=${cpusLabel} workspaces=${workspaces.length})`)
    await runtime.createSandbox(containerName, workspaces, {
      image: config.image,
      resources,
      networkAllow: buildNetworkAllow(config.network?.allow, secrets, logger),
      restrictEgress: egressRestrictionRequested(config.network?.allow, secrets),
      env: resolvePassthroughEnv(),
      secrets,
    })
    convergedSecrets.add(containerName)
    recordHandledSecretEnvs(containerName, secrets)
    registerActiveSandbox(worktreeName, containerName, projectDir, startedAt, mounts)
    logger.log(`Sandbox ${containerName} started`)

    return { containerName }
  }

  async function stop(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName || runtime.sandboxContainerName(worktreeName)

    // Fail-closed on the five-state contract: `unknown` means the state query failed and says
    // nothing about the sandbox, so removal could destroy a live container that a concurrent or
    // indeterminate query cannot see. Preserve the active-map entry (if any) so callers can
    // observe the indeterminate state, and refuse to touch the sandbox. `missing` is a confirmed
    // absence: clear stale local bookkeeping without invoking msb.
    const state = await runtime.getSandboxState(containerName)
    if (state === 'unknown') {
      const err = new Error(
        `Could not determine whether sandbox ${containerName} exists (state query failed); refusing to remove`,
      )
      logger.log(`Sandbox ${containerName} stop: ${err.message}`)
      throw err
    }
    if (state === 'missing') {
      activeSandboxes.delete(worktreeName)
      convergedSecrets.delete(containerName)
      handledSecretEnvs.delete(containerName)
      logger.log(`Sandbox ${containerName} already gone`)
      return
    }

    // Cleanup (in-memory map entry) always runs; the removal failure is rethrown so
    // callers that own the container lifecycle (e.g. the session-sandbox controller) can observe
    // that the container may still be live instead of recording a successful stop.
    let removalError: unknown = null
    try {
      await runtime.removeSandbox(containerName)
      logger.log(`Sandbox ${containerName} removed`)
    } catch (err) {
      removalError = err
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox ${containerName} removal: ${errMsg}`)
    } finally {
      // Cleanup of the in-memory map entry must never be skipped: a stale entry would leave the
      // manager believing a removed container is live, blocking recreation.
      activeSandboxes.delete(worktreeName)
      convergedSecrets.delete(containerName)
      handledSecretEnvs.delete(containerName)
    }
    if (removalError) throw removalError
  }

  function getActive(worktreeName: string): ActiveSandbox | null {
    return activeSandboxes.get(worktreeName) || null
  }

  function isActive(worktreeName: string): boolean {
    return activeSandboxes.has(worktreeName)
  }

  /**
   * A `stopped` sandbox is live: msb suspends idle microVMs and `msb exec` resumes them in
   * place. Only a confirmed-`missing` sandbox invalidates the map entry — `unknown` means the
   * status query failed and is not evidence the sandbox is gone.
   */
  async function isLive(worktreeName: string): Promise<boolean> {
    const active = activeSandboxes.get(worktreeName)
    if (!active) {
      return false
    }

    const containerName = active.containerName
    const state = await runtime.getSandboxState(containerName)

    if (state === 'missing') {
      logger.log(`Sandbox: sandbox ${containerName} no longer exists, removing stale map entry for ${worktreeName}`)
      activeSandboxes.delete(worktreeName)
      return false
    }

    return true
  }

  async function cleanupOrphans(preserveWorktrees?: string[]): Promise<number> {
    const sandboxes = await runtime.listSandboxesByPrefix('forge-')
    let removed = 0

    const preserveSet = preserveWorktrees
      ? new Set(preserveWorktrees.map((wt) => runtime.sandboxContainerName(wt)))
      : new Set<string>()

    for (const name of sandboxes) {
      if (preserveSet.has(name)) {
        continue
      }
      try {
        await runtime.removeSandbox(name)
        removed++
        convergedSecrets.delete(name)
        handledSecretEnvs.delete(name)
        logger.log(`Removed orphaned sandbox: ${name}`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(`Failed to remove orphaned sandbox ${name}: ${errMsg}`)
      }
    }

    if (!preserveWorktrees) {
      activeSandboxes.clear()
      convergedSecrets.clear()
      handledSecretEnvs.clear()
    } else {
      for (const key of activeSandboxes.keys()) {
        if (!preserveWorktrees.includes(key)) {
          activeSandboxes.delete(key)
        }
      }
    }

    return removed
  }

  async function restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void> {
    await ensureRunning(worktreeName, projectDir, startedAt)
  }

  /**
   * Single decision point for "is this worktree's sandbox usable?", shared by the mapped and
   * unmapped paths. `running` and `stopped` are both usable — msb suspends idle microVMs to
   * `stopped` and `msb exec` resumes them in place, so recreating one would needlessly destroy
   * container-local state. `unknown` means the status query failed and says nothing about the
   * sandbox, so an existing entry is kept as-is (without refreshing the liveness timestamp, so
   * the next call re-checks) and only a confirmed-`missing` sandbox is created.
   */
  async function resolveUsableSandbox(worktreeName: string, projectDir: string, startedAt?: string): Promise<string> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName ?? runtime.sandboxContainerName(worktreeName)
    const state = await runtime.getSandboxState(containerName)

    if (state === 'running' || state === 'stopped') {
      await refreshSecrets(containerName)
      registerActiveSandbox(worktreeName, containerName, projectDir, startedAt)
      lastLivenessCheck.set(worktreeName, Date.now())
      return containerName
    }

    if (state === 'unknown' && active) {
      logger.log(`Sandbox: state of ${containerName} is unknown, keeping ${worktreeName} unchanged`)
      return active.containerName
    }

    const result = await start(worktreeName, projectDir, startedAt)
    lastLivenessCheck.set(worktreeName, Date.now())
    return result.containerName
  }

  async function ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string> {
    const active = activeSandboxes.get(worktreeName)
    const lastCheck = lastLivenessCheck.get(worktreeName)
    const now = Date.now()

    if (active && lastCheck !== undefined && (now - lastCheck) < LIVENESS_CHECK_TTL) {
      return active.containerName
    }

    // Single-flight per worktree: concurrent callers would otherwise each run the create path and
    // race one another, with the loser's create rejected while the winner's is still in flight.
    const inFlight = ensureRunningInFlight.get(worktreeName)
    if (inFlight) return inFlight

    const pending = resolveUsableSandbox(worktreeName, projectDir, startedAt)
      .finally(() => ensureRunningInFlight.delete(worktreeName))
    ensureRunningInFlight.set(worktreeName, pending)
    return pending
  }

  return {
    runtime,
    start,
    stop,
    getActive,
    isActive,
    isLive,
    cleanupOrphans,
    restore,
    ensureRunning,
  }
}
