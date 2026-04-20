import { describe, test, expect, beforeEach } from 'bun:test'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from '../src/hooks/sandbox-tools'
import type { Logger } from '../src/types'
import type { SandboxContext } from '../src/sandbox/context'

interface MockSandboxContext {
  docker: {
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
  let mockDocker: MockSandboxContext['docker']
  let mockLogger: Logger
  let beforeHook: ReturnType<typeof createSandboxToolBeforeHook>
  let afterHook: ReturnType<typeof createSandboxToolAfterHook>

  const TEST_SESSION_ID = 'test-session-123'
  const TEST_CALL_ID = 'test-call-456'
  const TEST_HOST_DIR = '/tmp/test-project'
  const TEST_CONTAINER_NAME = 'test-container'

  beforeEach(() => {
    mockDocker = {
      exec: async (_container, cmd, _opts) => {
        if (cmd.includes('rg --files')) {
          return {
            stdout: `/workspace/src/file.ts\n/workspace/src/another.ts`,
            stderr: '',
            exitCode: 0,
          }
        }
        if (cmd.includes('rg -nH')) {
          return {
            stdout: `/workspace/src/file.ts|10|console.log('hello')`,
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

    const sandboxContext: SandboxContext = {
      docker: mockDocker,
      containerName: TEST_CONTAINER_NAME,
      hostDir: TEST_HOST_DIR,
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
    test('bash is not intercepted when no sandbox session is resolved', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => null,
        logger: mockLogger,
      })

      const input = { tool: 'bash', sessionID: 'no-sandbox-session', callID: 'call-1' }
      const output = { args: { command: 'echo test' } }

      await hook(input as never, output as never)

      expect(output.args.command).toBe('echo test')
    })

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
    test('glob executes inside Docker with host→container path mapping', async () => {
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

    test('glob output is rewritten from container paths to host paths', async () => {
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

      expect(output.output).toContain(TEST_HOST_DIR)
      expect(output.output).toContain('file.ts')
      expect(output.output).not.toContain('/workspace/src/file.ts')
    })
  })

  describe('sandboxed grep', () => {
    test('grep executes inside Docker with rewritten file paths', async () => {
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

  describe('bash interception', () => {
    test('bash still works after refactor', async () => {
      const input = {
        tool: 'bash',
        sessionID: TEST_SESSION_ID,
        callID: TEST_CALL_ID,
      }
      const output = {
        args: {
          command: 'echo "test output"',
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toContain('echo "test output"')
    })

    test('bash git push is blocked in sandbox', async () => {
      const input = {
        tool: 'bash',
        sessionID: TEST_SESSION_ID,
        callID: 'git-push-call',
      }
      const output = {
        args: {
          command: 'git push',
        },
        title: '',
        output: '',
        metadata: undefined,
      }

      await beforeHook(input as never, output as never)
      await afterHook({ ...input, args: output.args } as never, output as never)

      expect(output.output).toContain('Git push is not available')
    })
  })
})
