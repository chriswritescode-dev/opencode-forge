/**
 * The in-sandbox half of a code-graph snapshot. `runCodeGraphSnapshot` is serialized with
 * `Function.prototype.toString()` and executed by codegraph's bundled Node inside the loop
 * sandbox, where the index lives, so it must stay self-contained: it may reference only its
 * parameters and globals, never another module-level binding. Its result is the typed contract
 * Forge parses back on the host with `parseCodeGraphRunnerResult`.
 *
 * The library surface below is the subset of `@colbymchenry/codegraph` v1.6.2 (the exact
 * version pinned in `container/Dockerfile`) this runner calls. It must exist in the published
 * release asset the image installs: source builds that also call themselves 1.6.2 add methods,
 * such as `getUnresolvedReferenceSourcesNamed`, that the release lacks.
 */

/** A codegraph index node, as returned by `CodeGraph.getNodesInFile` and `getNode`. */
interface CodeGraphNodeRecord {
  id: string
  name: string
  kind: string
  signature?: string
  filePath: string
  startLine: number
  endLine: number
}

/** `CodeGraph.indexAll` result fields this runner reads. */
interface CodeGraphIndexResult {
  success: boolean
  filesIndexed: number
  errors: unknown[]
}

/** An open codegraph index. */
interface CodeGraphHandle {
  indexAll(): Promise<CodeGraphIndexResult>
  sync(): Promise<unknown>
  getNodesInFile(filePath: string): CodeGraphNodeRecord[]
  getFileDependents(filePath: string): string[]
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: CodeGraphNodeRecord; edge: { line?: number } }>
  getNode(id: string): CodeGraphNodeRecord | null
  /** Which of `names` the index holds an unresolved reference to. */
  getUnresolvedNamesAmong(names: Iterable<string>): Set<string>
  getFiles(): Array<{ path: string }>
  /** References from a file's symbols that never resolved to an indexed node, in line order. */
  getUnresolvedReferencesInFile(filePath: string): Array<{ fromNodeId: string; referenceName: string; referenceKind: string; line: number }>
  destroy(): void
}

/** `lib/dist/index.js` of the codegraph release. */
interface CodeGraphLibrary {
  CodeGraph: {
    isInitialized(projectRoot: string): boolean
    init(projectRoot: string, options?: { index?: boolean }): Promise<CodeGraphHandle>
    open(projectRoot: string, options?: { readOnly?: boolean }): Promise<CodeGraphHandle>
    recreate(projectRoot: string): Promise<CodeGraphHandle>
  }
  /** Thrown by `sync`/`indexAll` when another live process holds the index's `codegraph.lock`. */
  LockUnavailableError: abstract new (...args: never[]) => Error
  setLogger(logger: unknown): void
  silentLogger: unknown
}

/**
 * `lib/dist/mcp/writer-lock.js` of the codegraph release: the `rebuild.pid` lock `codegraph index`
 * takes, which the CLI's read commands check to warn about a half-built index.
 */
interface CodeGraphWriterLock {
  tryAcquireWriterLock(projectRoot: string, mode: string, lockName: 'rebuild.pid'): { kind: 'acquired' | 'taken' }
  releaseWriterLock(projectRoot: string, lockName: 'rebuild.pid'): void
}

/** Node's `fs`, as far as this runner uses it. */
interface FileSystem {
  mkdirSync(path: string, options: { recursive: true }): unknown
}

/** `lib/dist/search/query-utils.js` of the codegraph release. */
interface CodeGraphQueryUtils {
  isTestPath(filePath: string): boolean
}

/** Input of one snapshot run. */
export interface CodeGraphRunnerInput {
  /** The release's `lib` directory, e.g. `/opt/codegraph/lib`. */
  libDir: string
  projectRoot: string
  /** Directory the project's `.codegraph` link points at; created when missing. */
  indexDir: string
  /** Repo-relative files to report on. */
  files: string[]
  /** Maximum reverse-dependency depth when collecting affected tests. */
  maxDepth: number
  /**
   * The runner prints a `deadline` result and exits after this many milliseconds, so it never
   * outlives the host's exec timeout inside the sandbox even if killing the host-side exec does
   * not reach it.
   */
  deadlineMs: number
  /**
   * Audit checkpoints only: also report the callers of changed symbols and the code that still
   * refers to symbols the change removed or renamed. Absent at section start, where no code has
   * changed yet.
   */
  impact?: CodeGraphImpactInput
}

