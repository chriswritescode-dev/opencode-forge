import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
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

  beforeEach(() => {
    order = 0
    dockerResult = { stdout: 'docker ok\n', stderr: '', exitCode: 0 }
    dockerCalls = []
    askCalls = []
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
      directory: '/tmp/host',
      worktree: '/tmp/host',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: mockAsk,
    }
  })

  function makeBash(sandboxFor: (sessionID: string) => Promise<SandboxContext | null> | SandboxContext | null) {
    return createBashTool({
      resolveSandboxForSession: async (sessionID) => await sandboxFor(sessionID),
      logger: mockLogger,
    })
  }

  function sandbox(): SandboxContext {
    return { docker: mockDocker, containerName: 'forge-foo', hostDir: '/tmp/host' }
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

    await tool.execute({ command: 'ls', workdir: '/tmp/host/src', description: 'list' }, mockToolCtx as never)

    expect(dockerCalls[0]?.opts).toMatchObject({ cwd: '/workspace/src' })
  })

  test('rewrites /workspace output back to host path', async () => {
    dockerResult = { stdout: '/workspace/src/file.ts\n', stderr: '', exitCode: 0 }
    const tool = makeBash(() => sandbox())

    const result = await tool.execute({ command: 'ls', description: 'list' }, mockToolCtx as never)

    expect(result).toContain('/tmp/host/src/file.ts')
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

  test('asks permission with bash pattern before executing', async () => {
    const tool = makeBash(() => sandbox())

    await tool.execute({ command: 'git push origin main', description: 'push' }, mockToolCtx as never)

    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.input).toEqual({
      permission: 'bash',
      patterns: ['git push origin main'],
      always: ['git push origin main'],
      metadata: {},
    })
    expect(askCalls[0]!.order).toBeLessThan(dockerCalls[0]!.order)
  })

  test('propagates permission rejection', async () => {
    mockAsk = async () => { throw new Error('Denied by user rule') }
    mockToolCtx.ask = mockAsk
    const tool = makeBash(() => sandbox())

    await expect(tool.execute({ command: 'git push', description: 'push' }, mockToolCtx as never)).rejects.toThrow(/Denied/)
    expect(dockerCalls).toHaveLength(0)
  })

  test('regression: frozen args object does not throw', async () => {
    const tool = makeBash(() => sandbox())

    await expect(tool.execute(Object.freeze({ command: 'ls', description: 'list' }), mockToolCtx as never)).resolves.toBeDefined()
  })
})
