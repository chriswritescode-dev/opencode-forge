import { spawnSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
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

class FakeLockUnavailableError extends Error {}

interface FakeNode {
  id: string
  name: string
  kind: string
  filePath: string
  startLine: number
  endLine: number
  signature?: string
}

interface FakeGraphOptions {
  initialized?: boolean
  dependents?: Record<string, string[]>
  syncError?: string
  syncLocked?: boolean
  rebuildLockTaken?: boolean
  indexFails?: boolean
  openError?: string
  queryError?: string
  callersError?: string
  /** Index content per file after the run's sync, replacing the default nodes for that file. */
  nodes?: Record<string, FakeNode[]>
  /** Index content per file before the open path's sync; defaults to `nodes`. */
  preSyncNodes?: Record<string, FakeNode[]>
  callers?: Record<string, FakeCaller[]>
  /** Nodes `getNode` resolves that no `getNodesInFile` call lists. */
  definitions?: FakeNode[]
  /** Names `getUnresolvedNamesAmong` reports as still referenced, intersected with its argument. */
  unresolvedNames?: string[]
  /** Files `getFiles` lists; defaults to those with nodes or unresolved references. */
  files?: string[]
  /** Unresolved references per file, as `getUnresolvedReferencesInFile` returns them. */
  unresolvedReferences?: Record<string, FakeUnresolvedReference[]>
}

interface FakeCaller {
  node: FakeNode
  edge: { line?: number }
}

interface FakeUnresolvedReference {
  fromNodeId: string
  referenceName: string
  referenceKind: string
  line: number
}

const defaultNodes = (file: string): FakeNode[] => [
  { id: `file:${file}`, name: file, kind: 'file', filePath: file, startLine: 1, endLine: 1 },
  { id: `import:${file}`, name: './dep', kind: 'import', filePath: file, startLine: 1, endLine: 1 },
  { id: `function:${file}:fn`, name: 'fn', kind: 'function', signature: '(x: number)', filePath: file, startLine: 2, endLine: 2 },
  { id: `class:${file}:Klass`, name: 'Klass', kind: 'class', filePath: file, startLine: 5, endLine: 5 },
]

function fakeLoader(options: FakeGraphOptions = {}) {
  const calls: string[] = []
  const mkdirs: string[] = []
  const knownNodes = [
    ...(options.definitions ?? []),
    ...Object.values(options.nodes ?? {}).flat(),
    ...Object.values(options.preSyncNodes ?? {}).flat(),
  ]
  const knownFiles = options.files ?? [
    ...new Set([
      ...Object.keys(options.nodes ?? {}),
      ...Object.keys(options.preSyncNodes ?? {}),
      ...Object.keys(options.unresolvedReferences ?? {}),
    ]),
  ]
  const handle = (origin: string) => {
    let synced = origin !== 'open'
    return {
      indexAll: async () => {
        calls.push(`indexAll:${origin}`)
        return { success: !options.indexFails, filesIndexed: 3, errors: options.indexFails ? [{}] : [] }
      },
      sync: async () => {
        calls.push('sync')
        if (options.syncLocked) throw new FakeLockUnavailableError('Sync could not acquire the file lock')
        if (options.syncError) throw new Error(options.syncError)
        synced = true
      },
      getNodesInFile: (file: string) => {
        if (options.queryError) throw new Error(options.queryError)
        const content = synced ? options.nodes : options.preSyncNodes ?? options.nodes
        return content?.[file] ?? defaultNodes(file)
      },
      getFileDependents: (file: string) => options.dependents?.[file] ?? [],
      getCallers: (id: string) => {
        if (options.callersError) throw new Error(options.callersError)
        return options.callers?.[id] ?? []
      },
      getNode: (id: string) => knownNodes.find((node) => node.id === id) ?? null,
      getUnresolvedNamesAmong: (names: Iterable<string>) => {
        const referenced = new Set(options.unresolvedNames ?? [])
        const found = new Set<string>()
        for (const name of names) {
          if (referenced.has(name)) found.add(name)
        }
        return found
      },
      getFiles: () => {
        calls.push('getFiles')
        return knownFiles.map((path) => ({ path }))
      },
      getUnresolvedReferencesInFile: (file: string) => {
        calls.push(`unresolvedInFile:${file}`)
        return options.unresolvedReferences?.[file] ?? []
      },
      destroy: () => {
        calls.push(`destroy:${origin}`)
      },
    }
  }
  const load = (path: string): unknown => {
    if (path === 'fs') return { mkdirSync: (dir: string) => mkdirs.push(dir) }
    if (path.endsWith('/dist/search/query-utils.js')) return { isTestPath: (file: string) => file.includes('.test.') }
    if (path.endsWith('/dist/mcp/writer-lock.js')) {
      return {
        tryAcquireWriterLock: (_root: string, _mode: string, lockName: string) => {
          calls.push(`acquire:${lockName}`)
          return { kind: options.rebuildLockTaken ? 'taken' : 'acquired' }
        },
        releaseWriterLock: (_root: string, lockName: string) => calls.push(`release:${lockName}`),
      }
    }
    return {
      LockUnavailableError: FakeLockUnavailableError,
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
    deadlineMs: 60_000,
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
    expect(calls).toEqual([
      'isInitialized:/work',
      'acquire:rebuild.pid',
      'init:{"index":false}',
      'indexAll:init',
      'release:rebuild.pid',
      'destroy:init',
    ])
  })

  it('rebuilds the index when sync fails', async () => {
    const { load, calls } = fakeLoader({ syncError: 'locked' })

    const result = await runCodeGraphSnapshot(load, input())

    expect(result).toMatchObject({ ok: true, index: 'rebuilt' })
    expect(calls).toEqual([
      'isInitialized:/work',
      'open',
      'sync',
      'destroy:open',
      'acquire:rebuild.pid',
      'recreate',
      'indexAll:recreate',
      'release:rebuild.pid',
      'destroy:recreate',
    ])
  })

  it('leaves an index another process holds untouched instead of rebuilding it', async () => {
    const lockedSync = fakeLoader({ syncLocked: true })
    expect(await runCodeGraphSnapshot(lockedSync.load, input())).toEqual({
      ok: false,
      stage: 'locked',
      error: 'Sync could not acquire the file lock',
    })
    expect(lockedSync.calls).toEqual(['isInitialized:/work', 'open', 'sync', 'destroy:open'])

    const busyRebuild = fakeLoader({ syncError: 'corrupt', rebuildLockTaken: true })
    expect(await runCodeGraphSnapshot(busyRebuild.load, input())).toMatchObject({ ok: false, stage: 'locked' })
    expect(busyRebuild.calls).not.toContain('recreate')
    expect(busyRebuild.calls).not.toContain('release:rebuild.pid')

    const busyCreate = fakeLoader({ initialized: false, rebuildLockTaken: true })
    expect(await runCodeGraphSnapshot(busyCreate.load, input())).toMatchObject({ ok: false, stage: 'locked' })
    expect(busyCreate.calls.some((call) => call.startsWith('init'))).toBe(false)
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
    expect(failedCreate.calls.slice(-2)).toEqual(['destroy:init', 'release:rebuild.pid'])

    const failedRebuild = fakeLoader({ syncError: 'locked', indexFails: true })
    const rebuild = await runCodeGraphSnapshot(failedRebuild.load, input())
    expect(rebuild).toMatchObject({ ok: false, stage: 'index' })
    expect(rebuild.ok === false && rebuild.error).toContain('sync failed (locked)')
    expect(failedRebuild.calls.filter((call) => call.startsWith('destroy'))).toEqual(['destroy:open', 'destroy:recreate'])
    expect(failedRebuild.calls.at(-1)).toBe('release:rebuild.pid')

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

describe('runCodeGraphSnapshot impact', () => {
  const keepMe: FakeNode = { id: 'function:keepMe', name: 'keepMe', kind: 'function', filePath: 'src/lib.ts', startLine: 3, endLine: 5 }
  const untouched: FakeNode = { id: 'function:untouched', name: 'untouched', kind: 'function', filePath: 'src/lib.ts', startLine: 20, endLine: 25 }
  const run: FakeNode = { id: 'function:run', name: 'run', kind: 'function', filePath: 'src/app.ts', startLine: 3, endLine: 5 }
  const appFile: FakeNode = { id: 'file:src/app.ts', name: 'app.ts', kind: 'file', filePath: 'src/app.ts', startLine: 1, endLine: 5 }
  const impact = (ranges: Record<string, Array<{ start: number; end: number }>>, callerLimit = 5) => ({ ranges, callerLimit })

  it('reports the symbols whose definition overlaps a changed range, with live callers outside the changed files', async () => {
    const { load } = fakeLoader({
      nodes: {
        'src/lib.ts': [
          { id: 'file:src/lib.ts', name: 'lib.ts', kind: 'file', filePath: 'src/lib.ts', startLine: 1, endLine: 30 },
          { id: 'import:src/lib.ts', name: './x', kind: 'import', filePath: 'src/lib.ts', startLine: 1, endLine: 1 },
          keepMe,
          untouched,
        ],
      },
      callers: {
        'function:keepMe': [
          { node: appFile, edge: { line: 1 } },
          { node: run, edge: { line: 14 } },
          { node: run, edge: { line: 16 } },
          { node: keepMe, edge: { line: 3 } },
          { node: { id: 'function:local', name: 'local', kind: 'function', filePath: 'src/lib.ts', startLine: 30, endLine: 31 }, edge: { line: 31 } },
          { node: { id: 'function:elsewhere', name: 'elsewhere', kind: 'function', filePath: 'src/other.ts', startLine: 40, endLine: 41 } },
        ],
      },
    })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 4, end: 4 }] }) }))

    expect(result.ok && result.impact).toEqual({
      changedSymbols: [
        {
          name: 'keepMe',
          kind: 'function',
          path: 'src/lib.ts',
          startLine: 3,
          callerCount: 2,
          callers: [
            { name: 'run', kind: 'function', path: 'src/app.ts', line: 14 },
            { name: 'elsewhere', kind: 'function', path: 'src/other.ts', line: 40 },
          ],
        },
      ],
      removedSymbols: [],
    })
  })

  it('lists at most callerLimit callers, counts the rest, and includes changed symbols with no callers', async () => {
    const first: FakeNode = { id: 'function:first', name: 'first', kind: 'function', filePath: 'src/lib.ts', startLine: 2, endLine: 4 }
    const orphan: FakeNode = { id: 'function:orphan', name: 'orphan', kind: 'function', filePath: 'src/lib.ts', startLine: 10, endLine: 12 }
    const { load } = fakeLoader({
      nodes: { 'src/lib.ts': [first, orphan] },
      callers: {
        'function:first': [
          { node: { id: 'c', name: 'c', kind: 'function', filePath: 'src/c.ts', startLine: 30, endLine: 31 }, edge: { line: 31 } },
          { node: { id: 'a', name: 'a', kind: 'function', filePath: 'src/a.ts', startLine: 10, endLine: 11 }, edge: { line: 11 } },
          { node: { id: 'b', name: 'b', kind: 'function', filePath: 'src/a.ts', startLine: 20, endLine: 21 }, edge: { line: 21 } },
        ],
      },
    })

    const result = await runCodeGraphSnapshot(
      load,
      input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 11, end: 12 }, { start: 3, end: 3 }] }, 2) }),
    )

    expect(result.ok && result.impact).toEqual({
      changedSymbols: [
        {
          name: 'first',
          kind: 'function',
          path: 'src/lib.ts',
          startLine: 2,
          callerCount: 3,
          callers: [
            { name: 'a', kind: 'function', path: 'src/a.ts', line: 11 },
            { name: 'b', kind: 'function', path: 'src/a.ts', line: 21 },
          ],
        },
        { name: 'orphan', kind: 'function', path: 'src/lib.ts', startLine: 10, callerCount: 0, callers: [] },
      ],
      removedSymbols: [],
    })
  })

  it('reports symbols the sync removed or renamed that still have unresolved references', async () => {
    const zero: FakeNode = { id: 'function:zero', name: 'zero', kind: 'function', filePath: 'src/zero.ts', startLine: 1, endLine: 3 }
    const { load } = fakeLoader({
      nodes: {
        'src/lib.ts': [
          { id: 'function:renamedFn', name: 'renamedFn', kind: 'function', filePath: 'src/lib.ts', startLine: 1, endLine: 1 },
          keepMe,
        ],
      },
      preSyncNodes: {
        'src/lib.ts': [
          { id: 'function:removeMe', name: 'removeMe', kind: 'function', filePath: 'src/lib.ts', startLine: 1, endLine: 1 },
          { id: 'function:renameMe', name: 'renameMe', kind: 'function', filePath: 'src/lib.ts', startLine: 2, endLine: 2 },
          keepMe,
          { id: 'function:ghost', name: 'ghost', kind: 'function', filePath: 'src/lib.ts', startLine: 9, endLine: 9 },
        ],
      },
      definitions: [run, appFile, zero],
      unresolvedNames: ['removeMe', 'renameMe'],
      unresolvedReferences: {
        'src/app.ts': [
          { fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'calls', line: 4 },
          { fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'calls', line: 4 },
          { fromNodeId: 'file:src/app.ts', referenceName: 'removeMe', referenceKind: 'imports', line: 1 },
          { fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'decorates', line: 2 },
          { fromNodeId: 'function:missing', referenceName: 'removeMe', referenceKind: 'calls', line: 7 },
          { fromNodeId: 'function:run', referenceName: 'renameMe', referenceKind: 'calls', line: 4 },
          { fromNodeId: 'function:run', referenceName: 'keepMe', referenceKind: 'calls', line: 4 },
          { fromNodeId: 'function:gone', referenceName: 'ghost', referenceKind: 'calls', line: 8 },
        ],
        'src/zero.ts': [
          { fromNodeId: 'function:zero', referenceName: 'removeMe', referenceKind: 'references', line: 2 },
          { fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'calls', line: 4 },
        ],
      },
    })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 1, end: 2 }] }) }))

    expect(result.ok && result.impact && result.impact.changedSymbols.map((symbol) => symbol.name)).toEqual(['renamedFn'])
    expect(result.ok && result.impact && result.impact.removedSymbols).toEqual([
      {
        name: 'removeMe',
        path: 'src/lib.ts',
        references: [
          { name: 'app.ts', kind: 'file', path: 'src/app.ts', line: 1 },
          { name: 'run', kind: 'function', path: 'src/app.ts', line: 4 },
          { name: 'zero', kind: 'function', path: 'src/zero.ts', line: 2 },
        ],
      },
      {
        name: 'renameMe',
        path: 'src/lib.ts',
        references: [{ name: 'run', kind: 'function', path: 'src/app.ts', line: 4 }],
      },
    ])
  })

  it('scans no files for references when no vanished name is still referenced', async () => {
    const { load, calls } = fakeLoader({
      nodes: { 'src/lib.ts': [keepMe] },
      preSyncNodes: {
        'src/lib.ts': [
          { id: 'function:removeMe', name: 'removeMe', kind: 'function', filePath: 'src/lib.ts', startLine: 1, endLine: 1 },
          keepMe,
        ],
      },
      definitions: [run],
      unresolvedNames: [],
      unresolvedReferences: { 'src/app.ts': [{ fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'calls', line: 4 }] },
    })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 3, end: 3 }] }) }))

    expect(result.ok && result.impact && result.impact.removedSymbols).toEqual([])
    expect(calls).not.toContain('getFiles')
    expect(calls.some((call) => call.startsWith('unresolvedInFile:'))).toBe(false)
  })

  it('reports no removed symbols when it creates the index', async () => {
    const { load, calls } = fakeLoader({
      initialized: false,
      nodes: { 'src/lib.ts': [keepMe] },
      preSyncNodes: { 'src/lib.ts': [keepMe, { id: 'function:removeMe', name: 'removeMe', kind: 'function', filePath: 'src/lib.ts', startLine: 1, endLine: 1 }] },
      definitions: [run],
      unresolvedNames: ['removeMe'],
      unresolvedReferences: { 'src/app.ts': [{ fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'calls', line: 4 }] },
    })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 3, end: 3 }] }) }))

    expect(result.ok && result.index).toBe('created')
    expect(result.ok && result.impact && result.impact.removedSymbols).toEqual([])
    expect(calls).not.toContain('getFiles')
  })

  it('keeps the baseline captured before a failed sync when it rebuilds', async () => {
    const { load } = fakeLoader({
      syncError: 'corrupt',
      nodes: { 'src/lib.ts': [keepMe] },
      preSyncNodes: { 'src/lib.ts': [keepMe, { id: 'function:removeMe', name: 'removeMe', kind: 'function', filePath: 'src/lib.ts', startLine: 1, endLine: 1 }] },
      definitions: [run],
      unresolvedNames: ['removeMe'],
      unresolvedReferences: { 'src/app.ts': [{ fromNodeId: 'function:run', referenceName: 'removeMe', referenceKind: 'calls', line: 4 }] },
    })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 3, end: 3 }] }) }))

    expect(result.ok && result.index).toBe('rebuilt')
    expect(result.ok && result.impact && result.impact.removedSymbols).toEqual([
      { name: 'removeMe', path: 'src/lib.ts', references: [{ name: 'run', kind: 'function', path: 'src/app.ts', line: 4 }] },
    ])
  })

  it('reports a failing impact query as a query failure', async () => {
    const { load } = fakeLoader({ nodes: { 'src/lib.ts': [keepMe] }, callersError: 'corrupt' })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'], impact: impact({ 'src/lib.ts': [{ start: 3, end: 3 }] }) }))

    expect(result).toEqual({ ok: false, stage: 'query', error: 'corrupt' })
  })

  it('omits impact when the input does not ask for it', async () => {
    const { load } = fakeLoader({
      nodes: { 'src/lib.ts': [keepMe] },
      callers: { 'function:keepMe': [{ node: run, edge: { line: 4 } }] },
      preSyncNodes: { 'src/lib.ts': [keepMe] },
    })

    const result = await runCodeGraphSnapshot(load, input({ files: ['src/lib.ts'] }))

    expect(result.ok && 'impact' in result).toBe(false)
  })
})

