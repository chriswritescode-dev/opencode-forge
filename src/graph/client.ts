import { RpcClient } from './rpc'
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
  PrepareScanResult,
  ScanBatchResult,
  OrphanFileResult,
  CircularDependencyResult,
  ChangeImpactResult,
  SymbolReferenceResult,
} from './types'
import type { Logger } from '../types'

interface GraphWorkerConfig {
  cwd: string
  dbPath: string
  logger?: Logger
}

/**
 * GraphClient communicates with the graph worker via RPC
 * All tree-sitter parsing and SQLite queries run in worker thread
 */
export class GraphClient {
  private client: RpcClient | null = null
  private worker: Worker | null = null
  private ready = false
  private workerError: Error | null = null

  async initialize(_config: GraphWorkerConfig): Promise<void> {
    // Worker will be created by service
    this.ready = true
  }

  setWorker(worker: Worker, logger?: Logger): void {
    this.worker = worker
    this.client = new RpcClient(worker, logger)
    
    this.client.on('error', (_error: Error) => {
      this.ready = false
      this.workerError = _error
    })
    
    this.client.on('exit', () => {
      this.ready = false
    })
  }

  markWorkerDead(error?: Error): void {
    this.ready = false
    if (error) {
      this.workerError = error
    }
    if (this.client) {
      this.client.markTerminated()
    }
  }

  getWorkerError(): Error | null {
    return this.workerError
  }

  async scan(): Promise<void> {
    if (!this.client) throw new Error('Graph client not initialized')
    await this.client.call<void>('scan', [])
  }

  async prepareScan(): Promise<PrepareScanResult> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<PrepareScanResult>('prepareScan', [])
  }

  async scanBatch(offset: number, batchSize: number): Promise<ScanBatchResult> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<ScanBatchResult>('scanBatch', [offset, batchSize])
  }

  async finalizeScan(): Promise<void> {
    if (!this.client) throw new Error('Graph client not initialized')
    await this.client.call<void>('finalizeScan', [])
  }

  async getStats(): Promise<GraphStats> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<GraphStats>('getStats', [])
  }

  async getTopFiles(limit = 20): Promise<TopFileResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<TopFileResult[]>('getTopFiles', [limit])
  }

  async getFileDependents(relPath: string): Promise<FileDepResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<FileDepResult[]>('getFileDependents', [relPath])
  }

  async getFileDependencies(relPath: string): Promise<FileDepResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<FileDepResult[]>('getFileDependencies', [relPath])
  }

  async getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<FileCoChangeResult[]>('getFileCoChanges', [relPath])
  }

  async getFileBlastRadius(relPath: string): Promise<number> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<number>('getFileBlastRadius', [relPath])
  }

  async getFileSymbols(relPath: string): Promise<FileSymbolResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<FileSymbolResult[]>('getFileSymbols', [relPath])
  }

  async findSymbols(name: string, limit = 50): Promise<SymbolSearchResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<SymbolSearchResult[]>('findSymbols', [name, limit])
  }

  async searchSymbolsFts(query: string, limit = 20): Promise<SymbolSearchResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<SymbolSearchResult[]>('searchSymbolsFts', [query, limit])
  }

  async getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<SymbolSignatureResult | null>('getSymbolSignature', [path, line])
  }

  async getCallers(path: string, line: number): Promise<CallerResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<CallerResult[]>('getCallers', [path, line])
  }

  async getCallees(path: string, line: number): Promise<CalleeResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<CalleeResult[]>('getCallees', [path, line])
  }

  async getUnusedExports(limit = 20, includeInternalOnly = false): Promise<UnusedExportResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<UnusedExportResult[]>('getUnusedExports', [limit, includeInternalOnly])
  }

  async getDuplicateStructures(limit = 20): Promise<DuplicateStructureResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<DuplicateStructureResult[]>('getDuplicateStructures', [limit])
  }

  async getNearDuplicates(threshold = 0.8, limit = 50): Promise<NearDuplicateResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<NearDuplicateResult[]>('getNearDuplicates', [threshold, limit])
  }

  async getExternalPackages(limit = 20): Promise<ExternalPackageResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<ExternalPackageResult[]>('getExternalPackages', [limit])
  }

  async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<{ content: string; paths: string[] }>('render', [opts])
  }

  async getOrphanFiles(limit = 50): Promise<OrphanFileResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<OrphanFileResult[]>('getOrphanFiles', [limit])
  }

  async getCircularDependencies(limit = 20): Promise<CircularDependencyResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<CircularDependencyResult[]>('getCircularDependencies', [limit])
  }

  async getChangeImpact(paths: string[], maxDepth = 5): Promise<ChangeImpactResult> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<ChangeImpactResult>('getChangeImpact', [paths, maxDepth])
  }

  async getSymbolReferences(name: string, limit = 50): Promise<SymbolReferenceResult[]> {
    if (!this.client) throw new Error('Graph client not initialized')
    return this.client.call<SymbolReferenceResult[]>('getSymbolReferences', [name, limit])
  }

  async onFileChanged(absPath: string): Promise<void> {
    if (!this.client) return
    if (!this.ready) {
      throw new Error('Graph client not ready - worker may be unavailable')
    }
    await this.client.call<void>('onFileChanged', [absPath])
  }

  async onFilesChanged(absPaths: string[]): Promise<void> {
    if (!this.client) return
    if (!this.ready) {
      throw new Error('Graph client not ready - worker may be unavailable')
    }
    await this.client.call<void>('onFilesChanged', [absPaths])
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.terminate()
      this.client = null
    }
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.ready = false
  }

  isReady(): boolean {
    return this.ready
  }
}
