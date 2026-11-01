import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODE_GRAPH_PROBE_COMMAND,
  codeGraphReportPath,
  createCodeGraphSnapshotter,
  ensureCodeGraphReportFile,
  resolveLoopCodeGraphTarget,
  type CodeGraphTarget,
} from '../../src/loop/code-graph'
import { runCodeGraphSnapshot, type CodeGraphRunnerInput } from '../../src/loop/code-graph-runner'
import type { SandboxContextManager } from '../../src/sandbox/context'
import type { CommandResult } from '../../src/sandbox/process'
import type { Logger } from '../../src/types'

function createLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(stderr = ''): CommandResult {
  return { stdout: '', stderr, exitCode: 1 }
}

interface RecordedCommand {
  command: string
  timeoutMs: number
}

interface RecordingTarget extends CodeGraphTarget {
  commands: RecordedCommand[]
  runnerInputs: CodeGraphRunnerInput[]
}

function isRunnerCommand(command: string): boolean {
  return command.includes('/opt/codegraph/node') && command.includes(' -e ')
}

function runnerInputOf(command: string): CodeGraphRunnerInput {
  const match = /'([^']*)'$/.exec(command)
  if (!match) throw new Error(`no runner input in ${command}`)
  return JSON.parse(match[1]) as CodeGraphRunnerInput
}

const FAKE_DEPENDENTS: Record<string, string[]> = {
  'a.ts': ['b.ts'],
  'b.ts': ['test/a.test.ts'],
}

interface FakeIndexOptions {
  initialized?: boolean
  syncError?: string
}

/** A codegraph library stand-in for running the real runner function in-process. */
function fakeLibraryLoader(options: FakeIndexOptions = {}): (path: string) => unknown {
  const handle = {
    indexAll: async () => ({ success: true, filesIndexed: 1, errors: [] }),
    sync: async () => {
      if (options.syncError) throw new Error(options.syncError)
    },
    getNodesInFile: (file: string) => [
      { name: file, kind: 'file', startLine: 1 },
      { name: `symbolOf_${file}`, kind: 'function', signature: '()', startLine: 3 },
    ],
    getFileDependents: (file: string) => FAKE_DEPENDENTS[file] ?? [],
    destroy: () => {},
  }
  return (path) => {
    if (path === 'fs') return { mkdirSync: () => {} }
    if (path.endsWith('/dist/search/query-utils.js')) {
      return { isTestPath: (file: string) => file.startsWith('test/') }
    }
    if (path.endsWith('/dist/mcp/writer-lock.js')) {
      return { tryAcquireWriterLock: () => ({ kind: 'acquired' }), releaseWriterLock: () => {} }
    }
    return {
      LockUnavailableError: class extends Error {},
      setLogger: () => {},
      silentLogger: {},
      CodeGraph: {
        isInitialized: () => options.initialized ?? false,
        init: async () => handle,
        open: async () => handle,
        recreate: async () => handle,
      },
    }
  }
}

function createTarget(
  worktreeDir: string,
  respond: (command: string) => CommandResult | Error | undefined = () => undefined,
  options: { required?: boolean } & FakeIndexOptions = {},
): RecordingTarget {
  const commands: RecordedCommand[] = []
  const runnerInputs: CodeGraphRunnerInput[] = []
  return {
    key: 'forge-test-container',
    worktreeDir,
    required: options.required ?? false,
    commands,
    runnerInputs,
    async exec(command, timeoutMs) {
      commands.push({ command, timeoutMs })
      const scripted = respond(command)
      if (scripted instanceof Error) throw scripted
      if (scripted) return scripted
      if (command === CODE_GRAPH_PROBE_COMMAND) return ok('present\n')
      if (isRunnerCommand(command)) {
        const input = runnerInputOf(command)
        runnerInputs.push(input)
        const result = await runCodeGraphSnapshot(fakeLibraryLoader(options), input)
        return ok(`progress noise\n${JSON.stringify(result)}\n`)
      }
      return ok()
    },
  }
}

const tempDirs: string[] = []

function createWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-codegraph-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createCodeGraphSnapshotter', () => {
  it('builds a missing index and reports symbols, dependents and affected tests from one runner exec', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const infos: unknown[][] = []
    const logger = createLogger()
    logger.log = (...args: unknown[]) => {
      infos.push(args)
    }
    const target = createTarget(worktreeDir)

    const report = await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, { title: 'section 1', files: ['a.ts'] })

    expect(report).toContain('# Code graph: section 1')
    expect(report).toContain('## Changed or planned files\n\n- a.ts')
    expect(report).toContain('## Affected test files\n\n- test/a.test.ts')
    expect(report).toContain('## a.ts\n\nUsed by: b.ts')
    expect(report).toContain('- `symbolOf_a.ts` (function) () — line 3')
    expect(report).not.toContain('(file)')

    expect(target.commands.map((entry) => entry.command)).toEqual([CODE_GRAPH_PROBE_COMMAND, expect.stringContaining('/opt/codegraph/node')])
    expect(target.runnerInputs).toEqual([
      {
        libDir: '/opt/codegraph/lib',
        projectRoot: worktreeDir,
        indexDir: '/opt/forge/cache/codegraph',
        files: ['a.ts'],
        maxDepth: 5,
        deadlineMs: 540000,
      },
    ])
    expect(readlinkSync(join(worktreeDir, '.codegraph'))).toBe('/opt/forge/cache/codegraph')
    expect(String(infos.at(-1)?.[0])).toContain('index created')
  })

  it('never runs the codegraph CLI or rewrites git config', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const target = createTarget(worktreeDir, () => undefined, { syncError: 'stale lock', initialized: true })

    await createCodeGraphSnapshotter({ logger: createLogger() }).snapshotFiles(target, { title: 'cli', files: ['a.ts'] })

    for (const { command } of target.commands) {
      expect(command).not.toMatch(/(^|[\s;&])codegraph\s/)
      expect(command).not.toContain('GIT_CONFIG')
    }
    expect(target.commands.find((entry) => isRunnerCommand(entry.command))?.command).toContain(
      'CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_DAEMON=1 CODEGRAPH_NO_WATCH=1',
    )
  })

  it('syncs an existing index inside the same runner exec', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const infos: unknown[][] = []
    const logger = createLogger()
    logger.log = (...args: unknown[]) => {
      infos.push(args)
    }
    const target = createTarget(worktreeDir, () => undefined, { initialized: true })

    expect(await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, { title: 'section 2', files: ['a.ts'] })).not.toBeNull()

    expect(target.commands.filter((entry) => isRunnerCommand(entry.command))).toHaveLength(1)
    expect(infos).toEqual([])
  })

  it('reports a sync that fell back to a rebuild from the same runner exec', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const infos: unknown[][] = []
    const logger = createLogger()
    logger.log = (...args: unknown[]) => {
      infos.push(args)
    }
    const target = createTarget(worktreeDir, () => undefined, { initialized: true, syncError: 'stale lock' })

    const report = await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, { title: 'section 3', files: ['a.ts'] })

    expect(report).toContain('# Code graph: section 3')
    expect(target.commands.filter((entry) => isRunnerCommand(entry.command))).toHaveLength(1)
    expect(String(infos.at(-1)?.[0])).toContain('index rebuilt')
  })

  it('returns null and logs when the runner reports a failure or its output is unreadable', async () => {
    for (const runnerOutput of [
      { stdout: '', stderr: 'Segmentation fault', exitCode: 139 },
      ok(`${JSON.stringify({ ok: false, stage: 'index', error: 'disk full' })}\n`),
    ]) {
      const worktreeDir = createWorktree()
      writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
      const errors: unknown[][] = []
      const logger = createLogger()
      logger.error = (...args: unknown[]) => {
        errors.push(args)
      }
      const target = createTarget(worktreeDir, (command) => (isRunnerCommand(command) ? runnerOutput : undefined))

      expect(await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, { title: 'crash', files: ['a.ts'] })).toBeNull()
      expect(String(errors.at(-1)?.[0])).toMatch(/Segmentation fault|index failed .*disk full/)
    }
  })

  it('logs a held index as a skipped snapshot, not an error', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const errors: unknown[][] = []
    const infos: unknown[][] = []
    const logger = createLogger()
    logger.error = (...args: unknown[]) => {
      errors.push(args)
    }
    logger.log = (...args: unknown[]) => {
      infos.push(args)
    }
    const target = createTarget(worktreeDir, (command) =>
      isRunnerCommand(command) ? ok(`${JSON.stringify({ ok: false, stage: 'locked', error: 'rebuild.pid is held' })}\n`) : undefined,
    )

    expect(await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, { title: 'busy', files: ['a.ts'] })).toBeNull()
    expect(errors).toEqual([])
    expect(String(infos.at(-1)?.[0])).toContain('index busy')
  })

  it('skips the runner when no planned file exists in the worktree', async () => {
    const worktreeDir = createWorktree()
    const target = createTarget(worktreeDir)

    expect(await createCodeGraphSnapshotter({ logger: createLogger() }).snapshotFiles(target, { title: 'none', files: ['gone.ts'] })).toBeNull()
    expect(target.commands.some((entry) => isRunnerCommand(entry.command))).toBe(false)
  })

  it('returns null when the binary is missing and probes it once across snapshots', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const target = createTarget(worktreeDir, (command) =>
      command === CODE_GRAPH_PROBE_COMMAND ? fail() : undefined,
    )
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    expect(await snapshotter.snapshotFiles(target, { title: 'one', files: ['a.ts'] })).toBeNull()
    expect(await snapshotter.snapshotFiles(target, { title: 'two', files: ['a.ts'] })).toBeNull()

    const commands = target.commands.map((entry) => entry.command)
    expect(commands.filter((command) => command === CODE_GRAPH_PROBE_COMMAND)).toHaveLength(1)
    expect(commands.some(isRunnerCommand)).toBe(false)
  })

  it('probes only for the bundled node and the library the runner loads', () => {
    expect(CODE_GRAPH_PROBE_COMMAND).not.toContain('command -v codegraph')
    expect(CODE_GRAPH_PROBE_COMMAND).toContain('test -x /opt/codegraph/node')
    expect(CODE_GRAPH_PROBE_COMMAND).toContain('test -f /opt/codegraph/lib/dist/index.js')
  })

  it('logs a missing binary as an error only when codegraph is required', async () => {
    for (const required of [false, true]) {
      const worktreeDir = createWorktree()
      writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
      const errors: unknown[][] = []
      const infos: unknown[][] = []
      const logger = createLogger()
      logger.error = (...args: unknown[]) => {
        errors.push(args)
      }
      logger.log = (...args: unknown[]) => {
        infos.push(args)
      }
      const target = createTarget(
        worktreeDir,
        (command) => (command === CODE_GRAPH_PROBE_COMMAND ? fail() : undefined),
        { required },
      )

      expect(await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, { title: 'x', files: ['a.ts'] })).toBeNull()
      expect(errors).toHaveLength(required ? 1 : 0)
      expect(infos).toHaveLength(required ? 0 : 1)
    }
  })

  it('retries the binary probe after a failed probe exec', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    let probes = 0
    const target = createTarget(worktreeDir, (command) => {
      if (command !== CODE_GRAPH_PROBE_COMMAND) return undefined
      probes += 1
      return probes === 1 ? new Error('msb exec failed') : ok('present\n')
    })
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    expect(await snapshotter.snapshotFiles(target, { title: 'one', files: ['a.ts'] })).toBeNull()
    expect(await snapshotter.snapshotFiles(target, { title: 'two', files: ['a.ts'] })).toContain('# Code graph: two')

    expect(probes).toBe(2)
  })

  it('leaves a non-symlink .codegraph directory untouched and returns null', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    mkdirSync(join(worktreeDir, '.codegraph'))
    writeFileSync(join(worktreeDir, '.codegraph', 'user.txt'), 'keep me\n')
    const target = createTarget(worktreeDir)
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    expect(await snapshotter.snapshotFiles(target, { title: 'blocked', files: ['a.ts'] })).toBeNull()

    expect(existsSync(join(worktreeDir, '.codegraph', 'user.txt'))).toBe(true)
    expect(target.commands.some((entry) => isRunnerCommand(entry.command))).toBe(false)
  })

  it('returns null when the target exec throws', async () => {
    const worktreeDir = createWorktree()
    const target = createTarget(worktreeDir, () => new Error('sandbox is gone'))
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    expect(await snapshotter.snapshotFiles(target, { title: 'boom', files: ['a.ts'] })).toBeNull()
  })

  it('drops missing files, queries the rest in one exec, and never truncates the report', async () => {
    const worktreeDir = createWorktree()
    mkdirSync(join(worktreeDir, 'f'))
    const files: string[] = []
    for (let index = 0; index < 300; index += 1) {
      const file = `f/${index}.ts`
      writeFileSync(join(worktreeDir, file), `export const value${index} = ${index}\n`)
      files.push(file)
    }
    files.push('missing.ts', '/etc/passwd')
    const target = createTarget(worktreeDir)
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    const report = await snapshotter.snapshotFiles(target, { title: 'large', files })

    expect(report).not.toBeNull()
    expect(report!.match(/^## f\//gm)).toHaveLength(300)
    expect(report).not.toContain('missing.ts')
    expect(report).not.toContain('/etc/passwd')
    expect(target.commands.filter((entry) => isRunnerCommand(entry.command))).toHaveLength(1)
    expect(target.runnerInputs[0].files).toHaveLength(300)
  })
})

