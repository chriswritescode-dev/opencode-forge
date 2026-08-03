import type { SandboxRuntime, SandboxWorkspace } from './sbx'
import { describeSbxUnavailable, type SbxAvailability } from './sbx'
import type { Logger, SandboxResources, SandboxMountConfig } from '../types'
import { resolve, join, isAbsolute, posix as posixPath } from 'path'
import { mkdirSync, existsSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { defaultGitService, type GitService } from '../utils/git-service'
import { canonicalizePath, isSameOrDescendantPath, type SandboxMount } from './path'

export interface SandboxManagerConfig {
  image: string
  dataDir?: string
  resources?: SandboxResources
  sourceProjectDir?: string
  mountProjectReadonly?: boolean
  customMounts?: SandboxMountConfig[]
  buildContextDir?: string
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
   * Network policy for the sbx proxy. `env` lists host environment variable names to pass through
   * into the sandbox on every exec (written to a per-sandbox env file under `<dataDir>/sandbox-env/`).
   * `allow` lists egress hosts to permit on the sbx network proxy's default-deny policy.
   */
  network?: { env?: string[]; allow?: string[] }
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
  envFile?: string
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

/**
 * Maps the resolved mount plan to `sbx create` workspaces. `sbx` rejects overlapping
 * workspace paths, so any mount whose hostDir overlaps (in either direction) an earlier
 * accepted hostDir is dropped (with a log). First accepted wins, so callers must pass mounts
 * in priority order (worktree → git dirs → read-only project → tool-output → temp → custom).
 */
export function buildSandboxWorkspaces(mounts: SandboxMount[], logger: Logger): SandboxWorkspace[] {
  const accepted: string[] = []
  const workspaces: SandboxWorkspace[] = []
  for (const mount of mounts) {
    const overlap = accepted.some((hostDir) => containerPathsOverlap(mount.hostDir, hostDir))
    if (overlap) {
      logger.log(`Sandbox: dropping workspace ${mount.hostDir} because it overlaps an already-mounted host dir`)
      continue
    }
    accepted.push(mount.hostDir)
    workspaces.push({ hostDir: mount.hostDir, readOnly: mount.readOnly })
  }
  return workspaces
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
  let runtimeAvailableCache: { value: SbxAvailability; at: number } | null = null
  let imageReady = false
  let allowListApplied = false

  async function ensureRuntimeAvailable(): Promise<void> {
    const now = Date.now()
    if (runtimeAvailableCache && (now - runtimeAvailableCache.at) < DOCKER_AVAILABLE_TTL) {
      if (!runtimeAvailableCache.value.available) {
        throw new Error(describeSbxUnavailable(runtimeAvailableCache.value))
      }
      return
    }
    const result = await runtime.checkAvailable()
    runtimeAvailableCache = { value: result, at: now }
    if (!result.available) {
      throw new Error(describeSbxUnavailable(result))
    }
  }

  async function ensureTemplate(): Promise<void> {
    if (imageReady) return
    const exists = await runtime.templateExists(config.image)
    if (!exists) {
      const buildHint = config.buildContextDir
        ? `  docker build -t ${config.image} "${config.buildContextDir}" && docker save ${config.image} -o <tar> && sbx template load <tar>`
        : `  docker build -t ${config.image} <build-context-dir> && docker save ${config.image} -o <tar> && sbx template load <tar>`
      throw new Error(
        `Sandbox template "${config.image}" not found. Build and load it first:\n${buildHint}\n\n` +
        `To disable the sandbox, set "sandbox": { "enabled": false } in your forge config.`
      )
    }
    imageReady = true
  }

  function buildMountPlan(projectDir: string): { mounts: SandboxMount[] } {
    const absolute = resolve(projectDir)
    // `sbx` mounts every workspace at its identical host path (there is no separate
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
    // it survives the overlap drop and keeps the whole git metadata region writable), then the
    // read-only project mount, then tool-output/temp/custom. Because the first accepted mount
    // wins, the read-only project workspace (an ancestor of the git dirs) is dropped with a log
    // rather than swallowing the writable git workspaces. Never resolve the conflict by making
    // the project workspace read-write — that would let a sandboxed agent modify the user's
    // main checkout.
    const candidates: SandboxMount[] = [
      worktreeMount,
      ...orderedGitMounts,
      ...(projectMount ? [projectMount] : []),
      ...(toolOutputMount ? [toolOutputMount] : []),
      ...(tmpMount ? [tmpMount] : []),
      ...customMounts,
    ]

    const mounts: SandboxMount[] = []
    const accepted = new Set<string>()
    for (const mount of candidates) {
      const overlap = [...accepted].some((hostDir) => containerPathsOverlap(mount.hostDir, hostDir))
      if (overlap) {
        logger.log(`Sandbox: dropping workspace ${mount.hostDir} because it overlaps an already-mounted host dir`)
        continue
      }
      accepted.add(mount.hostDir)
      mounts.push(mount)
    }

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

    const result = [...paths].map((hostDir) => ({ hostDir, containerDir: hostDir, readOnly: false }))
    gitMountCache.set(projectDir, result)
    return result
  }

  function writeEnvPassthroughFile(containerName: string): string | undefined {
    const names = config.network?.env
    if (!names || names.length === 0) return undefined
    const dataDir = config.dataDir
    if (!dataDir) return undefined

    const lines: string[] = []
    for (const name of names) {
      const value = process.env[name]
      if (value !== undefined) {
        lines.push(`${name}=${value}`)
      }
    }
    if (lines.length === 0) return undefined

    const dir = join(dataDir, 'sandbox-env')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${containerName}.env`)
    writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf-8' })
    chmodSync(filePath, 0o600)
    return filePath
  }

  /**
   * Applies the configured egress allowlist to the sbx network proxy. Policy rules are global to
   * sbx, not per sandbox, so they are applied at most once per manager instance. A host that
   * fails to allow is logged but never throws: an unusable rule must not block a loop that does
   * not need that host.
   */
  async function applyNetworkAllowList(): Promise<void> {
    if (allowListApplied) return
    allowListApplied = true
    for (const host of config.network?.allow ?? []) {
      const trimmed = host.trim()
      if (!trimmed) continue
      const ok = await runtime.allowNetworkHost(trimmed)
      if (!ok) {
        logger.log(`Sandbox: failed to allow network host "${trimmed}"`)
      }
    }
  }

  /**
   * Single point that records a usable sandbox in the active map, shared by the adopt path in
   * `start` and by `resolveUsableSandbox`. An existing entry's `startedAt` wins so adopting a
   * sandbox never resets the time it actually came up.
   */
  function registerActiveSandbox(worktreeName: string, containerName: string, projectDir: string, startedAt?: string): void {
    const active = activeSandboxes.get(worktreeName)
    activeSandboxes.set(worktreeName, {
      containerName,
      projectDir: resolve(projectDir),
      startedAt: active?.startedAt ?? startedAt ?? new Date().toISOString(),
      mounts: buildMountPlan(projectDir).mounts,
      envFile: writeEnvPassthroughFile(containerName),
    })
  }

  async function start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }> {
    await ensureRuntimeAvailable()
    await ensureTemplate()
    await applyNetworkAllowList()

    const containerName = runtime.sandboxContainerName(worktreeName)

    const absoluteProjectDir = resolve(projectDir)
    const state = await runtime.getSandboxState(containerName)
    if (state !== 'missing') {
      logger.log(`Sandbox ${containerName} already exists (${state}), adopting`)
      registerActiveSandbox(worktreeName, containerName, projectDir, startedAt)
      return { containerName }
    }

    const { mounts } = buildMountPlan(absoluteProjectDir)
    const workspaces = buildSandboxWorkspaces(mounts, logger)
    const resources: SandboxResources = {
      memory: config.resources?.memory ?? DEFAULT_RESOURCES.memory,
      cpus: config.resources?.cpus ?? DEFAULT_RESOURCES.cpus,
    }
    logger.log(`Creating sandbox ${containerName} for ${absoluteProjectDir} (memory=${resources.memory} cpus=${resources.cpus})`)
    await runtime.createSandbox(containerName, workspaces, { template: config.image, resources })

    const active: ActiveSandbox = {
      containerName,
      projectDir: absoluteProjectDir,
      startedAt: startedAt ?? new Date().toISOString(),
      mounts,
      envFile: writeEnvPassthroughFile(containerName),
    }

    activeSandboxes.set(worktreeName, active)
    logger.log(`Sandbox ${containerName} started`)

    return { containerName }
  }

  async function stop(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName || runtime.sandboxContainerName(worktreeName)

    // Cleanup (env file, in-memory map entry) always runs; the removal failure is rethrown so
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
      // Cleanup of the in-memory map entry must never be skipped: an env-file deletion failure
      // must not leave stale manager state that would trigger indefinite fail-closed retries for a
      // container that was already removed.
      if (active?.envFile) {
        try {
          rmSync(active.envFile, { force: true })
        } catch (err) {
          logger.log(`Sandbox: failed to remove env file ${active.envFile}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      activeSandboxes.delete(worktreeName)
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
   * A `stopped` sandbox is live: `sbx` suspends idle microVMs and `sbx exec` resumes them in
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
        logger.log(`Removed orphaned sandbox: ${name}`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(`Failed to remove orphaned sandbox ${name}: ${errMsg}`)
      }
    }

    if (!preserveWorktrees) {
      activeSandboxes.clear()
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
   * unmapped paths. `running` and `stopped` are both usable — `sbx` suspends idle microVMs to
   * `stopped` and `sbx exec` resumes them in place, so recreating one would needlessly destroy
   * container-local state. `unknown` means the status query failed and says nothing about the
   * sandbox, so an existing entry is kept as-is (without refreshing the liveness timestamp, so
   * the next call re-checks) and only a confirmed-`missing` sandbox is created.
   */
  async function resolveUsableSandbox(worktreeName: string, projectDir: string, startedAt?: string): Promise<string> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName ?? runtime.sandboxContainerName(worktreeName)
    const state = await runtime.getSandboxState(containerName)

    if (state === 'running' || state === 'stopped') {
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
    // race `sbx`, which answers the loser with `409 Conflict ... has an operation in progress`.
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
