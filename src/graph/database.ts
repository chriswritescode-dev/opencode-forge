import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { hashProjectId, hashGraphCacheScope } from '../storage/graph-projects'
import { openSqliteWithIntegrityGuard, cleanupOrphanedShmFile } from '../storage/sqlite-open'

// Track database instances for cleanup
const databaseInstances: Map<string, Database> = new Map()

/**
 * Metadata file name stored alongside graph.db to enable cache identity resolution
 */
const GRAPH_METADATA_FILE = 'graph-metadata.json'

/**
 * Graph cache metadata structure stored in the metadata file
 */
export interface GraphCacheMetadata {
  projectId: string
  cwd: string
  createdAt: number
  /** Timestamp of the last successful full scan */
  lastIndexedAt?: number
  /** Number of files indexed in the last successful full scan */
  indexedFileCount?: number
  /** Maximum mtime of indexed files in the last successful full scan */
  indexedMaxMtimeMs?: number
  /** Branch name at last successful index or branch switch */
  lastBranch?: string
}

const GRAPH_PRAGMAS = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA busy_timeout=5000',
  'PRAGMA synchronous=NORMAL',
  'PRAGMA foreign_keys=ON',
]

/**
 * Validates the graph DB by exercising data pages — PRAGMA integrity_check can
 * miss WAL-level corruption. Throwing here triggers corruption recovery.
 */
function validateGraphDatabase(db: Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  if (tables.some(t => t.name === 'files')) {
    db.prepare('SELECT COUNT(*) as c FROM files').get()
  }
}

/**
 * Opens a managed graph database with integrity verification.
 * If integrity check fails or opening throws a corruption error, deletes the
 * corrupted DB files and recreates a fresh database.
 */
export function openGraphDatabase(dbPath: string): Database {
  return openSqliteWithIntegrityGuard(dbPath, {
    label: 'Graph database',
    pragmas: GRAPH_PRAGMAS,
    bootstrap: createTables,
    validate: validateGraphDatabase,
    // Clean up orphaned SHM files when the WAL file is completely missing.
    // This state indicates the previous process crashed without checkpointing,
    // and opening with a stale SHM but no WAL can trigger "malformed" errors.
    // Note: empty WAL + SHM is normal after a TRUNCATE checkpoint — don't touch that.
    preOpenCleanup: cleanupOrphanedShmFile,
  })
}

/**
 * Ensures the graph directory and metadata file exist, returning the database path.
 * Does NOT open a database connection — the worker thread is the sole DB owner.
 */
export function ensureGraphDirectory(projectId: string, dataDir: string, cwd?: string): string {
  const projectIdHash = cwd
    ? hashGraphCacheScope(projectId, cwd)
    : hashProjectId(projectId)
  const graphDir = join(dataDir, 'graph', projectIdHash)

  if (!existsSync(graphDir)) {
    mkdirSync(graphDir, { recursive: true })
  }

  const metadataPath = join(graphDir, GRAPH_METADATA_FILE)
  if (!existsSync(metadataPath)) {
    const metadata: GraphCacheMetadata = {
      projectId,
      cwd: cwd ?? '',
      createdAt: Date.now(),
    }
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
  }

  return join(graphDir, 'graph.db')
}

/**
 * Initialize the graph database with the full schema
 * Database location: <dataDir>/graph/<projectId::cwd-hash>/graph.db
 */
export function initializeGraphDatabase(projectId: string, dataDir: string, cwd?: string): Database {
  const dbPath = ensureGraphDirectory(projectId, dataDir, cwd)
  const db = openGraphDatabase(dbPath)

  // Track instance for later cleanup
  databaseInstances.set(dbPath, db)

  return db
}

/**
 * Reads graph cache metadata from a graph directory.
 * 
 * @param graphDir - The graph cache directory path
 * @returns The metadata object or null if not found/readable
 */
export function readGraphCacheMetadata(graphDir: string): GraphCacheMetadata | null {
  const metadataPath = join(graphDir, GRAPH_METADATA_FILE)
  
  if (!existsSync(metadataPath)) {
    return null
  }
  
  try {
    const content = readFileSync(metadataPath, 'utf-8')
    return JSON.parse(content) as GraphCacheMetadata
  } catch {
    return null
  }
}

/**
 * Writes graph cache metadata to a graph directory.
 * Updates the metadata file with the provided fields, preserving existing data.
 * 
 * @param graphDir - The graph cache directory path
 * @param metadata - The metadata fields to update
 * @returns true if successful, false otherwise
 */
