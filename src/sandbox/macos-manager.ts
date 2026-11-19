import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'
import type { Logger, SandboxMacosConfig, SandboxOverrides } from '../types'
import { defaultGitService, type GitService } from '../utils/git-service'
import { processShared } from '../utils/process-shared'
import type { ActiveSandbox, ApplyOverridesOutcome, SandboxManager } from './manager'
import { quoteShellArg } from './exec-fs'
import type { SandboxRuntimeSettings } from './loop-settings'
import { ensureSpacesdToken, macosStatePaths } from './macos'
import {
  buildLumeRunBody,
  mapLumeVmState,
  spacesdUrlFromDetails,
  type LumeVmDetails,
  type createLumeClient,
} from './macos-lume'
import {
  ensureNetgwRunning,
  formatBlockedEvent,
  gatewaySocketPath,
  readNetgwBlockedEvents,
  writeNetgwFiles,
} from './macos-netgw'
import {
  MACOS_SETUP_SHARE_TAG,
  MACOS_VM_NAME,
  assertDirectoryInsideMacosShares,
  macosMountsFromShares,
  type MacosShare,
} from './macos-shares'
import type { spawnDetached } from './process'
import type { SandboxRuntime, SandboxState } from './runtime'

export interface MacosVmReady {
  url: string
  liveShares: MacosShare[]
  bootedAt: string
}

export interface MacosVmShared {
  boot: Promise<MacosVmReady> | null
  ready: MacosVmReady | null
  refresh: Promise<MacosVmReady> | null
  mountedUrl: string | null
  eventsOffset: number
  eventsTimer: ReturnType<typeof setInterval> | null
}

export interface MacosSandboxManagerDeps {
  runtime: SandboxRuntime
  lume: ReturnType<typeof createLumeClient>
  dataDir: string
  config: SandboxMacosConfig
  shares: MacosShare[]
  networkAllow?: string[]
  logger: Logger
  git?: GitService
  pollIntervalMs?: number
  bootTimeoutMs?: number
  netgwSpawn?: typeof spawnDetached
}

const LIVENESS_CHECK_TTL = 2_000
const BLOCKED_EVENT_POLL_MS = 5_000

const recordedVmStateSchema = z.object({
  shares: z.array(
    z.object({
      hostDir: z.string(),
      guestDir: z.string(),
      readOnly: z.boolean(),
      tag: z.string(),
    }),
  ),
  bootedAt: z.string(),
})

function assertNoPerLoopSecrets(overrides?: SandboxOverrides): void {
  if ((overrides?.secrets?.length ?? 0) > 0 || overrides?.secretProvider) {
    throw new Error('Per-loop secrets are not supported in the macOS sandbox mode; remove them or use sandbox.mode "msb"')
  }
}

