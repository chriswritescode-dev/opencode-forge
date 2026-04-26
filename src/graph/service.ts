import { GraphClient } from './client'
import { ensureGraphDirectory, readGraphCacheMetadata, writeGraphCacheMetadata } from './database'
import { join, relative, dirname, isAbsolute } from 'path'
import { watch, existsSync } from 'fs'
import type { Logger } from '../types'
import { collectIndexFingerprint } from './utils'
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
  OrphanFileResult,
  CircularDependencyResult,
  ChangeImpactResult,
  SymbolReferenceResult,
} from './types'
import { INDEXABLE_EXTENSIONS } from './constants'
import { IGNORED_DIRS, IGNORED_EXTS } from './utils'
import type { GraphState, GraphStatsPayload } from '../utils/graph-status-store'

interface GraphService {
  /** Whether the graph service is fully initialized and ready to respond to queries. */
  readonly ready: boolean
  /**
   * Performs a full scan of the codebase, indexing all files and building the graph.
   * Emits progress status updates during indexing.
   */
  scan(): Promise<void>
  /**
   * Closes the graph service, stopping watchers and releasing resources.
   */
  close(): Promise<void>
  /**
   * Returns statistics about the indexed codebase.
   */
  getStats(): Promise<GraphStats>
  /**
   * Returns the top N files by PageRank importance.
   * @param limit - Maximum number of files to return. Defaults to 20.
   */
  getTopFiles(limit?: number): Promise<TopFileResult[]>
  /**
   * Returns files that depend on the specified file.
   * @param relPath - Relative path to the file.
   */
  getFileDependents(relPath: string): Promise<FileDepResult[]>
  /**
   * Returns files that the specified file depends on.
   * @param relPath - Relative path to the file.
   */
  getFileDependencies(relPath: string): Promise<FileDepResult[]>
  /**
   * Returns files that frequently change together with the specified file.
   * @param relPath - Relative path to the file.
   */
  getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]>
  /**
   * Returns the blast radius (number of affected files) if this file were changed.
   * @param relPath - Relative path to the file.
   */
  getFileBlastRadius(relPath: string): Promise<number>
  /**
   * Returns all symbols defined in the specified file.
   * @param relPath - Relative path to the file.
   */
  getFileSymbols(relPath: string): Promise<FileSymbolResult[]>
  /**
   * Searches for symbols by exact name match.
   * @param name - Symbol name to search for.
   * @param limit - Maximum number of results. Defaults to 50.
   */
  findSymbols(name: string, limit?: number): Promise<SymbolSearchResult[]>
  /**
   * Searches for symbols using full-text search.
   * @param query - Search query string.
   * @param limit - Maximum number of results. Defaults to 20.
   */
  searchSymbolsFts(query: string, limit?: number): Promise<SymbolSearchResult[]>
  /**
   * Returns the signature of a symbol at the given location.
   * @param path - Absolute path to the file.
   * @param line - Line number of the symbol.
   */
  getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null>
  /**
   * Returns all call sites that call the symbol at the given location.
   * @param path - Absolute path to the file.
   * @param line - Line number of the symbol definition.
   */
  getCallers(path: string, line: number): Promise<CallerResult[]>
  /**
   * Returns all symbols called by the symbol at the given location.
   * @param path - Absolute path to the file.
   * @param line - Line number of the symbol definition.
   */
  getCallees(path: string, line: number): Promise<CalleeResult[]>
  /**
   * Returns exported symbols that appear unused.
   * @param limit - Maximum number of results. Defaults to 50.
   */
  getUnusedExports(limit?: number, includeInternalOnly?: boolean): Promise<UnusedExportResult[]>
  /**
   * Returns groups of files with duplicate code structures.
   * @param limit - Maximum number of result groups. Defaults to 20.
   */
  getDuplicateStructures(limit?: number): Promise<DuplicateStructureResult[]>
  /**
   * Returns pairs of similar but not identical code structures.
   * @param threshold - Similarity threshold (0-1). Defaults to 0.8.
   * @param limit - Maximum number of results. Defaults to 50.
   */
  getNearDuplicates(threshold?: number, limit?: number): Promise<NearDuplicateResult[]>
  /**
   * Returns external packages imported by the codebase.
   * @param limit - Maximum number of results. Defaults to 50.
   */
  getExternalPackages(limit?: number): Promise<ExternalPackageResult[]>
  /**
   * Returns files with no incoming edges (nobody imports them).
   * @param limit - Maximum number of results. Defaults to 50.
   */
  getOrphanFiles(limit?: number): Promise<OrphanFileResult[]>
  /**
   * Returns circular dependency cycles in the file dependency graph.
   * @param limit - Maximum number of cycles. Defaults to 20.
   */
  getCircularDependencies(limit?: number): Promise<CircularDependencyResult[]>
  /**
   * Returns the transitive impact of changing a set of files.
   * @param paths - Relative paths of changed files.
   * @param maxDepth - Maximum BFS traversal depth. Defaults to 5.
   */
  getChangeImpact(paths: string[], maxDepth?: number): Promise<ChangeImpactResult>
  /**
   * Returns all references to a symbol (imports, calls, re-exports).
   * @param name - Symbol name to search for.
   * @param limit - Maximum number of results. Defaults to 50.
   */
  getSymbolReferences(name: string, limit?: number): Promise<SymbolReferenceResult[]>
  /**
   * Renders a text visualization of the code graph.
   * @param opts - Rendering options.
   */
  render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }>
  /**
   * Notifies the service that a file has changed, triggering re-indexing.
   * @param absPath - Absolute path to the changed file.
   */
  onFileChanged(absPath: string): void
  /**
   * Determines whether a full scan is needed on startup based on cache freshness.
   * Returns a decision with reason for logging purposes.
   */
  shouldScanOnStartup(): Promise<{ shouldScan: boolean; reason: string }>
  /**
   * Ensures the graph index is ready for queries on startup.
   * Scans only when cache is missing, stale, or unhealthy; otherwise skips.
   * @returns 'scanned' if a full scan was performed, 'skipped' if cache was reused
   */
  ensureStartupIndex(): Promise<'scanned' | 'skipped'>
}

