import { z } from 'zod'

interface CodeGraphNodeRecord {
  id: string
  name: string
  kind: string
  signature?: string
  filePath: string
  startLine: number
  endLine: number
}

interface CodeGraphIndexResult {
  success: boolean
  filesIndexed: number
  errors: unknown[]
}

interface CodeGraphHandle {
  indexAll(): Promise<CodeGraphIndexResult>
  sync(): Promise<void>
  getNodesInFile(filePath: string): CodeGraphNodeRecord[]
  getFileDependents(filePath: string): string[]
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: CodeGraphNodeRecord; edge: { line?: number } }>
  getNode(id: string): CodeGraphNodeRecord | null
  getUnresolvedNamesAmong(names: Iterable<string>): Set<string>
  getFiles(): Array<{ path: string }>
  getUnresolvedReferencesInFile(filePath: string): Array<{ fromNodeId: string; referenceName: string; referenceKind: string; line: number }>
  destroy(): void
}

interface CodeGraphLoggerSink {
  log(message: string): void
}

interface CodeGraphLibrary {
  CodeGraph: {
    isInitialized(projectRoot: string): boolean
    init(projectRoot: string, options?: { index?: boolean }): Promise<CodeGraphHandle>
    open(projectRoot: string, options?: { readOnly?: boolean }): Promise<CodeGraphHandle>
    recreate(projectRoot: string): Promise<CodeGraphHandle>
  }
  LockUnavailableError: abstract new (...args: never[]) => Error
  setLogger(logger: CodeGraphLoggerSink): void
  silentLogger: CodeGraphLoggerSink
}

interface CodeGraphWriterLock {
  tryAcquireWriterLock(projectRoot: string, mode: string, lockName: 'rebuild.pid'): { kind: 'acquired' | 'taken' }
  releaseWriterLock(projectRoot: string, lockName: 'rebuild.pid'): void
}

interface FileSystem {
  mkdirSync(path: string, options: { recursive: true }): void
}

interface CodeGraphQueryUtils {
  isTestPath(filePath: string): boolean
}

export interface CodeGraphModuleLoader {
  (path: string): CodeGraphLibrary & CodeGraphQueryUtils & CodeGraphWriterLock & FileSystem
}

export interface CodeGraphRunnerInput {
  libDir: string
  projectRoot: string
  indexDir: string
  files: string[]
  maxDepth: number
  deadlineMs: number
  impact?: CodeGraphImpactInput
}

export interface CodeGraphLineRange {
  start: number
  end: number
}

export interface CodeGraphImpactInput {
  ranges: Record<string, CodeGraphLineRange[]>
  callerLimit: number
}

export interface CodeGraphReference {
  name: string
  kind: string
  path: string
  line: number
}

export interface CodeGraphChangedSymbol {
  name: string
  kind: string
  path: string
  startLine: number
  callers: CodeGraphReference[]
  callerCount: number
  callerQueryLimit: number
}

export interface CodeGraphRemovedSymbol {
  name: string
  path: string
  references: CodeGraphReference[]
}

export interface CodeGraphImpactReport {
  changedSymbols: CodeGraphChangedSymbol[]
  removedSymbols: CodeGraphRemovedSymbol[]
}

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
  dependents: string[]
}

const CODE_GRAPH_RUNNER_STAGES = ['load', 'locked', 'index', 'query', 'deadline'] as const

export type CodeGraphRunnerStage = (typeof CODE_GRAPH_RUNNER_STAGES)[number]

export type CodeGraphRunnerResult =
  | {
      ok: true
      index: CodeGraphIndexAction
      files: CodeGraphFileReport[]
      affectedTests: string[]
      impact?: CodeGraphImpactReport
    }
  | { ok: false; stage: CodeGraphRunnerStage; error: string }

export async function runCodeGraphSnapshot(
  load: CodeGraphModuleLoader,
  input: CodeGraphRunnerInput,
): Promise<CodeGraphRunnerResult> {
  const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
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
  const memberKinds = new Set(['method', 'property', 'field', 'parameter', 'enum_member'])
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
  const trackedSymbolNames = (handle: CodeGraphHandle, filePath: string): string[] =>
    visibleSymbols(handle, filePath)
      .filter((node) => !memberKinds.has(node.kind))
      .map((node) => node.name)

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
        const rawCallers = handle.getCallers(node.id)
        for (const caller of rawCallers) {
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
          callerQueryLimit: rawCallers.length,
        })
      }
    }
    changedSymbols.sort((a, b) => (a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1))

    const removedSymbols: CodeGraphRemovedSymbol[] = []
    if (previous) {
      const vanished = new Map<string, string[]>()
      const vanishedNames = new Set<string>()
      for (const [path, names] of previous) {
        const current = new Set(trackedSymbolNames(handle, path))
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
    lib = load(`${input.libDir}/dist/index.js`)
    queryUtils = load(`${input.libDir}/dist/search/query-utils.js`)
    writerLock = load(`${input.libDir}/dist/mcp/writer-lock.js`)
    lib.setLogger(lib.silentLogger)
    load('fs').mkdirSync(input.indexDir, { recursive: true })
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
  let baseline: Map<string, string[]> | null = null
  let baselineError: unknown
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
            previous.set(path, trackedSymbolNames(openedIndex, path))
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

const codeGraphReferenceSchema = z.looseObject({
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  line: z.number(),
})

const codeGraphSymbolSchema = z.looseObject({
  name: z.string(),
  kind: z.string(),
  signature: z.string().nullable(),
  startLine: z.number(),
})

const codeGraphFileReportSchema = z.looseObject({
  path: z.string(),
  symbols: z.array(codeGraphSymbolSchema),
  dependents: z.array(z.string()),
})

const codeGraphChangedSymbolSchema = z.looseObject({
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  startLine: z.number(),
  callers: z.array(codeGraphReferenceSchema),
  callerCount: z.number(),
  callerQueryLimit: z.number(),
})

const codeGraphRemovedSymbolSchema = z.looseObject({
  name: z.string(),
  path: z.string(),
  references: z.array(codeGraphReferenceSchema),
})

const codeGraphImpactReportSchema = z.looseObject({
  changedSymbols: z.array(codeGraphChangedSymbolSchema),
  removedSymbols: z.array(codeGraphRemovedSymbolSchema),
})

const codeGraphRunnerResultSchema = z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    index: z.enum(['created', 'synced', 'rebuilt']),
    files: z.array(codeGraphFileReportSchema),
    affectedTests: z.array(z.string()),
    impact: codeGraphImpactReportSchema.optional(),
  }),
  z.looseObject({
    ok: z.literal(false),
    stage: z.enum(CODE_GRAPH_RUNNER_STAGES),
    error: z.string(),
  }),
])

export function parseCodeGraphRunnerResult(stdout: string): CodeGraphRunnerResult | null {
  const line = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1)
  if (!line) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = codeGraphRunnerResultSchema.safeParse(decoded)
  return parsed.success ? parsed.data : null
}
