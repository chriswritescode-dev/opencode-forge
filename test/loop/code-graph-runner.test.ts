import { spawnSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCodeGraphRunnerScript,
  parseCodeGraphRunnerResult,
  runCodeGraphSnapshot,
  type CodeGraphRunnerInput,
} from '../../src/loop/code-graph-runner'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeGraphOptions {
  initialized?: boolean
  dependents?: Record<string, string[]>
  syncError?: string
  indexFails?: boolean
  openError?: string
  queryError?: string
}

function fakeLoader(options: FakeGraphOptions = {}) {
  const calls: string[] = []
  const mkdirs: string[] = []
  const handle = (origin: string) => ({
    indexAll: async () => {
      calls.push(`indexAll:${origin}`)
      return { success: !options.indexFails, filesIndexed: 3, errors: options.indexFails ? [{}] : [] }
    },
    sync: async () => {
      calls.push('sync')
      if (options.syncError) throw new Error(options.syncError)
    },
    getNodesInFile: (file: string) => {
      if (options.queryError) throw new Error(options.queryError)
      return [
        { name: file, kind: 'file', startLine: 1 },
        { name: './dep', kind: 'import', startLine: 1 },
        { name: 'fn', kind: 'function', signature: '(x: number)', startLine: 2 },
        { name: 'Klass', kind: 'class', startLine: 5 },
      ]
    },
    getFileDependents: (file: string) => options.dependents?.[file] ?? [],
    destroy: () => {
      calls.push(`destroy:${origin}`)
    },
  })
  const load = (path: string): unknown => {
    if (path === 'fs') return { mkdirSync: (dir: string) => mkdirs.push(dir) }
    if (path.endsWith('/dist/search/query-utils.js')) return { isTestPath: (file: string) => file.includes('.test.') }
    return {
      setLogger: () => {},
      silentLogger: {},
      CodeGraph: {
        isInitialized: (root: string) => {
          calls.push(`isInitialized:${root}`)
          return options.initialized ?? true
        },
        init: async (_root: string, initOptions: unknown) => {
          calls.push(`init:${JSON.stringify(initOptions)}`)
          return handle('init')
        },
        open: async () => {
          calls.push('open')
          if (options.openError) throw new Error(options.openError)
          return handle('open')
        },
        recreate: async () => {
          calls.push('recreate')
          return handle('recreate')
        },
      },
    }
  }
  return { load, calls, mkdirs }
}

function input(overrides: Partial<CodeGraphRunnerInput> = {}): CodeGraphRunnerInput {
  return {
    libDir: '/opt/codegraph/lib',
    projectRoot: '/work',
    indexDir: '/opt/forge/cache/codegraph',
    files: ['src/a.ts'],
    maxDepth: 5,
    ...overrides,
  }
}