describe('resolveLoopCodeGraphTarget', () => {
  const execution = {
    runtime: {
      exec: async () => ok(),
    },
  }

  function createManager(active: { containerName: string } | null): Pick<SandboxContextManager, 'runtime' | 'getActive'> {
    return {
      runtime: execution.runtime as unknown as SandboxContextManager['runtime'],
      getActive: () => active as unknown as ReturnType<SandboxContextManager['getActive']>,
    }
  }

  it('returns null when the feature is disabled', () => {
    const target = resolveLoopCodeGraphTarget(
      createManager({ containerName: 'forge-one' }),
      { loopName: 'one', sandbox: true, worktreeDir: '/tmp/worktree' },
      { codeGraph: { enabled: false } },
    )
    expect(target).toBeNull()
  })

  it('requires the binary only when the config asks for codegraph explicitly', () => {
    const resolve = (codeGraph: { install?: boolean; enabled?: boolean } | undefined) =>
      resolveLoopCodeGraphTarget(
        createManager({ containerName: 'forge-one' }),
        { loopName: 'one', sandbox: true, worktreeDir: '/tmp/worktree' },
        codeGraph ? { codeGraph } : undefined,
      )?.required

    expect(resolve(undefined)).toBe(false)
    expect(resolve({ install: false })).toBe(false)
    expect(resolve({ install: true })).toBe(true)
    expect(resolve({ enabled: true })).toBe(true)
  })

  it('returns null when the loop is not sandboxed', () => {
    const target = resolveLoopCodeGraphTarget(
      createManager({ containerName: 'forge-one' }),
      { loopName: 'one', sandbox: false, worktreeDir: '/tmp/worktree' },
      undefined,
    )
    expect(target).toBeNull()
  })

  it('returns null when there is no active sandbox', () => {
    const target = resolveLoopCodeGraphTarget(
      createManager(null),
      { loopName: 'one', sandbox: true, worktreeDir: '/tmp/worktree' },
      undefined,
    )
    expect(target).toBeNull()
  })

  it('routes exec into the active container from the worktree', async () => {
    const calls: Array<{ name: string; command: string; opts: unknown }> = []
    const manager = createManager({ containerName: 'forge-one' })
    manager.runtime = {
      exec: async (name: string, command: string, opts: unknown) => {
        calls.push({ name, command, opts })
        return ok()
      },
    } as unknown as SandboxContextManager['runtime']

    const target = resolveLoopCodeGraphTarget(
      manager,
      { loopName: 'one', sandbox: true, worktreeDir: '/tmp/worktree' },
      undefined,
    )

    expect(target?.key).toBe('forge-one')
    await target!.exec('codegraph node a.ts', 1000)
    expect(calls).toEqual([
      {
        name: 'forge-one',
        command: 'codegraph node a.ts',
        opts: { cwd: '/tmp/worktree', timeout: 1000 },
      },
    ])
  })
})

