import { GraphClient } from './client'
import { initializeGraphDatabase, closeGraphDatabase } from './database'
import { join, relative } from 'path'
import { createHash } from 'crypto'
import { watch } from 'fs'
import type { Logger } from '../types'
import type {
  GraphStats,
  TopFileResult,
  FileDepResult,
  FileCoChangeResult,
  FileSymbolResult,
  SymbolSearchResult,
  SymbolSignatureResult,
  CallerResult,
  CalleeResult,
  UnusedExportResult,
  DuplicateStructureResult,
  NearDuplicateResult,
  ExternalPackageResult,
} from './types'
import { INDEXABLE_EXTENSIONS } from './constants'
import { IGNORED_DIRS, IGNORED_EXTS } from './utils'
import type { GraphState, GraphStatsPayload } from '../utils/graph-status-store'

export interface GraphService {
  readonly ready: boolean
  scan(): Promise<void>
  close(): Promise<void>
  getStats(): Promise<GraphStats>
  getTopFiles(limit?: number): Promise<TopFileResult[]>
  getFileDependents(relPath: string): Promise<FileDepResult[]>
  getFileDependencies(relPath: string): Promise<FileDepResult[]>
  getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]>
  getFileBlastRadius(relPath: string): Promise<number>
  getFileSymbols(relPath: string): Promise<FileSymbolResult[]>
  findSymbols(name: string, limit?: number): Promise<SymbolSearchResult[]>
  searchSymbolsFts(query: string, limit?: number): Promise<SymbolSearchResult[]>
  getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null>
  getCallers(path: string, line: number): Promise<CallerResult[]>
  getCallees(path: string, line: number): Promise<CalleeResult[]>
  getUnusedExports(limit?: number): Promise<UnusedExportResult[]>
  getDuplicateStructures(limit?: number): Promise<DuplicateStructureResult[]>
  getNearDuplicates(threshold?: number, limit?: number): Promise<NearDuplicateResult[]>
  getExternalPackages(limit?: number): Promise<ExternalPackageResult[]>
  render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }>
  onFileChanged(absPath: string): void
}

export type GraphStatusCallback = (state: GraphState, stats?: GraphStatsPayload, message?: string) => void

interface GraphServiceConfig {
  projectId: string
  dataDir: string
  cwd: string
  logger: Logger
  watch?: boolean
  debounceMs?: number
  maxFiles?: number
  onStatusChange?: GraphStatusCallback
}

interface PendingChange {
  absPath: string
  relPath: string
  timestamp: number
}

const DEFAULT_DEBOUNCE_MS = 500