describe('parseCodeGraphRunnerResult', () => {
  it('reads the last non-empty line', () => {
    const result = { ok: true, index: 'synced', files: [{ path: 'a.ts', symbols: [], dependents: [] }], affectedTests: [] }
    expect(parseCodeGraphRunnerResult(`warning: noise\n${JSON.stringify(result)}\n\n`)).toEqual(result)
    for (const stage of ['load', 'locked', 'index', 'query', 'deadline']) {
      expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: false, stage, error: 'x' }))).toEqual({ ok: false, stage, error: 'x' })
    }
  })

  it('rejects empty, non-JSON, and wrongly shaped output', () => {
    expect(parseCodeGraphRunnerResult('')).toBeNull()
    expect(parseCodeGraphRunnerResult('Segmentation fault')).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: true, index: 'synced', files: [{ path: 'a.ts' }], affectedTests: [] }))).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: true, index: 'synced', files: [], affectedTests: [1] }))).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: true, index: 'other', files: [], affectedTests: [] }))).toBeNull()
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ok: false, stage: 'sync', error: 'x' }))).toBeNull()
  })

  it('accepts a valid impact report, rejects a malformed one, and accepts its absence', () => {
    const base = { ok: true, index: 'synced', files: [], affectedTests: [] }
    const reference = { name: 'run', kind: 'function', path: 'src/app.ts', line: 4 }
    const impact = {
      changedSymbols: [{ name: 'keepMe', kind: 'function', path: 'src/lib.ts', startLine: 2, callers: [reference], callerCount: 1 }],
      removedSymbols: [{ name: 'removeMe', path: 'src/lib.ts', references: [reference] }],
    }

    expect(parseCodeGraphRunnerResult(JSON.stringify(base))).toEqual(base)
    expect(parseCodeGraphRunnerResult(JSON.stringify({ ...base, impact }))).toEqual({ ...base, impact })

    const malformed = [
      'impact',
      { changedSymbols: impact.changedSymbols },
      { changedSymbols: [], removedSymbols: [{ name: 'removeMe', path: 'src/lib.ts' }] },
      { changedSymbols: [{ ...impact.changedSymbols[0], callerCount: '1' }], removedSymbols: [] },
      { changedSymbols: [{ ...impact.changedSymbols[0], callers: [{ name: 'run', kind: 'function', path: 'src/app.ts' }] }], removedSymbols: [] },
      { changedSymbols: [], removedSymbols: [{ name: 'removeMe', path: 'src/lib.ts', references: [{ ...reference, line: '4' }] }] },
    ]
    for (const value of malformed) {
      expect(parseCodeGraphRunnerResult(JSON.stringify({ ...base, impact: value }))).toBeNull()
    }
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
    mkdirSync(join(libDir, 'dist', 'mcp'), { recursive: true })
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
exports.LockUnavailableError = class LockUnavailableError extends Error {}
exports.CodeGraph = { isInitialized: () => true, open: async () => handle }
`,
    )
    writeFileSync(join(libDir, 'dist', 'search', 'query-utils.js'), `exports.isTestPath = (file) => file.endsWith('.test.ts')\n`)
    writeFileSync(join(libDir, 'dist', 'mcp', 'writer-lock.js'), `exports.tryAcquireWriterLock = () => ({ kind: 'acquired' })\nexports.releaseWriterLock = () => {}\n`)

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

  it('prints a deadline result and exits when the run outlives deadlineMs', () => {
    const libDir = tempDir('forge-codegraph-slow-')
    mkdirSync(join(libDir, 'dist', 'search'), { recursive: true })
    mkdirSync(join(libDir, 'dist', 'mcp'), { recursive: true })
    writeFileSync(
      join(libDir, 'dist', 'index.js'),
      `exports.silentLogger = {}
exports.setLogger = () => {}
exports.LockUnavailableError = class extends Error {}
exports.CodeGraph = { isInitialized: () => true, open: () => new Promise(() => { setInterval(() => {}, 1000) }) }
`,
    )
    writeFileSync(join(libDir, 'dist', 'search', 'query-utils.js'), `exports.isTestPath = () => false\n`)
    writeFileSync(join(libDir, 'dist', 'mcp', 'writer-lock.js'), `exports.tryAcquireWriterLock = () => ({ kind: 'acquired' })\nexports.releaseWriterLock = () => {}\n`)
    const startedAt = Date.now()

    const { run, result } = runScript(process.execPath, input({ libDir, indexDir: join(libDir, 'index'), deadlineMs: 300 }), libDir)

    expect(Date.now() - startedAt).toBeLessThan(20_000)
    expect(run.status).toBe(124)
    expect(result).toEqual({ ok: false, stage: 'deadline', error: 'runner exceeded 300 ms' })
  })

  it('prints a load failure when the library is missing', () => {
    const indexDir = join(tempDir('forge-codegraph-missing-'), 'index')
    const { run, result } = runScript(process.execPath, input({ libDir: '/nonexistent/codegraph/lib', indexDir }), tmpdir())
    expect(run.status).toBe(0)
    expect(result).toMatchObject({ ok: false, stage: 'load' })
    expect(existsSync(join(indexDir, 'rebuild.pid'))).toBe(false)
  })

  /**
   * An extracted published codegraph asset, taken from `FORGE_CODEGRAPH_RELEASE_DIR` when set,
   * e.g. the `codegraph-darwin-arm64.tar.gz` asset of GitHub release v1.6.2, holding `node` and
   * `lib/`. Point it at the published asset, not a local source build: a source build can call
   * itself v1.6.2 while exposing methods the release lacks.
   */
  const localRelease = process.env.FORGE_CODEGRAPH_RELEASE_DIR ?? join(homedir(), '.codegraph', 'versions', 'v1.6.2')
  const hasLocalRelease = existsSync(join(localRelease, 'node')) && existsSync(join(localRelease, 'lib', 'dist', 'index.js'))

  it.skipIf(!hasLocalRelease)('creates, syncs, and leaves locked a real codegraph v1.6.2 index through a .codegraph link without git hooks', () => {
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
    expect(existsSync(join(indexDir, 'rebuild.pid'))).toBe(false)

    const databasePath = join(indexDir, 'codegraph.db')
    const indexedAt = statSync(databasePath).ino
    writeFileSync(join(indexDir, 'codegraph.lock'), String(process.pid))
    writeFileSync(join(project, 'b.ts'), 'import { a } from "./a"\nexport const b = a() + 1\n')
    const locked = runScript(releaseNode, releaseInput, project)
    rmSync(join(indexDir, 'codegraph.lock'))

    expect(locked.result).toMatchObject({ ok: false, stage: 'locked' })
    expect(statSync(databasePath).ino).toBe(indexedAt)
    expect(readdirSync(join(project, '.git', 'hooks')).filter((hook) => !hook.endsWith('.sample'))).toEqual([])
    expect(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: project }).status).not.toBe(0)
  })

  it.skipIf(!hasLocalRelease)('reports changed and removed symbols through a real codegraph v1.6.2 index', () => {
    const project = tempDir('forge-codegraph-impact-')
    const indexDir = join(tempDir('forge-codegraph-impact-cache-'), 'codegraph')
    mkdirSync(join(project, 'src'))
    writeFileSync(
      join(project, 'src', 'lib.ts'),
      'export function removeMe() { return 1 }\nexport function renameMe() { return 2 }\nexport function keepMe() { return 3 }\n',
    )
    writeFileSync(
      join(project, 'src', 'app.ts'),
      'import { keepMe, removeMe, renameMe } from "./lib"\n\nexport function run() {\n  return removeMe() + renameMe() + keepMe()\n}\n',
    )
    expect(spawnSync('git', ['init', '-q'], { cwd: project }).status).toBe(0)
    symlinkSync(indexDir, join(project, '.codegraph'))
    const releaseNode = join(localRelease, 'node')
    const releaseInput = input({ libDir: join(localRelease, 'lib'), projectRoot: project, indexDir, files: ['src/lib.ts'] })

    const first = runScript(releaseNode, releaseInput, project)
    expect(first.run.status).toBe(0)
    expect(first.result).toMatchObject({ ok: true, index: 'created' })
    expect(first.result?.ok === true ? first.result.files[0]?.symbols.map((symbol) => symbol.name) : null).toEqual([
      'removeMe',
      'renameMe',
      'keepMe',
    ])
    expect(first.result?.ok === true ? first.result.impact : null).toBeUndefined()

    writeFileSync(join(project, 'src', 'lib.ts'), 'export function renamedFn() { return 2 }\nexport function keepMe() { return 30 }\n')
    const second = runScript(
      releaseNode,
      { ...releaseInput, impact: { ranges: { 'src/lib.ts': [{ start: 1, end: 2 }] }, callerLimit: 10 } },
      project,
    )

    expect(second.run.status).toBe(0)
    expect(second.result).toMatchObject({ ok: true, index: 'synced' })
    const report = second.result?.ok === true ? second.result.impact : undefined
    expect(report?.changedSymbols.map((symbol) => symbol.name)).toEqual(['renamedFn', 'keepMe'])
    const keep = report?.changedSymbols.find((symbol) => symbol.name === 'keepMe')
    expect(keep).toMatchObject({ kind: 'function', path: 'src/lib.ts', startLine: 2 })
    expect(keep?.callers).toEqual([{ name: 'run', kind: 'function', path: 'src/app.ts', line: 4 }])
    expect(keep?.callerCount).toBe(1)
    expect(report?.removedSymbols.map((symbol) => `${symbol.path}:${symbol.name}`)).toEqual(['src/lib.ts:removeMe', 'src/lib.ts:renameMe'])
    for (const removed of report?.removedSymbols ?? []) {
      expect(removed.references).toContainEqual({ name: 'run', kind: 'function', path: 'src/app.ts', line: 4 })
    }
  })
})
