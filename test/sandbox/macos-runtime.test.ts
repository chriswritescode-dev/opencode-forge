import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MACOS_DEFAULT_TIMEOUT,
  createMacosRuntime,
  describeMacosUnavailable,
  ensureSpacesdToken,
  macosStatePaths,
} from '../../src/sandbox/macos'
import type { CommandResult } from '../../src/sandbox/process'
import type { CommandRunner } from '../../src/sandbox/runtime'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-macos-runtime-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type LumeArg = Parameters<typeof createMacosRuntime>[0]['lume']

interface FakeLume {
  lume: LumeArg
  getVm: ReturnType<typeof vi.fn>
  listVms: ReturnType<typeof vi.fn>
}

function createFakeLume(): FakeLume {
  const getVm = vi.fn()
  const listVms = vi.fn()
  const lume = {
    getVm,
    listVms,
    cloneVm: vi.fn(),
    runVm: vi.fn(),
    stopVm: vi.fn(),
  } as unknown as LumeArg
  return { lume, getVm, listVms }
}

function makeRuntime(input: {
  dataDir: string
  lume: LumeArg
  config?: Parameters<typeof createMacosRuntime>[0]['config']
  run?: CommandRunner
}) {
  return createMacosRuntime({
    dataDir: input.dataDir,
    config: input.config ?? {},
    lume: input.lume,
    logger,
    run: input.run,
  })
}

interface RecordedRun {
  command: string
  args: string[]
  opts?: { timeout?: number; env?: Record<string, string>; abort?: AbortSignal }
}

function recordingRun(result?: Partial<CommandResult>): { run: CommandRunner; calls: RecordedRun[] } {
  const calls: RecordedRun[] = []
  const run: CommandRunner = async (args, opts) => {
    calls.push({ command: args[0] ?? '', args: args.slice(1), opts })
    return { stdout: '', stderr: '', exitCode: 0, ...result }
  }
  return { run, calls }
}

function writeUrlFile(dataDir: string, url = 'http://127.0.0.1:61000'): void {
  const paths = macosStatePaths(dataDir)
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.urlFile, url)
}

describe('macosStatePaths', () => {
  test('lays out every macOS sandbox state path under the data dir', () => {
    expect(macosStatePaths('/data')).toEqual({
      root: '/data/macos',
      setupDir: '/data/macos/setup',
      tokenFile: '/data/macos/setup/env-token',
      urlFile: '/data/macos/spacesd-url',
      vmStateFile: '/data/macos/vm-state.json',
      netDir: '/data/macos/net',
    })
  })
})

describe('ensureSpacesdToken', () => {
  test('creates a 64-hex token once with restrictive modes', () => {
    const paths = macosStatePaths(makeTempDir())

    const token = ensureSpacesdToken(paths)

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(paths.tokenFile, 'utf-8')).toBe(token)
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600)
    expect(statSync(paths.setupDir).mode & 0o777).toBe(0o700)
    expect(ensureSpacesdToken(paths)).toBe(token)
  })

  test('regenerates the token when the file is empty', () => {
    const paths = macosStatePaths(makeTempDir())
    const token = ensureSpacesdToken(paths)
    writeFileSync(paths.tokenFile, '  \n')

    const regenerated = ensureSpacesdToken(paths)

    expect(regenerated).toMatch(/^[0-9a-f]{64}$/)
    expect(regenerated).not.toBe(token)
    expect(readFileSync(paths.tokenFile, 'utf-8')).toBe(regenerated)
  })
})

describe('exec', () => {
  test('runs cua spacesd exec with cwd, timeout, url, and the token in the environment', async () => {
    const dataDir = makeTempDir()
    const paths = macosStatePaths(dataDir)
    writeUrlFile(dataDir)
    const cuaPath = join(dataDir, 'bin dir', 'cua')
    const controller = new AbortController()
    const { run, calls } = recordingRun({ stdout: 'hi', exitCode: 0 })
    const runtime = makeRuntime({ dataDir, config: { cuaPath }, lume: createFakeLume().lume, run })

    const result = await runtime.exec('ignored', 'echo hi', {
      timeout: 4100,
      cwd: '/work',
      abort: controller.signal,
    })

    expect(result).toEqual({ stdout: 'hi', stderr: '', exitCode: 0 })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.command).toBe(cuaPath)
    expect(call.args).toEqual([
      'spacesd',
      'exec',
      '--cwd',
      '/work',
      '--timeout',
      '5',
      'http://127.0.0.1:61000',
      '/bin/bash',
      '-c',
      'umask 022; echo hi',
    ])
    const token = ensureSpacesdToken(paths)
    expect(call.opts?.env?.CUA_SPACESD_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(call.opts?.env?.CUA_SPACESD_TOKEN).toBe(token)
    for (const arg of call.args) {
      expect(arg).not.toBe(token)
      expect(arg.includes(token)).toBe(false)
    }
    expect(call.opts?.timeout).toBe(4100)
    expect(call.opts?.abort).toBe(controller.signal)
  })

  test('omits --cwd and uses the default timeout when none is given', async () => {
    const dataDir = makeTempDir()
    writeUrlFile(dataDir)
    const { run, calls } = recordingRun()
    const runtime = makeRuntime({ dataDir, lume: createFakeLume().lume, run })

    await runtime.exec('ignored', 'echo hi')

    const [call] = calls
    expect(call.command).toBe('cua')
    expect(call.args).toEqual([
      'spacesd',
      'exec',
      '--timeout',
      String(Math.ceil(MACOS_DEFAULT_TIMEOUT / 1000)),
      'http://127.0.0.1:61000',
      '/bin/bash',
      '-c',
      'umask 022; echo hi',
    ])
    expect(call.args).not.toContain('--cwd')
    expect(call.opts?.timeout).toBe(MACOS_DEFAULT_TIMEOUT)
  })

  test('refuses when no spacesd endpoint has been recorded', async () => {
    const run = vi.fn<CommandRunner>()
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume: createFakeLume().lume, run })

    await expect(runtime.exec('ignored', 'echo hi')).rejects.toThrow(
      'macOS sandbox is not ready (no spacesd endpoint)',
    )
    expect(run).not.toHaveBeenCalled()
  })
})

