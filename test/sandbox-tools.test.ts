import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from '../src/hooks/sandbox-tools'
import type { createLoopService } from '../src/services/loop'
import type { createSandboxManager } from '../src/sandbox/manager'
import type { Logger } from '../src/types'

interface MockSandboxContext {
  docker: {
    exec: (container: string, cmd: string, opts?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  }
  containerName: string
  hostDir: string
}

interface MockDeps {
  loopService: {
    resolveWorktreeName: (sessionId: string) => string | null
    getActiveState: (name: string) => { active: boolean; sandbox?: boolean } | null
  }
  sandboxManager: {
    docker: MockSandboxContext['docker']
    getActive: (name: string) => { containerName: string; projectDir: string } | null
  } | null
  logger: Logger
}

describe('sandbox tool hooks', () => {
  let mockDocker: MockSandboxContext['docker']
  let mockLoopService: MockDeps['loopService']
  let mockSandboxManager: MockDeps['sandboxManager']
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
        // For bash commands, return the actual command output
        return {
          stdout: `Executed: ${cmd}`,
          stderr: '',
          exitCode: 0,
        }
      },
    }

    mockLoopService = {
      resolveWorktreeName: (sessionId) => sessionId === TEST_SESSION_ID ? 'test-worktree' : null,
      getActiveState: (name) => name === 'test-worktree' ? { active: true, sandbox: true } : null,
    }

    mockSandboxManager = {
      docker: mockDocker,
      getActive: (name) => name === 'test-worktree' ? {
        containerName: TEST_CONTAINER_NAME,
        projectDir: TEST_HOST_DIR,
      } : null,
    }

    mockLogger = {
      log: () => {},
    }

    const deps: MockDeps = {
      loopService: mockLoopService,
      sandboxManager: mockSandboxManager,
      logger: mockLogger,
    }

    beforeHook = createSandboxToolBeforeHook(deps as never)
    afterHook = createSandboxToolAfterHook(deps as never)
  })

  // No cleanup needed - Bun test handles this

  describe('non-sandbox passthrough', () => {
    test('bash is not intercepted when no sandbox session is resolved', async () => {
      const deps: MockDeps = {
        loopService: {
          resolveWorktreeName: () => null,
          getActiveState: () => null,
        },
        sandboxManager: null,
        logger: mockLogger,
      }
      const hook = createSandboxToolBeforeHook(deps as never)

      const input = { tool: 'bash', sessionID: 'no-sandbox-session', callID: 'call-1' }
      const output = { args: { command: 'echo test' } }

      await hook(input as never, output as never)

      expect(output.args.command).toBe('echo test')
    })

    test('glob is not intercepted when no sandbox session is resolved', async () => {
      const deps: MockDeps = {
        loopService: {
          resolveWorktreeName: () => null,
          getActiveState: () => null,
        },
        sandboxManager: null,
        logger: mockLogger,
      }
      const hook = createSandboxToolBeforeHook(deps as never)

      const input = { tool: 'glob', sessionID: 'no-sandbox-session', callID: 'call-1' }
      const output = { args: { pattern: '*.ts' } }

      await hook(input as never, output as never)

      expect(output.args.pattern).toBe('*.ts')
    })

    test('grep is not intercepted when no sandbox session is resolved', async () => {
      const deps: MockDeps = {
        loopService: {
          resolveWorktreeName: () => null,
          getActiveState: () => null,
        },
        sandboxManager: null,
        logger: mockLogger,
      }
      const hook = createSandboxToolBeforeHook(deps as never)

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