export function createMacosSandboxManager(deps: MacosSandboxManagerDeps): SandboxManager {
  const runtime = deps.runtime
  const lume = deps.lume
  const logger = deps.logger
  const paths = macosStatePaths(deps.dataDir)
  const pollIntervalMs = deps.pollIntervalMs ?? 2000
  const bootTimeoutMs = deps.bootTimeoutMs ?? 180000
  const baseVm = deps.config.baseVm ?? 'forge-macos-base'
  const netgwPath = deps.config.netgwPath ?? 'cua-netgw'
  const git = deps.git ?? defaultGitService
  const shares = deps.shares
  const networkAllow = deps.networkAllow
  const shared = processShared('macos-vm.v1', () => ({
    boot: null,
    ready: null,
    refresh: null,
    mountedUrl: null,
    eventsOffset: 0,
    eventsTimer: null,
  }))

  const activeSandboxes = new Map<string, ActiveSandbox>()
  const lastLivenessCheck = new Map<string, number>()
  const ensureRunningInFlight = new Map<string, Promise<string>>()
  const instanceIds = new Map<string, string>()
  const settingsByInstance = new Map<string, SandboxRuntimeSettings | null>()

  function vmNotReadyError(): Error {
    return new Error(`macOS sandbox VM ${MACOS_VM_NAME} did not become ready within ${bootTimeoutMs}ms`)
  }

  function readRecordedVmState(): { shares: MacosShare[]; bootedAt: string } | null {
    let raw: string
    try {
      raw = readFileSync(paths.vmStateFile, 'utf-8')
    } catch {
      return null
    }
    try {
      const parsed = recordedVmStateSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async function bootVm(sharedVm: MacosVmShared): Promise<MacosVmReady> {
    const availability = await runtime.checkAvailable()
    if (!availability.available) {
      if (availability.reason === 'unknown') {
        logger.log(`Sandbox: could not determine macOS sandbox availability (${availability.detail ?? 'no detail'}); continuing`)
      } else {
        throw new Error(runtime.describeUnavailable(availability))
      }
    }

    let details: LumeVmDetails | null
    try {
      details = await lume.getVm(MACOS_VM_NAME)
    } catch (error) {
      throw new Error('Could not determine whether forge-macos exists (Lume query failed); refusing to start', { cause: error })
    }

    const state = mapLumeVmState(details)
    if (state === 'missing') {
      let base: LumeVmDetails | null
      try {
        base = await lume.getVm(baseVm)
      } catch {
        base = null
      }
      if (!base) {
        throw new Error(`macOS sandbox base VM "${baseVm}" not found; build it as described in docs/sandbox.md (macOS mode)`)
      }
      await lume.cloneVm(baseVm, MACOS_VM_NAME)
    }

    let bootedAt: string
    let liveShares: MacosShare[]
    if (state === 'missing' || state === 'stopped') {
      ensureSpacesdToken(paths)
      writeNetgwFiles(paths.netDir, networkAllow, logger)
      ensureNetgwRunning({ netDir: paths.netDir, netgwPath, logger, spawn: deps.netgwSpawn })
      const allShares: MacosShare[] = [
        ...shares,
        { hostDir: paths.setupDir, guestDir: '/Volumes/forge-setup', readOnly: true, tag: MACOS_SETUP_SHARE_TAG },
      ]
      bootedAt = new Date().toISOString()
      try {
        await lume.runVm(MACOS_VM_NAME, buildLumeRunBody(allShares, gatewaySocketPath(paths.netDir)))
      } catch (error) {
        let started: SandboxState
        try {
          started = mapLumeVmState(await lume.getVm(MACOS_VM_NAME))
        } catch {
          started = 'unknown'
        }
        if (started !== 'running' && started !== 'transient') throw error
      }
      mkdirSync(paths.root, { recursive: true, mode: 0o700 })
      writeFileSync(paths.vmStateFile, JSON.stringify({ shares, bootedAt }), { mode: 0o600 })
      liveShares = shares
    } else {
      const recorded = readRecordedVmState()
      if (recorded) {
        liveShares = recorded.shares
        bootedAt = recorded.bootedAt
      } else {
        liveShares = []
        bootedAt = 'unknown-boot'
      }
      try {
        writeNetgwFiles(paths.netDir, networkAllow, logger)
        ensureNetgwRunning({ netDir: paths.netDir, netgwPath, logger, spawn: deps.netgwSpawn })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.log(`Sandbox: could not prepare macOS egress gateway on adoption: ${message}`)
      }
    }

    let current: LumeVmDetails | null = null
    const deadline = Date.now() + bootTimeoutMs
    for (;;) {
      current = await lume.getVm(MACOS_VM_NAME)
      if (mapLumeVmState(current) === 'running') break
      if (Date.now() >= deadline) throw vmNotReadyError()
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    const url = spacesdUrlFromDetails(current)
    if (!url) throw vmNotReadyError()
    mkdirSync(paths.root, { recursive: true, mode: 0o700 })
    writeFileSync(paths.urlFile, url, { mode: 0o600 })

    if (sharedVm.mountedUrl !== url) {
      if (liveShares.length > 0) {
        const script = liveShares
          .map((share) => {
            const pattern = quoteShellArg(` on ${share.guestDir} (`)
            const guestDir = quoteShellArg(share.guestDir)
            const tag = quoteShellArg(share.tag)
            return `if ! /sbin/mount | grep -F -q ${pattern}; then sudo /bin/mkdir -p ${guestDir} && sudo /usr/sbin/chown "$(id -u):$(id -g)" ${guestDir} && sudo /sbin/mount_virtiofs ${tag} ${guestDir}; fi`
          })
          .join(' && ')
        const result = await runtime.exec(MACOS_VM_NAME, script)
        if (result.exitCode !== 0) {
          throw new Error(`Failed to mount macOS sandbox shares: ${result.stderr || result.stdout}`)
        }
      }
      sharedVm.mountedUrl = url
    }

    if (sharedVm.eventsTimer === null) {
      const timer = setInterval(() => {
        const { events, nextOffset } = readNetgwBlockedEvents(paths.netDir, sharedVm.eventsOffset)
        sharedVm.eventsOffset = nextOffset
        for (const event of events) logger.log(formatBlockedEvent(event))
      }, BLOCKED_EVENT_POLL_MS)
      timer.unref()
      sharedVm.eventsTimer = timer
    }

    return { url, liveShares, bootedAt }
  }

  function startBoot(): Promise<MacosVmReady> {
    const pending = bootVm(shared).then((ready) => {
      shared.ready = ready
      return ready
    })
    shared.boot = pending
    pending.catch(() => {
      if (shared.boot !== pending) return
      shared.boot = null
      shared.ready = null
    })
    return pending
  }

  function ensureVm(): Promise<MacosVmReady> {
    if (!shared.boot) return startBoot()
    const cached = shared.ready
    if (!cached) return shared.boot
    if (shared.refresh) return shared.refresh
    shared.refresh = (async (): Promise<MacosVmReady> => {
      let details: LumeVmDetails | null
      try {
        details = await lume.getVm(MACOS_VM_NAME)
      } catch {
        return cached
      }
      const state = mapLumeVmState(details)
      const stale = state === 'stopped'
        || state === 'missing'
        || (state === 'running' && spacesdUrlFromDetails(details) !== cached.url)
      if (!stale) return cached
      shared.boot = null
      shared.ready = null
      shared.mountedUrl = null
      return startBoot()
    })().finally(() => {
      shared.refresh = null
    })
    return shared.refresh
  }

  function instanceIdFor(bootedAt: string): string {
    const existing = instanceIds.get(bootedAt)
    if (existing) return existing
    const created = randomUUID()
    instanceIds.set(bootedAt, created)
    return created
  }

  async function settingsFor(containerName: string, instanceId: string): Promise<SandboxRuntimeSettings | null> {
    const cached = settingsByInstance.get(instanceId)
    if (cached !== undefined) return cached
    const settings = await runtime.readSandboxSettings(containerName)
    settingsByInstance.set(instanceId, settings)
    return settings
  }

  async function attach(
    worktreeName: string,
    projectDir: string,
    startedAt: string | undefined,
    overrides: SandboxOverrides | undefined,
  ): Promise<string> {
    assertNoPerLoopSecrets(overrides)
    const ready = await ensureVm()
    assertDirectoryInsideMacosShares(resolve(projectDir), ready.liveShares)
    const common = git.revParseGitCommonDir(projectDir)
    if (common.ok && common.stdout.trim()) {
      assertDirectoryInsideMacosShares(resolve(projectDir, common.stdout.trim()), ready.liveShares)
    }
    const containerName = runtime.sandboxContainerName(worktreeName)
    const instanceId = instanceIdFor(ready.bootedAt)
    const settings = await settingsFor(containerName, instanceId)
    const applied: ActiveSandbox = {
      containerName,
      projectDir: resolve(projectDir),
      startedAt: startedAt ?? new Date().toISOString(),
      mounts: macosMountsFromShares(ready.liveShares),
      instanceId,
    }
    if (settings) applied.settings = settings
    activeSandboxes.set(worktreeName, applied)
    lastLivenessCheck.set(worktreeName, Date.now())
    return containerName
  }

  async function start(
    worktreeName: string,
    projectDir: string,
    startedAt?: string,
    overrides?: SandboxOverrides,
  ): Promise<{ containerName: string }> {
    return { containerName: await attach(worktreeName, projectDir, startedAt, overrides) }
  }

  async function stop(worktreeName: string): Promise<void> {
    activeSandboxes.delete(worktreeName)
    lastLivenessCheck.delete(worktreeName)
  }

  function getActive(worktreeName: string): ActiveSandbox | null {
    return activeSandboxes.get(worktreeName) || null
  }

  function isActive(worktreeName: string): boolean {
    return activeSandboxes.has(worktreeName)
  }

  async function isLive(worktreeName: string): Promise<boolean> {
    const active = activeSandboxes.get(worktreeName)
    if (!active) return false
    const state = await runtime.getSandboxState(active.containerName)
    if (state === 'missing') {
      activeSandboxes.delete(worktreeName)
      return false
    }
    return true
  }

  async function cleanupOrphans(): Promise<number> {
    return 0
  }

  async function restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void> {
    await ensureRunning(worktreeName, projectDir, startedAt)
  }

  async function ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string> {
    const active = activeSandboxes.get(worktreeName)
    const lastCheck = lastLivenessCheck.get(worktreeName)
    if (active && lastCheck !== undefined && (Date.now() - lastCheck) < LIVENESS_CHECK_TTL) {
      return active.containerName
    }
    const inFlight = ensureRunningInFlight.get(worktreeName)
    if (inFlight) return inFlight
    const pending = attach(worktreeName, projectDir, startedAt, undefined)
      .finally(() => ensureRunningInFlight.delete(worktreeName))
    ensureRunningInFlight.set(worktreeName, pending)
    return pending
  }

  async function applyOverrides(worktreeName: string, projectDir: string): Promise<ApplyOverridesOutcome> {
    await ensureRunning(worktreeName, projectDir)
    return 'unchanged'
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
