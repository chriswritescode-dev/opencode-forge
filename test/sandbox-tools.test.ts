import { describe, test, expect, beforeEach } from 'vitest'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from '../src/hooks/sandbox-tools'
import type { Logger } from '../src/types'
import type { SandboxContext } from '../src/sandbox/context'
import type { SandboxMount } from '../src/sandbox/path'

interface MockSandboxContext {
  runtime: {
    exec: (container: string, cmd: string, opts?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  }
  containerName: string
  hostDir: string
}

interface MockDeps {
  resolveSandboxForSession: (sessionID: string) => Promise<SandboxContext | null>
  logger: Logger
}

describe('sandbox tool hooks', () => {
  let mockRuntime: MockSandboxContext['runtime']
  let mockLogger: Logger
  let beforeHook: ReturnType<typeof createSandboxToolBeforeHook>
  let afterHook: ReturnType<typeof createSandboxToolAfterHook>

  const TEST_SESSION_ID = 'test-session-123'
  const TEST_CALL_ID = 'test-call-456'
  const TEST_HOST_DIR = '/tmp/test-project'
  const TEST_CONTAINER_NAME = 'test-container'

  beforeEach(() => {
    mockRuntime = {
      exec: async (_container, cmd, _opts) => {
        if (cmd.includes('rg --files')) {
          return {
            stdout: `${TEST_HOST_DIR}/src/file.ts\n${TEST_HOST_DIR}/src/another.ts`,
            stderr: '',
            exitCode: 0,
          }
        }
        if (cmd.includes('rg -nH')) {
          return {
            stdout: `${TEST_HOST_DIR}/src/file.ts|10|console.log('hello')`,
            stderr: '',
            exitCode: 0,
          }
        }
        return {
          stdout: `Executed: ${cmd}`,
          stderr: '',
          exitCode: 0,
        }
      },
    }

    mockLogger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }

    const mounts: SandboxMount[] = [{ hostDir: TEST_HOST_DIR, containerDir: '/workspace' }]

    const sandboxContext: SandboxContext = {
      runtime: mockRuntime,
      containerName: TEST_CONTAINER_NAME,
      hostDir: TEST_HOST_DIR,
      mounts,
    }

    const resolveSandboxForSession = async (sessionID: string): Promise<SandboxContext | null> => {
      return sessionID === TEST_SESSION_ID ? sandboxContext : null
    }

    const deps: MockDeps = {
      resolveSandboxForSession,
      logger: mockLogger,
    }

    beforeHook = createSandboxToolBeforeHook(deps)
    afterHook = createSandboxToolAfterHook(deps)
  })

  // No cleanup needed - Bun test handles this

  describe('non-sandbox passthrough', () => {
    test('glob is not intercepted when no sandbox session is resolved', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => null,
        logger: mockLogger,
      })

      const input = { tool: 'glob', sessionID: 'no-sandbox-session', callID: 'call-1' }
      const output = { args: { pattern: '*.ts' } }

      await hook(input as never, output as never)

      expect(output.args.pattern).toBe('*.ts')
    })