describe('getSandboxState', () => {
  test('maps missing, running, and unknown VM states', async () => {
    const { lume, getVm } = createFakeLume()
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })

    getVm.mockResolvedValueOnce(null)
    await expect(runtime.getSandboxState('forge-macos')).resolves.toBe('missing')

    getVm.mockResolvedValueOnce({
      name: 'forge-macos',
      status: 'running',
      forwards: { '3211': 61000 },
    })
    await expect(runtime.getSandboxState('forge-macos')).resolves.toBe('running')

    getVm.mockRejectedValueOnce(new Error('lume down'))
    await expect(runtime.getSandboxState('forge-macos')).resolves.toBe('unknown')
  })
})

describe('templateExists', () => {
  test('is true when lume returns the VM', async () => {
    const { lume, getVm } = createFakeLume()
    getVm.mockResolvedValue({ name: 'forge-macos', status: 'stopped' })
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })

    await expect(runtime.templateExists('forge-macos')).resolves.toBe(true)
  })

  test('is false when lume returns null', async () => {
    const { lume, getVm } = createFakeLume()
    getVm.mockResolvedValue(null)
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })

    await expect(runtime.templateExists('forge-macos')).resolves.toBe(false)
  })

  test('is false when lume throws', async () => {
    const { lume, getVm } = createFakeLume()
    getVm.mockRejectedValue(new Error('lume down'))
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })

    await expect(runtime.templateExists('forge-macos')).resolves.toBe(false)
  })
})

describe('readSandboxSettings', () => {
  test('maps VM cpu and memory to runtime settings', async () => {
    const { lume, getVm } = createFakeLume()
    getVm.mockResolvedValue({
      name: 'forge-macos',
      status: 'running',
      cpuCount: 4,
      memorySize: 8589934592,
    })
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })

    await expect(runtime.readSandboxSettings('forge-macos')).resolves.toEqual({
      cpus: 4,
      memoryMib: 8192,
      allowLan: false,
    })
  })

  test('returns null when the VM is missing', async () => {
    const { lume, getVm } = createFakeLume()
    getVm.mockResolvedValue(null)
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })

    await expect(runtime.readSandboxSettings('forge-macos')).resolves.toBeNull()
  })
})

describe('unsupported operations', () => {
  test('throw the exact unsupported messages', async () => {
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume: createFakeLume().lume })

    await expect(runtime.loadTemplate('/tmp/template.tar', 'ref')).rejects.toThrow(
      'loadTemplate is not supported in the macOS sandbox mode',
    )
    await expect(runtime.createSandbox('name', [], { image: 'image' })).rejects.toThrow(
      'createSandbox is not supported in the macOS sandbox mode',
    )
    await expect(runtime.startSandbox('name')).rejects.toThrow(
      'startSandbox is not supported in the macOS sandbox mode',
    )
    await expect(runtime.resizeSandbox('name', { cpus: '2', memory: '4g' })).rejects.toThrow(
      'resizeSandbox is not supported in the macOS sandbox mode',
    )
  })
})

describe('refreshSandboxSecrets', () => {
  test('succeeds when no secrets are configured', async () => {
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume: createFakeLume().lume })

    await expect(runtime.refreshSandboxSecrets('forge-macos', [])).resolves.toEqual({ ok: true })
  })

  test('refuses secrets in the macOS sandbox mode', async () => {
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume: createFakeLume().lume })

    await expect(
      runtime.refreshSandboxSecrets('forge-macos', [{ env: 'API_TOKEN', hosts: ['api.example.com'] }]),
    ).resolves.toEqual({
      ok: false,
      reason: 'secrets are not supported in the macOS sandbox mode',
    })
  })
})

