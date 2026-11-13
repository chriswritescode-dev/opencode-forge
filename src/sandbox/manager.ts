import { randomUUID } from 'node:crypto'
import type { SandboxRuntime, SandboxWorkspace } from './msb'
import { buildNetworkAllow, egressRestrictionRequested, describeMsbUnavailable, msbSizeToMib, normalizeMsbSize, parseMsbCpus, SANDBOX_CACHE_DIR, type MsbAvailability } from './msb'
import { resolveSandboxAllowLan, resolveSandboxResources, type SandboxRuntimeSettings } from './loop-settings'
import type { Logger, SandboxOverrides, SandboxResources, SandboxMountConfig, SandboxSecretConfig } from '../types'
import { resolve, join, isAbsolute, basename, dirname, posix as posixPath } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { defaultGitService, type GitService } from '../utils/git-service'
import { canonicalizePath, isSameOrDescendantPath, type SandboxMount } from './path'
import { formatTemplateBuildCommands } from './template'

export interface SandboxManagerConfig {
  image: string
  resources?: SandboxResources
  resolveOverrides?: (worktreeName: string) => SandboxOverrides | undefined
  sourceProjectDir?: string
  mountProjectReadonly?: boolean
  customMounts?: SandboxMountConfig[]
  buildContextDir?: string
  templateBuildArgs?: string[]
  toolOutputDir?: string
  tmpDir?: string
  listSkillPaths?: (projectDir: string) => Promise<string[]>
  fallbackSkillsDir?: string
  network?: { env?: string[]; allow?: string[]; secrets?: SandboxSecretConfig[]; allowLan?: boolean }
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
export const SKILL_LIST_TIMEOUT_MS = 10_000

export interface SandboxMountPlan {
  mounts: SandboxMount[]
}

export interface SandboxMountPlan {
  mounts: SandboxMount[]
}

export interface ActiveSandbox {
  containerName: string
  projectDir: string
  startedAt: string
  mounts: SandboxMount[]
  instanceId: string
  settings?: SandboxRuntimeSettings
}

export type ApplyOverridesOutcome = 'unchanged' | 'resized' | 'recreated'

export interface SandboxManager {
  runtime: SandboxRuntime
  start(worktreeName: string, projectDir: string, startedAt?: string, overrides?: SandboxOverrides): Promise<{ containerName: string }>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
  isActive(worktreeName: string): boolean
  isLive(worktreeName: string): Promise<boolean>
  cleanupOrphans(preserveWorktrees?: string[]): Promise<number>
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
  applyOverrides(worktreeName: string, projectDir: string): Promise<ApplyOverridesOutcome>
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

export function buildSandboxWorkspaces(mounts: SandboxMount[], logger: Logger): SandboxWorkspace[] {
  return dropConflictingMounts(mounts, logger).map((mount) => ({
    hostDir: canonicalizePath(mount.hostDir),
    containerDir: mount.containerDir,
    readOnly: mount.readOnly,
  }))
}

const SKILL_ROOT_DIR_NAMES: ReadonlySet<string> = new Set(['skills', 'skill'])

export interface SkillMountSelection {
  skillDirs: readonly string[]
  workspaceDir: string
  logger: Logger
  fallbackRoots?: readonly string[]
}

export function resolveSkillMounts(input: SkillMountSelection): SandboxMount[] {
  const { skillDirs, workspaceDir, logger, fallbackRoots = [] } = input
  const canonicalWorkspaceDir = canonicalizePath(workspaceDir)

  const rootCandidates: string[] = []
  const skillDirCandidates: string[] = []
  const seen = new Set<string>()

  const addRoot = (dir: string): void => {
    if (seen.has(dir)) return
    seen.add(dir)
    rootCandidates.push(dir)
  }
  const addSkillDir = (dir: string): void => {
    if (seen.has(dir)) return
    seen.add(dir)
    skillDirCandidates.push(dir)
  }

  for (const root of fallbackRoots) addRoot(resolve(root))

  const resolvedSkillDirs = skillDirs.map((dir) => resolve(dir))
  for (const dir of resolvedSkillDirs) {
    const parent = dirname(dir)
    if (SKILL_ROOT_DIR_NAMES.has(basename(parent))) addRoot(parent)
    else addSkillDir(dir)
  }

  const canonicalRoots = rootCandidates.map((root) => canonicalizePath(root))
  for (const dir of resolvedSkillDirs) {
    if (canonicalRoots.some((root) => isSameOrDescendantPath(canonicalizePath(dir), root))) continue
    addSkillDir(dir)
  }

  const candidates = [...rootCandidates, ...skillDirCandidates]
    .filter((dir) => {
      if (isSameOrDescendantPath(canonicalizePath(dir), canonicalWorkspaceDir)) {
        logger.log(`Sandbox: skipping skills mount inside the workspace: ${dir}`)
        return false
      }
      if (!existsSync(dir)) {
        logger.log(`Sandbox: skipping skills mount; directory does not exist: ${dir}`)
        return false
      }
      return true
    })
    .sort((a, b) => a.length - b.length)

  const roots = rootCandidates.map((root) => resolve(root))
  const mounts: SandboxMount[] = []
  const accepted: string[] = []
  for (const dir of candidates) {
    const canonical = canonicalizePath(dir)
    if (accepted.some((root) => isSameOrDescendantPath(canonical, root))) continue
    accepted.push(canonical)
    const nestedUnderRoot = roots.some((root) => dir !== root && isSameOrDescendantPath(dir, root))
    const target = nestedUnderRoot ? canonical : dir
    mounts.push({ hostDir: target, containerDir: target, readOnly: true })
  }
  return mounts
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
  const skillDirCache = new Map<string, string[]>()
  const skillListAttempted = new Set<string>()
  const convergedSecrets = new Set<string>()
  const preparedCacheDisks = new Set<string>()
  const handledSecretEnvs = new Map<string, Set<string>>()
  const settingsLookups = new Set<string>()
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
      const availability = await runtime.checkAvailable()
      if (!availability.available) {
        if (availability.reason === 'unknown') return
        throw new Error(describeMsbUnavailable(availability))
      }
      const buildHint = `  ${formatTemplateBuildCommands(
        config.buildContextDir ?? '<build-context-dir>',
        config.image,
        config.templateBuildArgs ?? [],
      )}`
      throw new Error(
        `Sandbox template "${config.image}" not found. Build and load it first:\n${buildHint}\n\n` +
        `To disable the sandbox, set "sandbox": { "enabled": false } in your forge config.`
      )
    }
    imageReady = true
  }

