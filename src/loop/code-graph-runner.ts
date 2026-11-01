/**
 * The in-sandbox half of a code-graph snapshot. `runCodeGraphSnapshot` is serialized with
 * `Function.prototype.toString()` and executed by codegraph's bundled Node inside the loop
 * sandbox, where the index lives, so it must stay self-contained: it may reference only its
 * parameters and globals, never another module-level binding. Its result is the typed contract
 * Forge parses back on the host with `parseCodeGraphRunnerResult`.
 *
 * The library surface below is the subset of `@colbymchenry/codegraph` v1.6.2 (the exact
 * version pinned in `container/Dockerfile`) this runner calls.
 */

/** A codegraph index node, as returned by `CodeGraph.getNodesInFile`. */
interface CodeGraphNodeRecord {
  name: string
  kind: string
  signature?: string
  startLine: number
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
  setLogger(logger: unknown): void
  silentLogger: unknown
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

export type CodeGraphRunnerStage = 'load' | 'index' | 'query'

export type CodeGraphRunnerResult =
  | { ok: true; index: CodeGraphIndexAction; files: CodeGraphFileReport[]; affectedTests: string[] }
  | { ok: false; stage: CodeGraphRunnerStage; error: string }

/**
 * Brings the index up to date and collects each file's symbols, direct dependents, and the test
 * files reachable through reverse imports (the same walk as `codegraph affected`: a changed test
 * file counts itself, and the walk stops at test files and at `maxDepth`).
 *
 * A missing index is created with a full index; an existing one is synced, and a failed sync is
 * replaced by a full rebuild. The library never installs git hooks or writes a `.gitignore` on
 * this path, unlike the `codegraph init` command. Never throws: every failure is reported with the
 * stage it happened in.
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

  let lib: CodeGraphLibrary
  let queryUtils: CodeGraphQueryUtils
  try {
    lib = load(`${input.libDir}/dist/index.js`) as CodeGraphLibrary
    queryUtils = load(`${input.libDir}/dist/search/query-utils.js`) as CodeGraphQueryUtils
    lib.setLogger(lib.silentLogger)
    ;(load('fs') as FileSystem).mkdirSync(input.indexDir, { recursive: true })
  } catch (err) {
    return { ok: false, stage: 'load', error: message(err) }
  }

  let graph: CodeGraphHandle | null = null
  let index: CodeGraphIndexAction
  try {
    if (!lib.CodeGraph.isInitialized(input.projectRoot)) {
      graph = await lib.CodeGraph.init(input.projectRoot, { index: false })
      await fullIndex(graph)
      index = 'created'
    } else {
      graph = await lib.CodeGraph.open(input.projectRoot)
      try {
        await graph.sync()
        index = 'synced'
      } catch (syncError) {
        close(graph)
        graph = null
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
    return { ok: false, stage: 'index', error: message(err) }
  }

  const opened = graph
  try {
    const hiddenKinds = new Set(['file', 'import'])
    const files: CodeGraphFileReport[] = input.files.map((path) => ({
      path,
      symbols: opened
        .getNodesInFile(path)
        .filter((node) => !hiddenKinds.has(node.kind))
        .map((node) => ({ name: node.name, kind: node.kind, signature: node.signature ?? null, startLine: node.startLine })),
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
    return { ok: true, index, files, affectedTests: [...affected].sort() }
  } catch (err) {
    return { ok: false, stage: 'query', error: message(err) }
  } finally {
    close(opened)
  }
}

/**
 * The `node -e` program that runs `runCodeGraphSnapshot` with the JSON input passed as the first
 * argument and prints the result as the last line of stdout.
 */
export function buildCodeGraphRunnerScript(): string {
  return [
    `(${runCodeGraphSnapshot.toString()})(require, JSON.parse(process.argv[1]))`,
    `.then((result) => process.stdout.write('\\n' + JSON.stringify(result) + '\\n'))`,
    `.catch((err) => process.stdout.write('\\n' + JSON.stringify({ ok: false, stage: 'load', error: String(err) }) + '\\n'))`,
  ].join('')
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
    return { ok: true, index: result.index, files: result.files, affectedTests: result.affectedTests }
  }
  if (
    result.ok === false &&
    (result.stage === 'load' || result.stage === 'index' || result.stage === 'query') &&
    typeof result.error === 'string'
  ) {
    return { ok: false, stage: result.stage, error: result.error }
  }
  return null
}