describe('shared VM identity', () => {
  test('removeSandbox logs and leaves lume untouched', async () => {
    const { lume, getVm, listVms } = createFakeLume()
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume })
    vi.clearAllMocks()

    await runtime.removeSandbox('forge-macos')

    expect(logger.log).toHaveBeenCalledWith('Sandbox: not removing the shared macOS VM forge-macos')
    expect(getVm).not.toHaveBeenCalled()
    expect(listVms).not.toHaveBeenCalled()
  })

  test('reports no per-sandbox instances and one container name', async () => {
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume: createFakeLume().lume })

    await expect(runtime.listSandboxesByPrefix('forge-')).resolves.toEqual([])
    expect(runtime.sandboxContainerName('any-worktree')).toBe('forge-macos')
    expect(runtime.kind).toBe('macos')
  })
})

describe('checkAvailable', () => {
  test('reports not-installed when the Lume API is unreachable', async () => {
    const { lume, listVms } = createFakeLume()
    listVms.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const lumeUrl = 'http://127.0.0.1:7999'
    const runtime = makeRuntime({ dataDir: makeTempDir(), config: { lumeUrl }, lume })

    await expect(runtime.checkAvailable()).resolves.toEqual({
      available: false,
      reason: 'not-installed',
      detail: `Lume API not reachable at ${lumeUrl}`,
    })
  })

  test('reports not-installed when the cua probe cannot find the binary', async () => {
    const { lume, listVms } = createFakeLume()
    listVms.mockResolvedValue([])
    const cuaPath = '/opt/tools/cua'
    const probed: string[] = []
    const run: CommandRunner = async (args) => {
      probed.push(args[0] ?? '')
      return { stdout: '', stderr: args[0] === cuaPath ? 'spawn cua ENOENT' : '', exitCode: 1 }
    }
    const runtime = makeRuntime({ dataDir: makeTempDir(), config: { cuaPath }, lume, run })

    await expect(runtime.checkAvailable()).resolves.toEqual({
      available: false,
      reason: 'not-installed',
      detail: `\`cua\` is not available at ${cuaPath}`,
    })
    expect(probed).toEqual([cuaPath])
  })

  test('reports unknown when a probe fails for another reason', async () => {
    const { lume, listVms } = createFakeLume()
    listVms.mockResolvedValue([])
    const run: CommandRunner = async () => ({ stdout: '', stderr: 'boom', exitCode: 2 })
    const runtime = makeRuntime({ dataDir: makeTempDir(), lume, run })

    await expect(runtime.checkAvailable()).resolves.toEqual({
      available: false,
      reason: 'unknown',
      detail: 'boom',
    })
  })

  test('probes cua then cua-netgw and rejects non-darwin hosts', async () => {
    const { lume, listVms } = createFakeLume()
    listVms.mockResolvedValue([])
    const probed: string[] = []
    const run: CommandRunner = async (args) => {
      probed.push(args[0] ?? '')
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const runtime = makeRuntime({
      dataDir: makeTempDir(),
      config: { cuaPath: '/bin/cua', netgwPath: '/bin/cua-netgw' },
      lume,
      run,
    })
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')

    await expect(runtime.checkAvailable()).resolves.toEqual({
      available: false,
      reason: 'host-unsupported',
    })
    expect(probed).toEqual(['/bin/cua', '/bin/cua-netgw'])
  })
})

describe('describeMacosUnavailable', () => {
  test('not-installed names the Cua fork binaries and the msb alternative', () => {
    const text = describeMacosUnavailable({ available: false, reason: 'not-installed' })
    expect(text).toContain('lume serve')
    expect(text).toContain('cuaPath')
    expect(text).toContain('cua-netgw')
    expect(text).toContain('msb')
  })

  test('host-unsupported names macOS', () => {
    const text = describeMacosUnavailable({ available: false, reason: 'host-unsupported' })
    expect(text).toContain('macOS')
  })

  test('unknown includes the detail', () => {
    expect(describeMacosUnavailable({ available: false, reason: 'unknown', detail: 'boom' })).toContain('boom')
    expect(describeMacosUnavailable({ available: false, reason: 'unknown' })).toContain('Unknown error.')
  })
})

describe('shimExecLine', () => {
  test('embeds the readiness guard, token export, and spacesd exec line', () => {
    const dataDir = makeTempDir()
    const paths = macosStatePaths(dataDir)
    const cuaPath = join(dataDir, 'bin dir', 'cua')
    const runtime = makeRuntime({ dataDir, config: { cuaPath }, lume: createFakeLume().lume })

    const line = runtime.shimExecLine()
    const lines = line.split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('if [ ! -r ')).toBe(true)
    expect(lines[0]).toContain('exit 125')
    expect(line).toContain(`'${paths.tokenFile}'`)
    expect(line).toContain(`'${paths.urlFile}'`)
    expect(line).toContain(`'${cuaPath}'`)
    expect(line).toContain('export CUA_SPACESD_TOKEN')
    expect(lines[2]).toBe(
      `exec '${cuaPath}' spacesd exec -i --cwd "$PWD" "$(cat '${paths.urlFile}')" /bin/bash -c 'umask 022; exec /bin/bash "$@"' bash "$@"`,
    )
  })
})