describe('runCodeGraphSnapshot', () => {
  it('syncs an existing index and reports symbols, sorted direct dependents, and transitive affected tests', async () => {
    const { load, calls, mkdirs } = fakeLoader({
      dependents: {
        'src/a.ts': ['src/c.ts', 'src/b.ts'],
        'src/b.ts': ['src/b.test.ts', 'src/a.ts'],
        'src/c.ts': ['src/d.ts'],
        'src/d.ts': ['src/d.test.ts'],
      },
    })

    const result = await runCodeGraphSnapshot(load, input())

    expect(result).toEqual({
      ok: true,
      index: 'synced',
      files: [
        {
          path: 'src/a.ts',
          symbols: [
            { name: 'fn', kind: 'function', signature: '(x: number)', startLine: 2 },
            { name: 'Klass', kind: 'class', signature: null, startLine: 5 },
          ],
          dependents: ['src/b.ts', 'src/c.ts'],
        },
      ],
      affectedTests: ['src/b.test.ts', 'src/d.test.ts'],
    })
    expect(mkdirs).toEqual(['/opt/forge/cache/codegraph'])
    expect(calls).toEqual(['isInitialized:/work', 'open', 'sync', 'destroy:open'])
  })

  it('creates a missing index with a full index instead of syncing', async () => {
    const { load, calls } = fakeLoader({ initialized: false })

    const result = await runCodeGraphSnapshot(load, input())

    expect(result).toMatchObject({ ok: true, index: 'created' })
    expect(calls).toEqual(['isInitialized:/work', 'init:{"index":false}', 'indexAll:init', 'destroy:init'])
  })

  it('rebuilds the index when sync fails', async () => {
    const { load, calls } = fakeLoader({ syncError: 'locked' })

    const result = await runCodeGraphSnapshot(load, input())

    expect(result).toMatchObject({ ok: true, index: 'rebuilt' })
    expect(calls).toEqual(['isInitialized:/work', 'open', 'sync', 'destroy:open', 'recreate', 'indexAll:recreate', 'destroy:recreate'])
  })

  it('counts a changed test file as affected and stops the walk at maxDepth', async () => {
    const { load } = fakeLoader({
      dependents: { 'src/a.ts': ['src/b.ts'], 'src/b.ts': ['src/c.ts'], 'src/c.ts': ['src/c.test.ts'] },
    })

    const shallow = await runCodeGraphSnapshot(load, input({ files: ['src/a.ts', 'src/x.test.ts'], maxDepth: 2 }))
    const deep = await runCodeGraphSnapshot(load, input({ files: ['src/a.ts'], maxDepth: 3 }))

    expect(shallow.ok && shallow.affectedTests).toEqual(['src/x.test.ts'])
    expect(deep.ok && deep.affectedTests).toEqual(['src/c.test.ts'])
  })

  it('reports each failure with its stage and closes every index it opened', async () => {
    const failedCreate = fakeLoader({ initialized: false, indexFails: true })
    expect(await runCodeGraphSnapshot(failedCreate.load, input())).toEqual({
      ok: false,
      stage: 'index',
      error: 'full index failed after 3 files with 1 errors',
    })
    expect(failedCreate.calls.at(-1)).toBe('destroy:init')

    const failedRebuild = fakeLoader({ syncError: 'locked', indexFails: true })
    const rebuild = await runCodeGraphSnapshot(failedRebuild.load, input())
    expect(rebuild).toMatchObject({ ok: false, stage: 'index' })
    expect(rebuild.ok === false && rebuild.error).toContain('sync failed (locked)')
    expect(failedRebuild.calls.filter((call) => call.startsWith('destroy'))).toEqual(['destroy:open', 'destroy:recreate'])

    const queryFailure = fakeLoader({ queryError: 'corrupt' })
    expect(await runCodeGraphSnapshot(queryFailure.load, input())).toEqual({ ok: false, stage: 'query', error: 'corrupt' })
    expect(queryFailure.calls.at(-1)).toBe('destroy:open')

    const openFailure = fakeLoader({ openError: 'no index' })
    expect(await runCodeGraphSnapshot(openFailure.load, input())).toEqual({ ok: false, stage: 'index', error: 'no index' })

    const missingLibrary = await runCodeGraphSnapshot((path) => {
      if (path === 'fs') return { mkdirSync: () => {} }
      throw new Error('Cannot find module')
    }, input())
    expect(missingLibrary).toEqual({ ok: false, stage: 'load', error: 'Cannot find module' })
  })
})

describe('parseCodeGraphRunnerResult', () => {
  it('reads the last non-empty line', () => {
    const result = { ok: true, index: 'synced', files: [{ path: 'a.ts', symbols: [], dependents: [] }], affectedTests: [] }
    expect(parseCodeGraphRunnerResult(`warning: noise\n${JSON.stringify(result)}\n\n`)).toEqual(result)
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: false, stage: 'index', error: 'x' }))).toEqual({
      ok: false,
      stage: 'index',
      error: 'x',
    })
  })

  it('rejects empty, non-JSON, and wrongly shaped output', () => {
    expect(parseCodeGraphRunnerResult('')).toBeNull()
    expect(parseCodeGraphRunnerResult('Segmentation fault')).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: true, index: 'synced', files: [{ path: 'a.ts' }], affectedTests: [] }))).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: true, index: 'synced', files: [], affectedTests: [1] }))).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: true, index: 'other', files: [], affectedTests: [] }))).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: false, stage: 'sync', error: 'x' }))).toBeNull()
  })
})

function runScript(nodeBinary: string, runnerInput: CodeGraphRunnerInput, cwd: string) {
  const run = spawnSync(nodeBinary, ['-e', buildCodeGraphRunnerScript(), JSON.stringify(runnerInput)], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1' },
    timeout: 60_000,
  })
  return { run, result: parseCodeGraphRunnerResult(run.stdout) }
}

