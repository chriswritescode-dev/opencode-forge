import type { DockerService } from './docker'
import type { Logger, SandboxResources, SandboxMountConfig } from '../types'
import { join, resolve, isAbsolute } from 'path'
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'fs'
import { defaultGitService, type GitService } from '../utils/git-service'
import type { SandboxMount } from './path'

export interface SandboxManagerConfig {
  image: string
  dataDir?: string
  resources?: SandboxResources
  sourceProjectDir?: string
  mountProjectReadonly?: boolean
  projectMountPath?: string
  customMounts?: SandboxMountConfig[]
  buildContextDir?: string
  network?: { hostGateway?: boolean; env?: string[] }
}

const DEFAULT_RESOURCES: Required<Pick<SandboxResources, 'memory' | 'cpus' | 'shmSize'>> = {
  memory: '8g',
  cpus: '4',
  shmSize: '1g',
}

export function resolveCustomMounts(
  raw: SandboxMountConfig[] | undefined,
  reservedContainerPaths: ReadonlySet<string>,
  logger: Logger,
): SandboxMount[] {
  if (!raw || raw.length === 0) return []
  const resolved: SandboxMount[] = []
  const used = new Set<string>(reservedContainerPaths)
  for (const entry of raw) {
    const host = entry?.host?.trim()
    const container = entry?.container?.trim()
    if (!host || !container) {
      logger.log(`Sandbox: skipping custom mount with missing host/container path: ${JSON.stringify(entry)}`)
      continue
    }
    if (!isAbsolute(container)) {
      logger.log(`Sandbox: skipping custom mount; container path must be absolute: ${container}`)
      continue
    }
    const hostDir = resolve(host)
    if (!existsSync(hostDir)) {
      logger.log(`Sandbox: skipping custom mount; host path does not exist: ${hostDir}`)
      continue
    }
    if (used.has(container)) {
      logger.log(`Sandbox: skipping custom mount; container path already in use: ${container}`)
      continue
    }
    used.add(container)
    resolved.push({ hostDir, containerDir: container, readOnly: entry.readonly !== false })
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
  docker: DockerService
  start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
  isActive(worktreeName: string): boolean
  isLive(worktreeName: string): Promise<boolean>
  isLiveByName(worktreeName: string): Promise<boolean>
  cleanupOrphans(preserveWorktrees?: string[]): Promise<number>
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
}

export function createSandboxManager(
  docker: DockerService,
  config: SandboxManagerConfig,
  logger: Logger,
  git: GitService = defaultGitService,
): SandboxManager {
  const activeSandboxes = new Map<string, ActiveSandbox>()
  const lastLivenessCheck = new Map<string, number>()
  const gitMountCache = new Map<string, string[]>()
  let dockerAvailableCache: { value: boolean; at: number } | null = null
  let imageReady = false

  async function ensureDockerAvailable(): Promise<void> {
    const now = Date.now()
    if (dockerAvailableCache && (now - dockerAvailableCache.at) < DOCKER_AVAILABLE_TTL) {
      if (!dockerAvailableCache.value) {
        throw new Error('Docker is not available. Please ensure Docker is running.')
      }
      return
    }
    const available = await docker.checkDocker()
    dockerAvailableCache = { value: available, at: now }
    if (!available) {
      throw new Error('Docker is not available. Please ensure Docker is running.')
    }
  }

  async function ensureImage(): Promise<void> {
    if (imageReady) return
    const exists = await docker.imageExists(config.image)
    if (!exists) {
      const buildHint = config.buildContextDir
        ? `  docker build -t ${config.image} "${config.buildContextDir}"`
        : `  docker build -t ${config.image} <build-context-dir>`
      throw new Error(
        `Docker image "${config.image}" not found. Build it first:\n` +
        `${buildHint}\n\n` +
        `To disable the sandbox, set "sandbox": { "enabled": false } in your forge config.`
      )
    }
    imageReady = true
  }

  function buildMountPlan(projectDir: string): { mounts: SandboxMount[]; gitMounts: string[] } {
    const absolute = resolve(projectDir)
    const mounts: SandboxMount[] = [
      { hostDir: absolute, containerDir: '/workspace' },
    ]
    const sourceProjectDir = config.sourceProjectDir
    const projectMountPath = config.projectMountPath ?? '/project'
    const hasProjectMount = config.mountProjectReadonly !== false
      && !!sourceProjectDir
      && resolve(sourceProjectDir) !== absolute
    if (hasProjectMount) {
      mounts.push({
        hostDir: resolve(sourceProjectDir!),
        containerDir: projectMountPath,
        readOnly: true,
      })
    }
    const gitMounts = detectGitMount(absolute)
    const reserved = new Set<string>(['/workspace'])
    for (const m of mounts.slice(1)) reserved.add(m.containerDir)
    for (const g of gitMounts) reserved.add(g.slice(g.lastIndexOf(':') + 1))
    mounts.push(...resolveCustomMounts(config.customMounts, reserved, logger))
    return { mounts, gitMounts }
  }

  function detectGitMount(projectDir: string): string[] {
    const cached = gitMountCache.get(projectDir)
    if (cached) return cached

    const gitDirResult = git.revParseGitDir(projectDir)
    const commonDirResult = git.revParseGitCommonDir(projectDir)
    if (!gitDirResult.ok || !commonDirResult.ok || !gitDirResult.stdout || !commonDirResult.stdout) {
      gitMountCache.set(projectDir, [])
      return []
    }

    const mounts = new Set<string>()
    const resolvedGitDir = resolve(projectDir, gitDirResult.stdout.trim())
    const resolvedCommonDir = resolve(projectDir, commonDirResult.stdout.trim())

    if (!resolvedGitDir.startsWith(projectDir + '/')) {
      mounts.add(`${resolvedGitDir}:${resolvedGitDir}`)
    }

    if (!resolvedCommonDir.startsWith(projectDir + '/')) {
      mounts.add(`${resolvedCommonDir}:${resolvedCommonDir}`)
    }

    const result = [...mounts]
    gitMountCache.set(projectDir, result)
    return result
  }

  function buildAddHosts(): string[] | undefined {
    if (config.network?.hostGateway === false) return []
    return ['host.docker.internal:host-gateway']
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

  async function start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }> {
    await ensureDockerAvailable()
    await ensureImage()

    const containerName = docker.containerName(worktreeName)

    const absoluteProjectDir = resolve(projectDir)
    const running = await docker.isRunning(containerName)
    if (running) {
      logger.log(`Sandbox container ${containerName} already running`)
      activeSandboxes.set(worktreeName, {
        containerName,
        projectDir: absoluteProjectDir,
        startedAt: startedAt ?? new Date().toISOString(),
        mounts: buildMountPlan(projectDir).mounts,
      })
      return { containerName }
    }

    const { mounts, gitMounts } = buildMountPlan(absoluteProjectDir)
    const extraMounts = [...gitMounts]
    for (const mount of mounts.slice(1)) {
      extraMounts.push(mount.readOnly ? `${mount.hostDir}:${mount.containerDir}:ro` : `${mount.hostDir}:${mount.containerDir}`)
    }
    if (extraMounts.length > 0) {
      logger.log(`Sandbox: mounting extra volumes: ${extraMounts.join(', ')}`)
    }
    const resources: SandboxResources = {
      memory: config.resources?.memory ?? DEFAULT_RESOURCES.memory,
      cpus: config.resources?.cpus ?? DEFAULT_RESOURCES.cpus,
      shmSize: config.resources?.shmSize ?? DEFAULT_RESOURCES.shmSize,
      ...(config.resources?.memorySwap ? { memorySwap: config.resources.memorySwap } : {}),
    }
    const addHosts = buildAddHosts()
    const envFile = writeEnvPassthroughFile(containerName)
    // Every sandbox runs Docker-in-Docker: a nested, isolated dockerd so loops can build and
    // run containers (e.g. end-to-end tests). The nested daemon requires root, so the container
    // runs as root (no --user mapping); on Docker Desktop bind-mount file ownership still maps
    // back to the host user.
    logger.log(`Creating sandbox container ${containerName} for ${absoluteProjectDir} (memory=${resources.memory} cpus=${resources.cpus} shmSize=${resources.shmSize}${resources.memorySwap ? ` memorySwap=${resources.memorySwap}` : ''} dind=on)`)
    try {
      await docker.createContainer(containerName, absoluteProjectDir, config.image, { extraMounts, resources, addHosts, dockerInDocker: true, ...(envFile ? { envFile } : {}) })
    } finally {
      if (envFile) {
        rmSync(envFile, { force: true })
      }
    }

    const active: ActiveSandbox = {
      containerName,
      projectDir: absoluteProjectDir,
      startedAt: startedAt ?? new Date().toISOString(),
      mounts,
    }

    activeSandboxes.set(worktreeName, active)
    logger.log(`Sandbox container ${containerName} started`)

    return { containerName }
  }

  async function stop(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName || docker.containerName(worktreeName)

    try {
      await docker.removeContainer(containerName)
      logger.log(`Sandbox container ${containerName} removed`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox container ${containerName} removal: ${errMsg}`)
    } finally {
      activeSandboxes.delete(worktreeName)
    }
  }

  function getActive(worktreeName: string): ActiveSandbox | null {
    return activeSandboxes.get(worktreeName) || null
  }

  function isActive(worktreeName: string): boolean {
    return activeSandboxes.has(worktreeName)
  }

  async function isLive(worktreeName: string): Promise<boolean> {
    const active = activeSandboxes.get(worktreeName)
    if (!active) {
      return false
    }
    
    const containerName = active.containerName
    const running = await docker.isRunning(containerName)
    
    if (!running) {
      // Container is not running in Docker - remove stale map entry
      logger.log(`Sandbox: container ${containerName} not found in Docker, removing stale map entry for ${worktreeName}`)
      activeSandboxes.delete(worktreeName)
      return false
    }
    
    return true
  }

  async function isLiveByName(worktreeName: string): Promise<boolean> {
    const containerName = docker.containerName(worktreeName)
    return docker.isRunning(containerName)
  }

  async function cleanupOrphans(preserveWorktrees?: string[]): Promise<number> {
    const containers = await docker.listContainersByPrefix('forge-')
    let removed = 0

    const preserveSet = preserveWorktrees
      ? new Set(preserveWorktrees.map((wt) => docker.containerName(wt)))
      : new Set<string>()

    for (const name of containers) {
      if (preserveSet.has(name)) {
        continue
      }
      try {
        await docker.removeContainer(name)
        removed++
        logger.log(`Removed orphaned sandbox container: ${name}`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(`Failed to remove orphaned sandbox container ${name}: ${errMsg}`)
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

  async function ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string> {
    const active = activeSandboxes.get(worktreeName)
    const lastCheck = lastLivenessCheck.get(worktreeName)
    const now = Date.now()

    // Cache hit: active entry and liveness checked within TTL
    if (active && lastCheck !== undefined && (now - lastCheck) < LIVENESS_CHECK_TTL) {
      return active.containerName
    }

    if (active) {
      const running = await docker.isRunning(active.containerName)
      if (running) {
        // Repopulate mounts in case config changed, then update cache
        activeSandboxes.set(worktreeName, {
          ...active,
          projectDir: resolve(projectDir),
          mounts: buildMountPlan(projectDir).mounts,
        })
        lastLivenessCheck.set(worktreeName, Date.now())
        return active.containerName
      }
      // Container is dead — remove stale entry and Docker container before recreating
      logger.log(`Sandbox: container ${active.containerName} is not running, recreating for ${worktreeName}`)
      activeSandboxes.delete(worktreeName)
      await docker.removeContainer(active.containerName)

      const result = await start(worktreeName, projectDir, startedAt)
      lastLivenessCheck.set(worktreeName, Date.now())
      return result.containerName
    }

    // No active entry — check if the container is still alive in Docker (e.g. after process
    // restart or isLive cleanup). If running, repopulate the map; otherwise clean up and create.
    const containerName = docker.containerName(worktreeName)
    const running = await docker.isRunning(containerName)
    if (running) {
      const absoluteProjectDir = resolve(projectDir)
      const { mounts } = buildMountPlan(projectDir)
      const activeEntry: ActiveSandbox = {
        containerName,
        projectDir: absoluteProjectDir,
        startedAt: startedAt ?? new Date().toISOString(),
        mounts,
      }
      activeSandboxes.set(worktreeName, activeEntry)
      lastLivenessCheck.set(worktreeName, Date.now())
      return containerName
    }

    // Stopped container exists — remove it to avoid name conflict on create
    await docker.removeContainer(containerName)

    const runningResult = await start(worktreeName, projectDir, startedAt)
    lastLivenessCheck.set(worktreeName, Date.now())
    return runningResult.containerName
  }

  return {
    docker,
    start,
    stop,
    getActive,
    isActive,
    isLive,
    isLiveByName,
    cleanupOrphans,
    restore,
    ensureRunning,
  }
}