/** A changed line range on the new side of a diff, 1-based and inclusive. */
export interface CodeGraphLineRange {
  start: number
  end: number
}

export interface CodeGraphImpactInput {
  /** New-side changed line ranges per repo-relative file in `files`. */
  ranges: Record<string, CodeGraphLineRange[]>
  /** Callers listed per changed symbol; the rest are only counted. */
  callerLimit: number
}

/** One place in the code that refers to a symbol: the referring symbol and the line of the reference. */
export interface CodeGraphReference {
  name: string
  kind: string
  path: string
  line: number
}

/** A symbol whose definition overlaps a changed range, with its callers outside the changed files. */
export interface CodeGraphChangedSymbol {
  name: string
  kind: string
  path: string
  startLine: number
  /** At most `callerLimit` callers, sorted by path and line. */
  callers: CodeGraphReference[]
  /** All callers outside the changed files, including those beyond `callerLimit`. */
  callerCount: number
}

/** A symbol present in a changed file before the run's sync and gone after it, still referenced elsewhere. */
export interface CodeGraphRemovedSymbol {
  name: string
  /** The file the symbol was defined in before the change. */
  path: string
  /** Unresolved references to the name, sorted by path and line. */
  references: CodeGraphReference[]
}

export interface CodeGraphImpactReport {
  changedSymbols: CodeGraphChangedSymbol[]
  /** Only removed or renamed symbols that still have references. */
  removedSymbols: CodeGraphRemovedSymbol[]
}

/** How the run brought the index up to date before querying it. */
export type CodeGraphIndexAction = 'created' | 'synced' | 'rebuilt'

export interface CodeGraphSymbol {
  name: string
  kind: string
  signature: string | null
  startLine: number
}

export interface CodeGraphFileReport {
  path: string
  symbols: CodeGraphSymbol[]
  /** Files that import this one, directly. */
  dependents: string[]
}

/**
 * Where a run failed. `locked`: another live process holds the index (`codegraph.lock` or
 * `rebuild.pid`), so the run left it untouched. `deadline`: the run hit `deadlineMs`.
 */
export type CodeGraphRunnerStage = 'load' | 'locked' | 'index' | 'query' | 'deadline'

const CODE_GRAPH_RUNNER_STAGES: readonly CodeGraphRunnerStage[] = ['load', 'locked', 'index', 'query', 'deadline']

export type CodeGraphRunnerResult =
  | {
      ok: true
      index: CodeGraphIndexAction
      files: CodeGraphFileReport[]
      affectedTests: string[]
      /** Present exactly when the input asked for `impact`. */
      impact?: CodeGraphImpactReport
    }
  | { ok: false; stage: CodeGraphRunnerStage; error: string }

/**
 * Brings the index up to date and collects each file's symbols, direct dependents, and the test
 * files reachable through reverse imports (the same walk as `codegraph affected`: a changed test
 * file counts itself, and the walk stops at test files and at `maxDepth`). With `impact`, it also
 * reports the symbols overlapping the changed ranges with their callers, and the symbols the
 * change removed or renamed that still have references.
 *
 * A missing index is created with a full index; an existing one is synced, and a failed sync is
 * replaced by a full rebuild. Creating and rebuilding hold `rebuild.pid`, like `codegraph index`.
 * When another live process holds the index (a sync refused with `LockUnavailableError`, or
 * `rebuild.pid` taken), the run reports `locked` and leaves the index alone instead of deleting
 * an index that process still uses. The library never installs git hooks or writes a
 * `.gitignore` on this path, unlike the `codegraph init` command. Never throws: every failure is
 * reported with the stage it happened in.
 */
