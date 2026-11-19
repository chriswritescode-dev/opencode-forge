import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMacosSandboxManager } from '../../src/sandbox/macos-manager'
import type { SandboxManager } from '../../src/sandbox/manager'
import { SPACESD_GUEST_PORT, mapLumeVmState } from '../../src/sandbox/macos-lume'
import {
  MACOS_SETUP_SHARE_TAG,
  MACOS_VM_NAME,
  macosMountsFromShares,
  macosShareTag,
} from '../../src/sandbox/macos-shares'
import type { MacosShare } from '../../src/sandbox/macos-shares'
import { gatewaySocketPath } from '../../src/sandbox/macos-netgw'
import type { SandboxMacosConfig } from '../../src/types'
import type { GitService } from '../../src/utils/git-service'
import { createMockLogger } from '../helpers/logger'
import { createFakeLumeClient, createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import type { FakeLumeClient, MockSandboxRuntime } from '../helpers/sandbox-mocks'

interface SharedMacosVm {
  eventsTimer: ReturnType<typeof setInterval> | null
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-macos-manager-'))
  tempDirs.push(dir)
  return dir
}

function resetShared(): void {
  const store = globalThis.__opencodeForgeShared as unknown as Record<string, SharedMacosVm | undefined> | undefined
  const shared = store?.['macos-vm.v1']
  if (shared?.eventsTimer) clearInterval(shared.eventsTimer)
  if (store) delete store['macos-vm.v1']
}

beforeEach(() => {
  resetShared()
})

afterEach(() => {
  resetShared()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRuntime(): { runtime: MockSandboxRuntime; execCalls: string[] } {
  const runtime = createMockSandboxRuntime()
  runtime.checkAvailable = vi.fn(async () => ({ available: true as const }))
  runtime.sandboxContainerName = () => MACOS_VM_NAME
  const execCalls: string[] = []
  runtime.exec = vi.fn(async (_name: string, command: string) => {
    execCalls.push(command)
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  return { runtime, execCalls }
}

function fakeGit(commonDir?: string): GitService {
  return {
    revParseGitCommonDir: () => commonDir
      ? { ok: true, status: 0, stdout: commonDir, stderr: '' }
      : { ok: false, status: 128, stdout: '', stderr: 'not a git repository' },
  } as unknown as GitService
}

function shareFor(dir: string, readOnly = false): MacosShare {
  mkdirSync(dir, { recursive: true })
  return { hostDir: dir, guestDir: dir, readOnly, tag: macosShareTag(dir) }
}

interface ManagerInput {
  runtime: MockSandboxRuntime
  lume: FakeLumeClient
  dataDir: string
  shares: MacosShare[]
  logger?: ReturnType<typeof createMockLogger>
  git?: GitService
  config?: SandboxMacosConfig
  bootTimeoutMs?: number
}

function makeManager(input: ManagerInput): SandboxManager {
  return createMacosSandboxManager({
    runtime: input.runtime,
    lume: input.lume,
    dataDir: input.dataDir,
    config: input.config ?? {},
    shares: input.shares,
    logger: input.logger ?? createMockLogger(),
    git: input.git ?? fakeGit(),
    pollIntervalMs: 1,
    bootTimeoutMs: input.bootTimeoutMs ?? 2000,
    netgwSpawn: () => 1,
  })
}

function stoppedVm(name: string): { name: string; status: string } {
  return { name, status: 'stopped' }
}

function runningVm(name: string, hostPort: number): { name: string; status: string; forwards: Record<string, number> } {
  return { name, status: 'running', forwards: { [String(SPACESD_GUEST_PORT)]: hostPort } }
}

const outsideRootsPattern = /outside the macOS sandbox roots/

describe('macOS shared VM manager boot', () => {
  test('boots the VM once and mounts once for three registrations', async () => {
    const dataDir = makeTempDir()
    const rootA = makeTempDir()
    const rootB = makeTempDir()
    const worktreesDir = join(dataDir, 'worktrees')
    const shares = [shareFor(rootA), shareFor(rootB), shareFor(worktreesDir)]
    const projectA = join(rootA, 'project')
    const projectB = join(rootB, 'project')
    const worktreeProject = join(worktreesDir, 'feature')
    for (const dir of [projectA, projectB, worktreeProject]) mkdirSync(dir, { recursive: true })
    const { runtime, execCalls } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm('forge-macos-base', stoppedVm('forge-macos-base'))
    const manager = makeManager({ runtime, lume, dataDir, shares })

    const results = [
      await manager.start('root-a', projectA),
      await manager.start('root-b', projectB),
      await manager.start('worktree', worktreeProject),
    ]

    expect(results.map((result) => result.containerName)).toEqual([MACOS_VM_NAME, MACOS_VM_NAME, MACOS_VM_NAME])
    expect(lume.getCloneCalls()).toEqual([{ source: 'forge-macos-base', target: MACOS_VM_NAME }])
    expect(lume.getRunCalls()).toHaveLength(1)
    expect(execCalls).toHaveLength(1)
    for (const share of shares) {
      expect(execCalls[0]).toContain(share.tag)
      expect(execCalls[0]).toContain(share.guestDir)
    }
    for (const name of ['root-a', 'root-b', 'worktree']) {
      expect(manager.getActive(name)?.mounts).toEqual(macosMountsFromShares(shares))
    }
  })

  test('sends the stopped-VM boot payload and records the boot', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const skillsDir = makeTempDir()
    const shares = [shareFor(root), shareFor(skillsDir, true)]
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares })

    await manager.start('wt', projectDir)

    const [runCall] = lume.getRunCalls()
    expect(runCall.name).toBe(MACOS_VM_NAME)
    expect(runCall.body.forwards).toEqual([SPACESD_GUEST_PORT])
    expect(runCall.body.network).toBe(`gateway:${gatewaySocketPath(join(dataDir, 'macos', 'net'))}`)
    expect(runCall.body.sharedDirectories.slice(0, -1)).toEqual(
      shares.map((share) => ({ hostPath: share.hostDir, readOnly: share.readOnly, tag: share.tag })),
    )
    expect(runCall.body.sharedDirectories.at(-1)).toEqual({
      hostPath: join(dataDir, 'macos', 'setup'),
      readOnly: true,
      tag: MACOS_SETUP_SHARE_TAG,
    })

    const vmState = JSON.parse(readFileSync(join(dataDir, 'macos', 'vm-state.json'), 'utf-8'))
    expect(vmState).toEqual({ shares, bootedAt: expect.any(String) })
    expect(readFileSync(join(dataDir, 'macos', 'spacesd-url'), 'utf-8')).toContain('http://127.0.0.1:45678')
  })

  test('refuses when the base VM does not exist', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(
      'macOS sandbox base VM "forge-macos-base" not found; build it as described in docs/sandbox.md (macOS mode)',
    )
    expect(lume.getCloneCalls()).toEqual([])
    expect(manager.isActive('wt')).toBe(false)
  })

  test('writes a deny-all egress policy and reports LAN off', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await manager.start('wt', projectDir)

    const netDir = join(dataDir, 'macos', 'net')
    const rules = JSON.parse(readFileSync(join(netDir, 'netgw-rules.json'), 'utf-8'))
    expect(rules.default_accept).toBe(false)
    expect(rules.rules).toEqual([])
    expect(existsSync(join(netDir, 'netgw.json'))).toBe(true)
    expect(manager.getActive('wt')?.settings?.allowLan).toBe(false)
  })

  test('continues when availability is unknown', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const logger = createMockLogger()
    runtime.checkAvailable = vi.fn(async () => ({
      available: false as const,
      reason: 'unknown' as const,
      detail: 'probe timed out',
    }))
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)], logger })

    await expect(manager.start('wt', projectDir)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    expect(manager.isActive('wt')).toBe(true)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('could not determine macOS sandbox availability'),
    )
  })

  test('refuses when the backend is unavailable', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    runtime.checkAvailable = vi.fn(async () => ({
      available: false as const,
      reason: 'not-installed' as const,
      detail: 'no lume',
    }))
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.start('wt', projectDir)).rejects.toThrow('mock unavailable')
    expect(lume.getVmCalls()).toEqual([])
  })

  test('refuses when the Lume VM query fails', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.failNext('getVm')
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(
      'Could not determine whether forge-macos exists (Lume query failed); refusing to start',
    )
    expect(manager.isActive('wt')).toBe(false)
  })

  test('adopts a VM that another starter brought up when runVm fails', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const shares = [shareFor(root)]
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    lume.runVm = async () => {
      lume.setVm(MACOS_VM_NAME, runningVm(MACOS_VM_NAME, 40000))
      throw new Error('already running')
    }
    const manager = makeManager({ runtime, lume, dataDir, shares })

    await expect(manager.start('wt', projectDir)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    expect(readFileSync(join(dataDir, 'macos', 'spacesd-url'), 'utf-8')).toContain('http://127.0.0.1:40000')
    const vmState = JSON.parse(readFileSync(join(dataDir, 'macos', 'vm-state.json'), 'utf-8'))
    expect(vmState.shares).toEqual(shares)
  })

  test('boot times out when the spacesd forward never appears', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    lume.setForwardAfterPolls(10000)
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)], bootTimeoutMs: 20 })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(/did not become ready within 20ms/)
  })

  test('refuses when the shares cannot be mounted', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    runtime.exec = vi.fn(async () => ({ stdout: '', stderr: 'mount_virtiofs failed', exitCode: 1 }))
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(
      'Failed to mount macOS sandbox shares: mount_virtiofs failed',
    )
    expect(manager.isActive('wt')).toBe(false)
  })
})