  async function refreshSkillDirs(projectDir: string): Promise<void> {
    const absolute = resolve(projectDir)
    skillListAttempted.add(absolute)
    const listSkillPaths = config.listSkillPaths
    if (!listSkillPaths) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const paths = await Promise.race([
        listSkillPaths(absolute),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`skill listing timed out after ${SKILL_LIST_TIMEOUT_MS}ms`)),
            SKILL_LIST_TIMEOUT_MS,
          )
        }),
      ])
      const dirs: string[] = []
      const seen = new Set<string>()
      for (const path of paths) {
        if (!path || !isAbsolute(path) || basename(path) !== 'SKILL.md') continue
        const dir = resolve(dirname(path))
        if (seen.has(dir)) continue
        seen.add(dir)
        dirs.push(dir)
      }
      skillDirCache.set(absolute, dirs)
    } catch (err) {
      const fallback = skillDirCache.has(absolute)
        ? 'the previously resolved skill directories'
        : config.fallbackSkillsDir ? `the fallback skills directory ${config.fallbackSkillsDir}` : 'no skills mount'
      logger.log(`Sandbox: could not list skills for ${absolute}; using ${fallback}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function buildMountPlan(projectDir: string): SandboxMountPlan {
    const absolute = resolve(projectDir)
    const worktreeMount: SandboxMount = { hostDir: absolute, containerDir: absolute }

    const gitMounts = detectGitMount(absolute)
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
    const skillsMounts = resolveSkillsMounts(absolute)

    const reserved = new Set<string>([worktreeMount.containerDir, ...orderedGitMounts.map((m) => m.containerDir)])
    if (projectMount) reserved.add(projectMount.containerDir)
    if (toolOutputMount) reserved.add(toolOutputMount.containerDir)
    if (tmpMount) reserved.add(tmpMount.containerDir)
    for (const mount of skillsMounts) reserved.add(mount.containerDir)
    const customMounts = resolveCustomMounts(config.customMounts, reserved, logger)

    const candidates: SandboxMount[] = [
      worktreeMount,
      ...orderedGitMounts,
      ...(projectMount ? [projectMount] : []),
      ...(toolOutputMount ? [toolOutputMount] : []),
      ...(tmpMount ? [tmpMount] : []),
      ...skillsMounts,
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

  function resolveSkillsMounts(workspaceDir: string): SandboxMount[] {
    const cached = skillDirCache.get(workspaceDir)
    const fallbackRoots = cached === undefined && config.fallbackSkillsDir ? [config.fallbackSkillsDir] : []
    if (cached === undefined && fallbackRoots.length === 0) return []
    return resolveSkillMounts({
      skillDirs: cached ?? [],
      workspaceDir,
      logger,
      fallbackRoots,
    })
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

    const hooksDir = join(resolvedCommonDir, 'hooks')
    if (existsSync(hooksDir)) {
      result.push({ hostDir: hooksDir, containerDir: hooksDir, readOnly: true })
    }

    gitMountCache.set(projectDir, result)
    return result
  }

  function registerActiveSandbox(
    worktreeName: string,
    containerName: string,
    projectDir: string,
    startedAt?: string,
    mounts?: SandboxMount[],
    created?: { settings?: SandboxRuntimeSettings },
  ): void {
    const active = activeSandboxes.get(worktreeName)
    const same = !created && active?.containerName === containerName ? active : undefined
    const settings = created ? created.settings : same?.settings
    const applied: ActiveSandbox = {
      containerName,
      projectDir: resolve(projectDir),
      startedAt: active?.startedAt ?? startedAt ?? new Date().toISOString(),
      mounts: mounts ?? buildMountPlan(projectDir).mounts,
      instanceId: same?.instanceId ?? randomUUID(),
    }
    if (settings) applied.settings = settings
    activeSandboxes.set(worktreeName, applied)
  }

  async function learnSettings(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    if (!active || active.settings || settingsLookups.has(active.instanceId)) return
    settingsLookups.add(active.instanceId)
    const settings = await runtime.readSandboxSettings(active.containerName)
    const current = activeSandboxes.get(worktreeName)
    if (settings && current?.containerName === active.containerName) current.settings = settings
  }

  function resolveTargetSettings(worktreeName: string, override?: SandboxOverrides) {
    const overrides = override ?? config.resolveOverrides?.(worktreeName)
    const resources = resolveSandboxResources(config.resources, overrides?.resources)
    const cpus = parseMsbCpus(resources.cpus, logger)
    const memory = normalizeMsbSize(resources.memory, logger)
    const memoryMib = memory === undefined ? undefined : msbSizeToMib(memory)
    const allowLan = resolveSandboxAllowLan(config.network?.allowLan, overrides)
    const settings: SandboxRuntimeSettings | undefined =
      cpus !== undefined && memoryMib !== undefined ? { cpus, memoryMib, allowLan } : undefined
    return { overrides, resources, cpus, memoryMib, allowLan, settings }
  }

  function resolvePassthroughEnv(): string[] {
    return (config.network?.env ?? []).filter((name) => {
      if (process.env[name] === undefined) {
        logger.log(`Sandbox: skipping env passthrough ${name}: host variable is not set`)
        return false
      }
      return true
    })
  }

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

  async function refreshSecrets(containerName: string): Promise<boolean> {
    if (convergedSecrets.has(containerName)) return true
    const secrets = resolveSandboxSecrets()
    if (secrets.length === 0) {
      convergedSecrets.add(containerName)
      return true
    }
    warnUncoveredSecretHosts(containerName, secrets)
    if (!(await runtime.refreshSandboxSecrets(containerName, secrets))) {
      logger.log(`Sandbox: failed to refresh secrets for ${containerName}`)
      return false
    }
    convergedSecrets.add(containerName)
    recordHandledSecretEnvs(containerName, secrets)
    return true
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

  async function prepareCacheDisk(containerName: string): Promise<void> {
    if (preparedCacheDisks.has(containerName)) return
    const result = await runtime.exec(containerName, `sudo sh -c 'chown agent:agent ${SANDBOX_CACHE_DIR} && chmod 0777 ${SANDBOX_CACHE_DIR}'`)
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to make the sandbox cache disk writable at ${SANDBOX_CACHE_DIR}: ${result.stderr || result.stdout}`,
      )
    }
    preparedCacheDisks.add(containerName)
  }

  async function start(worktreeName: string, projectDir: string, startedAt?: string, overrides?: SandboxOverrides): Promise<{ containerName: string }> {
    await ensureRuntimeAvailable()
    await ensureTemplate()
    await refreshSkillDirs(projectDir)

    const containerName = runtime.sandboxContainerName(worktreeName)

    const absoluteProjectDir = resolve(projectDir)
    const state = await runtime.getSandboxState(containerName)
    if (state === 'unknown') {
      throw new Error(
        `Could not determine whether sandbox ${containerName} exists (state query failed); refusing to start`,
      )
    }
    if (state !== 'missing') {
      logger.log(`Sandbox ${containerName} already exists (${state}), adopting`)
      if (!(await refreshSecrets(containerName))) {
        throw new Error(`Failed to refresh secrets for sandbox ${containerName}; refusing to adopt`)
      }
      await prepareCacheDisk(containerName)
      registerActiveSandbox(worktreeName, containerName, projectDir, startedAt)
      await learnSettings(worktreeName)
      return { containerName }
    }

    const { mounts } = buildMountPlan(absoluteProjectDir)
    const workspaces = buildSandboxWorkspaces(mounts, logger)
    const target = resolveTargetSettings(worktreeName, overrides)
    const secrets = resolveSandboxSecrets()
    logger.log(`Creating sandbox ${containerName} for ${absoluteProjectDir} (memory=${target.resources.memory} cpus=${target.resources.cpus} lan=${target.allowLan} workspaces=${workspaces.length})`)
    await runtime.createSandbox(containerName, workspaces, {
      image: config.image,
      resources: target.resources,
      networkAllow: buildNetworkAllow(config.network?.allow, secrets, logger),
      restrictEgress: egressRestrictionRequested(config.network?.allow, secrets),
      env: resolvePassthroughEnv(),
      secrets,
      allowLan: target.allowLan,
    })
    await prepareCacheDisk(containerName)
    convergedSecrets.add(containerName)
    recordHandledSecretEnvs(containerName, secrets)
    registerActiveSandbox(worktreeName, containerName, projectDir, startedAt, mounts, { settings: target.settings })
    logger.log(`Sandbox ${containerName} started`)

    return { containerName }
  }

  async function stop(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName || runtime.sandboxContainerName(worktreeName)

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
      preparedCacheDisks.delete(containerName)
      logger.log(`Sandbox ${containerName} already gone`)
      try {
        await runtime.removeSandbox(containerName)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.log(`Sandbox ${containerName} removal: ${errMsg}`)
      }
      return
    }

    let removalError: unknown
    try {
      await runtime.removeSandbox(containerName)
      logger.log(`Sandbox ${containerName} removed`)
    } catch (err) {
      removalError = err
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox ${containerName} removal: ${errMsg}`)
    } finally {
      activeSandboxes.delete(worktreeName)
      convergedSecrets.delete(containerName)
      handledSecretEnvs.delete(containerName)
      preparedCacheDisks.delete(containerName)
    }
    if (removalError) throw removalError
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
    const state = await runtime.getSandboxState(containerName)

    if (state === 'missing') {
      logger.log(`Sandbox: sandbox ${containerName} no longer exists, removing stale map entry for ${worktreeName}`)
      activeSandboxes.delete(worktreeName)
      preparedCacheDisks.delete(containerName)
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
        preparedCacheDisks.delete(name)
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
      preparedCacheDisks.clear()
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

  async function resolveUsableSandbox(worktreeName: string, projectDir: string, startedAt?: string): Promise<string> {
    if (!skillListAttempted.has(resolve(projectDir))) await refreshSkillDirs(projectDir)
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName ?? runtime.sandboxContainerName(worktreeName)
    const state = await runtime.getSandboxState(containerName)

    if (state === 'running' || state === 'stopped') {
      if (!(await refreshSecrets(containerName))) {
        throw new Error(`Failed to refresh secrets for sandbox ${containerName}; refusing to adopt`)
      }
      await prepareCacheDisk(containerName)
      registerActiveSandbox(worktreeName, containerName, projectDir, startedAt)
      await learnSettings(worktreeName)
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

    const inFlight = ensureRunningInFlight.get(worktreeName)
    if (inFlight) return inFlight

    const pending = resolveUsableSandbox(worktreeName, projectDir, startedAt)
      .finally(() => ensureRunningInFlight.delete(worktreeName))
    ensureRunningInFlight.set(worktreeName, pending)
    return pending
  }

  async function convergeOverrides(worktreeName: string, projectDir: string): Promise<ApplyOverridesOutcome> {
    await resolveUsableSandbox(worktreeName, projectDir)
    const active = activeSandboxes.get(worktreeName)
    if (!active) throw new Error(`Sandbox for ${worktreeName} is not active; cannot apply its settings`)
    const current = active.settings ?? await runtime.readSandboxSettings(active.containerName)
    if (!current) throw new Error(`Could not read the current settings of sandbox ${active.containerName}`)
    const target = resolveTargetSettings(worktreeName)

    if (current.allowLan !== target.allowLan) {
      logger.log(`Sandbox ${active.containerName}: LAN access ${target.allowLan ? 'on' : 'off'} requires recreating the sandbox`)
      await stop(worktreeName)
      await start(worktreeName, projectDir, active.startedAt, target.overrides)
      lastLivenessCheck.set(worktreeName, Date.now())
      return 'recreated'
    }

    const cpus = target.cpus ?? current.cpus
    const memoryMib = target.memoryMib ?? current.memoryMib
    if (cpus === current.cpus && memoryMib === current.memoryMib) {
      active.settings = current
      return 'unchanged'
    }
    logger.log(`Sandbox ${active.containerName}: resizing to cpus=${cpus} memory=${memoryMib}MiB (restarts the sandbox)`)
    await runtime.resizeSandbox(active.containerName, { cpus: target.resources.cpus, memory: target.resources.memory })
    active.settings = { cpus, memoryMib, allowLan: current.allowLan }
    lastLivenessCheck.set(worktreeName, Date.now())
    return 'resized'
  }

  async function applyOverrides(worktreeName: string, projectDir: string): Promise<ApplyOverridesOutcome> {
    for (let inFlight = ensureRunningInFlight.get(worktreeName); inFlight; inFlight = ensureRunningInFlight.get(worktreeName)) {
      await inFlight.catch(() => undefined)
    }
    let outcome: ApplyOverridesOutcome = 'unchanged'
    const pending = convergeOverrides(worktreeName, projectDir)
      .then((result) => {
        outcome = result
        return activeSandboxes.get(worktreeName)?.containerName ?? runtime.sandboxContainerName(worktreeName)
      })
      .finally(() => ensureRunningInFlight.delete(worktreeName))
    ensureRunningInFlight.set(worktreeName, pending)
    await pending
    return outcome
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
    applyOverrides,
  }
}