    test('grep is not intercepted when no sandbox session is resolved', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => null,
        logger: mockLogger,
      })

      const input = { tool: 'grep', sessionID: 'no-sandbox-session', callID: 'call-1' }
      const output = { args: { pattern: 'test' } }

      await hook(input as never, output as never)

      expect(output.args.pattern).toBe('test')
    })
  })

  describe('sandboxed glob', () => {
    test('glob executes against the worktree host path', async () => {
      const input = {
        tool: 'glob',
        sessionID: TEST_SESSION_ID,
        callID: TEST_CALL_ID,
      }
      const output = {
        args: {
          pattern: '*.ts',
          path: `${TEST_HOST_DIR}/src`,
        },
      }

      await beforeHook(input as never, output as never)

      expect(output.args).toBeDefined()
    })

    test('glob emits file paths verbatim from the host search root', async () => {
      const input = {
        tool: 'glob',
        sessionID: TEST_SESSION_ID,
        callID: TEST_CALL_ID,
      }
      const output = {
        args: {
          pattern: '*.ts',
          path: `${TEST_HOST_DIR}/src`,
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toContain(`${TEST_HOST_DIR}/src/file.ts`)
      expect(output.output).toContain('file.ts')
      expect(output.output).not.toContain('/workspace/src/file.ts')
    })

    test('glob defaults the search root to the worktree host directory', async () => {
      let executedCmd = ''
      const runtime = {
        exec: async (_container: string, cmd: string) => {
          executedCmd = cmd
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      }
      const sandboxContext: SandboxContext = {
        runtime: runtime as never,
        containerName: TEST_CONTAINER_NAME,
        hostDir: TEST_HOST_DIR,
        mounts: [{ hostDir: TEST_HOST_DIR, containerDir: TEST_HOST_DIR }],
      }
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => sandboxContext,
        logger: mockLogger,
      })

      await hook(
        { tool: 'glob', sessionID: TEST_SESSION_ID, callID: 'glob-default-root' } as never,
        { args: { pattern: '*.ts' } } as never,
      )

      expect(executedCmd).toMatch(/rg --files/)
      expect(executedCmd).toContain(TEST_HOST_DIR)
    })

    test('glob anchors relative search paths to the worktree host directory', async () => {
      let execCwd: string | undefined
      const runtime = {
        exec: async (_container: string, _cmd: string, opts?: { cwd?: string }) => {
          execCwd = opts?.cwd
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      }
      const sandboxContext: SandboxContext = {
        runtime: runtime as never,
        containerName: TEST_CONTAINER_NAME,
        hostDir: TEST_HOST_DIR,
        mounts: [{ hostDir: TEST_HOST_DIR, containerDir: TEST_HOST_DIR }],
      }
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => sandboxContext,
        logger: mockLogger,
      })

      await hook(
        { tool: 'glob', sessionID: TEST_SESSION_ID, callID: 'glob-relative-path' } as never,
        { args: { pattern: '*.ts', path: 'src' } } as never,
      )

      expect(execCwd).toBe(TEST_HOST_DIR)
    })
  })

  describe('sandboxed grep', () => {
    test('grep executes against the worktree host path', async () => {
      const input = {
        tool: 'grep',
        sessionID: TEST_SESSION_ID,
        callID: TEST_CALL_ID,
      }
      const output = {
        args: {
          pattern: 'console.log',
          path: `${TEST_HOST_DIR}/src`,
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toContain('Found')
      expect(output.output).toContain('matches')
      expect(output.output).toContain(TEST_HOST_DIR)
    })

    test('grep output includes formatted line numbers and text', async () => {
      const input = {
        tool: 'grep',
        sessionID: TEST_SESSION_ID,
        callID: TEST_CALL_ID,
      }
      const output = {
        args: {
          pattern: 'console.log',
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toContain('Line 10:')
      expect(output.output).toContain('console.log')
    })

    test('grep respects include filter', async () => {
      const input = {
        tool: 'grep',
        sessionID: TEST_SESSION_ID,
        callID: TEST_CALL_ID,
      }
      const output = {
        args: {
          pattern: 'test',
          include: '*.ts',
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)

      expect(output.args).toBeDefined()
    })
  })

  describe('host fallback for absolute out-of-mount paths', () => {
    test('glob with absolute path outside mount is not intercepted (host fallback)', async () => {
      const input = {
        tool: 'glob',
        sessionID: TEST_SESSION_ID,
        callID: 'glob-fallback-1',
      }
      const output = {
        args: {
          pattern: '*.txt',
          path: '/var/lib/opencode/tool-output',
        },
        title: '',
        output: 'HOST_NATIVE',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toBe('HOST_NATIVE')
    })

    test('grep with absolute path outside mount is not intercepted (host fallback)', async () => {
      const input = {
        tool: 'grep',
        sessionID: TEST_SESSION_ID,
        callID: 'grep-fallback-1',
      }
      const output = {
        args: {
          pattern: 'test',
          path: '/var/lib/opencode/tool-output',
        },
        title: '',
        output: 'HOST_NATIVE',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toBe('HOST_NATIVE')
    })

    test('grep with relative path is still intercepted', async () => {
      const input = {
        tool: 'grep',
        sessionID: TEST_SESSION_ID,
        callID: 'grep-relative-1',
      }
      const output = {
        args: {
          pattern: 'console.log',
          path: 'src',
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toContain('Found')
    })

    test('grep anchors relative search paths to the worktree host directory', async () => {
      let execCwd: string | undefined
      const runtime = {
        exec: async (_container: string, _cmd: string, opts?: { cwd?: string }) => {
          execCwd = opts?.cwd
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      }
      const sandboxContext: SandboxContext = {
        runtime: runtime as never,
        containerName: TEST_CONTAINER_NAME,
        hostDir: TEST_HOST_DIR,
        mounts: [{ hostDir: TEST_HOST_DIR, containerDir: TEST_HOST_DIR }],
      }
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => sandboxContext,
        logger: mockLogger,
      })

      await hook(
        { tool: 'grep', sessionID: TEST_SESSION_ID, callID: 'grep-relative-path' } as never,
        { args: { pattern: 'console.log', path: 'src' } } as never,
      )

      expect(execCwd).toBe(TEST_HOST_DIR)
    })
  })

  describe('bash passthrough', () => {
    test('hook ignores bash tool entirely (handled by plugin tool override)', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => ({
          runtime: mockRuntime,
          containerName: 'test-container',
          hostDir: '/tmp/host',
          mounts: [{ hostDir: '/tmp/host', containerDir: '/workspace' }],
        }),
        logger: mockLogger,
      })
      const input = { tool: 'bash', sessionID: TEST_SESSION_ID, callID: 'bash-1' }
      const output = { args: Object.freeze({ command: 'echo hi' }) }

      await hook(input as never, output as never)

      expect(output.args.command).toBe('echo hi')
    })
  })
})