export async function runCodeGraphSnapshot(
  load: (path: string) => unknown,
  input: CodeGraphRunnerInput,
): Promise<CodeGraphRunnerResult> {
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  const close = (handle: CodeGraphHandle): void => {
    try {
      handle.destroy()
    } catch {
      return
    }
  }
  const fullIndex = async (handle: CodeGraphHandle): Promise<void> => {
    const result = await handle.indexAll()
    if (!result.success) {
      throw new Error(`full index failed after ${result.filesIndexed} files with ${result.errors.length} errors`)
    }
  }
  const hiddenKinds = new Set(['file', 'import'])
  const unresolvedReferenceKinds = [
    'calls',
    'imports',
    'references',
    'extends',
    'implements',
    'instantiates',
    'type_of',
    'returns',
  ]
  const byPathThenLine = (a: CodeGraphReference, b: CodeGraphReference): number =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1
  const visibleSymbols = (handle: CodeGraphHandle, filePath: string): CodeGraphNodeRecord[] =>
    handle.getNodesInFile(filePath).filter((node) => !hiddenKinds.has(node.kind))

  const collectImpact = (
    handle: CodeGraphHandle,
    request: CodeGraphImpactInput,
    changedFiles: string[],
    previous: Map<string, string[]> | null,
  ): CodeGraphImpactReport => {
    const changed = new Set(changedFiles)
    const changedSymbols: CodeGraphChangedSymbol[] = []
    for (const [path, ranges] of Object.entries(request.ranges)) {
      for (const node of visibleSymbols(handle, path)) {
        if (!ranges.some((range) => node.startLine <= range.end && node.endLine >= range.start)) continue
        const seen = new Set([node.id])
        const callers: CodeGraphReference[] = []
        for (const caller of handle.getCallers(node.id)) {
          if (!caller.node || hiddenKinds.has(caller.node.kind) || changed.has(caller.node.filePath) || seen.has(caller.node.id)) continue
          seen.add(caller.node.id)
          callers.push({
            name: caller.node.name,
            kind: caller.node.kind,
            path: caller.node.filePath,
            line: caller.edge?.line ?? caller.node.startLine,
          })
        }
        callers.sort(byPathThenLine)
        changedSymbols.push({
          name: node.name,
          kind: node.kind,
          path,
          startLine: node.startLine,
          callers: callers.slice(0, request.callerLimit),
          callerCount: callers.length,
        })
      }
    }
    changedSymbols.sort((a, b) => (a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1))

    const removedSymbols: CodeGraphRemovedSymbol[] = []
    if (previous) {
      const vanished = new Map<string, string[]>()
      const vanishedNames = new Set<string>()
      for (const [path, names] of previous) {
        const current = new Set(visibleSymbols(handle, path).map((node) => node.name))
        const gone = names.filter((name) => !current.has(name))
        if (gone.length === 0) continue
        vanished.set(path, gone)
        for (const name of gone) vanishedNames.add(name)
      }
      const stillReferenced = vanishedNames.size === 0 ? new Set<string>() : handle.getUnresolvedNamesAmong(vanishedNames)
      const referencesByName = new Map<string, CodeGraphReference[]>()
      if (stillReferenced.size > 0) {
        const kinds = new Set(unresolvedReferenceKinds)
        const seen = new Set<string>()
        for (const file of handle.getFiles()) {
          for (const reference of handle.getUnresolvedReferencesInFile(file.path)) {
            if (!stillReferenced.has(reference.referenceName) || !kinds.has(reference.referenceKind)) continue
            const source = handle.getNode(reference.fromNodeId)
            if (!source) continue
            const key = JSON.stringify([reference.referenceName, source.name, source.kind, source.filePath, reference.line])
            if (seen.has(key)) continue
            seen.add(key)
            const list = referencesByName.get(reference.referenceName) ?? []
            list.push({ name: source.name, kind: source.kind, path: source.filePath, line: reference.line })
            referencesByName.set(reference.referenceName, list)
          }
        }
      }
      const vanishedPaths = [...vanished.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      for (const [path, names] of vanishedPaths) {
        for (const name of [...names].sort()) {
          const references = referencesByName.get(name)
          if (!references || references.length === 0) continue
          removedSymbols.push({ name, path, references: [...references].sort(byPathThenLine) })
        }
      }
    }
    return { changedSymbols, removedSymbols }
  }

  let lib: CodeGraphLibrary
  let queryUtils: CodeGraphQueryUtils
  let writerLock: CodeGraphWriterLock
  try {
    lib = load(`${input.libDir}/dist/index.js`) as CodeGraphLibrary
    queryUtils = load(`${input.libDir}/dist/search/query-utils.js`) as CodeGraphQueryUtils
    writerLock = load(`${input.libDir}/dist/mcp/writer-lock.js`) as CodeGraphWriterLock
    lib.setLogger(lib.silentLogger)
    ;(load('fs') as FileSystem).mkdirSync(input.indexDir, { recursive: true })
  } catch (err) {
    return { ok: false, stage: 'load', error: message(err) }
  }

  const rebuildBusy: CodeGraphRunnerResult = {
    ok: false,
    stage: 'locked',
    error: 'another process is rebuilding this index (rebuild.pid is held)',
  }
  let holdsRebuildLock = false
  const acquireRebuildLock = (): boolean => {
    holdsRebuildLock = writerLock.tryAcquireWriterLock(input.projectRoot, 'forge-snapshot', 'rebuild.pid').kind === 'acquired'
    return holdsRebuildLock
  }

  let graph: CodeGraphHandle | null = null
  let index: CodeGraphIndexAction
  /** Symbol names each impact file had before this run's sync; null when there was no index to read. */
  let baseline: Map<string, string[]> | null = null
  /** A baseline read failure is reported with the other impact queries, after the index is up to date. */
  let baselineError: unknown = null
  try {
    if (!lib.CodeGraph.isInitialized(input.projectRoot)) {
      if (!acquireRebuildLock()) return rebuildBusy
      graph = await lib.CodeGraph.init(input.projectRoot, { index: false })
      await fullIndex(graph)
      index = 'created'
    } else {
      const openedIndex = await lib.CodeGraph.open(input.projectRoot)
      graph = openedIndex
      if (input.impact) {
        try {
          const previous = new Map<string, string[]>()
          for (const path of Object.keys(input.impact.ranges)) {
            previous.set(path, visibleSymbols(openedIndex, path).map((node) => node.name))
          }
          baseline = previous
        } catch (err) {
          baselineError = err
        }
      }
      try {
        await openedIndex.sync()
        index = 'synced'
      } catch (syncError) {
        close(graph)
        graph = null
        if (syncError instanceof lib.LockUnavailableError) {
          return { ok: false, stage: 'locked', error: message(syncError) }
        }
        if (!acquireRebuildLock()) return rebuildBusy
        graph = await lib.CodeGraph.recreate(input.projectRoot)
        try {
          await fullIndex(graph)
        } catch (rebuildError) {
          throw new Error(`sync failed (${message(syncError)}); rebuild failed (${message(rebuildError)})`, { cause: rebuildError })
        }
        index = 'rebuilt'
      }
    }
  } catch (err) {
    if (graph) close(graph)
    return { ok: false, stage: err instanceof lib.LockUnavailableError ? 'locked' : 'index', error: message(err) }
  } finally {
    if (holdsRebuildLock) writerLock.releaseWriterLock(input.projectRoot, 'rebuild.pid')
  }

  const opened = graph
  try {
    if (baselineError) throw baselineError
    const files: CodeGraphFileReport[] = input.files.map((path) => ({
      path,
      symbols: visibleSymbols(opened, path).map((node) => ({
        name: node.name,
        kind: node.kind,
        signature: node.signature ?? null,
        startLine: node.startLine,
      })),
      dependents: [...opened.getFileDependents(path)].sort(),
    }))

    const affected = new Set<string>()
    for (const file of input.files) {
      if (queryUtils.isTestPath(file)) {
        affected.add(file)
        continue
      }
      const visited = new Set([file])
      const queue = [{ file, depth: 0 }]
      while (queue.length > 0) {
        const current = queue.shift()!
        if (current.depth >= input.maxDepth) continue
        for (const dependent of opened.getFileDependents(current.file)) {
          if (visited.has(dependent)) continue
          visited.add(dependent)
          if (queryUtils.isTestPath(dependent)) affected.add(dependent)
          else queue.push({ file: dependent, depth: current.depth + 1 })
        }
      }
    }
    const impact = input.impact ? collectImpact(opened, input.impact, input.files, baseline) : undefined
    const affectedTests = [...affected].sort()
    return impact
      ? { ok: true, index, files, affectedTests, impact }
      : { ok: true, index, files, affectedTests }
  } catch (err) {
    return { ok: false, stage: 'query', error: message(err) }
  } finally {
    close(opened)
  }
}

/**
 * The `node -e` program that runs `runCodeGraphSnapshot` with the JSON input passed as the first
 * argument, prints the result as the last line of stdout, and exits once it is flushed (the
 * library can leave worker handles open). At `deadlineMs` it prints a `deadline` result and
 * exits instead; codegraph's locks record the pid, so a lock left behind is cleared as stale.
 */
export function buildCodeGraphRunnerScript(): string {
  return [
    'const input = JSON.parse(process.argv[1]);',
    'const finish = (result, code) => process.stdout.write("\\n" + JSON.stringify(result) + "\\n", () => process.exit(code));',
    'setTimeout(() => finish({ ok: false, stage: "deadline", error: "runner exceeded " + input.deadlineMs + " ms" }, 124), input.deadlineMs).unref();',
    `(${runCodeGraphSnapshot.toString()})(require, input)`,
    '.then((result) => finish(result, 0))',
    '.catch((err) => finish({ ok: false, stage: "load", error: String(err) }, 1));',
  ].join('\n')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isSymbol(value: unknown): value is CodeGraphSymbol {
  if (!value || typeof value !== 'object') return false
  const symbol = value as Record<string, unknown>
  return (
    typeof symbol.name === 'string' &&
    typeof symbol.kind === 'string' &&
    (symbol.signature === null || typeof symbol.signature === 'string') &&
    typeof symbol.startLine === 'number'
  )
}

function isFileReport(value: unknown): value is CodeGraphFileReport {
  if (!value || typeof value !== 'object') return false
  const file = value as Record<string, unknown>
  return typeof file.path === 'string' && Array.isArray(file.symbols) && file.symbols.every(isSymbol) && isStringArray(file.dependents)
}

function isReference(value: unknown): value is CodeGraphReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Record<string, unknown>
  return (
    typeof reference.name === 'string' &&
    typeof reference.kind === 'string' &&
    typeof reference.path === 'string' &&
    typeof reference.line === 'number'
  )
}

function isChangedSymbol(value: unknown): value is CodeGraphChangedSymbol {
  if (!value || typeof value !== 'object') return false
  const symbol = value as Record<string, unknown>
  return (
    typeof symbol.name === 'string' &&
    typeof symbol.kind === 'string' &&
    typeof symbol.path === 'string' &&
    typeof symbol.startLine === 'number' &&
    typeof symbol.callerCount === 'number' &&
    Array.isArray(symbol.callers) &&
    symbol.callers.every(isReference)
  )
}

function isRemovedSymbol(value: unknown): value is CodeGraphRemovedSymbol {
  if (!value || typeof value !== 'object') return false
  const symbol = value as Record<string, unknown>
  return (
    typeof symbol.name === 'string' &&
    typeof symbol.path === 'string' &&
    Array.isArray(symbol.references) &&
    symbol.references.every(isReference)
  )
}

function isImpactReport(value: unknown): value is CodeGraphImpactReport {
  if (!value || typeof value !== 'object') return false
  const report = value as Record<string, unknown>
  return (
    Array.isArray(report.changedSymbols) &&
    report.changedSymbols.every(isChangedSymbol) &&
    Array.isArray(report.removedSymbols) &&
    report.removedSymbols.every(isRemovedSymbol)
  )
}

/**
 * Parses the runner's stdout: the last non-empty line must be a result matching
 * `CodeGraphRunnerResult`. Anything else (no output, a crash trace, a shape from another
 * version) returns null.
 */
export function parseCodeGraphRunnerResult(stdout: string): CodeGraphRunnerResult | null {
  const line = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1)
  if (!line) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const result = parsed as Record<string, unknown>
  if (result.ok === true) {
    if (result.index !== 'created' && result.index !== 'synced' && result.index !== 'rebuilt') return null
    if (!Array.isArray(result.files) || !result.files.every(isFileReport) || !isStringArray(result.affectedTests)) return null
    if (result.impact === undefined) {
      return { ok: true, index: result.index, files: result.files, affectedTests: result.affectedTests }
    }
    if (!isImpactReport(result.impact)) return null
    return { ok: true, index: result.index, files: result.files, affectedTests: result.affectedTests, impact: result.impact }
  }
  const stage = CODE_GRAPH_RUNNER_STAGES.find((candidate) => candidate === result.stage)
  if (result.ok === false && stage && typeof result.error === 'string') {
    return { ok: false, stage, error: result.error }
  }
  return null
}
