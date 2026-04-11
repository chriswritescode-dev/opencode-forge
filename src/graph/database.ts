import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { hashProjectId } from '../storage/graph-projects'

// Track database instances for cleanup
const databaseInstances: Map<string, Database> = new Map()

/**
 * Initialize the graph database with the full schema
 * Database location: <dataDir>/graph/<projectId-hash>/graph.db
 */
export function initializeGraphDatabase(projectId: string, dataDir: string): Database {
  // Create project-specific subdirectory using hash
  const projectIdHash = hashProjectId(projectId)
  const graphDir = join(dataDir, 'graph', projectIdHash)
  
  if (!existsSync(graphDir)) {
    mkdirSync(graphDir, { recursive: true })
  }

  const dbPath = join(graphDir, 'graph.db')
  const db = new Database(dbPath)

  // SQLite optimizations
  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA busy_timeout=5000')
  db.run('PRAGMA synchronous=NORMAL')
  db.run('PRAGMA foreign_keys=ON')

  // Create all tables
  createTables(db)

  // Track instance for later cleanup
  databaseInstances.set(dbPath, db)

  return db
}

/**
 * Close all graph database instances
 */
export function closeGraphDatabase(): void {
  for (const [path, db] of databaseInstances.entries()) {
    try {
      db.close()
    } catch (err) {
      // Database may already be closed
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

  // Refs table (imports)
  db.run(`
    CREATE TABLE IF NOT EXISTS refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      source_file_id INTEGER,
      import_source TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE SET NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_file_id ON refs(file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_source_file_id ON refs(source_file_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_refs_import_source ON refs(import_source)`)

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

  // FTS5 virtual table for symbol search
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name,
      path,
      kind,
      content='symbols',
      content_rowid='id'
    )
  `)

  // Triggers to keep FTS in sync
  db.run(`
    CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, path, kind)
      VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, path, kind) VALUES('delete', old.id, old.name, '', old.kind);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, path, kind) VALUES('delete', old.id, old.name, '', old.kind);
      INSERT INTO symbols_fts(rowid, name, path, kind)
      VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
    END
  `)
}
