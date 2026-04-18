// Core RepoMap implementation - ported from soulforge

import { Database, Statement } from 'bun:sqlite'
import { resolve, join, dirname, extname, relative } from 'path'
import { existsSync, statSync } from 'fs'

import { TreeSitterBackend } from './tree-sitter'
import { FileCache } from './cache'
import { tokenize, computeMinHash, computeFragmentHashes, jaccardSimilarity } from './clone-detection'
import {
  INDEXABLE_EXTENSIONS,
  PAGERANK_ITERATIONS,
  PAGERANK_DAMPING,
  GRAPH_SCAN_BATCH_SIZE,
} from './constants'
import { isBarrelFile, kindTag, collectFilesAsync, extractSignature } from './utils'
import type {
  DbFile,
  DbSymbol,
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
  GraphStats,
  SymbolKind,
  PrepareScanResult,
  ScanBatchResult,
  OrphanFileResult,
  CircularDependencyResult,
  ChangeImpactResult,
  ImpactedFile,
  SymbolReferenceResult,
} from './types'

interface IndexedFile {
  id: number
  path: string
  mtime_ms: number
  language: string
  line_count: number
  symbol_count: number
  pagerank: number
  is_barrel: boolean
}

interface Edge {
  source_file_id: number
  target_file_id: number
  weight: number
  confidence: number
}

interface Ref {
  id: number
  file_id: number
  name: string
  source_file_id: number | null
  import_source: string
}

interface RepoMapConfig {
  cwd: string
  db: Database
}

export class RepoMap {
  private db: Database
  private cwd: string
  private treeSitter: TreeSitterBackend
  private cache: FileCache
  private stmts: Record<string, Statement> = {}
  // Scan state for batch operations
  private scanFiles: string[] = []
  private scanTotalFiles: number = 0

  constructor(config: RepoMapConfig) {
    this.cwd = resolve(config.cwd)
    this.db = config.db
    this.treeSitter = new TreeSitterBackend()
    this.cache = new FileCache(200)
    this.treeSitter.setCache(this.cache)
    this.prepareStatements()
  }