describe('macOS shared VM manager revalidation', () => {
  test('re-boots the shared VM after it stops', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await manager.start('wt', projectDir)
    expect(lume.getRunCalls()).toHaveLength(1)

    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))

    await expect(manager.start('wt', projectDir)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    expect(lume.getRunCalls()).toHaveLength(2)
    expect(manager.isActive('wt')).toBe(true)
    expect(readFileSync(join(dataDir, 'macos', 'spacesd-url'), 'utf-8')).toContain('http://127.0.0.1:45678')
  })

  test('re-adopts a restarted VM with a new spacesd URL', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime, execCalls } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await manager.start('wt', projectDir)
    expect(lume.getRunCalls()).toHaveLength(1)
    expect(execCalls).toHaveLength(1)

    lume.setVm(MACOS_VM_NAME, runningVm(MACOS_VM_NAME, 41000))

    await expect(manager.start('wt', projectDir)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    expect(lume.getRunCalls()).toHaveLength(1)
    expect(readFileSync(join(dataDir, 'macos', 'spacesd-url'), 'utf-8')).toContain('http://127.0.0.1:41000')
    expect(execCalls).toHaveLength(2)
  })

  test('keeps the cached boot while the VM is transient or unreachable', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime, execCalls } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await manager.start('wt', projectDir)
    lume.setVm(MACOS_VM_NAME, { name: MACOS_VM_NAME, status: 'provisioning' })

    await expect(manager.start('wt', projectDir)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    expect(lume.getRunCalls()).toHaveLength(1)
    expect(execCalls).toHaveLength(1)

    lume.failNext('getVm')

    await expect(manager.start('wt', projectDir)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    expect(lume.getRunCalls()).toHaveLength(1)
    expect(execCalls).toHaveLength(1)
    expect(readFileSync(join(dataDir, 'macos', 'spacesd-url'), 'utf-8')).toContain('http://127.0.0.1:45678')
  })
})

