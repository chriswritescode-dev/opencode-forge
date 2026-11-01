import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeGraphReportPath,
  createCodeGraphSnapshotter,
  ensureCodeGraphReportFile,
  resolveLoopCodeGraphTarget,
  type CodeGraphTarget,
} from '../../src/loop/code-graph'
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
}

function createTarget(
  worktreeDir: string,
  respond: (command: string) => CommandResult | Error | undefined = () => undefined,
): RecordingTarget {
  const commands: RecordedCommand[] = []
  return {
    key: 'forge-test-container',
    worktreeDir,
    commands,
    async exec(command, timeoutMs) {
      commands.push({ command, timeoutMs })
      const scripted = respond(command)
      if (scripted instanceof Error) throw scripted
      if (scripted) return scripted
      if (command === 'command -v codegraph') return ok('/usr/local/bin/codegraph\n')
      if (command.includes('codegraph.db')) return ok('missing\n')
      if (command.includes('codegraph affected')) return ok(JSON.stringify({ affectedTests: ['test/a.test.ts'] }))
      if (command.includes('codegraph node')) return ok(`symbols for ${command}`)
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
  it('initializes the index on the first snapshot and reports affected tests and node output', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const target = createTarget(worktreeDir)
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    const report = await snapshotter.snapshotFiles(target, { title: 'section 1', files: ['a.ts'] })

    expect(report).toContain('# Code graph: section 1')
    expect(report).toContain('## Changed or planned files')
    expect(report).toContain('- a.ts')
    expect(report).toContain('## Affected test files')
    expect(report).toContain('- test/a.test.ts')
    expect(report).toContain('## a.ts')
    expect(report).toContain('symbols for')

    const commands = target.commands.map((entry) => entry.command)
    const initIndex = commands.findIndex((command) => command.includes('codegraph init'))
    const affectedIndex = commands.findIndex((command) => command.includes('codegraph affected'))
    const nodeIndex = commands.findIndex((command) => command.includes('codegraph node'))
    expect(initIndex).toBeGreaterThanOrEqual(0)
    expect(initIndex).toBeLessThan(affectedIndex)
    expect(affectedIndex).toBeLessThan(nodeIndex)
    expect(readlinkSync(join(worktreeDir, '.codegraph'))).toBe('/opt/forge/cache/codegraph')
  })

  it('redirects codegraph git hooks to the cache disk for init and sync', async () => {
    const initWorktree = createWorktree()
    writeFileSync(join(initWorktree, 'a.ts'), 'export const a = 1\n')
    const initTarget = createTarget(initWorktree)

    await createCodeGraphSnapshotter({ logger: createLogger() }).snapshotFiles(initTarget, {
      title: 'init hooks',
      files: ['a.ts'],
    })

    const initCommand = initTarget.commands.find((entry) => entry.command.includes('codegraph init --yes'))?.command
    expect(initCommand).toContain('GIT_CONFIG_KEY_0=core.hooksPath')
    expect(initCommand).toContain("GIT_CONFIG_VALUE_0='/opt/forge/cache/codegraph-git-hooks'")

    const syncWorktree = createWorktree()
    writeFileSync(join(syncWorktree, 'a.ts'), 'export const a = 1\n')
    const syncTarget = createTarget(syncWorktree, (command) =>
      command.includes('codegraph.db') ? ok('present\n') : undefined,
    )

    await createCodeGraphSnapshotter({ logger: createLogger() }).snapshotFiles(syncTarget, {
      title: 'sync hooks',
      files: ['a.ts'],
    })

    const syncCommand = syncTarget.commands.find((entry) => entry.command.includes('codegraph sync --quiet'))?.command
    expect(syncCommand).toContain('GIT_CONFIG_KEY_0=core.hooksPath')
    expect(syncCommand).toContain("GIT_CONFIG_VALUE_0='/opt/forge/cache/codegraph-git-hooks'")
  })

  it('syncs instead of initializing when the index database already exists', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const target = createTarget(worktreeDir, (command) =>
      command.includes('codegraph.db') ? ok('present\n') : undefined,
    )
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    const report = await snapshotter.snapshotFiles(target, { title: 'section 2', files: ['a.ts'] })

    expect(report).not.toBeNull()
    const commands = target.commands.map((entry) => entry.command)
    expect(commands.some((command) => command.includes('codegraph sync'))).toBe(true)
    expect(commands.some((command) => command.includes('codegraph init'))).toBe(false)
  })

  it('falls back to a full index when sync fails', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const target = createTarget(worktreeDir, (command) => {
      if (command.includes('codegraph.db')) return ok('present\n')
      if (command.includes('codegraph sync')) return fail('stale lock')
      return undefined
    })
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    const report = await snapshotter.snapshotFiles(target, { title: 'section 3', files: ['a.ts'] })

    expect(report).not.toBeNull()
    const commands = target.commands.map((entry) => entry.command)
    expect(commands.some((command) => command.includes('codegraph sync'))).toBe(true)
    expect(commands.some((command) => command.includes('codegraph index --quiet'))).toBe(true)
  })

  it('refuses to initialize when the index probe cannot report the index state', async () => {
    for (const dbProbe of [fail('probe exploded'), ok('unknown\n')]) {
      const worktreeDir = createWorktree()
      writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
      const errors: unknown[][] = []
      const logger = createLogger()
      logger.error = (...args: unknown[]) => {
        errors.push(args)
      }
      const target = createTarget(worktreeDir, (command) => (command.includes('codegraph.db') ? dbProbe : undefined))

      const report = await createCodeGraphSnapshotter({ logger }).snapshotFiles(target, {
        title: 'probe',
        files: ['a.ts'],
      })

      expect(report).toBeNull()
      const commands = target.commands.map((entry) => entry.command)
      expect(commands.some((command) => command.includes('codegraph init'))).toBe(false)
      expect(commands.some((command) => command.includes('codegraph sync'))).toBe(false)
      expect(errors.length).toBeGreaterThan(0)
    }
  })

  it('returns null when the binary is missing and probes it once across snapshots', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    const target = createTarget(worktreeDir, (command) =>
      command === 'command -v codegraph' ? fail() : undefined,
    )
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    expect(await snapshotter.snapshotFiles(target, { title: 'one', files: ['a.ts'] })).toBeNull()
    expect(await snapshotter.snapshotFiles(target, { title: 'two', files: ['a.ts'] })).toBeNull()

    const commands = target.commands.map((entry) => entry.command)
    expect(commands.filter((command) => command === 'command -v codegraph')).toHaveLength(1)
    expect(commands.some((command) => command.includes('codegraph init'))).toBe(false)
  })

  it('retries the binary probe after a failed probe exec', async () => {
    const worktreeDir = createWorktree()
    writeFileSync(join(worktreeDir, 'a.ts'), 'export const a = 1\n')
    let probes = 0
    const target = createTarget(worktreeDir, (command) => {
      if (command !== 'command -v codegraph') return undefined
      probes += 1
      return probes === 1 ? new Error('msb exec failed') : ok('/usr/local/bin/codegraph\n')
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
    const commands = target.commands.map((entry) => entry.command)
    expect(commands.some((command) => command.includes('codegraph init'))).toBe(false)
  })

  it('returns null when the target exec throws', async () => {
    const worktreeDir = createWorktree()
    const target = createTarget(worktreeDir, () => new Error('sandbox is gone'))
    const snapshotter = createCodeGraphSnapshotter({ logger: createLogger() })

    expect(await snapshotter.snapshotFiles(target, { title: 'boom', files: ['a.ts'] })).toBeNull()
  })

  it('drops missing files and never truncates the report', async () => {
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
    const affected = target.commands.find((entry) => entry.command.includes('codegraph affected'))
    expect(affected?.command).toContain('f/0.ts')
    expect(affected?.command).not.toContain('missing.ts')
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
      { loop: { codeGraph: { enabled: false } } },
    )
    expect(target).toBeNull()
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
})