type GraphStatusCallback = (state: GraphState, stats?: GraphStatsPayload, message?: string) => void

/**
 * Configuration for creating a graph service instance.
 */
interface GraphServiceConfig {
  projectId: string
  dataDir: string
  cwd: string
  logger: Logger
  watch?: boolean
  debounceMs?: number
  onStatusChange?: GraphStatusCallback
}

interface PendingChange {
  absPath: string
  relPath: string
  timestamp: number
}

const DEFAULT_DEBOUNCE_MS = 500

/** Minimum number of files required to consider the graph for health check */
const MIN_FILES_FOR_HEALTH_CHECK = 50

/** Minimum number of symbols required to consider the graph for health check */
const MIN_SYMBOLS_FOR_HEALTH_CHECK = 500

/**
 * Evaluates graph health based on stats to detect obviously incomplete indexes.
 * Returns a description of the health issue if found, or null if healthy.
 * 
 * Conservative heuristic: only treat the graph as incomplete when derived state is
 * missing for a large, symbol-dense index. Small or dependency-free repos can
 * validly have zero edges.
 */
function evaluateGraphHealth(stats: { files: number; symbols: number; edges: number; calls: number }): string | null {
  // Only flag as incomplete for large, symbol-dense indexes with zero edges.
  // Smaller repos or those with standalone files can validly have no dependencies.
  if (
    stats.files >= MIN_FILES_FOR_HEALTH_CHECK &&
    stats.symbols >= MIN_SYMBOLS_FOR_HEALTH_CHECK &&
    stats.edges === 0 &&
    stats.calls === 0
  ) {
    return `${stats.files} files and ${stats.symbols} symbols indexed but 0 dependency edges or call edges generated`
  }
  
  return null
}

/**
 * Determines whether a startup scan is needed based on cache freshness and health.
 */