export function createGraphService(config: GraphServiceConfig): GraphService {
  const { projectId, dataDir, cwd, logger, watch: watchEnabled, debounceMs, maxFiles, onStatusChange } = config
  const client = new GraphClient()
  let dbPath: string | null = null
  let initialized = false
  let watcher: ReturnType<typeof watch> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const pendingQueue = new Map<string, PendingChange>()
  let isFlushing = false
  let watcherInitialized = false

  const effectiveDebounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS

  function emitStatus(state: GraphState, stats?: GraphStatsPayload, message?: string): void {
    if (onStatusChange) {
      onStatusChange(state, stats, message)
    }
  }

  function shouldIndexPath(absPath: string, relPath: string): boolean {
    // Check if path is within project root
    if (!absPath.startsWith(cwd)) {
      return false
    }

    // Check ignored directories
    const parts = relPath.split('/')
    if (parts.some(part => IGNORED_DIRS.has(part))) {
      return false
    }

    // Check extension
    const ext = '.' + relPath.split('.').pop()?.toLowerCase()
    if (ext && IGNORED_EXTS.has(ext)) {
      return false
    }

    // Check if extension is indexable
    if (ext && !(ext in INDEXABLE_EXTENSIONS)) {
      return false
    }

    return true
  }

  function normalizePath(absPath: string): { absPath: string; relPath: string } | null {
    const relPath = relative(cwd, absPath)
    if (!shouldIndexPath(absPath, relPath)) {
      return null
    }
    return { absPath, relPath }
  }

  let workerHealthy = true

  async function flushQueue(): Promise<void> {
    if (isFlushing || pendingQueue.size === 0 || !workerHealthy) {
      if (!workerHealthy && pendingQueue.size > 0) {
        logger.debug('Graph flush skipped - worker unhealthy')
        pendingQueue.clear()
      }
      return
    }

    isFlushing = true
    const pathsToFlush = new Map(pendingQueue)
    pendingQueue.clear()

    try {
      for (const change of pathsToFlush.values()) {
        try {
          await client.onFileChanged(change.absPath)
          logger.debug(`Graph flushed: ${change.relPath}`)
        } catch (err) {
          logger.error(`Failed to update graph for ${change.relPath}`, err)
          workerHealthy = false
          client.markWorkerDead(err instanceof Error ? err : new Error(String(err)))
          pendingQueue.clear()
          // Persist error status to KV so TUI can display degraded state
          const errorMessage = err instanceof Error ? err.message : String(err)
          emitStatus('error', undefined, `Worker flush failed: ${errorMessage}`)
          break
        }
      }

      if (workerHealthy && initialized) {
        const stats = await client.getStats()
        emitStatus('ready', {
          files: stats.files,
          symbols: stats.symbols,
          edges: stats.edges,
          calls: stats.calls,
        })
      }
    } finally {
      isFlushing = false
      
      // Check if new changes arrived during flush
      if (pendingQueue.size > 0 && workerHealthy) {
        scheduleFlush()
      }
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
    }
    flushTimer = setTimeout(() => {
      flushQueue().catch((err) => {
        logger.error('Graph flush failed', err)
      })
    }, effectiveDebounceMs)
  }

  function enqueueChange(absPath: string): void {
    const normalized = normalizePath(absPath)
    if (!normalized) {
      logger.debug(`Graph watcher: ignoring non-indexable path ${absPath}`)
      return
    }

    const { absPath: normalizedAbs, relPath } = normalized
    pendingQueue.set(normalizedAbs, {
      absPath: normalizedAbs,
      relPath,
      timestamp: Date.now(),
    })

    logger.debug(`Graph watcher: enqueued ${relPath}`)
    scheduleFlush()
  }

  function startWatcher(): void {
    if (!watchEnabled || watcherInitialized) {
      return
    }

    try {
      watcher = watch(cwd, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        
        const absPath = join(cwd, filename)
        enqueueChange(absPath)
      })

      watcherInitialized = true
      logger.log('Graph filesystem watcher started')
    } catch (err) {
      logger.error('Failed to start graph filesystem watcher', err)
    }
  }

  function stopWatcher(): void {
    if (watcher) {
      watcher.close()
      watcher = null
      watcherInitialized = false
      logger.log('Graph filesystem watcher stopped')
    }
  }

  const service: GraphService = {
    get ready(): boolean {
      return initialized && workerHealthy && client.isReady()
    },

    async scan(): Promise<void> {
      if (!initialized) {
        await initialize()
      }
      
      // Emit indexing status before starting the scan
      emitStatus('indexing')
      
      await client.scan()
      
      // Emit ready status after scan completes
      const stats = await client.getStats()
      emitStatus('ready', {
        files: stats.files,
        symbols: stats.symbols,
        edges: stats.edges,
        calls: stats.calls,
      })
    },

    async close(): Promise<void> {
      // Clear flush timer
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }

      // Flush any remaining changes
      if (pendingQueue.size > 0) {
        await flushQueue()
      }

      // Stop watcher
      stopWatcher()

      // Close client
      await client.close()
      closeGraphDatabase()
      initialized = false
      workerHealthy = false
    },

    async getStats(): Promise<GraphStats> {
      if (!initialized) await initialize()
      return client.getStats()
    },

    async getTopFiles(limit = 20): Promise<TopFileResult[]> {
      if (!initialized) await initialize()
      return client.getTopFiles(limit)
    },

    async getFileDependents(relPath: string): Promise<FileDepResult[]> {
      if (!initialized) await initialize()
      return client.getFileDependents(relPath)
    },

    async getFileDependencies(relPath: string): Promise<FileDepResult[]> {
      if (!initialized) await initialize()
      return client.getFileDependencies(relPath)
    },

    async getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]> {
      if (!initialized) await initialize()
      return client.getFileCoChanges(relPath)
    },

    async getFileBlastRadius(relPath: string): Promise<number> {
      if (!initialized) await initialize()
      return client.getFileBlastRadius(relPath)
    },

    async getFileSymbols(relPath: string): Promise<FileSymbolResult[]> {
      if (!initialized) await initialize()
      return client.getFileSymbols(relPath)
    },

    async findSymbols(name: string, limit = 50): Promise<SymbolSearchResult[]> {
      if (!initialized) await initialize()
      return client.findSymbols(name, limit)
    },

    async searchSymbolsFts(query: string, limit = 20): Promise<SymbolSearchResult[]> {
      if (!initialized) await initialize()
      return client.searchSymbolsFts(query, limit)
    },

    async getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null> {
      if (!initialized) await initialize()
      return client.getSymbolSignature(path, line)
    },

    async getCallers(path: string, line: number): Promise<CallerResult[]> {
      if (!initialized) await initialize()
      return client.getCallers(path, line)
    },

    async getCallees(path: string, line: number): Promise<CalleeResult[]> {
      if (!initialized) await initialize()
      return client.getCallees(path, line)
    },

    async getUnusedExports(limit = 50): Promise<UnusedExportResult[]> {
      if (!initialized) await initialize()
      return client.getUnusedExports(limit)
    },

    async getDuplicateStructures(limit = 20): Promise<DuplicateStructureResult[]> {
      if (!initialized) await initialize()
      return client.getDuplicateStructures(limit)
    },

    async getNearDuplicates(threshold = 0.8, limit = 50): Promise<NearDuplicateResult[]> {
      if (!initialized) await initialize()
      return client.getNearDuplicates(threshold, limit)
    },

    async getExternalPackages(limit = 50): Promise<ExternalPackageResult[]> {
      if (!initialized) await initialize()
      return client.getExternalPackages(limit)
    },

    async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
      if (!initialized) await initialize()
      return client.render(opts)
    },

    onFileChanged(absPath: string): void {
      enqueueChange(absPath)
    },
  }

  function resolveWorkerPath(): string {
    const isDev = import.meta.url.endsWith('.ts')
    const workerFile = isDev ? 'worker.ts' : 'worker.js'
    const workerUrl = new URL(`./${workerFile}`, import.meta.url)
    return workerUrl.pathname
  }

  async function initialize(): Promise<void> {
    if (initialized) return

    try {
      // Emit initializing status
      emitStatus('initializing')

      // Calculate db path
      const projectIdHash = createHash('sha256').update(projectId).digest('hex').substring(0, 16)
      const graphDir = join(dataDir, 'graph', projectIdHash)
      dbPath = join(graphDir, 'graph.db')
      
      initializeGraphDatabase(projectId, dataDir)

      // Create worker with explicit path resolution
      const workerPath = resolveWorkerPath()
      logger.debug(`Graph worker path: ${workerPath}`)
      
      const worker = new globalThis.Worker(workerPath, {
        env: {
          GRAPH_DB_PATH: dbPath,
          GRAPH_CWD: cwd,
          GRAPH_MAX_FILES: maxFiles?.toString() ?? '',
        },
      })

      client.setWorker(worker, logger)
      await client.initialize({ cwd, dbPath, logger })

      initialized = true
      workerHealthy = true
      logger.log('Graph service initialized')
      logger.debug('Graph worker ready')

      // Start watcher after successful initialization
      if (watchEnabled) {
        startWatcher()
      }
    } catch (error) {
      initialized = false
      workerHealthy = false
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to initialize graph service', error)
      emitStatus('error', undefined, msg)
      const err = new Error(`Graph service initialization failed: ${msg}`)
      err.cause = error
      throw err
    }
  }

  return service
}
