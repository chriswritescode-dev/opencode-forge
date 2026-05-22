import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBashTool } from '../../src/tools/bash'
import type { SandboxContext } from '../../src/sandbox/context'
import type { Logger } from '../../src/types'

type DockerExecResult = { stdout: string; stderr: string; exitCode: number }
type DockerExecCall = { order: number; name: string; command: string; opts?: { timeout?: number; cwd?: string } }

describe('createBashTool', () => {
  let order: number
  let dockerResult: DockerExecResult
  let dockerCalls: DockerExecCall[]
  let askCalls: Array<{ order: number; input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> } }>
  let mockAsk: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>
  let mockDocker: SandboxContext['docker']
  let mockLogger: Logger
  let mockToolCtx: {
    sessionID: string
    messageID: string
    agent: string
    directory: string
    worktree: string
    abort: AbortSignal
    metadata: () => void
    ask: typeof mockAsk
  }

  let tmpData: string
  let tmpHostDir: string

  beforeEach(() => {
    order = 0
    dockerResult = { stdout: 'docker ok\n', stderr: '', exitCode: 0 }
    dockerCalls = []
    askCalls = []
    tmpData = mkdtempSync(join(tmpdir(), 'forge-bash-data-'))
    tmpHostDir = mkdtempSync(join(tmpdir(), 'forge-bash-host-'))
    mockAsk = async (input) => {
      askCalls.push({ order: ++order, input })
    }
    mockDocker = {
      exec: async (name, command, opts) => {
        dockerCalls.push({ order: ++order, name, command, opts })
        return dockerResult
      },
    } as SandboxContext['docker']
    mockLogger = { log() {}, error() {}, debug() {} }
    mockToolCtx = {
      sessionID: 's1',
      messageID: 'msg-1',
      agent: 'code',
      directory: tmpHostDir,
      worktree: tmpHostDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: mockAsk,
    }
  })

  function sandbox(): SandboxContext {
    return { docker: mockDocker, containerName: 'forge-foo', hostDir: tmpHostDir }
  }

  function makeBash(sandboxFor: (sessionID: string) => Promise<SandboxContext | null> | SandboxContext | null) {
    return createBashTool({
      resolveSandboxForSession: async (sessionID) => await sandboxFor(sessionID),
      logger: mockLogger,
      dataDir: tmpData,
    })
  }

  test('runs command in docker when sandbox resolves', async () => {
    const tool = makeBash((sessionID) => sessionID === 's1' ? sandbox() : null)

    const result = await tool.execute({ command: 'echo hi', description: 'echo' }, mockToolCtx as never)

    expect(dockerCalls).toHaveLength(1)
    expect(dockerCalls[0]).toMatchObject({ name: 'forge-foo', command: 'echo hi', opts: { timeout: undefined, cwd: undefined } })
    expect(result).toContain('docker ok')
  })

  test('translates workdir to /workspace path for docker', async () => {
    const tool = makeBash(() => sandbox())

    await tool.execute({ command: 'ls', workdir: join(tmpHostDir, 'src'), description: 'list' }, mockToolCtx as never)

    expect(dockerCalls[0]?.opts).toMatchObject({ cwd: '/workspace/src' })
  })

  test('rewrites /workspace output back to host path', async () => {
    dockerResult = { stdout: '/workspace/src/file.ts\n', stderr: '', exitCode: 0 }
    const tool = makeBash(() => sandbox())

    const result = await tool.execute({ command: 'ls', description: 'list' }, mockToolCtx as never)

    expect(result).toContain(join(tmpHostDir, 'src/file.ts'))
    expect(result).not.toContain('/workspace')
  })

  test('propagates timeout to docker exec', async () => {
    const tool = makeBash(() => sandbox())

    await tool.execute({ command: 'sleep 1', timeout: 5000, description: 't' }, mockToolCtx as never)

    expect(dockerCalls[0]?.opts).toMatchObject({ timeout: 5000 })
  })

  test('returns non-zero exit code with marker', async () => {
    dockerResult = { stdout: 'oops', stderr: 'err', exitCode: 2 }
    const tool = makeBash(() => sandbox())

    const result = await tool.execute({ command: 'false', description: 'fail' }, mockToolCtx as never)

    expect(result).toContain('oops')
    expect(result).toContain('err')
    expect(result).toContain('[Exit code: 2]')
  })

  test('returns timeout metadata when exit code is 124', async () => {
    dockerResult = { stdout: '', stderr: '', exitCode: 124 }
    const tool = makeBash(() => sandbox())

    const result = await tool.execute({ command: 'sleep 10', timeout: 5000, description: 'timeout' }, mockToolCtx as never)

    expect(result).toContain('<bash_metadata>\nbash tool terminated command after exceeding timeout')
    expect(result).toContain('5000 ms')
  })

  test('falls back to host execution when sandbox is null', async () => {
    const tool = makeBash(() => null)

    const result = await tool.execute({ command: 'printf hello', description: 'host' }, mockToolCtx as never)

    expect(dockerCalls).toHaveLength(0)
    expect(String(result).trim()).toBe('hello')
  })

  test('host fallback honours workdir', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'forge-bash-'))
    writeFileSync(join(tempDir, 'marker.txt'), 'x')
    const tool = makeBash(() => null)

    const result = await tool.execute({ command: 'ls', workdir: tempDir, description: 'ls' }, mockToolCtx as never)

    expect(result).toContain('marker.txt')
  })

  test('host fallback returns exit code marker for non-zero', async () => {
    const tool = makeBash(() => null)

    const result = await tool.execute({ command: 'sh -c "exit 3"', description: 'fail' }, mockToolCtx as never)

    expect(result).toContain('[Exit code: 3]')
  })

  test('asks permission with arity-scoped patterns and always', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'git push origin main', description: 'push' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.permission).toBe('bash')
    expect(askCalls[0]?.input.patterns).toEqual(['git push origin main'])
    expect(askCalls[0]?.input.always).toEqual(['git push *'])
  })

  test('supports forge-bash permission name for loop sandboxes', async () => {
    const tool = createBashTool({
      resolveSandboxForSession: async () => sandbox(),
      logger: mockLogger,
      dataDir: tmpData,
      permissionName: 'forge-bash',
      requireSandbox: true,
    })
    await tool.execute({ command: 'git status', description: 'status' }, mockToolCtx as never)
    expect(askCalls[0]?.input.permission).toBe('forge-bash')
  })

  test('forge-bash mode rejects sessions without an active sandbox', async () => {
    const tool = createBashTool({
      resolveSandboxForSession: async () => null,
      logger: mockLogger,
      dataDir: tmpData,
      permissionName: 'forge-bash',
      requireSandbox: true,
    })
    await expect(tool.execute({ command: 'git status', description: 'status' }, mockToolCtx as never)).rejects.toThrow(/active Forge loop sandboxes/)
    expect(askCalls).toHaveLength(0)
  })

  test('arity for npm run uses 3-token prefix', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'npm run build', description: 'build' }, mockToolCtx as never)
    expect(askCalls[0]?.input.always).toEqual(['npm run build *'])
  })

  test('propagates permission rejection', async () => {
    mockAsk = async () => { throw new Error('Denied by user rule') }
    mockToolCtx.ask = mockAsk
    const tool = makeBash(() => sandbox())

    await expect(tool.execute({ command: 'git push', description: 'push' }, mockToolCtx as never)).rejects.toThrow(/Denied/)
    expect(dockerCalls).toHaveLength(0)
  })

  test('asks permission even when no command nodes found (redirection-only)', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: '> /tmp/marker', description: 'redirect' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.permission).toBe('bash')
    expect(askCalls[0]?.input.patterns).toEqual(['> /tmp/marker'])
    expect(askCalls[0]?.input.always).toEqual(['> /tmp/marker'])
  })

  test('permission rejection prevents redirection command from executing', async () => {
    mockAsk = async () => { throw new Error('Denied by user rule') }
    mockToolCtx.ask = mockAsk
    const tool = makeBash(() => sandbox())

    await expect(tool.execute({ command: '> /tmp/marker', description: 'redirect' }, mockToolCtx as never)).rejects.toThrow(/Denied/)
    expect(dockerCalls).toHaveLength(0)
  })

  test('asks permission with both command and redirection-only side effects', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'echo hi; > /tmp/marker', description: 'echo and redirect' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.permission).toBe('bash')
    expect(askCalls[0]?.input.patterns).toEqual(['echo hi', '> /tmp/marker'])
    expect(askCalls[0]?.input.always).toEqual(['echo *', '> /tmp/marker'])
  })

  test('permission rejection prevents mixed command + redirect from executing', async () => {
    mockAsk = async () => { throw new Error('Denied by user rule') }
    mockToolCtx.ask = mockAsk
    const tool = makeBash(() => sandbox())

    await expect(tool.execute({ command: 'echo hi; > /tmp/marker', description: 'echo and redirect' }, mockToolCtx as never)).rejects.toThrow(/Denied/)
    expect(dockerCalls).toHaveLength(0)
  })

  test('regression: frozen args object does not throw', async () => {
    const tool = makeBash(() => sandbox())

    await expect(tool.execute(Object.freeze({ command: 'ls', description: 'list' }), mockToolCtx as never)).resolves.toBeDefined()
  })

  test('asks permission for redirection inside if statement', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'if true; then > /tmp/marker; fi', description: 'nested redirect' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.permission).toBe('bash')
    expect(askCalls[0]?.input.patterns.some(p => p.includes('> /tmp/marker'))).toBe(true)
  })

  test('asks permission for redirection inside while loop', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'while false; do > /tmp/marker; done', description: 'nested redirect' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.patterns.some(p => p.includes('> /tmp/marker'))).toBe(true)
  })

  test('asks permission for redirection inside compound block', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: '{ echo hi; > /tmp/marker; }', description: 'nested redirect' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.patterns).toEqual(['echo hi', '> /tmp/marker'])
  })

  test('truncates docker output and writes overflow file', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n')
    dockerResult = { stdout: big, stderr: '', exitCode: 0 }
    const tool = makeBash(() => sandbox())
    const result = await tool.execute({ command: 'big', description: 'big' }, mockToolCtx as never)
    expect(result).toContain('...output truncated...')
    expect(result).toContain('Full output saved to:')
    expect(result).toContain(join(tmpData, 'bash-output'))
  })

  test('asks external_directory before bash for rm of external path', async () => {
    const tool = createBashTool({
      resolveSandboxForSession: async () => sandbox(),
      logger: mockLogger,
      dataDir: tmpData,
    })
    await tool.execute({ command: 'rm /tmp/external/foo.txt', description: 'rm' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(2)
    expect(askCalls[0]?.input.permission).toBe('external_directory')
    expect(askCalls[1]?.input.permission).toBe('bash')
    expect(askCalls[0]!.order).toBeLessThan(askCalls[1]!.order)
  })

  test('does NOT ask external_directory for in-cwd rm', async () => {
    mockToolCtx.directory = '/home/proj'
    const tool = createBashTool({
      resolveSandboxForSession: async () => sandbox(),
      logger: mockLogger,
      dataDir: tmpData,
    })
    await tool.execute({ command: 'rm src/foo.txt', description: 'rm' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.permission).toBe('bash')
  })

  test('streams ctx.metadata while host command runs', async () => {
    const metaCalls: Array<{ output: string }> = []
    const ctx = { ...mockToolCtx, metadata: (m: { metadata: { output: string } }) => { metaCalls.push(m.metadata) } }
    const tool = createBashTool({
      resolveSandboxForSession: async () => null,
      logger: mockLogger,
      dataDir: tmpData,
    })
    await tool.execute({ command: 'printf one; printf two; printf three', description: 's' }, ctx as never)
    expect(metaCalls.length).toBeGreaterThanOrEqual(1)
    expect(metaCalls[metaCalls.length - 1]?.output).toContain('onetwothree')
  })

  test('host abort signal kills the child', async () => {
    const controller = new AbortController()
    const ctx = { ...mockToolCtx, abort: controller.signal }
    const tool = createBashTool({
      resolveSandboxForSession: async () => null,
      logger: mockLogger,
      dataDir: tmpData,
    })
    const promise = tool.execute({ command: 'sleep 5', description: 's' }, ctx as never)
    setTimeout(() => controller.abort(), 50)
    const result = await promise
    expect(result).toBeDefined() // resolved (not hung)
  })

  test('external workdir triggers external_directory before bash', async () => {
    mockToolCtx.directory = '/repo'
    const tool = createBashTool({
      resolveSandboxForSession: async () => sandbox(),
      logger: mockLogger,
      dataDir: tmpData,
    })
    await tool.execute({ command: 'rm foo.txt', workdir: '/tmp/external', description: 'rm' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(2)
    expect(askCalls[0]?.input.permission).toBe('external_directory')
    expect(askCalls[0]?.input.patterns.some(p => p.startsWith('/tmp/external/'))).toBe(true)
    expect(askCalls[1]?.input.permission).toBe('bash')
    expect(askCalls[0]!.order).toBeLessThan(askCalls[1]!.order)
  })

  test('in-workspace workdir does NOT request external_directory', async () => {
    mockToolCtx.directory = '/repo'
    const tool = createBashTool({
      resolveSandboxForSession: async () => sandbox(),
      logger: mockLogger,
      dataDir: tmpData,
    })
    await tool.execute({ command: 'ls', workdir: '/repo/src', description: 'list' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input.permission).toBe('bash')
  })

  test('tool description references Bash, workdir, and truncation', () => {
    const tool = createBashTool({
      resolveSandboxForSession: async () => null,
      logger: mockLogger,
      dataDir: '/tmp',
    })
    expect(tool.description).toContain('bash')
    expect(tool.description).toContain('workdir')
    expect(tool.description).toMatch(/truncated|truncation/i)
  })

  test('tool description contains upstream prompt content', () => {
    const tool = createBashTool({
      resolveSandboxForSession: async () => null,
      logger: mockLogger,
      dataDir: '/tmp',
    })
    expect(tool.description).toContain('# Git and GitHub')
    expect(tool.description).toContain('Use `gh` for GitHub tasks')
    expect(tool.description).toContain('Directory Verification')
    expect(tool.description).toContain('Command Execution')
    expect(tool.description).toContain('Usage notes')
    expect(tool.description).toContain('persistent shell session')
  })

  test('host fallback uses ctx.directory when no workdir provided', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'forge-bash-dir-'))
    writeFileSync(join(tempDir, 'marker.txt'), 'x')
    mockToolCtx.directory = tempDir
    const tool = makeBash(() => null)

    const result = await tool.execute({ command: 'ls', description: 'ls' }, mockToolCtx as never)

    expect(result).toContain('marker.txt')
  })

  test('relative workdir resolves under ctx.directory', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'forge-bash-rel-'))
    const subDir = join(tempDir, 'sub')
    const { mkdirSync } = await import('fs')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'marker.txt'), 'x')
    mockToolCtx.directory = tempDir
    const tool = makeBash(() => null)

    const result = await tool.execute({ command: 'ls', workdir: 'sub', description: 'ls' }, mockToolCtx as never)

    expect(result).toContain('marker.txt')
  })
})