export function writeGraphCacheMetadata(
  graphDir: string,
  metadata: Partial<GraphCacheMetadata>
): boolean {
  const metadataPath = join(graphDir, GRAPH_METADATA_FILE)
  
  try {
    const existing = readGraphCacheMetadata(graphDir)
    const updated: GraphCacheMetadata = {
      ...(existing ?? {
        projectId: '',
        cwd: '',
        createdAt: Date.now(),
      }),
      ...metadata,
    }
    writeFileSync(metadataPath, JSON.stringify(updated, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * Close all graph database instances
 */
export function closeGraphDatabase(): void {
  for (const [path, db] of databaseInstances.entries()) {
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {}
    try {
      db.close()
    } catch (err) {
      console.debug(`Graph database close skipped for ${path}`, err)
    }
    databaseInstances.delete(path)
  }
}



function createTables(db: Database): void {
  // Files table
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      mtime_ms INTEGER NOT NULL,
      language TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      symbol_count INTEGER NOT NULL DEFAULT 0,
      pagerank REAL NOT NULL DEFAULT 0,
      is_barrel INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_pagerank ON files(pagerank DESC)`)

  // Symbols table
  db.run(`
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      is_exported INTEGER NOT NULL DEFAULT 0,
      signature TEXT,
      qualified_name TEXT,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported)`)

  // Edges table (file dependencies)
  db.run(`
    CREATE TABLE IF NOT EXISTS edges (
      source_file_id INTEGER NOT NULL,
      target_file_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (source_file_id, target_file_id),
      FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (target_file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_file_id)`)

  // Refs table (imports) - migrate if is_dynamic column is missing
  const refsInfo = db.prepare("PRAGMA table_info(refs)").all() as Array<{ name: string }>
  const hasIsDynamic = refsInfo.some(col => col.name === 'is_dynamic')
  if (!hasIsDynamic) {
    db.run('DROP TABLE IF EXISTS refs')
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      source_file_id INTEGER,
      import_source TEXT NOT NULL,
      is_dynamic INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE SET NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_file_id ON refs(file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_source_file_id ON refs(source_file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_import_source ON refs(import_source)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name)`)

  // Entrypoints table - files that are entry points (bin, scripts)
  db.run(`
    CREATE TABLE IF NOT EXISTS entrypoints (
      file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      reason TEXT NOT NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_entrypoints_file_id ON entrypoints(file_id)`)

  // Calls table (call graph)
  db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_symbol_id INTEGER NOT NULL,
      callee_name TEXT NOT NULL,
      callee_symbol_id INTEGER,
      callee_file_id INTEGER,
      line INTEGER NOT NULL,
      FOREIGN KEY (caller_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (callee_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL,
      FOREIGN KEY (callee_file_id) REFERENCES files(id) ON DELETE SET NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON calls(callee_name)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_callee_file ON calls(callee_file_id)`)

  // Co-changes table
  db.run(`
    CREATE TABLE IF NOT EXISTS cochanges (
      file_id_a INTEGER NOT NULL,
      file_id_b INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (file_id_a, file_id_b),
      FOREIGN KEY (file_id_a) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id_b) REFERENCES files(id) ON DELETE CASCADE
    )
  `)

  // External imports table
  db.run(`
    CREATE TABLE IF NOT EXISTS external_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      package TEXT NOT NULL,
      specifiers TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_external_imports_file_id ON external_imports(file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_external_imports_package ON external_imports(package)`)

  // Semantic summaries table - uses composite primary key for INSERT OR REPLACE semantics
  // Migration: Drop old table if it exists with autoincrement id, recreate with composite PK
  const tableInfo = db.prepare("PRAGMA table_info(semantic_summaries)").all() as Array<{ name: string; pk: number }>
  const hasOldSchema = tableInfo.some(col => col.name === 'id' && col.pk === 1)
  const hasNewSchema = tableInfo.length > 0 && !hasOldSchema

  if (hasOldSchema) {
    // Drop old schema table to recreate with composite primary key
    db.run(`DROP TABLE IF EXISTS semantic_summaries`)
  }
  
  if (!hasNewSchema) {
    // Create table only if it doesn't exist with correct schema
    db.run(`
      CREATE TABLE semantic_summaries (
        symbol_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        file_mtime INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        PRIMARY KEY (symbol_id, source),
        FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
      )
    `)
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_semantic_summaries_symbol_id ON semantic_summaries(symbol_id)`)

  // Shape hashes table (for clone detection)
  db.run(`
    CREATE TABLE IF NOT EXISTS shape_hashes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      shape_hash TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_shape_hashes_file_id ON shape_hashes(file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_shape_hashes_shape_hash ON shape_hashes(shape_hash)`)

  // Token signatures table (for near-duplicate detection)
  db.run(`
    CREATE TABLE IF NOT EXISTS token_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      minhash BLOB NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_token_signatures_file_id ON token_signatures(file_id)`)

  // Token fragments table
  db.run(`
    CREATE TABLE IF NOT EXISTS token_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      line INTEGER NOT NULL,
      token_offset INTEGER NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_token_fragments_hash ON token_fragments(hash)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_token_fragments_file_id ON token_fragments(file_id)`)

  // FTS5 virtual table for symbol search (standalone — not external content, since
  // 'path' is derived from the files table via JOIN, not stored in symbols directly)
  // Migration: drop old external-content FTS table that references non-existent symbols.path
  const ftsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE name='symbols_fts'").get() as { sql: string } | undefined
  let shouldRebuildFts = ftsInfo?.sql?.includes("content='symbols'") ?? false
  
  // Also rebuild FTS if schema is correct but data may be stale (count mismatch)
  if (!shouldRebuildFts && ftsInfo) {
    const symbolCount = db.prepare('SELECT COUNT(*) as count FROM symbols').get() as { count: number }
    const ftsCount = db.prepare('SELECT COUNT(*) as count FROM symbols_fts').get() as { count: number }
    if (symbolCount.count !== ftsCount.count) {
      shouldRebuildFts = true
    }
  }
  
  if (shouldRebuildFts) {
    db.run('DROP TABLE IF EXISTS symbols_fts')
  }
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name,
      path,
      kind
    )
  `)

  // Triggers to keep FTS in sync (standalone FTS table — use regular INSERT/DELETE)
  // Migration: drop old triggers that used external-content delete syntax
  db.run('DROP TRIGGER IF EXISTS symbols_ai')
  db.run('DROP TRIGGER IF EXISTS symbols_ad')
  db.run('DROP TRIGGER IF EXISTS symbols_au')
  db.run(`
    CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, path, kind)
      VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
    END
  `)
  db.run(`
    CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
      DELETE FROM symbols_fts WHERE rowid = old.id;
    END
  `)
  db.run(`
    CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
      DELETE FROM symbols_fts WHERE rowid = old.id;
      INSERT INTO symbols_fts(rowid, name, path, kind)
      VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
    END
  `)
}