describe('macOS shared VM manager roots', () => {
  test('refuses a project outside every share before registering it', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const outsideRoot = makeTempDir()
    const outsideProject = join(outsideRoot, 'project')
    mkdirSync(outsideProject, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    const promise = manager.start('wt', outsideProject)
    await expect(promise).rejects.toThrow(outsideRootsPattern)
    await expect(manager.start('wt', outsideProject)).rejects.toThrow(/restart the forge-macos VM/)
    expect(manager.isActive('wt')).toBe(false)
    expect(manager.getActive('wt')).toBeNull()
  })

  test('refuses a git common dir outside every share', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const outsideRoot = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({
      runtime,
      lume,
      dataDir,
      shares: [shareFor(root)],
      git: fakeGit(outsideRoot),
    })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(outsideRootsPattern)
    expect(manager.isActive('wt')).toBe(false)
  })

  test('adopting a running VM mounts only the recorded shares', async () => {
    const dataDir = makeTempDir()
    const rootA = makeTempDir()
    const rootB = makeTempDir()
    const shareA = shareFor(rootA)
    const shareB = shareFor(rootB)
    const projectA = join(rootA, 'project')
    const projectB = join(rootB, 'project')
    for (const dir of [projectA, projectB]) mkdirSync(dir, { recursive: true })
    mkdirSync(join(dataDir, 'macos'), { recursive: true })
    writeFileSync(
      join(dataDir, 'macos', 'vm-state.json'),
      JSON.stringify({ shares: [shareA], bootedAt: 'boot-1' }),
    )
    const { runtime, execCalls } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, runningVm(MACOS_VM_NAME, 40000))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareA, shareB] })

    await expect(manager.start('root-a', projectA)).resolves.toEqual({ containerName: MACOS_VM_NAME })
    await expect(manager.start('root-b', projectB)).rejects.toThrow(/restart the forge-macos VM/)

    expect(lume.getRunCalls()).toEqual([])
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]).toContain(shareA.guestDir)
    expect(execCalls[0]).not.toContain(shareB.guestDir)
  })

  test('adopting without a recorded vm-state refuses every share', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, runningVm(MACOS_VM_NAME, 40000))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(outsideRootsPattern)
    expect(manager.isActive('wt')).toBe(false)
  })

  test('adopting with a corrupt vm-state refuses every share', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(dataDir, 'macos'), { recursive: true })
    writeFileSync(join(dataDir, 'macos', 'vm-state.json'), '{not json')
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, runningVm(MACOS_VM_NAME, 40000))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.start('wt', projectDir)).rejects.toThrow(outsideRootsPattern)
    expect(manager.isActive('wt')).toBe(false)
  })
})