async function determineStartupScan(
  dbPath: string | null,
  cwd: string,
  client: GraphClient
): Promise<{ shouldScan: boolean; reason: string }> {
  if (!dbPath) {
    return { shouldScan: true, reason: 'Graph database path not set' }
  }
  const graphDir = dirname(dbPath)
  
  // 1. Check if metadata exists
  const metadata = readGraphCacheMetadata(graphDir)
  if (!metadata) {
    return { shouldScan: true, reason: 'Graph cache metadata missing' }
  }
  
  // 2. Check if graph DB has any indexed files
  try {
    const stats = await client.getStats()
    const hasIndexedFiles = stats.files > 0
    
    // If metadata exists but graph has no files, scan is needed
    if (!hasIndexedFiles) {
      // Check if repo is non-empty
      const currentFingerprint = await collectIndexFingerprint(cwd, graphDir)
      if (currentFingerprint.fileCount > 0) {
        return { shouldScan: true, reason: 'Graph database empty but repository has files' }
      }
      // Empty repo - no scan needed
      return { shouldScan: false, reason: 'Repository is empty' }
    }
    
    // 3. Check persisted status for this scope
    // Note: We can't directly check KV here, so we rely on metadata and stats
    
    // 4. Compare current fingerprint to last successful scan
    const currentFingerprint = await collectIndexFingerprint(cwd, graphDir)
    
    // If fingerprint fields are missing from metadata (old format), scan to update
    if (metadata.indexedFileCount === undefined || metadata.indexedMaxMtimeMs === undefined) {
      return { 
        shouldScan: true, 
        reason: 'Graph metadata missing fingerprint fields - scanning to update' 
      }
    }
    
    // If file count changed, scan is needed
    if (currentFingerprint.fileCount !== metadata.indexedFileCount) {
      return { 
        shouldScan: true, 
        reason: `File count changed: ${metadata.indexedFileCount} -> ${currentFingerprint.fileCount}` 
      }
    }
    
    // If max mtime increased (files modified), scan is needed
    if (currentFingerprint.maxMtimeMs > metadata.indexedMaxMtimeMs) {
      return { 
        shouldScan: true, 
        reason: `Files modified since last index (mtime: ${metadata.indexedMaxMtimeMs} -> ${currentFingerprint.maxMtimeMs})` 
      }
    }
    
    // 5. Check graph health - unhealthy graphs should be rescanned
    const healthIssue = evaluateGraphHealth(stats)
    if (healthIssue) {
      return { 
        shouldScan: true, 
        reason: `Graph cache unhealthy: ${healthIssue}` 
      }
    }
    
    // 6. Cache is fresh and healthy - skip scan
    return { 
      shouldScan: false, 
      reason: `Graph cache fresh: ${stats.files} files, fingerprint matches last scan` 
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { shouldScan: true, reason: `Graph stats unavailable: ${msg}` }
  }
}

/**
 * Creates a graph service instance for code indexing and querying.
 * 
 * @param config - Service configuration including project ID, data directory, and callbacks
 * @returns A GraphService instance for code graph operations
 */
export function createGraphService(config: GraphServiceConfig): GraphService {
  const { projectId, dataDir, cwd, logger, watch: watchEnabled, debounceMs, onStatusChange } = config
  const client = new GraphClient()
  let dbPath: string | null = null
  let initialized = false
  let closing = false
  let watcher: ReturnType<typeof watch> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const pendingQueue = new Map<string, PendingChange>()
  let isFlushing = false
  let watcherInitialized = false
  let scanInFlight: Promise<void> | null = null

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

  async function ensureInit(): Promise<void> {
    if (!initialized) await initialize()
  }

  async function flushQueue(): Promise<void> {
    if (closing || isFlushing || pendingQueue.size === 0 || !workerHealthy) {
      if (!closing && !workerHealthy && pendingQueue.size > 0) {
        logger.debug('Graph flush skipped - worker unhealthy')
        pendingQueue.clear()
      }
      return
    }

    // Defer flush while a scan is in flight to avoid race conditions
    if (scanInFlight) {
      scheduleFlush()
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
        
        // Evaluate graph health after flush
        const healthIssue = evaluateGraphHealth(stats)
        if (healthIssue) {
          const errorMsg = `Graph index incomplete: ${healthIssue}. Run graph scan again or clear the cache.`
          emitStatus('error', {
            files: stats.files,
            symbols: stats.symbols,
            edges: stats.edges,
            calls: stats.calls,
          }, errorMsg)
          workerHealthy = false
        } else {
          emitStatus('ready', {
            files: stats.files,
            symbols: stats.symbols,
            edges: stats.edges,
            calls: stats.calls,
          })
        }
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
    if (closing || flushTimer) {
      if (!closing && flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null // Nullify immediately to prevent race conditions
      }
    }
    if (closing) return
    flushTimer = setTimeout(() => {
      flushQueue().catch((err) => {
        logger.error('Graph flush failed', err)
      })
    }, effectiveDebounceMs)
  }

  function enqueueChange(absPath: string): void {
    if (closing) {
      logger.debug(`Graph watcher: ignoring change during shutdown ${absPath}`)
      return
    }
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
    if (!watchEnabled || watcherInitialized || closing) {
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
      return initialized && !closing && workerHealthy && client.isReady()
    },

    async scan(): Promise<void> {
      // If a scan is already in flight, return the same promise (serialize concurrent requests)
      if (scanInFlight) {
        return scanInFlight
      }

      await ensureInit()

      emitStatus('indexing')

      // Capture the scan promise for concurrent request handling
      scanInFlight = (async () => {
        try {
          // Prepare scan - collect files and get batch info
          const prepResult = await client.prepareScan()
          
          // Process files in batches with progress updates
          let offset = 0
          let completed = false
          
          while (!completed) {
            const batchResult = await client.scanBatch(offset, prepResult.batchSize)
            offset = batchResult.nextOffset
            completed = batchResult.completed
            
            // Emit progress during indexing
            const progressMessage = `Indexing graph: ${offset}/${prepResult.totalFiles} files`
            emitStatus('indexing', undefined, progressMessage)
          }

          // Finalize - build derived state (PageRank, edges, call graph, etc.)
          await client.finalizeScan()

          const stats = await client.getStats()
          
          // Evaluate graph health - detect obviously incomplete indexes
          const healthIssue = evaluateGraphHealth(stats)
          if (healthIssue) {
            const errorMsg = `Graph index incomplete: ${healthIssue}. Run graph scan again or clear the cache.`
            emitStatus('error', {
              files: stats.files,
              symbols: stats.symbols,
              edges: stats.edges,
              calls: stats.calls,
            }, errorMsg)
            workerHealthy = false
            throw new Error(errorMsg)
          }
          
          // Persist fingerprint metadata for future startup freshness checks
          if (dbPath) {
            const graphDir = dirname(dbPath)
            const currentFingerprint = await collectIndexFingerprint(cwd, graphDir)
            writeGraphCacheMetadata(graphDir, {
              lastIndexedAt: Date.now(),
              indexedFileCount: currentFingerprint.fileCount,
              indexedMaxMtimeMs: currentFingerprint.maxMtimeMs,
            })
          }
          
          workerHealthy = true
          emitStatus('ready', {
            files: stats.files,
            symbols: stats.symbols,
            edges: stats.edges,
            calls: stats.calls,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          emitStatus('error', undefined, msg)
          workerHealthy = false
          throw err
        } finally {
          scanInFlight = null
          
          // Schedule flush for any changes that arrived during the scan
          if (pendingQueue.size > 0 && !closing && workerHealthy) {
            scheduleFlush()
          }
        }
      })()

      return scanInFlight
    },

    async close(): Promise<void> {
      // Mark as closing to prevent new work from being queued
      closing = true

      // Clear flush timer immediately
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }

      // Discard pending queue rather than flushing during shutdown
      pendingQueue.clear()

      // Stop watcher before more paths can be enqueued
      stopWatcher()

      // Close client (and its worker) — worker owns the DB handle
      await client.close()
      initialized = false
      workerHealthy = false
    },

    async getStats(): Promise<GraphStats> {
      await ensureInit()
      return client.getStats()
    },

    async getTopFiles(limit = 20): Promise<TopFileResult[]> {
      await ensureInit()
      return client.getTopFiles(limit)
    },

    async getFileDependents(relPath: string): Promise<FileDepResult[]> {
      await ensureInit()
      return client.getFileDependents(validateRelativePath(relPath))
    },

    async getFileDependencies(relPath: string): Promise<FileDepResult[]> {
      await ensureInit()
      return client.getFileDependencies(validateRelativePath(relPath))
    },

    async getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]> {
      await ensureInit()
      return client.getFileCoChanges(validateRelativePath(relPath))
    },

    async getFileBlastRadius(relPath: string): Promise<number> {
      await ensureInit()
      return client.getFileBlastRadius(validateRelativePath(relPath))
    },

    async getFileSymbols(relPath: string): Promise<FileSymbolResult[]> {
      await ensureInit()
      return client.getFileSymbols(validateRelativePath(relPath))
    },

    async findSymbols(name: string, limit = 50): Promise<SymbolSearchResult[]> {
      await ensureInit()
      return client.findSymbols(name, limit)
    },

    async searchSymbolsFts(query: string, limit = 20): Promise<SymbolSearchResult[]> {
      await ensureInit()
      return client.searchSymbolsFts(query, limit)
    },

    async getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null> {
      await ensureInit()
      return client.getSymbolSignature(path, line)
    },

    async getCallers(path: string, line: number): Promise<CallerResult[]> {
      await ensureInit()
      return client.getCallers(path, line)
    },

    async getCallees(path: string, line: number): Promise<CalleeResult[]> {
      await ensureInit()
      return client.getCallees(path, line)
    },

    async getUnusedExports(limit = 50, includeInternalOnly = false): Promise<UnusedExportResult[]> {
      await ensureInit()
      return client.getUnusedExports(limit, includeInternalOnly)
    },

    async getDuplicateStructures(limit = 20): Promise<DuplicateStructureResult[]> {
      await ensureInit()
      return client.getDuplicateStructures(limit)
    },

    async getNearDuplicates(threshold = 0.8, limit = 50): Promise<NearDuplicateResult[]> {
      await ensureInit()
      return client.getNearDuplicates(threshold, limit)
    },

    async getExternalPackages(limit = 50): Promise<ExternalPackageResult[]> {
      await ensureInit()
      return client.getExternalPackages(limit)
    },

    async getOrphanFiles(limit = 50): Promise<OrphanFileResult[]> {
      await ensureInit()
      return client.getOrphanFiles(limit)
    },

    async getCircularDependencies(limit = 20): Promise<CircularDependencyResult[]> {
      await ensureInit()
      return client.getCircularDependencies(limit)
    },

    async getChangeImpact(paths: string[], maxDepth = 5): Promise<ChangeImpactResult> {
      await ensureInit()
      return client.getChangeImpact(paths, maxDepth)
    },

    async getSymbolReferences(name: string, limit = 50): Promise<SymbolReferenceResult[]> {
      await ensureInit()
      return client.getSymbolReferences(name, limit)
    },

    async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
      await ensureInit()
      return client.render(opts)
    },

    onFileChanged(absPath: string): void {
      if (closing) {
        logger.debug(`Graph service: ignoring file change during shutdown ${absPath}`)
        return
      }
      enqueueChange(absPath)
    },

    async shouldScanOnStartup(): Promise<{ shouldScan: boolean; reason: string }> {
      // Ensure initialization first (needed for client.getStats())
      await ensureInit()

      if (!dbPath) {
        return { shouldScan: true, reason: 'Graph database path not set' }
      }
      return determineStartupScan(dbPath, cwd, client)
    },

    async ensureStartupIndex(): Promise<'scanned' | 'skipped'> {
      // Ensure initialization first (sets dbPath and initializes client)
      await ensureInit()

      // Client is already initialized by this point
      const decision = await determineStartupScan(dbPath, cwd, client)
      
      if (decision.shouldScan) {
        logger.log(`Graph startup: ${decision.reason} - performing full scan`)
        await service.scan()
        return 'scanned'
      } else {
        logger.log(`Graph startup: ${decision.reason} - skipping scan`)
        // Refresh ready status with current stats
        const stats = await client.getStats()
        emitStatus('ready', {
          files: stats.files,
          symbols: stats.symbols,
          edges: stats.edges,
          calls: stats.calls,
        }, decision.reason)
        return 'skipped'
      }
    },
  }

  function resolveWorkerPath(): string {
    const isDev = import.meta.url.endsWith('.ts')
    const workerFile = isDev ? 'worker.ts' : 'worker.js'
    const workerUrl = new URL(`./${workerFile}`, import.meta.url)
    if (!existsSync(workerUrl.pathname)) {
      throw new Error(`Graph worker file not found: ${workerUrl.pathname}`)
    }
    return workerUrl.pathname
  }

  function validateRelativePath(relPath: string): string {
    const normalized = relPath.trim().replace(/\\/g, '/')
    if (!normalized) {
      throw new Error('Graph file path must be non-empty')
    }
    if (isAbsolute(normalized)) {
      throw new Error(`Graph file path must be relative: ${relPath}`)
    }
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`Graph file path must stay within project root: ${relPath}`)
    }
    return normalized
  }

  async function initialize(): Promise<void> {
    if (initialized) return

    try {
      // Emit initializing status
      emitStatus('initializing')

      // Ensure graph directory exists; worker thread is the sole DB owner
      dbPath = ensureGraphDirectory(projectId, dataDir, cwd)

      // Create worker with explicit path resolution
      const workerPath = resolveWorkerPath()
      logger.debug(`Graph worker path: ${workerPath}`)
      
      const worker = new globalThis.Worker(workerPath, {
        env: {
          GRAPH_DB_PATH: dbPath,
          GRAPH_CWD: cwd,
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
