import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_GRAPH_PROBE_COMMAND,
  codeGraphReportPath,
  createCodeGraphSnapshotter,
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
  'c.ts': ['test/c.test.ts'],
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
      ...(file.startsWith('test/') ? [] : [{ name: `symbolOf_${file}`, kind: 'function', signature: '()', startLine: 3 }]),
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
    expect(report).toContain('## Tests that import these files\n\n_None found._')
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
        maxDepth: 1,
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

  it('sends the changed ranges and the caller limit to the runner only when they are given', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(worktreeDir, 'b.ts'), 'export const b = 1\n')
    const target = createTarget(worktreeDir)
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    await snapshotter.snapshotFiles(target, {
      title: 'audit attempt 1 (section:0)',
      files: ['a.ts', 'b.ts', 'gone.ts'],
      changedRanges: { 'a.ts': [{ start: 2, end: 4 }], 'gone.ts': [{ start: 1, end: 1 }] },
    })
    await snapshotter.snapshotFiles(target, { title: 'section 1', files: ['a.ts'] })

    expect(target.runnerInputs[0].impact).toEqual({ ranges: { 'a.ts': [{ start: 2, end: 4 }] }, callerLimit: 20 })
    expect(target.runnerInputs[1].impact).toBeUndefined()
  })

  function scriptedTarget(worktreeDir: string, result: unknown): RecordingTarget {
    return createTarget(worktreeDir, (command) => (isRunnerCommand(command) ? ok(`progress noise\n${JSON.stringify(result)}\n`) : undefined))
  }

  function bookReport(): Array<{ path: string; symbols: Array<Record<string, unknown>>; dependents: string[] }> {
    return [{ path: 'src/lib.ts', symbols: [{ name: 'keepMe', kind: 'function', signature: null, startLine: 9 }], dependents: [] }]
  }

  function auditResult(impact: unknown): Record<string, unknown> {
    return { ok: true, index: 'synced', files: bookReport(), affectedTests: [], impact }
  }

  async function formatAuditReport(worktreeDir: string, result: unknown): Promise<string | null> {
    mkdirSync(join(worktreeDir, 'src'), { recursive: true })
    writeFileSync(join(worktreeDir, 'src/lib.ts'), 'export function keepMe() {}\n')
    return createCodeGraphSnapshotter({ logger: createLogger() }).snapshotFiles(scriptedTarget(worktreeDir, result), {
      title: 'audit attempt 1 (section:0)',
      files: ['src/lib.ts'],
      changedRanges: { 'src/lib.ts': [{ start: 9, end: 9 }] },
    })
  }

  it('formats the callers of changed symbols and the references to removed symbols', async () => {
    const report = await formatAuditReport(
      createWorktree(),
      auditResult({
        changedSymbols: [
          {
            name: 'keepMe',
            kind: 'function',
            path: 'src/lib.ts',
            startLine: 9,
            callers: [{ name: 'run', kind: 'function', path: 'src/app.ts', line: 4 }],
            callerCount: 13,
          },
          { name: 'quiet', kind: 'function', path: 'src/lib.ts', startLine: 20, callers: [], callerCount: 0 },
        ],
        removedSymbols: [
          {
            name: 'removeMe',
            path: 'src/lib.ts',
            references: [{ name: 'run', kind: 'function', path: 'src/app.ts', line: 4 }],
          },
        ],
      }),
    )

    expect(report).toContain(
      [
        '## Callers of changed symbols',
        '',
        'Callers outside the files changed in this attempt.',
        '',
        '### `keepMe` (function) — src/lib.ts:9',
        '',
        '- `run` (function) — src/app.ts:4',
        '- … and 12 more: run `codegraph callers keepMe -f src/lib.ts`',
        '',
        '1 other changed symbol has no callers outside the changed files.',
        '',
        '## Removed or renamed symbols still referenced',
        '',
        'These names no longer exist in the index, but code still refers to them. Fix each reference or confirm it is intended.',
        '',
        '### `removeMe` (was in src/lib.ts)',
        '',
        '- `run` (function) — src/app.ts:4',
      ].join('\n'),
    )
    expect(report!.indexOf('## Callers of changed symbols')).toBeLessThan(report!.indexOf('## src/lib.ts'))
    expect(report).toContain('## src/lib.ts')
  })

  it('reports changed symbols without callers and omits the removed section when nothing was removed', async () => {
    const report = await formatAuditReport(
      createWorktree(),
      auditResult({
        changedSymbols: [
          { name: 'one', kind: 'function', path: 'src/lib.ts', startLine: 1, callers: [], callerCount: 0 },
          { name: 'two', kind: 'function', path: 'src/lib.ts', startLine: 2, callers: [], callerCount: 0 },
        ],
        removedSymbols: [],
      }),
    )

    expect(report).toContain(
      [
        '## Callers of changed symbols',
        '',
        'Callers outside the files changed in this attempt.',
        '',
        '_No changed symbol has callers outside the changed files._',
        '',
        '2 other changed symbols have no callers outside the changed files.',
      ].join('\n'),
    )
    expect(report).not.toContain('## Removed or renamed symbols still referenced')
  })

  it('adds no impact sections when the runner result carries no impact report', async () => {
    const report = await formatAuditReport(createWorktree(), {
      ok: true,
      index: 'synced',
      files: bookReport(),
      affectedTests: [],
    })

    expect(report).toContain('# Code graph: audit attempt 1 (section:0)')
    expect(report).not.toContain('## Callers of changed symbols')
    expect(report).not.toContain('## Removed or renamed symbols still referenced')
  })

  it('lists only the tests that import a changed file directly and drops empty file sections', async () => {
    const worktreeDir = createWorktree()
    mkdirSync(join(worktreeDir, 'test'))
    for (const file of ['a.ts', 'c.ts', 'test/c.test.ts']) writeFileSync(join(worktreeDir, file), 'export {}\n')
    const target = createTarget(worktreeDir)

    const report = await createCodeGraphSnapshotter({ logger: createLogger() }).snapshotFiles(target, {
      title: 'direct',
      files: ['a.ts', 'c.ts', 'test/c.test.ts'],
    })

    expect(report).toContain('## Tests that import these files\n\n- test/c.test.ts\n\nFor tests that reach these files indirectly')
    expect(report).not.toContain('test/a.test.ts')
    expect(report).toContain('## c.ts\n\nUsed by: test/c.test.ts')
    expect(report).not.toContain('## test/c.test.ts')
    expect(report).not.toContain('No dependents')
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

describe('writeReport', () => {
  function shellTarget(worktreeDir: string, commands: string[]): CodeGraphTarget {
    return {
      key: 'forge-test-container',
      worktreeDir,
      required: false,
      async exec(command) {
        commands.push(command)
        try {
          return ok(execSync(command, { cwd: worktreeDir, encoding: 'utf8', shell: '/bin/sh' }))
        } catch (err) {
          return fail(String((err as { stderr?: string }).stderr ?? err))
        }
      },
    }
  }

  it('writes the report through sandbox execs, in chunks that each stay a small shell argument', async () => {
    const worktreeDir = createWorktree()
    const commands: string[] = []
    const text = `# Code graph: big — ünïcode\n${'- test/some/long/path.test.ts\n'.repeat(4000)}`
    const relPath = codeGraphReportPath('section 1')

    expect(await createCodeGraphSnapshotter({ logger: createLogger() }).writeReport(shellTarget(worktreeDir, commands), relPath, text)).toBe(true)

    expect(readFileSync(join(worktreeDir, relPath), 'utf8')).toBe(text)
    expect(commands.length).toBeGreaterThan(1)
    for (const command of commands) expect(command.length).toBeLessThan(70 * 1024)
  })

  it('gives all chunks of one report a single time budget and stops once it is spent', async () => {
    const worktreeDir = createWorktree()
    const timeouts: number[] = []
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const target: CodeGraphTarget = {
        key: 'forge-test-container',
        worktreeDir,
        required: false,
        async exec(_command, timeoutMs) {
          timeouts.push(timeoutMs)
          now += 20_000
          return ok()
        },
      }

      const written = await createCodeGraphSnapshotter({ logger: createLogger() }).writeReport(
        target,
        codeGraphReportPath('section 1'),
        'x'.repeat(200_000),
      )

      expect(written).toBe(false)
      expect(timeouts).toEqual([30_000, 10_000])
    } finally {
      clock.mockRestore()
    }
  })

  it('reports a failed write without throwing', async () => {
    const worktreeDir = createWorktree()
    const errors: unknown[][] = []
    const logger = createLogger()
    logger.error = (...args: unknown[]) => {
      errors.push(args)
    }
    const target = createTarget(worktreeDir, () => fail('read-only file system'))

    expect(await createCodeGraphSnapshotter({ logger }).writeReport(target, codeGraphReportPath('section 1'), '# report\n')).toBe(false)
    expect(String(errors[0]?.[0])).toContain('read-only file system')
  })
})