describe('buildCodeGraphRunnerScript', () => {
  it('runs as a standalone node -e program against a library on disk', () => {
    const libDir = tempDir('forge-codegraph-lib-')
    const indexDir = join(libDir, 'index', 'nested')
    mkdirSync(join(libDir, 'dist', 'search'), { recursive: true })
    writeFileSync(
      join(libDir, 'dist', 'index.js'),
      `const handle = {
  sync: async () => {},
  indexAll: async () => ({ success: true, filesIndexed: 1, errors: [] }),
  getNodesInFile: () => [{ name: 'fn', kind: 'function', startLine: 4 }],
  getFileDependents: (file) => (file === 'a.ts' ? ['a.test.ts'] : []),
  destroy: () => {},
}
exports.silentLogger = {}
exports.setLogger = () => {}
exports.CodeGraph = { isInitialized: () => true, open: async () => handle }
`,
    )
    writeFileSync(join(libDir, 'dist', 'search', 'query-utils.js'), `exports.isTestPath = (file) => file.endsWith('.test.ts')\n`)

    const { run, result } = runScript(process.execPath, input({ libDir, indexDir, files: ['a.ts'] }), libDir)

    expect(run.status).toBe(0)
    expect(existsSync(indexDir)).toBe(true)
    expect(result).toEqual({
      ok: true,
      index: 'synced',
      files: [{ path: 'a.ts', symbols: [{ name: 'fn', kind: 'function', signature: null, startLine: 4 }], dependents: ['a.test.ts'] }],
      affectedTests: ['a.test.ts'],
    })
  })

  it('prints a load failure when the library is missing', () => {
    const indexDir = join(tempDir('forge-codegraph-missing-'), 'index')
    const { run, result } = runScript(process.execPath, input({ libDir: '/nonexistent/codegraph/lib', indexDir }), tmpdir())
    expect(run.status).toBe(0)
    expect(result).toMatchObject({ ok: false, stage: 'load' })
  })

  const localRelease = process.env.CODEGRAPH_RELEASE_DIR ?? join(homedir(), '.codegraph', 'versions', 'v1.6.2')
  const hasLocalRelease = existsSync(join(localRelease, 'node')) && existsSync(join(localRelease, 'lib', 'dist', 'index.js'))

  it.skipIf(!hasLocalRelease)('creates, then syncs, a real codegraph v1.6.2 index through a .codegraph link without git hooks', () => {
    const project = tempDir('forge-codegraph-project-')
    const indexDir = join(tempDir('forge-codegraph-cache-'), 'codegraph')
    mkdirSync(join(project, 'test'))
    writeFileSync(join(project, 'a.ts'), 'export function a() { return 1 }\n')
    writeFileSync(join(project, 'b.ts'), 'import { a } from "./a"\nexport const b = a()\n')
    writeFileSync(join(project, 'test', 'b.test.ts'), 'import { b } from "../b"\nexport const t = b\n')
    expect(spawnSync('git', ['init', '-q'], { cwd: project }).status).toBe(0)
    symlinkSync(indexDir, join(project, '.codegraph'))
    const releaseNode = join(localRelease, 'node')
    const releaseInput = input({ libDir: join(localRelease, 'lib'), projectRoot: project, indexDir, files: ['a.ts'] })

    const first = runScript(releaseNode, releaseInput, project)
    expect(first.run.status).toBe(0)
    expect(first.result).toMatchObject({ ok: true, index: 'created', affectedTests: ['test/b.test.ts'] })

    writeFileSync(join(project, 'a.ts'), 'export function a() { return 1 }\nexport function c() { return 2 }\n')
    const second = runScript(releaseNode, releaseInput, project)

    expect(second.run.status).toBe(0)
    expect(second.result).toEqual({
      ok: true,
      index: 'synced',
      files: [
        {
          path: 'a.ts',
          symbols: [
            { name: 'a', kind: 'function', signature: '()', startLine: 1 },
            { name: 'c', kind: 'function', signature: '()', startLine: 2 },
          ],
          dependents: ['b.ts'],
        },
      ],
      affectedTests: ['test/b.test.ts'],
    })
    expect(lstatSync(join(project, '.codegraph')).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(project, '.git', 'hooks')).filter((hook) => !hook.endsWith('.sample'))).toEqual([])
    expect(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: project }).status).not.toBe(0)
  })
})