describe('codeGraphReportPath', () => {
  it('sanitizes the report name to a safe relative path', () => {
    expect(codeGraphReportPath('Section 1: Startup')).toBe('.forge/codegraph/section-1-startup.md')
    expect(codeGraphReportPath('../../etc/passwd')).toBe('.forge/codegraph/etc-passwd.md')
  })
})

describe('ensureCodeGraphReportFile', () => {
  it('rewrites a deleted report file', () => {
    const worktreeDir = createWorktree()
    const relPath = codeGraphReportPath('section 1')
    expect(ensureCodeGraphReportFile(worktreeDir, relPath, '# report\n')).toBe(true)
    const absolute = join(worktreeDir, relPath)
    expect(existsSync(absolute)).toBe(true)

    unlinkSync(absolute)
    expect(ensureCodeGraphReportFile(worktreeDir, relPath, '# report\n')).toBe(true)
    expect(existsSync(absolute)).toBe(true)
  })

  it('replaces a symlink planted at the report path instead of writing through it', () => {
    const worktreeDir = createWorktree()
    const outside = createWorktree()
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'original\n')
    const relPath = codeGraphReportPath('section 1')
    mkdirSync(join(worktreeDir, '.forge/codegraph'), { recursive: true })
    symlinkSync(victim, join(worktreeDir, relPath))

    expect(ensureCodeGraphReportFile(worktreeDir, relPath, '# report\n')).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('original\n')
    expect(lstatSync(join(worktreeDir, relPath)).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktreeDir, relPath), 'utf8')).toBe('# report\n')
  })

  it('refuses a report directory that is a symlink out of the worktree', () => {
    const worktreeDir = createWorktree()
    const outside = createWorktree()
    symlinkSync(outside, join(worktreeDir, '.forge'))

    expect(ensureCodeGraphReportFile(worktreeDir, codeGraphReportPath('section 1'), '# report\n')).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })
})