describe('macOS shared VM manager lifecycle', () => {
  test('refuses per-loop secrets before touching the VM', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(
      manager.start('wt', projectDir, undefined, { secrets: [{ env: 'TOKEN', hosts: ['example.com'] }] }),
    ).rejects.toThrow(
      'Per-loop secrets are not supported in the macOS sandbox mode; remove them or use sandbox.mode "msb"',
    )
    await expect(
      manager.start('wt', projectDir, undefined, { secretProvider: 'provider' }),
    ).rejects.toThrow(
      'Per-loop secrets are not supported in the macOS sandbox mode; remove them or use sandbox.mode "msb"',
    )
    expect(lume.getVmCalls()).toEqual([])
  })

  test('stop drops only the local registration', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectA = join(root, 'a')
    const projectB = join(root, 'b')
    for (const dir of [projectA, projectB]) mkdirSync(dir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await manager.start('a', projectA)
    await manager.start('b', projectB)
    const vmCallsBefore = lume.getVmCalls().length

    await manager.stop('a')

    expect(manager.isActive('a')).toBe(false)
    expect(manager.isActive('b')).toBe(true)
    expect(manager.getActive('b')).not.toBeNull()
    expect(lume.getStopCalls()).toEqual([])
    expect(lume.getVmCalls()).toHaveLength(vmCallsBefore)
  })

  test('isLive drops a registration once the VM disappears', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    runtime.getSandboxState = vi.fn(async () => mapLumeVmState(await lume.getVm(MACOS_VM_NAME)))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await manager.start('wt', projectDir)
    lume.setVm(MACOS_VM_NAME, null)

    await expect(manager.isLive('wt')).resolves.toBe(false)
    expect(manager.isActive('wt')).toBe(false)

    lume.setVm(MACOS_VM_NAME, runningVm(MACOS_VM_NAME, 40000))
    await manager.start('wt', projectDir)

    await expect(manager.isLive('wt')).resolves.toBe(true)
  })

  test('exposes a no-op surface on top of the shared VM', async () => {
    const dataDir = makeTempDir()
    const root = makeTempDir()
    const projectDir = join(root, 'project')
    const restoredDir = join(root, 'restored')
    for (const dir of [projectDir, restoredDir]) mkdirSync(dir, { recursive: true })
    const { runtime } = makeRuntime()
    const lume = createFakeLumeClient()
    lume.setVm(MACOS_VM_NAME, stoppedVm(MACOS_VM_NAME))
    const manager = makeManager({ runtime, lume, dataDir, shares: [shareFor(root)] })

    await expect(manager.cleanupOrphans()).resolves.toBe(0)
    await manager.start('wt', projectDir)
    await expect(manager.applyOverrides('wt', projectDir)).resolves.toBe('unchanged')

    await manager.restore('restored', restoredDir, new Date().toISOString())

    expect(manager.isActive('restored')).toBe(true)
    expect(manager.getActive('restored')?.containerName).toBe(MACOS_VM_NAME)
  })
})