  private prepareStatements(): void {
    this.stmts = {
      getFileById: this.db.prepare('SELECT * FROM files WHERE id = ?'),
      getFileByPath: this.db.prepare('SELECT * FROM files WHERE path = ?'),
      getSymbolsByFileId: this.db.prepare('SELECT * FROM symbols WHERE file_id = ?'),
      getRefsByFileId: this.db.prepare('SELECT * FROM refs WHERE file_id = ?'),
      getEdgesBySource: this.db.prepare('SELECT * FROM edges WHERE source_file_id = ?'),
      getEdgesByTarget: this.db.prepare('SELECT * FROM edges WHERE target_file_id = ?'),
      getAllFiles: this.db.prepare('SELECT * FROM files ORDER BY pagerank DESC'),
      getAllSymbols: this.db.prepare('SELECT * FROM symbols'),
      getAllEdges: this.db.prepare('SELECT * FROM edges'),
      getAllRefs: this.db.prepare('SELECT * FROM refs'),
      insertFile: this.db.prepare(`
        INSERT OR REPLACE INTO files (path, mtime_ms, language, line_count, symbol_count, pagerank, is_barrel, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertSymbol: this.db.prepare(`
        INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported, signature, qualified_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertRef: this.db.prepare(`
        INSERT INTO refs (file_id, name, source_file_id, import_source, is_dynamic)
        VALUES (?, ?, ?, ?, ?)
      `),
      insertEdge: this.db.prepare(`
        INSERT OR REPLACE INTO edges (source_file_id, target_file_id, weight, confidence)
        VALUES (?, ?, ?, ?)
      `),
      insertCoChange: this.db.prepare(`
        INSERT OR REPLACE INTO cochanges (file_id_a, file_id_b, count)
        VALUES (?, ?, ?)
      `),
      deleteFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
      deleteRefsByFileId: this.db.prepare('DELETE FROM refs WHERE file_id = ?'),
      deleteEdgesBySource: this.db.prepare('DELETE FROM edges WHERE source_file_id = ?'),
      deleteEdgesByTarget: this.db.prepare('DELETE FROM edges WHERE target_file_id = ?'),
      deleteSymbolsByFileId: this.db.prepare('DELETE FROM symbols WHERE file_id = ?'),
      deleteShapeHashesByFileId: this.db.prepare('DELETE FROM shape_hashes WHERE file_id = ?'),
      deleteTokenSignaturesByFileId: this.db.prepare('DELETE FROM token_signatures WHERE file_id = ?'),
      deleteTokenFragmentsByFileId: this.db.prepare('DELETE FROM token_fragments WHERE file_id = ?'),
      deleteExternalImportsByFileId: this.db.prepare('DELETE FROM external_imports WHERE file_id = ?'),
      getCounts: this.db.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM files) as files,
          (SELECT COUNT(*) FROM symbols) as symbols,
          (SELECT COUNT(*) FROM edges) as edges
      `),
      // Queries for dependents/dependencies
      getEdgesByTargetFile: this.db.prepare('SELECT * FROM edges WHERE target_file_id = ?'),
      getEdgesBySourceFile: this.db.prepare('SELECT * FROM edges WHERE source_file_id = ?'),
      // Query for blast radius
      getEdgesTargetIds: this.db.prepare('SELECT target_file_id FROM edges WHERE source_file_id = ?'),
      // FTS search
      searchSymbolsFtsQuery: this.db.prepare(`
        SELECT s.name, f.path, s.kind, s.line, s.is_exported AS isExported, f.pagerank, s.id
        FROM symbols_fts ft
        JOIN symbols s ON ft.rowid = s.id
        JOIN files f ON s.file_id = f.id
        WHERE symbols_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      // Call graph queries
      getSymbolByFileAndLine: this.db.prepare('SELECT id, name, kind, line, signature FROM symbols WHERE file_id = ? AND line = ? LIMIT 1'),
      getCallersQuery: this.db.prepare(`
        SELECT s.name as caller_name, f.path as caller_path, s.line as caller_line, c.line as call_line
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE c.callee_name = ? AND (c.callee_file_id IS NULL OR c.callee_file_id = ?)
      `),
      getCalleesQuery: this.db.prepare(`
        SELECT c.callee_name, f.path as callee_file, c.line as call_line, s.line as callee_def_line
        FROM calls c
        JOIN files f ON c.callee_file_id = f.id
        JOIN symbols s ON c.callee_symbol_id = s.id
        WHERE c.caller_symbol_id = ?
      `),
      // Co-changes
      getCoChanges: this.db.prepare(`
        SELECT 
          CASE WHEN file_id_a = ? THEN file_id_b ELSE file_id_a END as other_id,
          count
        FROM cochanges 
        WHERE file_id_a = ? OR file_id_b = ?
        ORDER BY count DESC
        LIMIT 20
      `),
      // File symbols query
      getFileSymbolsQuery: this.db.prepare('SELECT * FROM symbols WHERE file_id = ?'),
      // Resolve unresolved refs
      getUnresolvedRefs: this.db.prepare('SELECT * FROM refs WHERE source_file_id IS NULL'),
      resolveRefMatch: this.db.prepare(`
        SELECT s.id, s.file_id, f.path 
        FROM symbols s 
        JOIN files f ON s.file_id = f.id 
        WHERE s.name = ? AND s.is_exported = 1
      `),
      // Test files
      getTestFiles: this.db.prepare(`
        SELECT id, path FROM files 
        WHERE path LIKE '%.test.%' OR path LIKE '%_test.%' OR path LIKE '%.spec.%'
      `),
      // Build call graph helpers - include files with any refs (resolved or unresolved)
      getFilesWithImports: this.db.prepare(`
        SELECT DISTINCT f.id, f.path FROM files f
        WHERE EXISTS (SELECT 1 FROM symbols s WHERE s.file_id = f.id AND s.kind IN ('function', 'method'))
          AND EXISTS (SELECT 1 FROM refs r WHERE r.file_id = f.id AND r.name != '*' AND r.import_source != '<self>')
      `),
      getImportsForFile: this.db.prepare<{ name: string; source_file_id: number }, [number]>(`
        SELECT DISTINCT r.name, r.source_file_id FROM refs r
        WHERE r.file_id = ? AND r.source_file_id IS NOT NULL AND r.name != '*'
          AND r.import_source != '<self>'
      `),
      getFunctionsForFile: this.db.prepare<
        { id: number; name: string; line: number; end_line: number },
        [number]
      >(`
        SELECT id, name, line, end_line FROM symbols
        WHERE file_id = ? AND kind IN ('function', 'method') AND end_line > line
      `),
      resolveCallee: this.db.prepare<{ id: number }, [number, string]>(`
        SELECT id FROM symbols WHERE file_id = ? AND name = ? AND is_exported = 1 LIMIT 1
      `),
      insertCall: this.db.prepare(`
        INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line)
        VALUES (?, ?, ?, ?, ?)
      `),
      // Unused exports - excludes external refs, self-refs, barrel re-exports, and dynamic imports
      getUnusedExportsQuery: this.db.prepare(`
        SELECT 
          s.id, 
          s.name, 
          s.kind, 
          s.line, 
          s.end_line, 
          f.path, 
          f.line_count,
          EXISTS (
            SELECT 1 FROM refs r 
            WHERE r.name = s.name 
              AND r.source_file_id = s.file_id 
              AND r.import_source = '<self>'
          ) AS has_self
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.is_exported = 1
          AND NOT EXISTS (
            SELECT 1 FROM refs r 
            WHERE r.name = s.name 
              AND r.source_file_id = s.file_id
              AND r.file_id != s.file_id
              AND r.is_dynamic = 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM refs rbarrel
            JOIN files fb ON rbarrel.file_id = fb.id
            WHERE rbarrel.name = s.name
              AND fb.is_barrel = 1
              AND rbarrel.source_file_id != fb.id
              AND EXISTS (
                SELECT 1 FROM refs rimport
                WHERE rimport.name = s.name
                  AND rimport.source_file_id = fb.id
                  AND rimport.file_id != fb.id
                  AND rimport.is_dynamic = 0
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM refs rdynamic
            WHERE rdynamic.source_file_id = s.file_id
              AND rdynamic.is_dynamic = 1
          )
        LIMIT ?
      `),
      // Orphan files - files with no incoming edges (excludes entrypoints)
      getOrphanFilesQuery: this.db.prepare(`
        SELECT f.path, f.language, f.line_count, f.symbol_count
        FROM files f
        LEFT JOIN edges e ON e.target_file_id = f.id
        LEFT JOIN entrypoints ep ON ep.file_id = f.id
        WHERE e.target_file_id IS NULL
          AND ep.file_id IS NULL
          AND f.is_barrel = 0
          AND f.path NOT LIKE '%.test.%'
          AND f.path NOT LIKE '%.spec.%'
          AND f.path NOT LIKE '%_test.%'
        ORDER BY f.line_count DESC
        LIMIT ?
      `),
      // Reverse edge lookup for change impact BFS
      getEdgesSourceIdsByTarget: this.db.prepare(
        'SELECT source_file_id FROM edges WHERE target_file_id = ?'
      ),
      // Symbol references
      getRefsByName: this.db.prepare(`
        SELECT f.path, r.import_source
        FROM refs r
        JOIN files f ON r.file_id = f.id
        WHERE r.name = ?
          AND r.import_source != '<self>'
      `),
      getCallsByCalleeName: this.db.prepare(`
        SELECT c.line, s.name as caller_name, f.path
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE c.callee_name = ?
      `),
      getReexportsByName: this.db.prepare(`
        SELECT f.path, s.line
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.name = ? AND s.is_exported = 1 AND f.is_barrel = 1
      `),
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.treeSitter.initialize(this.cwd)
      this.initSchema()
    } catch (err) {
      console.error('Failed to initialize RepoMap:', err)
      throw err
    }
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `)
    
    const version = this.db.prepare('SELECT version FROM schema_version ORDER BY id DESC LIMIT 1').get() as { version: number } | undefined
    
    if (!version || version.version < 1) {
      this.db.run('INSERT INTO schema_version (version) VALUES (1)')
    }

    // Only populate FTS if symbols table exists
    try {
      const ftsCount = this.db.prepare('SELECT COUNT(*) as c FROM symbols_fts').get() as { c: number } | undefined
      if (!ftsCount || ftsCount.c === 0) {
        const symbols = this.stmts.getAllSymbols.all() as Array<{ id: number; name: string; kind: string; file_id: number }>
        for (const sym of symbols) {
          const file = this.stmts.getFileById.get(sym.file_id) as { path: string } | undefined
          if (file) {
            try {
              this.db.run('INSERT INTO symbols_fts (rowid, name, path, kind) VALUES (?, ?, ?, ?)', [sym.id, sym.name, file.path, sym.kind])
            } catch {
              // FTS insert may fail
            }
          }
        }
      }
    } catch {
      // FTS table may not exist yet - that's ok, it will be created by database.ts
    }
  }

  async scan(): Promise<void> {
    // For backward compatibility, use the staged scan approach
    await this.prepareScan()
    let offset = 0
    let completed = false
    while (!completed) {
      const result = await this.scanBatch(offset, GRAPH_SCAN_BATCH_SIZE)
      offset = result.nextOffset
      completed = result.completed
    }
    await this.finalizeScan()
  }

  /**
   * Prepare for a full scan by collecting all indexable files and resetting scan state.
   * Returns the total number of files to process and the batch size to use.
   */
  async prepareScan(): Promise<PrepareScanResult> {
    // Collect all indexable files without any cap
    const result = await collectFilesAsync(this.cwd)
    this.scanFiles = result.files.map(f => relative(this.cwd, f.path))
    this.scanTotalFiles = this.scanFiles.length

    // Reset derived state tables before fresh scan to avoid stale data
    this.resetGraphDataForFullScan()

    return {
      totalFiles: this.scanTotalFiles,
      batchSize: GRAPH_SCAN_BATCH_SIZE,
    }
  }

  /**
   * Scan a batch of files starting at the given offset.
   * Returns progress info including whether scanning is complete.
   */
  async scanBatch(offset: number, batchSize: number): Promise<ScanBatchResult> {
    const filesToProcess = this.scanFiles.slice(offset, offset + batchSize)
    const processedCount = filesToProcess.length

    for (const filePath of filesToProcess) {
      try {
        await this.indexFile(filePath)
      } catch (err) {
        console.error(`Error indexing ${filePath}:`, err)
      }
    }

    const nextOffset = offset + processedCount
    const completed = nextOffset >= this.scanTotalFiles

    return {
      processed: processedCount,
      completed,
      nextOffset,
      totalFiles: this.scanTotalFiles,
    }
  }

  /**
   * Finalize the scan by building all derived state (refs, edges, PageRank, etc).
   * Should be called once after all file batches have been processed.
   */
  async finalizeScan(): Promise<void> {
    await this.collectEntrypoints()
    await this.resolveUnresolvedRefs()
    await this.buildEdges()
    await this.computePageRank()
    this.linkTestFiles()
    await this.buildCallGraph()
    await this.buildCoChanges()
    this.rescueOrphans()
  }

  /**
   * Reset graph data tables before a fresh full scan.
   * This ensures stale file entries and derived data from previous scans are removed.
   */
  private resetGraphDataForFullScan(): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM refs')
      this.db.run('DELETE FROM edges')
      this.db.run('DELETE FROM calls')
      this.db.run('DELETE FROM cochanges')
      this.db.run('DELETE FROM entrypoints')
      this.db.run('DELETE FROM shape_hashes')
      this.db.run('DELETE FROM token_signatures')
      this.db.run('DELETE FROM token_fragments')
      this.db.run('DELETE FROM external_imports')
      this.db.run('DELETE FROM semantic_summaries')
      // Drop and recreate FTS table to avoid trigger issues on empty content tables
      this.db.run('DROP TABLE IF EXISTS symbols_fts')
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
          name,
          path,
          kind
        )
      `)
      this.db.run('DROP TRIGGER IF EXISTS symbols_ai')
      this.db.run('DROP TRIGGER IF EXISTS symbols_ad')
      this.db.run('DROP TRIGGER IF EXISTS symbols_au')
      this.db.run(`
        CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
          INSERT INTO symbols_fts(rowid, name, path, kind)
          VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
        END
      `)
      this.db.run(`
        CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
          DELETE FROM symbols_fts WHERE rowid = old.id;
        END
      `)
      this.db.run(`
        CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
          DELETE FROM symbols_fts WHERE rowid = old.id;
          INSERT INTO symbols_fts(rowid, name, path, kind)
          VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
        END
      `)
      this.db.run('DELETE FROM symbols')
      this.db.run('DELETE FROM files')
    })()
  }



  async indexFile(filePath: string): Promise<void> {
    const absPath = filePath.startsWith('/') ? filePath : resolve(this.cwd, filePath)
    const relPath = relative(this.cwd, absPath)

    const ext = extname(absPath).toLowerCase()
    if (!(ext in INDEXABLE_EXTENSIONS)) return

    let stats: { size: number; mtimeMs: number }
    try {
      stats = statSync(absPath)
    } catch {
      return
    }

    if (stats.size > 500_000) return

    const outline = await this.treeSitter.getFileOutline(absPath)
    if (!outline) return

    const existing = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
    if (existing && existing.mtime_ms === stats.mtimeMs) {
      return
    }

    const isBarrel = isBarrelFile(relPath)
    const lineCount = outline.symbols.length > 0
      ? Math.max(...outline.symbols.map(s => s.location.endLine || s.location.line))
      : 1

    // Async I/O: collect all data before entering the synchronous transaction
    const { readFile } = await import('fs/promises')
    const content = await readFile(absPath, 'utf-8')
    const lines = content.split('\n')

    // Pre-resolve imports
    const resolvedImports: Array<{ specifiers: string[]; sourceFileId: number | null; importSource: string; isDynamic: boolean }> = []
    const externalImports: Array<{ package: string; specifiers: string[] }> = []

    for (const imp of outline.imports) {
      const isRelative = imp.source.startsWith('.') || imp.source.startsWith('/')

      // Type-only imports don't create runtime edges, but we still track external packages
      if (imp.isTypeOnly && isRelative) {
        continue
      }

      if (isRelative) {
        const resolvedSource = await this.resolveImportSource(imp.source, absPath)
        let sourceFileId: number | null = null
        if (resolvedSource) {
          const resolvedFile = this.stmts.getFileByPath.get(resolvedSource) as IndexedFile | undefined
          if (resolvedFile) {
            sourceFileId = resolvedFile.id
          }
        }
        // Only add to resolvedImports if not type-only (type-only imports don't create edges)
        if (!imp.isTypeOnly) {
          resolvedImports.push({ specifiers: imp.specifiers, sourceFileId, importSource: imp.source, isDynamic: imp.isDynamic })
        }
      } else {
        // External packages - track even type-only imports for inventory purposes
        let packageName: string
        if (imp.source.startsWith('@')) {
          const parts = imp.source.split('/')
          packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]
        } else {
          packageName = imp.source.split('/')[0]
        }
        externalImports.push({ package: packageName, specifiers: imp.specifiers })
      }
    }

    const shapeHashes = await this.treeSitter.getShapeHashes(filePath)

    // Pre-compute token data
    const tokenSignatures: Array<{ name: string; line: number; endLine: number; minhash: Uint32Array }> = []
    let fragmentHashes: Array<{ hash: string; tokenOffset: number }> = []
    try {
      const cachedContent = await this.cache.get(absPath) || ''
      const tokens = tokenize(cachedContent)
      const minhash = computeMinHash(tokens)
      if (minhash) {
        for (const sym of outline.symbols) {
          const symMinhash = computeMinHash(tokens.slice(
            Math.floor((sym.location.line - 1) * tokens.length / lineCount),
            Math.floor((sym.location.endLine || sym.location.line) * tokens.length / lineCount)
          ))
          if (symMinhash) {
            tokenSignatures.push({
              name: sym.name,
              line: sym.location.line,
              endLine: sym.location.endLine || sym.location.line,
              minhash: symMinhash,
            })
          }
        }
        fragmentHashes = computeFragmentHashes(tokens)
      }
    } catch (err) {
      console.debug('Token extraction failed for file:', filePath, err)
    }

    // All DB writes in a single transaction
    this.db.transaction(() => {
      if (existing) {
        this.stmts.deleteRefsByFileId.run([existing.id])
        this.stmts.deleteEdgesBySource.run([existing.id])
        this.stmts.deleteEdgesByTarget.run([existing.id])
        this.stmts.deleteSymbolsByFileId.run([existing.id])
        this.stmts.deleteShapeHashesByFileId.run([existing.id])
        this.stmts.deleteTokenSignaturesByFileId.run([existing.id])
        this.stmts.deleteTokenFragmentsByFileId.run([existing.id])
        this.stmts.deleteFile.run([existing.id])
      }

      const fileId = this.db.run(
        'INSERT INTO files (path, mtime_ms, language, line_count, symbol_count, pagerank, is_barrel, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [relPath, stats.mtimeMs, outline.language, lineCount, outline.symbols.length, 0, isBarrel ? 1 : 0, Date.now()]
      ).lastInsertRowid as number

      const seenSymbols = new Set<string>()
      const exportedSymbols = outline.symbols.filter(sym => 
        outline.exports.some(e => e.name === sym.name)
      )
      
      for (const sym of outline.symbols) {
        const key = `${sym.location.line}-${sym.name}-${sym.kind}`
        if (seenSymbols.has(key)) continue
        seenSymbols.add(key)

        const signature = extractSignature(lines, sym.location.line - 1, sym.kind)
        this.stmts.insertSymbol.run([
          fileId,
          sym.name,
          sym.kind,
          sym.location.line,
          sym.location.endLine || sym.location.line,
          outline.exports.some(e => e.name === sym.name) ? 1 : 0,
          signature || null,
          sym.name
        ])
      }

      // Detect same-file references to exported symbols
      if (exportedSymbols.length > 0) {
        const exportedNames = new Set(exportedSymbols.map(s => s.name))
        const seenSelfRefs = new Set<string>()
        
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]
          for (const exportedName of exportedNames) {
            // Skip the declaration line itself
            const declaringSymbol = exportedSymbols.find(s => s.name === exportedName)
            if (declaringSymbol && lineIdx + 1 === declaringSymbol.location.line) continue
            
            // Use word boundary regex to find references
            // Escape regex special characters in identifier names (e.g., $ in $state)
            const escapedName = exportedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            // Use negative lookbehind/lookahead for word boundaries to handle $ prefixes
            const regex = new RegExp(`(?<![a-zA-Z0-9_$])${escapedName}(?![a-zA-Z0-9_$])`, 'g')
            if (regex.test(line)) {
              const refKey = `${exportedName}-${lineIdx}`
              if (!seenSelfRefs.has(refKey)) {
                seenSelfRefs.add(refKey)
                this.stmts.insertRef.run([fileId, exportedName, fileId, '<self>', 0])
              }
            }
          }
        }
      }

      for (const ref of resolvedImports) {
        if (ref.isDynamic) {
          // Dynamic import: insert a synthetic ref with specifier '*' and mark as dynamic
          // This prevents the target's exports from being flagged as unused
          this.stmts.insertRef.run([fileId, '*', ref.sourceFileId, ref.importSource, 1])
        } else {
          for (const specifier of ref.specifiers) {
            // Insert refs - use fileId (the importing file) as file_id
            // source_file_id will be filled in by resolveUnresolvedRefs if the source is found
            this.stmts.insertRef.run([fileId, specifier, ref.sourceFileId, ref.importSource, 0])
          }
        }
      }

      for (const extImp of externalImports) {
        this.db.run(
          'INSERT INTO external_imports (file_id, package, specifiers) VALUES (?, ?, ?)',
          [fileId, extImp.package, extImp.specifiers.join(',')]
        )
      }

      if (shapeHashes) {
        for (const hash of shapeHashes) {
          this.db.run(
            'INSERT INTO shape_hashes (file_id, name, kind, line, end_line, shape_hash, node_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [fileId, hash.name, hash.kind, hash.line, hash.endLine, hash.shapeHash, hash.nodeCount]
          )
        }
      }

      for (const sig of tokenSignatures) {
        this.db.run(
          'INSERT INTO token_signatures (file_id, name, line, end_line, minhash) VALUES (?, ?, ?, ?, ?)',
          [fileId, sig.name, sig.line, sig.endLine, sig.minhash]
        )
      }

      for (const frag of fragmentHashes) {
        this.db.run(
          'INSERT INTO token_fragments (hash, file_id, name, line, token_offset) VALUES (?, ?, ?, ?, ?)',
          [frag.hash, fileId, '', 1, frag.tokenOffset]
        )
      }
    })()
  }

  private async resolveImportSource(importSource: string, fromFile: string): Promise<string | null> {
    const fromDir = dirname(fromFile)
    
    if (importSource.startsWith('.')) {
      const resolved = resolve(fromDir, importSource)
      
      if (existsSync(resolved)) return relative(this.cwd, resolved)
      
      for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.py', '.go', '.rs']) {
        if (existsSync(resolved + ext)) {
          return relative(this.cwd, resolved + ext)
        }
      }
      
      for (const index of ['/index.ts', '/index.tsx', '/index.js', '/__init__.py']) {
        if (existsSync(resolved + index)) {
          return relative(this.cwd, resolved + index)
        }
      }
      
      return null
    }
    
    return null
  }

  async resolveUnresolvedRefs(): Promise<void> {
    const unresolved = this.stmts.getUnresolvedRefs.all() as Ref[]
    if (unresolved.length === 0) return

    const findExported = this.db.prepare(`
      SELECT s.id, s.file_id, f.path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name = ? AND s.is_exported = 1
    `)

    this.db.transaction(() => {
      for (const ref of unresolved) {
        const matches = findExported.all(ref.name) as Array<{ id: number; file_id: number; path: string }>

        if (matches.length >= 1) {
          if (ref.import_source) {
            const pathMatch = matches.find(m => {
              const importPath = ref.import_source.startsWith('.')
                ? ref.import_source
                : ref.import_source
              return m.path === importPath || m.path.endsWith(importPath)
            })
            if (pathMatch) {
              this.db.run('UPDATE refs SET source_file_id = ? WHERE id = ?', [pathMatch.file_id, ref.id])
              continue
            }
          }

          this.db.run('UPDATE refs SET source_file_id = ? WHERE id = ?', [matches[0].file_id, ref.id])
        }
      }
    })()
  }

  async buildEdges(): Promise<void> {
    const refs = this.stmts.getAllRefs.all() as Ref[]
    const edgeMap = new Map<string, { weight: number; confidence: number }>()

    for (const ref of refs) {
      if (ref.source_file_id && ref.import_source !== '<self>') {
        const key = `${ref.file_id}-${ref.source_file_id}`
        const existing = edgeMap.get(key)
        if (existing) {
          edgeMap.set(key, { weight: existing.weight + 1, confidence: existing.confidence })
        } else {
          edgeMap.set(key, { weight: 1, confidence: 1 })
        }
      }
    }

    this.db.transaction(() => {
      for (const [key, data] of edgeMap) {
        const [source, target] = key.split('-').map(Number)
        const idf = Math.log(2)
        const dampenedWeight = data.weight * idf
        this.stmts.insertEdge.run([source, target, dampenedWeight, data.confidence])
      }
    })()
  }



  async computePageRank(): Promise<void> {
    const files = this.stmts.getAllFiles.all() as IndexedFile[]
    const n = files.length
    
    if (n === 0) return
    
    const damping = PAGERANK_DAMPING
    const iterations = PAGERANK_ITERATIONS
    
    const ranks = new Map<number, number>()
    for (const file of files) {
      ranks.set(file.id, 1 / n)
    }
    
    const edges = this.stmts.getAllEdges.all() as Edge[]
    const outgoing = new Map<number, number>()
    const incoming = new Map<number, Edge[]>()
    
    for (const edge of edges) {
      outgoing.set(edge.source_file_id, (outgoing.get(edge.source_file_id) || 0) + edge.weight)
      if (!incoming.has(edge.target_file_id)) {
        incoming.set(edge.target_file_id, [])
      }
      incoming.get(edge.target_file_id)!.push(edge)
    }
    
    for (let iter = 0; iter < iterations; iter++) {
      const newRanks = new Map<number, number>()
      
      for (const file of files) {
        let rank = (1 - damping) / n
        
        const incomingEdges = incoming.get(file.id) || []
        for (const edge of incomingEdges) {
          const outWeight = outgoing.get(edge.source_file_id) || 1
          const sourceRank = ranks.get(edge.source_file_id) || 0
          rank += damping * (sourceRank * edge.weight / outWeight)
        }
        
        newRanks.set(file.id, rank)
      }
      
      ranks.clear()
      for (const [k, v] of newRanks) {
        ranks.set(k, v)
      }
    }
    
    this.db.transaction(() => {
      for (const file of files) {
        const rank = ranks.get(file.id) || 0
        this.db.run('UPDATE files SET pagerank = ? WHERE id = ?', [rank, file.id])
      }
    })()
  }

  async computePageRankSync(): Promise<void> {
    await this.computePageRank()
  }

  async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
    const maxFiles = opts?.maxFiles ?? 20
    const maxSymbolsPerFile = opts?.maxSymbols ?? 5
    
    const files = this.stmts.getAllFiles.all() as IndexedFile[]
    if (!files || files.length === 0) {
      return { content: '', paths: [] }
    }
    
    const topFiles = files.slice(0, maxFiles)
    
    let content = ''
    const paths: string[] = []
    
    for (const file of topFiles) {
      const symbols = this.stmts.getSymbolsByFileId.all(file.id) as DbSymbol[]
      if (!symbols || symbols.length === 0) continue
      
      content += `// ${file.path}\n`
      for (const sym of symbols.slice(0, maxSymbolsPerFile)) {
        content += `//   ${kindTag(sym.kind as SymbolKind)}${sym.name}\n`
      }
      content += '\n'
      paths.push(file.path)
    }
    
    return { content, paths }
  }

  getStats(): GraphStats {
    const counts = this.stmts.getCounts.get() as { files: number; symbols: number; edges: number }
    const summaries = this.db.prepare('SELECT COUNT(*) as count FROM semantic_summaries').get() as { count: number }
    const calls = this.db.prepare('SELECT COUNT(*) as count FROM calls').get() as { count: number }
    
    return {
      files: counts.files,
      symbols: counts.symbols,
      edges: counts.edges,
      summaries: summaries.count,
      calls: calls.count,
    }
  }

  getTopFiles(limit = 20): TopFileResult[] {
    const files = this.db.prepare('SELECT * FROM files ORDER BY pagerank DESC LIMIT ?').all(limit) as DbFile[]
    return files.map(f => ({
      path: f.path,
      pagerank: f.pagerank,
      lines: f.line_count,
      symbols: f.symbol_count,
      language: f.language,
    }))
  }

  getFileDependents(path: string): FileDepResult[] {
    const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
    if (!file) return []
    
    const edges = this.stmts.getEdgesByTargetFile.all(file.id) as Edge[]
    const results: FileDepResult[] = []
    
    for (const edge of edges) {
      const source = this.stmts.getFileById.get(edge.source_file_id) as IndexedFile | undefined
      if (source) {
        results.push({ path: source.path, weight: edge.weight })
      }
    }
    
    return results
  }

  getFileDependencies(path: string): FileDepResult[] {
    const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
    if (!file) return []
    
    const edges = this.stmts.getEdgesBySourceFile.all(file.id) as Edge[]
    const results: FileDepResult[] = []
    
    for (const edge of edges) {
      const target = this.stmts.getFileById.get(edge.target_file_id) as IndexedFile | undefined
      if (target) {
        results.push({ path: target.path, weight: edge.weight })
      }
    }
    
    return results
  }

  getFileCoChanges(path: string): FileCoChangeResult[] {
    const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
    if (!file) return []
    
    const cochanges = this.stmts.getCoChanges.all(file.id, file.id, file.id) as Array<{ other_id: number; count: number }>
    
    return cochanges.map(c => {
      const other = this.stmts.getFileById.get(c.other_id) as IndexedFile | undefined
      return {
        path: other?.path || '',
        count: c.count,
      }
    }).filter(r => r.path)
  }

  getFileBlastRadius(path: string): number {
    const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
    if (!file) return 0
    
    const visited = new Set<number>()
    const queue = [file.id]
    
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      
      const edges = this.stmts.getEdgesTargetIds.all(id) as Array<{ target_file_id: number }>
      for (const edge of edges) {
        if (!visited.has(edge.target_file_id)) {
          queue.push(edge.target_file_id)
        }
      }
    }
    
    return visited.size - 1
  }

  getFileSymbols(path: string): FileSymbolResult[] {
    const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
    if (!file) return []
    
    const symbols = this.stmts.getFileSymbolsQuery.all(file.id) as DbSymbol[]
    return symbols.map(s => ({
      name: s.name,
      kind: s.kind,
      isExported: !!s.is_exported,
      line: s.line,
      endLine: s.end_line,
    }))
  }

  findSymbols(query: string, limit = 50): SymbolSearchResult[] {
    const results = this.db.prepare(`
      SELECT s.name, f.path, s.kind, s.line, s.is_exported AS isExported, f.pagerank, s.id
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name LIKE ?
      ORDER BY f.pagerank DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as Array<SymbolSearchResult & { id: number }>
    
    return results
  }

  searchSymbolsFts(query: string, limit = 50): SymbolSearchResult[] {
    try {
      const results = this.stmts.searchSymbolsFtsQuery.all(query, limit) as Array<SymbolSearchResult & { id: number }>
      
      return results
    } catch {
      return []
    }
  }

  getSymbolSignature(path: string, line: number): SymbolSignatureResult | null {
    const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
    if (!file) return null
    
    const symbol = this.stmts.getSymbolByFileAndLine.get(file.id, line) as { id: number; name: string; kind: string; line: number; signature?: string } | undefined
    
    if (!symbol) return null
    
    return {
      path,
      kind: symbol.kind,
      signature: symbol.signature || '',
      line: symbol.line,
    }
  }

  getCallers(path: string, line: number): CallerResult[] {
    // Find the symbol at the given location
    const fileId = this.stmts.getFileByPath.get(path) as { id: number } | undefined
    if (!fileId) return []

    const symbol = this.stmts.getSymbolByFileAndLine.get(fileId.id, line) as { id: number; name: string } | undefined

    if (!symbol) return []

    // Find all calls where this symbol is the callee - use both name and file for disambiguation
    const callers = this.db.prepare(`
      SELECT s.name as caller_name, f.path as caller_path, s.line as caller_line, c.line as call_line
      FROM calls c
      JOIN symbols s ON c.caller_symbol_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE c.callee_name = ? AND (c.callee_file_id IS NULL OR c.callee_file_id = ?)
    `).all(symbol.name, fileId.id) as Array<{
      caller_name: string
      caller_path: string
      caller_line: number
      call_line: number
    }>

    return callers.map(c => ({
      callerName: c.caller_name,
      callerPath: c.caller_path,
      callerLine: c.caller_line,
      callLine: c.call_line,
    }))
  }

  getCallees(path: string, line: number): CalleeResult[] {
    // Find the symbol at the given location
    const fileId = this.stmts.getFileByPath.get(path) as { id: number } | undefined
    if (!fileId) return []

    const symbol = this.stmts.getSymbolByFileAndLine.get(fileId.id, line) as { id: number; name: string } | undefined

    if (!symbol) return []

    // Find all calls made by this symbol - use symbol id for precise matching
    const callees = this.db.prepare(`
      SELECT c.callee_name, f.path as callee_file, c.line as call_line, 
             (SELECT line FROM symbols WHERE id = c.callee_symbol_id) as callee_def_line
      FROM calls c
      JOIN files f ON c.callee_file_id = f.id
      WHERE c.caller_symbol_id = ?
    `).all(symbol.id) as Array<{
      callee_name: string
      callee_file: string
      call_line: number
      callee_def_line: number | undefined
    }>

    return callees.map(c => ({
      calleeName: c.callee_name,
      calleeFile: c.callee_file,
      calleeLine: c.callee_def_line || c.call_line,
      callLine: c.call_line,
    }))
  }

  getUnusedExports(limit = 50, includeInternalOnly = false): UnusedExportResult[] {
    const results = this.stmts.getUnusedExportsQuery.all(limit) as Array<{
      id: number
      name: string
      kind: string
      line: number
      end_line: number
      path: string
      line_count: number
      has_self: number
    }>

    // Filter out symbols used internally unless explicitly requested
    const filtered = results.filter(r => includeInternalOnly || r.has_self === 0)

    return filtered.map(r => ({
      name: r.name,
      path: r.path,
      kind: r.kind,
      line: r.line,
      endLine: r.end_line,
      lineCount: r.line_count,
      usedInternally: r.has_self === 1,
    }))
  }

  getDuplicateStructures(limit = 20): DuplicateStructureResult[] {
    const hashes = this.db.prepare(`
      SELECT shape_hash, kind, node_count, 
        GROUP_CONCAT(file_id || ':' || line) as members
      FROM shape_hashes
      GROUP BY shape_hash
      HAVING COUNT(*) > 1
      LIMIT ?
    `).all(limit) as Array<{ shape_hash: string; kind: string; node_count: number; members: string }>
    
    return hashes.map(h => ({
      shapeHash: h.shape_hash,
      kind: h.kind,
      nodeCount: h.node_count,
      members: h.members.split(',').map(m => {
        const [fileId, line] = m.split(':')
        const file = this.stmts.getFileById.get(Number(fileId)) as IndexedFile | undefined
        return { path: file?.path || '', line: Number(line) }
      }),
    }))
  }

  getNearDuplicates(threshold = 0.8, limit = 50): NearDuplicateResult[] {
    const signatures = this.db.prepare('SELECT * FROM token_signatures').all() as Array<{
      id: number
      file_id: number
      name: string
      line: number
      end_line: number
      minhash: Buffer
    }>

    if (signatures.length === 0) return []

    // Convert BLOB minhash buffers to Uint32Array views
    const parsed = signatures.map(s => ({
      ...s,
      minhashArr: new Uint32Array(s.minhash.buffer, s.minhash.byteOffset, s.minhash.byteLength / 4),
    }))

    // LSH banding: 16 bands of 8 rows each (128 total hash values)
    const LSH_BANDS = 16
    const ROWS_PER_BAND = 8
    const MAX_BUCKET_SIZE = 100

    const buckets = new Map<string, number[]>()
    for (let idx = 0; idx < parsed.length; idx++) {
      const mh = parsed[idx].minhashArr
      for (let b = 0; b < LSH_BANDS; b++) {
        const offset = b * ROWS_PER_BAND
        const slice = mh.subarray(offset, offset + ROWS_PER_BAND)
        const key = `${b}:${Bun.hash(new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength))}`
        let bucket = buckets.get(key)
        if (!bucket) { bucket = []; buckets.set(key, bucket) }
        bucket.push(idx)
      }
    }

    // Collect candidate pairs from shared buckets
    const candidatePairs = new Set<string>()
    for (const members of buckets.values()) {
      if (members.length < 2 || members.length > MAX_BUCKET_SIZE) continue
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = Math.min(members[i], members[j])
          const b = Math.max(members[i], members[j])
          candidatePairs.add(`${a}:${b}`)
        }
      }
    }

    // Compare only candidate pairs
    const results: NearDuplicateResult[] = []
    for (const pairKey of candidatePairs) {
      const [ai, bi] = pairKey.split(':').map(Number)
      const a = parsed[ai]
      const b = parsed[bi]

      if (a.file_id === b.file_id) continue

      const similarity = jaccardSimilarity(a.minhashArr, b.minhashArr)

      if (similarity >= threshold) {
        const fileA = this.stmts.getFileById.get(a.file_id) as IndexedFile | undefined
        const fileB = this.stmts.getFileById.get(b.file_id) as IndexedFile | undefined

        if (fileA && fileB) {
          results.push({
            similarity,
            a: { path: fileA.path, line: a.line, name: a.name },
            b: { path: fileB.path, line: b.line, name: b.name },
          })
        }
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
  }

  getExternalPackages(limit = 50): ExternalPackageResult[] {
    const packages = this.db.prepare(`
      SELECT package, COUNT(DISTINCT file_id) as file_count,
        GROUP_CONCAT(DISTINCT specifiers) as specifiers
      FROM external_imports
      GROUP BY package
      ORDER BY file_count DESC
      LIMIT ?
    `).all(limit) as Array<{ package: string; file_count: number; specifiers: string }>
    
    return packages.map(p => ({
      package: p.package,
      fileCount: p.file_count,
      specifiers: p.specifiers ? p.specifiers.split(',').map(s => s.trim()) : [],
    }))
  }

  getOrphanFiles(limit = 50): OrphanFileResult[] {
    const results = this.stmts.getOrphanFilesQuery.all(limit) as Array<{
      path: string
      language: string
      line_count: number
      symbol_count: number
    }>

    return results.map(r => ({
      path: r.path,
      language: r.language,
      lineCount: r.line_count,
      symbolCount: r.symbol_count,
    }))
  }

  getCircularDependencies(limit = 20): CircularDependencyResult[] {
    const edges = this.stmts.getAllEdges.all() as Edge[]
    const files = this.stmts.getAllFiles.all() as IndexedFile[]

    if (files.length === 0 || edges.length === 0) return []

    // Build adjacency list
    const adj = new Map<number, number[]>()
    const selfEdges = new Set<number>()
    for (const edge of edges) {
      if (edge.source_file_id === edge.target_file_id) {
        selfEdges.add(edge.source_file_id)
        continue
      }
      let list = adj.get(edge.source_file_id)
      if (!list) { list = []; adj.set(edge.source_file_id, list) }
      list.push(edge.target_file_id)
    }

    // Iterative Tarjan's SCC
    const index = new Map<number, number>()
    const lowlink = new Map<number, number>()
    const onStack = new Set<number>()
    const stack: number[] = []
    let idx = 0
    const sccs: number[][] = []

    const allNodeIds = files.map(f => f.id)

    for (const startNode of allNodeIds) {
      if (index.has(startNode)) continue

      // Iterative DFS with explicit call stack
      // Each frame: [node, neighborIndex, isReturning]
      const callStack: Array<{ node: number; ni: number }> = []
      index.set(startNode, idx)
      lowlink.set(startNode, idx)
      idx++
      stack.push(startNode)
      onStack.add(startNode)
      callStack.push({ node: startNode, ni: 0 })

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1]
        const neighbors = adj.get(frame.node) || []

        if (frame.ni < neighbors.length) {
          const w = neighbors[frame.ni]
          frame.ni++

          if (!index.has(w)) {
            index.set(w, idx)
            lowlink.set(w, idx)
            idx++
            stack.push(w)
            onStack.add(w)
            callStack.push({ node: w, ni: 0 })
          } else if (onStack.has(w)) {
            lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, lowlink.get(w)!))
          }
        } else {
          // Done with this node — check if it's an SCC root
          if (lowlink.get(frame.node) === index.get(frame.node)) {
            const scc: number[] = []
            let w: number
            do {
              w = stack.pop()!
              onStack.delete(w)
              scc.push(w)
            } while (w !== frame.node)
            sccs.push(scc)
          }

          callStack.pop()
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1]
            lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!))
          }
        }
      }
    }

    // Resolve file IDs to paths
    const filePathMap = new Map<number, string>()
    for (const f of files) filePathMap.set(f.id, f.path)

    const results: CircularDependencyResult[] = []
    for (const scc of sccs) {
      if (scc.length > 1 || (scc.length === 1 && selfEdges.has(scc[0]))) {
        results.push({
          cycle: scc.map(id => filePathMap.get(id) || ''),
          length: scc.length,
        })
      }
    }

    return results.sort((a, b) => b.length - a.length).slice(0, limit)
  }

  getChangeImpact(paths: string[], maxDepth = 5): ChangeImpactResult {
    const startIds: number[] = []
    const validPaths: string[] = []
    for (const p of paths) {
      const file = this.stmts.getFileByPath.get(p) as IndexedFile | undefined
      if (file) {
        startIds.push(file.id)
        validPaths.push(p)
      }
    }

    if (startIds.length === 0) return { changedFiles: [], impactedFiles: [], totalAffected: 0 }

    // Multi-source BFS on reverse edge direction (who depends on changed files)
    const visited = new Map<number, number>()
    const queue: Array<{ id: number; depth: number }> = []

    for (const id of startIds) {
      visited.set(id, 0)
      queue.push({ id, depth: 0 })
    }

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!
      if (depth >= maxDepth) continue

      const dependents = this.stmts.getEdgesSourceIdsByTarget.all(id) as Array<{ source_file_id: number }>
      for (const dep of dependents) {
        if (!visited.has(dep.source_file_id)) {
          visited.set(dep.source_file_id, depth + 1)
          queue.push({ id: dep.source_file_id, depth: depth + 1 })
        }
      }
    }

    // Exclude seed files from results
    const seedSet = new Set(startIds)
    const impactedFiles: ImpactedFile[] = []
    for (const [fileId, depth] of visited) {
      if (seedSet.has(fileId)) continue
      const file = this.stmts.getFileById.get(fileId) as IndexedFile | undefined
      if (file) {
        impactedFiles.push({ path: file.path, depth })
      }
    }

    impactedFiles.sort((a, b) => a.depth - b.depth)

    return {
      changedFiles: validPaths,
      impactedFiles,
      totalAffected: impactedFiles.length,
    }
  }

  getSymbolReferences(name: string, limit = 50): SymbolReferenceResult[] {
    const results: SymbolReferenceResult[] = []

    // Import references
    const imports = this.stmts.getRefsByName.all(name) as Array<{ path: string; import_source: string }>
    for (const imp of imports) {
      results.push({
        kind: 'import',
        path: imp.path,
        line: 0,
        context: `import { ${name} } from '${imp.import_source}'`,
      })
    }

    // Call sites
    const calls = this.stmts.getCallsByCalleeName.all(name) as Array<{ line: number; caller_name: string; path: string }>
    for (const call of calls) {
      results.push({
        kind: 'call',
        path: call.path,
        line: call.line,
        context: call.caller_name,
      })
    }

    // Re-exports (barrel files)
    const reexports = this.stmts.getReexportsByName.all(name) as Array<{ path: string; line: number }>
    for (const re of reexports) {
      results.push({
        kind: 'reexport',
        path: re.path,
        line: re.line,
      })
    }

    return results.slice(0, limit)
  }

  async onFileChanged(path: string): Promise<{ status: string }> {
    const absPath = resolve(path)
    const relPath = relative(this.cwd, absPath)
    
    try {
      // Check if file still exists
      try {
        statSync(absPath)
      } catch {
        // File was deleted - remove from graph
        await this.removeFile(relPath)
        // Rebuild all derived state after deletion
        await this.buildEdges()
        await this.resolveUnresolvedRefs()
        await this.computePageRank()
        await this.buildCallGraph()
        return { status: 'ok' }
      }
      
      // Re-index the file
      await this.indexFile(relPath)
      
      // Rebuild all derived state for correctness
      const file = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
      if (file) {
        // Remove stale edges
        this.stmts.deleteEdgesBySource.run([file.id])
        this.stmts.deleteEdgesByTarget.run([file.id])
        
        // Resolve any unresolved refs after reindexing
        await this.resolveUnresolvedRefs()
        
        // Rebuild edges from all refs (not just this file's outgoing)
        await this.buildEdges()
        
        // Recompute PageRank
        await this.computePageRank()
        
        // Rebuild call graph
        await this.buildCallGraph()
      }
      
      return { status: 'ok' }
    } catch (err) {
      console.error('Error updating file:', err)
      return { status: 'error' }
    }
  }

  private async removeFile(relPath: string): Promise<void> {
    const existing = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
    if (!existing) return

    // Delete all related data
    this.stmts.deleteRefsByFileId.run([existing.id])
    this.stmts.deleteEdgesBySource.run([existing.id])
    this.stmts.deleteEdgesByTarget.run([existing.id])
    this.stmts.deleteSymbolsByFileId.run([existing.id])
    this.stmts.deleteShapeHashesByFileId.run([existing.id])
    this.stmts.deleteTokenSignaturesByFileId.run([existing.id])
    this.stmts.deleteTokenFragmentsByFileId.run([existing.id])
    this.stmts.deleteExternalImportsByFileId.run([existing.id])
    this.stmts.deleteFile.run([existing.id])
  }

  async buildCoChanges(): Promise<void> {
    // Check if git is available
    try {
      const { execSync } = await import('child_process')
      execSync('git rev-parse --git-dir', { cwd: this.cwd, stdio: 'pipe' })
    } catch {
      return // Not a git repo
    }

    this.db.run('DELETE FROM cochanges')

    let logOutput: string
    try {
      const { execFile } = await import('child_process')
      logOutput = await new Promise<string>((resolve, reject) => {
        execFile(
          'git',
          ['log', '--pretty=format:---COMMIT---', '--name-only', '-n', '300'],
          { cwd: this.cwd, timeout: 10_000, maxBuffer: 5_000_000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        )
      })
    } catch {
      return
    }

    const pathToId = new Map<string, number>()
    for (const row of this.db.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>) {
      pathToId.set(row.path, row.id)
    }

    const pairCounts = new Map<string, number>()
    const commits = logOutput.split('---COMMIT---').filter((s) => s.trim())

    for (const commit of commits) {
      const files = commit
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && pathToId.has(l))

      if (files.length < 2 || files.length > 20) continue

      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const a = files[i] as string
          const b = files[j] as string
          const key = a < b ? `${a}\0${b}` : `${b}\0${a}`
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
        }
      }
    }

    if (pairCounts.size === 0) return

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO cochanges (file_id_a, file_id_b, count)
      VALUES (?, ?, ?)
    `)

    const entries = [...pairCounts.entries()].filter(([, count]) => count >= 2)
    const tx = this.db.transaction(() => {
      for (const [key, count] of entries) {
        const [a, b] = key.split('\0') as [string, string]
        const idA = pathToId.get(a)
        const idB = pathToId.get(b)
        if (idA !== undefined && idB !== undefined) {
          insert.run(idA, idB, count)
        }
      }
    })
    tx()
  }

  async buildCallGraph(): Promise<void> {
    const { readFileSync } = await import('fs')
    const regexCache = new Map<string, RegExp>()
    this.db.run('DELETE FROM calls')

    const filesWithImports = this.stmts.getFilesWithImports.all() as Array<{ id: number; path: string }>

    if (filesWithImports.length === 0) return

    // Pre-read all files
    const fileContents = new Map<number, string[]>()
    for (const file of filesWithImports) {
      try {
        const content = readFileSync(join(this.cwd, file.path), 'utf-8')
        fileContents.set(file.id, content.split('\n'))
      } catch {}
    }

    const tx = this.db.transaction(() => {
      for (const file of filesWithImports) {
        const lines = fileContents.get(file.id)
        if (!lines) continue

        const imports = this.stmts.getImportsForFile.all(file.id) as Array<{ name: string; source_file_id: number }>
        if (imports.length === 0) continue

        const functions = this.stmts.getFunctionsForFile.all(file.id) as Array<{ id: number; name: string; line: number; end_line: number }>
        if (functions.length === 0) continue

        const importPatterns = imports.map((imp) => {
          const escaped = imp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          let re = regexCache.get(imp.name)
          if (!re) {
            re = new RegExp(`\\b${escaped}\\b`)
            regexCache.set(imp.name, re)
          }
          return { name: imp.name, sourceFileId: imp.source_file_id, re }
        })

        for (const func of functions) {
          const bodyStart = func.line
          const bodyEnd = Math.min(func.end_line, lines.length)
          const bodyText = lines.slice(bodyStart - 1, bodyEnd).join('\n')

          for (const imp of importPatterns) {
            if (imp.name === func.name) continue

            if (imp.re.test(bodyText)) {
              let callLine = func.line
              for (let i = bodyStart - 1; i < bodyEnd; i++) {
                const ln = lines[i]
                if (ln !== undefined && imp.re.test(ln)) {
                  callLine = i + 1
                  break
                }
              }

              const calleeRow = this.stmts.resolveCallee.get(imp.sourceFileId, imp.name) as { id: number } | undefined
              this.stmts.insertCall.run(
                func.id,
                imp.name,
                calleeRow?.id ?? null,
                imp.sourceFileId,
                callLine,
              )
            }
          }
        }
      }
    })
    tx()
  }

  async collectEntrypoints(): Promise<void> {
    const { readFile } = await import('fs/promises')
    const { existsSync } = await import('fs')
    
    const packageJsonPath = join(this.cwd, 'package.json')
    if (!existsSync(packageJsonPath)) return

    try {
      const content = await readFile(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(content)
      
      const entrypoints: Array<{ path: string; reason: string }> = []
      
      // Collect bin entrypoints
      if (pkg.bin) {
        const binEntries = typeof pkg.bin === 'object' ? Object.values(pkg.bin) : [pkg.bin]
        for (const binPath of binEntries) {
          if (typeof binPath === 'string' && binPath.startsWith('./dist/')) {
            // Map dist path to src path
            const srcPath = binPath.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')
            // Normalize path to match stored format (without leading ./)
            const normalizedPath = srcPath.startsWith('./') ? srcPath.slice(2) : srcPath
            entrypoints.push({ path: normalizedPath, reason: 'bin' })
          }
        }
      }
      
      // Collect script entrypoints that look like bun/node invocations
      if (pkg.scripts) {
        for (const script of Object.values(pkg.scripts)) {
          if (typeof script === 'string') {
            const match = script.match(/(?:bun|node)\s+(.+?)(?:\s|$)/)
            if (match) {
              const scriptPath = match[1]
              if (scriptPath.endsWith('.ts')) {
                // Normalize path to match stored format (without leading ./)
                const normalizedPath = scriptPath.startsWith('./') ? scriptPath.slice(2) : scriptPath
                entrypoints.push({ path: normalizedPath, reason: 'script' })
              }
            }
          }
        }
      }
      
      // Insert entrypoints into database
      const insertEntrypoint = this.db.prepare(`
        INSERT OR REPLACE INTO entrypoints (file_id, reason)
        VALUES (?, ?)
      `)
      
      this.db.transaction(() => {
        for (const entrypoint of entrypoints) {
          const file = this.stmts.getFileByPath.get(entrypoint.path) as IndexedFile | undefined
          if (file) {
            insertEntrypoint.run(file.id, entrypoint.reason)
          }
        }
      })()
    } catch {
      // package.json parsing failed - skip entrypoints
    }
  }

  linkTestFiles(): void {
    const testFiles = this.stmts.getTestFiles.all() as Array<{ id: number; path: string }>

    this.db.transaction(() => {
      for (const testFile of testFiles) {
        const sourcePath = testFile.path
          .replace(/\.test\./, '.')
          .replace(/_test\./, '.')
          .replace(/\.spec\./, '.')

        const source = this.stmts.getFileByPath.get(sourcePath) as IndexedFile | undefined
        if (source) {
          this.stmts.insertEdge.run([testFile.id, source.id, 1, 1])
        }
      }
    })()
  }

  rescueOrphans(): void {
    const orphans = this.db.prepare(`
      SELECT f.id, f.path
      FROM files f
      LEFT JOIN edges e ON e.target_file_id = f.id
      WHERE e.target_file_id IS NULL
        AND f.is_barrel = 0
    `).all() as Array<{ id: number; path: string }>

    if (orphans.length === 0) return

    const orphanIds = new Set(orphans.map(o => o.id))

    this.db.transaction(() => {
      for (const orphan of orphans) {
        let rescued = false

        // Strategy 1: co-change evidence (count >= 2 with a non-orphan)
        const cochanges = this.stmts.getCoChanges.all(orphan.id, orphan.id, orphan.id) as Array<{ other_id: number; count: number }>
        for (const cc of cochanges) {
          if (cc.count >= 2 && !orphanIds.has(cc.other_id)) {
            this.stmts.insertEdge.run([cc.other_id, orphan.id, 0.5, 0.5])
            rescued = true
            break
          }
        }
        if (rescued) continue

        // Strategy 2: directory proximity — find a non-orphan sibling
        const dir = orphan.path.substring(0, orphan.path.lastIndexOf('/'))
        if (dir) {
          const sibling = this.db.prepare(`
            SELECT f.id FROM files f
            WHERE f.path LIKE ? || '/%'
              AND f.id != ?
              AND EXISTS (SELECT 1 FROM edges e WHERE e.target_file_id = f.id)
            LIMIT 1
          `).get(`${dir}`, orphan.id) as { id: number } | undefined

          if (sibling) {
            this.stmts.insertEdge.run([sibling.id, orphan.id, 0.3, 0.3])
          }
        }
      }
    })()
  }
}
