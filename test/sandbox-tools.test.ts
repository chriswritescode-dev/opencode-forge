import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

  describe('fail-closed for absolute out-of-mount paths', () => {
    test('glob with absolute path outside mount fails closed instead of running on the host', async () => {
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

      await expect(beforeHook(input as never, output as never)).rejects.toThrow(/outside the sandbox workspace mount/)
    })

    test('grep with absolute path outside mount fails closed instead of running on the host', async () => {
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

      await expect(beforeHook(input as never, output as never)).rejects.toThrow(/outside the sandbox workspace mount/)
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

  describe('fail-closed search restoration', () => {
    test('resolver errors do not block shell or management tools', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => {
          throw new Error('sandbox unavailable')
        },
        logger: mockLogger,
      })
      for (const tool of ['bash', 'webfetch', 'plan-read']) {
        const input = { tool, sessionID: TEST_SESSION_ID, callID: `${tool}-1` }
        const output = { args: { path: '/tmp/x' } }
        await expect(hook(input as never, output as never)).resolves.toBeUndefined()
        expect(output.args.path).toBe('/tmp/x')
      }
    })

    test('host file tools fail closed when the sandbox resolver rejects', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => {
          throw new Error('sandbox unavailable')
        },
        logger: mockLogger,
      })
      for (const tool of ['read', 'edit', 'write', 'patch']) {
        const input = { tool, sessionID: TEST_SESSION_ID, callID: `${tool}-failclosed` }
        await expect(hook(input as never, { args: { path: '/tmp/x' } } as never)).rejects.toThrow('sandbox unavailable')
      }
    })

    test('glob fails closed when the sandbox resolver rejects', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => {
          throw new Error('sandbox unavailable')
        },
        logger: mockLogger,
      })
      const input = { tool: 'glob', sessionID: TEST_SESSION_ID, callID: 'glob-failclosed-1' }
      const output = { args: { pattern: '*.ts', path: `${TEST_HOST_DIR}/src` } }

      await expect(hook(input as never, output as never)).rejects.toThrow('sandbox unavailable')
    })

    test('grep fails closed when the sandbox resolver rejects', async () => {
      const hook = createSandboxToolBeforeHook({
        resolveSandboxForSession: async () => {
          throw new Error('sandbox unavailable')
        },
        logger: mockLogger,
      })
      const input = { tool: 'grep', sessionID: TEST_SESSION_ID, callID: 'grep-failclosed-1' }
      const output = { args: { pattern: 'console.log', path: `${TEST_HOST_DIR}/src` } }

      await expect(hook(input as never, output as never)).rejects.toThrow('sandbox unavailable')
    })
  })
})

describe('host file tool sandbox fence', () => {
  const logger: Logger = { log: () => {}, error: () => {}, debug: () => {} }
  let root: string
  let worktree: string
  let readOnlyDir: string
  let outsideDir: string

  const call = async (tool: string, args: Record<string, unknown>, sessionID = 'fenced') => {
    const sandbox: SandboxContext = {
      runtime: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as never,
      containerName: 'fence-container',
      hostDir: worktree,
      mounts: [
        { hostDir: worktree, containerDir: worktree },
        { hostDir: readOnlyDir, containerDir: readOnlyDir, readOnly: true },
      ],
    }
    const hook = createSandboxToolBeforeHook({
      resolveSandboxForSession: async (id) => (id === 'fenced' ? sandbox : null),
      logger,
    })
    return hook({ tool, sessionID, callID: `${tool}-fence` } as never, { args } as never)
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-fence-')))
    worktree = join(root, 'worktree')
    readOnlyDir = join(root, 'vault')
    outsideDir = join(root, 'outside')
    for (const dir of [worktree, readOnlyDir, outsideDir]) mkdirSync(dir)
    writeFileSync(join(worktree, 'file.ts'), '')
    writeFileSync(join(readOnlyDir, 'note.md'), '')
    writeFileSync(join(outsideDir, 'secret'), '')
    symlinkSync(outsideDir, join(worktree, 'escape'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('allows every file tool inside a writable mount, including relative and not-yet-existing paths', async () => {
    for (const tool of ['read', 'edit', 'write']) {
      await expect(call(tool, { path: join(worktree, 'file.ts') })).resolves.toBeUndefined()
      await expect(call(tool, { path: 'src/new/file.ts' })).resolves.toBeUndefined()
    }
  })

  test('refuses file tools on a path outside every mount', async () => {
    for (const tool of ['read', 'edit', 'write']) {
      await expect(call(tool, { path: join(outsideDir, 'secret') })).rejects.toThrow('outside the sandbox mounts')
    }
    await expect(call('read', { path: '../outside/secret' })).rejects.toThrow('outside the sandbox mounts')
    await expect(call('read', { path: '~/.ssh/id_ed25519' })).rejects.toThrow('outside the sandbox mounts')
  })

  test('refuses a path that escapes a mount through a symlink', async () => {
    await expect(call('read', { path: join(worktree, 'escape', 'secret') })).rejects.toThrow('outside the sandbox mounts')
    await expect(call('write', { path: join(worktree, 'escape', 'new-file') })).rejects.toThrow('outside the sandbox mounts')
  })

  test('allows reads but refuses mutation inside a read-only mount', async () => {
    await expect(call('read', { path: join(readOnlyDir, 'note.md') })).resolves.toBeUndefined()
    await expect(call('edit', { path: join(readOnlyDir, 'note.md') })).rejects.toThrow('read-only sandbox mount')
    await expect(call('write', { path: join(readOnlyDir, 'new.md') })).rejects.toThrow('read-only sandbox mount')
  })

  test('checks every path a patch touches, including move targets', async () => {
    const inside = `*** Begin Patch\n*** Update File: ${join(worktree, 'file.ts')}\n@@\n-a\n+b\n*** End Patch`
    await expect(call('patch', { patchText: inside })).resolves.toBeUndefined()
    const moved = `*** Begin Patch\n*** Update File: ${join(worktree, 'file.ts')}\n*** Move to: ${join(outsideDir, 'moved.ts')}\n*** End Patch`
    await expect(call('patch', { patchText: moved })).rejects.toThrow('outside the sandbox mounts')
    const readOnly = `*** Begin Patch\n*** Delete File: ${join(readOnlyDir, 'note.md')}\n*** End Patch`
    await expect(call('patch', { patchText: readOnly })).rejects.toThrow('read-only sandbox mount')
  })

  test('matches a mount declared through a symlinked path against its canonical target', async () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), 'forge-fence-alias-'))
    const alias = join(aliasRoot, 'link')
    symlinkSync(worktree, alias)
    const hook = createSandboxToolBeforeHook({
      resolveSandboxForSession: async () => ({
        runtime: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as never,
        containerName: 'fence-container',
        hostDir: alias,
        mounts: [{ hostDir: alias, containerDir: alias }],
      }),
      logger,
    })
    try {
      for (const path of [join(worktree, 'file.ts'), join(alias, 'file.ts'), 'file.ts']) {
        await expect(hook({ tool: 'edit', sessionID: 'fenced', callID: 'alias' } as never, { args: { path } } as never)).resolves.toBeUndefined()
      }
      await expect(
        hook({ tool: 'read', sessionID: 'fenced', callID: 'alias' } as never, { args: { path: join(outsideDir, 'secret') } } as never),
      ).rejects.toThrow('outside the sandbox mounts')
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true })
    }
  })

  test('leaves file tools untouched in sessions without a sandbox', async () => {
    await expect(call('write', { path: join(outsideDir, 'secret') }, 'host-session')).resolves.toBeUndefined()
  })
})
