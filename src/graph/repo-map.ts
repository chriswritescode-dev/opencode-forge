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
  MAX_INDEXED_FILES,
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
  maxFiles?: number
}

export class RepoMap {
  private db: Database
  private cwd: string
  private treeSitter: TreeSitterBackend
  private cache: FileCache
  private stmts: Record<string, Statement> = {}
  private maxFiles: number

  constructor(config: RepoMapConfig) {
    this.cwd = resolve(config.cwd)
    this.db = config.db
    this.maxFiles = config.maxFiles ?? MAX_INDEXED_FILES
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
        INSERT INTO refs (file_id, name, source_file_id, import_source)
        VALUES (?, ?, ?, ?)
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
          AND EXISTS (SELECT 1 FROM refs r WHERE r.file_id = f.id AND r.name != '*')
      `),
      getImportsForFile: this.db.prepare<{ name: string; source_file_id: number }, [number]>(`
        SELECT DISTINCT r.name, r.source_file_id FROM refs r
        WHERE r.file_id = ? AND r.source_file_id IS NOT NULL AND r.name != '*'
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
        const symbols = this.stmts.getAllSymbols.all() as Array<{ id: number; name: string; file_id: number }>
        for (const sym of symbols) {
          const file = this.stmts.getFileById.get(sym.file_id) as { path: string } | undefined
          if (file) {
            try {
              this.db.run('INSERT INTO symbols_fts (rowid, name, path) VALUES (?, ?, ?)', [sym.id, sym.name, file.path])
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
    const result = await collectFilesAsync(this.cwd)
    const files = result.files.slice(0, this.maxFiles)
    
    for (const file of files) {
      try {
        const relPath = relative(this.cwd, file.path)
        await this.indexFile(relPath)
      } catch (err) {
        console.error(`Error indexing ${file.path}:`, err)
      }
    }

    await this.resolveUnresolvedRefs()
    await this.buildEdges()
    await this.computePageRank()
    this.linkTestFiles()
    await this.buildCallGraph()
    await this.buildCoChanges()
  }



  async indexFile(filePath: string): Promise<void> {
    // Normalize path against cwd - handle both absolute and relative paths
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
    
    // Use absolute path for tree-sitter to ensure consistent caching
    const outline = await this.treeSitter.getFileOutline(absPath)
    if (!outline) return
    
    const existing = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
    if (existing && existing.mtime_ms === stats.mtimeMs) {
      return
    }
    
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
    
    const isBarrel = isBarrelFile(relPath)
    const lineCount = outline.symbols.length > 0 
      ? Math.max(...outline.symbols.map(s => s.location.endLine || s.location.line))
      : 1
    
    const fileId = this.db.run(
      'INSERT INTO files (path, mtime_ms, language, line_count, symbol_count, pagerank, is_barrel, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [relPath, stats.mtimeMs, outline.language, lineCount, outline.symbols.length, 0, isBarrel ? 1 : 0, Date.now()]
    ).lastInsertRowid as number
    
    // Extract signatures using the utility function
    const { readFile } = await import('fs/promises')
    const content = await readFile(absPath, 'utf-8')
    const lines = content.split('\n')
    
    // Deduplicate symbols by line and name to prevent duplicate DB rows
    // This is a second line of defense after tree-sitter deduplication
    const seenSymbols = new Set<string>()
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
    
    // Process imports - distinguish internal vs external
    const externalImports: Array<{ package: string; specifiers: string[] }> = []
    
    for (const imp of outline.imports) {
      const isRelative = imp.source.startsWith('.') || imp.source.startsWith('/')
      
      if (isRelative) {
        // Internal relative import - resolve and track in refs
        const resolvedSource = await this.resolveImportSource(imp.source, absPath)
        let sourceFileId: number | null = null
        
        if (resolvedSource) {
          const resolvedFile = this.stmts.getFileByPath.get(resolvedSource) as IndexedFile | undefined
          if (resolvedFile) {
            sourceFileId = resolvedFile.id
          }
        }
        
        for (const specifier of imp.specifiers) {
          this.stmts.insertRef.run([fileId, specifier, sourceFileId, imp.source])
        }
      } else {
        // External package import - track in external_imports
        // Preserve scoped package names (e.g. @types/node, @opencode-ai/sdk)
        let packageName: string
        if (imp.source.startsWith('@')) {
          // Scoped package: take first two segments (@scope/name)
          const parts = imp.source.split('/')
          packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]
        } else {
          // Unscoped package: take first segment
          packageName = imp.source.split('/')[0]
        }
        externalImports.push({ package: packageName, specifiers: imp.specifiers })
      }
    }
    
    // Insert external imports
    for (const extImp of externalImports) {
      this.db.run(
        'INSERT INTO external_imports (file_id, package, specifiers) VALUES (?, ?, ?)',
        [fileId, extImp.package, extImp.specifiers.join(',')]
      )
    }
    
    const shapeHashes = await this.treeSitter.getShapeHashes(filePath)
    if (shapeHashes) {
      for (const hash of shapeHashes) {
        this.db.run(
          'INSERT INTO shape_hashes (file_id, name, kind, line, end_line, shape_hash, node_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [fileId, hash.name, hash.kind, hash.line, hash.endLine, hash.shapeHash, hash.nodeCount]
        )
      }
    }
    
    try {
      // Use absolute path for cache lookup to match tree-sitter caching convention
      const content = await this.cache.get(absPath) || ''
      const tokens = tokenize(content)
      const minhash = computeMinHash(tokens)
      if (minhash) {
        for (const sym of outline.symbols) {
          const symMinhash = computeMinHash(tokens.slice(
            Math.floor((sym.location.line - 1) * tokens.length / lineCount),
            Math.floor((sym.location.endLine || sym.location.line) * tokens.length / lineCount)
          ))
          if (symMinhash) {
            this.db.run(
              'INSERT INTO token_signatures (file_id, name, line, end_line, minhash) VALUES (?, ?, ?, ?, ?)',
              [fileId, sym.name, sym.location.line, sym.location.endLine || sym.location.line, symMinhash]
            )
          }
        }
        
        const fragmentHashes = computeFragmentHashes(tokens)
        for (const frag of fragmentHashes) {
          this.db.run(
            'INSERT INTO token_fragments (hash, file_id, name, line, token_offset) VALUES (?, ?, ?, ?, ?)',
            [frag.hash, fileId, '', 1, frag.tokenOffset]
          )
        }
      }
    } catch (err) {
      console.debug('Token extraction failed for file:', filePath, err)
    }
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
    
    for (const ref of unresolved) {
      // Find matching exported symbols by name
      // Prefer matches from the import source path if available
      const matches = this.db.prepare(`
        SELECT s.id, s.file_id, f.path 
        FROM symbols s 
        JOIN files f ON s.file_id = f.id 
        WHERE s.name = ? AND s.is_exported = 1
      `).all(ref.name) as Array<{ id: number; file_id: number; path: string }>
      
      if (matches.length >= 1) {
        // If we have an import source, try to match by path first
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
        
        // Fall back to first match by name (best effort for ambiguous cases)
        this.db.run('UPDATE refs SET source_file_id = ? WHERE id = ?', [matches[0].file_id, ref.id])
      }
    }
  }

  async buildEdges(): Promise<void> {
    const refs = this.stmts.getAllRefs.all() as Ref[]
    const edgeMap = new Map<string, { weight: number; confidence: number }>()
    
    for (const ref of refs) {
      if (ref.source_file_id) {
        const key = `${ref.file_id}-${ref.source_file_id}`
        const existing = edgeMap.get(key)
        if (existing) {
          edgeMap.set(key, { weight: existing.weight + 1, confidence: existing.confidence })
        } else {
          edgeMap.set(key, { weight: 1, confidence: 1 })
        }
      }
    }
    
    for (const [key, data] of edgeMap) {
      const [source, target] = key.split('-').map(Number)
      const idf = Math.log(2)
      const dampenedWeight = data.weight * idf
      this.stmts.insertEdge.run([source, target, dampenedWeight, data.confidence])
    }
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
    
    for (const file of files) {
      const rank = ranks.get(file.id) || 0
      this.db.run('UPDATE files SET pagerank = ? WHERE id = ?', [rank, file.id])
    }
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

  getUnusedExports(limit = 50): UnusedExportResult[] {
    const exports = this.db.prepare(`
      SELECT s.*, f.path, f.line_count
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.is_exported = 1
      LIMIT ?
    `).all(limit) as Array<DbSymbol & { path: string; line_count: number }>
    
    const unused: UnusedExportResult[] = []
    
    for (const exp of exports) {
      const used = this.db.prepare(
        'SELECT 1 FROM refs WHERE name = ? AND source_file_id IS NOT NULL LIMIT 1'
      ).get(exp.name)
      
      if (!used) {
        unused.push({
          name: exp.name,
          path: exp.path,
          kind: exp.kind,
          line: exp.line,
          endLine: exp.end_line,
          lineCount: exp.line_count,
          usedInternally: false,
        })
      }
    }
    
    return unused
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
      minhash: Uint32Array
    }>
    
    const results: NearDuplicateResult[] = []
    
    for (let i = 0; i < signatures.length; i++) {
      for (let j = i + 1; j < signatures.length; j++) {
        const a = signatures[i]
        const b = signatures[j]
        
        if (a.file_id === b.file_id) continue
        
        const similarity = jaccardSimilarity(a.minhash, b.minhash)
        
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
    }
    
    return results.slice(0, limit)
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

  linkTestFiles(): void {
    const testFiles = this.stmts.getTestFiles.all() as Array<{ id: number; path: string }>
    
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
  }

  rescueOrphans(): void {
    // Ensure all files have at least some graph connections
  }
}
