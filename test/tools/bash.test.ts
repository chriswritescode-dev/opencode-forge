import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
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
    tmpData = mkdtempSync(join(tmpdir(), 'forge-sh-data-'))
    tmpHostDir = mkdtempSync(join(tmpdir(), 'forge-sh-host-'))
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

  test('skips ctx.ask entirely (loop-session membership is enforced by the tool, not the permission system)', async () => {
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'git status', description: 'status' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(0)
    expect(dockerCalls).toHaveLength(1)
  })

  test('skips ctx.ask for external workdir (sandbox guarantees consistent paths)', async () => {
    mockToolCtx.directory = '/repo'
    const tool = makeBash(() => sandbox())
    await tool.execute({ command: 'rm foo.txt', workdir: '/tmp/external', description: 'rm' }, mockToolCtx as never)
    expect(askCalls).toHaveLength(0)
  })

  test('rejects sessions without an active loop sandbox', async () => {
    const tool = makeBash(() => null)
    await expect(tool.execute({ command: 'git status', description: 'status' }, mockToolCtx as never)).rejects.toThrow(/active Forge loop session sandbox/)
    expect(askCalls).toHaveLength(0)
    expect(dockerCalls).toHaveLength(0)
  })

  test('regression: frozen args object does not throw', async () => {
    const tool = makeBash(() => sandbox())

    await expect(tool.execute(Object.freeze({ command: 'ls', description: 'list' }), mockToolCtx as never)).resolves.toBeDefined()
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

  test('tool description references sh, workdir, and truncation', () => {
    const tool = makeBash(() => null)
    expect(tool.description).toContain('sh')
    expect(tool.description).toContain('workdir')
    expect(tool.description).toMatch(/truncated|truncation/i)
  })

  test('tool description contains upstream prompt content', () => {
    const tool = makeBash(() => null)
    expect(tool.description).toContain('# Git and GitHub')
    expect(tool.description).toContain('Use `gh` for GitHub tasks')
    expect(tool.description).toContain('Directory Verification')
    expect(tool.description).toContain('Command Execution')
    expect(tool.description).toContain('Usage notes')
    expect(tool.description).toContain('persistent shell session')
  })

  test('tool description advertises the provided tmpDir for scratch work', () => {
    const tool = createBashTool({
      resolveSandboxForSession: async () => null,
      logger: mockLogger,
      dataDir: '/tmp',
      tmpDir: '.forge/tmp',
    })
    expect(tool.description).toContain('.forge/tmp')
    expect(tool.description).toContain('scratch')
  })
})
