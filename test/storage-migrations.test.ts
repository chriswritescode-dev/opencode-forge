import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'

function createTempDb(): string {
  const dir = tmpdir()
  const dbPath = join(dir, `forge-test-${randomUUID()}.db`)
  return dbPath
}

test('openForgeDatabase creates all new tables', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  const tableNames = tables.map((t) => t.name)

  expect(tableNames).toContain('loops')
  expect(tableNames).toContain('loop_large_fields')
  expect(tableNames).toContain('plans')
  expect(tableNames).toContain('review_findings')
  expect(tableNames).toContain('tui_preferences')
  expect(tableNames).toContain('migrations')

  db.close()
})

test('migrations are recorded exactly once', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const migrations = db.prepare('SELECT id, description FROM migrations ORDER BY id').all() as Array<{ id: string; description: string }>

  expect(migrations.length).toBeGreaterThan(0)

  const ids = migrations.map((m) => m.id)
  expect(ids).toContain('100')
  expect(ids).toContain('101')
  expect(ids).toContain('102')
  expect(ids).toContain('103')
  expect(ids).toContain('105')
  expect(ids).toContain('106')
  expect(ids).toContain('129')
  expect(ids).toContain('130')

  const uniqueIds = new Set(ids)
  expect(uniqueIds.size).toBe(migrations.length)

  db.close()
})

test('re-opening does not re-run migrations', () => {
  const dbPath = createTempDb()

  const db1 = openForgeDatabase(dbPath)
  const count1 = db1.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }

  db1.close()

  const db2 = openForgeDatabase(dbPath)
  const count2 = db2.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }

  expect(count2.count).toBe(count1.count)

  db2.close()
})

test('migrations run in transactions', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const countBefore = db.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }

  const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  const tableNames = tablesAfter.map((t) => t.name)
  expect(tableNames).toContain('loops')
  expect(tableNames).toContain('migrations')

  const countAfter = db.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }
  expect(countAfter.count).toBe(countBefore.count)

  db.close()
})

test('review findings scenario is nullable for new databases', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const scenario = db.prepare('PRAGMA table_info(review_findings)').all().find((col) => {
    return (col as { name: string }).name === 'scenario'
  }) as { notnull: number } | undefined

  expect(scenario?.notnull).toBe(0)

  db.close()
})

test('review findings scenario is made nullable when legacy migration id was already used', () => {
  const dbPath = createTempDb()
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE review_findings (
      project_id   TEXT NOT NULL,
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, loop_name, file, line)
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('103', 'Create review_findings table for write-once review findings', 1),
      ('111', 'Drop session_directory column from loops table (dead data removal)', 1);
  `)
  db.close()

  const migrated = openForgeDatabase(dbPath)
  const scenario = migrated.prepare('PRAGMA table_info(review_findings)').all().find((col) => {
    return (col as { name: string }).name === 'scenario'
  }) as { notnull: number } | undefined

  expect(scenario?.notnull).toBe(0)

  migrated.close()
})

test('review findings branch scope is dropped when migration 119 was already recorded', () => {
  const dbPath = createTempDb()
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE review_findings (
      project_id   TEXT NOT NULL,
      branch       TEXT NOT NULL DEFAULT '',
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      created_at   INTEGER NOT NULL,
      CHECK (NOT (branch != '' AND loop_name != '')),
      PRIMARY KEY (project_id, branch, loop_name, file, line)
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('103', 'Create review_findings table for write-once review findings', 1),
      ('111', 'Make scenario column nullable in review_findings table', 1),
      ('117', 'Add branch to primary key for review_findings table (branch-scoped findings)', 1),
      ('114', 'Ensure scenario column is nullable in review_findings table', 1),
      ('115', 'Create api_registry table for HTTP control plane (historical - dropped in 116)', 1),
      ('116', 'Drop api_registry table (bus-RPC migration - HTTP control plane removed)', 1),
      ('118', 'Drop audit_session_id column from loops table (single-session loop model)', 1),
      ('119', 'Add loop_name scope to review_findings; drop legacy branch-only rows', 1);
  `)
  db.close()

  const migrated = openForgeDatabase(dbPath)
  const cols = migrated.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>

  expect(cols.some((col) => col.name === 'branch')).toBe(false)
  expect(cols.find((col) => col.name === 'project_id')?.pk).toBe(1)
  expect(cols.find((col) => col.name === 'loop_name')?.pk).toBe(2)
  expect(cols.find((col) => col.name === 'file')?.pk).toBe(3)
  expect(cols.find((col) => col.name === 'line')?.pk).toBe(4)

  migrated.close()
})

test('review findings section_index is in primary key after migration 125', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const cols = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>
  expect(cols.find((col) => col.name === 'section_index')?.pk).toBe(5)
  expect(cols.find((col) => col.name === 'project_id')?.pk).toBe(1)
  expect(cols.find((col) => col.name === 'loop_name')?.pk).toBe(2)
  expect(cols.find((col) => col.name === 'file')?.pk).toBe(3)
  expect(cols.find((col) => col.name === 'line')?.pk).toBe(4)

  db.close()
})

test('migration 125 normalizes NULL section_index to -1 sentinel', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  // The review_findings table after migration 125 uses COALESCE(?, -1) to normalize NULL to -1.
  // Simulate cross-section writes via COALESCE (as the write function does).
  db.prepare(`
    INSERT INTO review_findings (project_id, loop_name, file, line, severity, description, scenario, section_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, -1), ?)
  `).run('proj', 'loop1', 'src/a.ts', 10, 'bug', 'desc', 'sc', null, Date.now())
  db.prepare(`
    INSERT INTO review_findings (project_id, loop_name, file, line, severity, description, scenario, section_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, -1), ?)
  `).run('proj', 'loop1', 'src/b.ts', 20, 'warning', 'desc2', 'sc2', null, Date.now())

  const rows = db.prepare('SELECT section_index FROM review_findings WHERE project_id = ? AND loop_name = ?').all('proj', 'loop1') as Array<{ section_index: number | null }>
  for (const row of rows) {
    expect(row.section_index).toBe(-1)
  }

  db.close()
})

test('migrates loop_large_fields prompt into plans and removes prompt column', () => {
  const dbPath = createTempDb()

  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('100', 'Create loops table', 1),
      ('101', 'Create loop_large_fields table', 1),
      ('102', 'Create plans table', 1),
      ('103', 'Create review_findings table', 1),
      ('105', 'Create tui_preferences table', 1),
      ('106', 'Drop project_kv table', 1),
      ('107', 'Add workspace_id column', 1),
      ('108', 'Add host_session_id column', 1),
      ('110', 'Drop completion_signal', 1),
      ('111', 'Make scenario nullable', 1),
      ('112', 'Drop audit column', 1),
      ('113', 'Add audit_session_id', 1),
      ('114', 'Ensure scenario nullable', 1),
      ('115', 'Create api_registry', 1),
      ('116', 'Drop api_registry', 1),
      ('117', 'Branch scope review findings', 1),
      ('118', 'Drop audit_session_id', 1),
      ('119', 'Loop scope review findings', 1),
      ('120', 'Loop only review findings', 1),
      ('121', 'Create section_plans', 1),
      ('122', 'Add decomposition state', 1),
      ('123', 'Add section_index', 1),
      ('124', 'Extend phase CHECK', 1),
      ('125', 'Rebuild review_findings PK', 1);

    CREATE TABLE loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing','decomposing','final_auditing')),
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      decomposition_status TEXT NOT NULL DEFAULT 'pending',
      decomposition_mode   TEXT NOT NULL DEFAULT 'agent',
      decomposition_session_id TEXT,
      current_section_index INTEGER NOT NULL DEFAULT 0,
      total_sections       INTEGER NOT NULL DEFAULT 0,
      final_audit_done     INTEGER NOT NULL DEFAULT 0,
      final_audit_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, loop_name)
    );

    CREATE TABLE loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      prompt              TEXT,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    );

    CREATE TABLE plans (
      project_id   TEXT NOT NULL,
      loop_name    TEXT,
      session_id   TEXT,
      content      TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
      UNIQUE (project_id, loop_name),
      UNIQUE (project_id, session_id)
    );

    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
    VALUES ('project-a', 'loop-a', 'running', 'session-1', 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'coding', 1);

    INSERT INTO loop_large_fields (project_id, loop_name, prompt, last_audit_result)
    VALUES ('project-a', 'loop-a', '# Prompt wins', 'audit text');

    INSERT INTO plans (project_id, loop_name, content, updated_at)
    VALUES ('project-a', 'loop-a', '# Old fallback', 1);
  `)
  db.close()

  const migrated = openForgeDatabase(dbPath)

  const plan = migrated.prepare(
    "SELECT content FROM plans WHERE project_id = 'project-a' AND loop_name = 'loop-a'"
  ).get() as { content: string } | undefined

  expect(plan).toBeDefined()
  expect(plan!.content).toBe('# Prompt wins')

  const lcols = migrated.prepare('PRAGMA table_info(loop_large_fields)').all()
  expect(lcols.some((col) => (col as { name: string }).name === 'prompt')).toBe(false)

  const llf = migrated.prepare(
    "SELECT last_audit_result FROM loop_large_fields WHERE project_id = 'project-a' AND loop_name = 'loop-a'"
  ).get() as { last_audit_result: string }
  expect(llf.last_audit_result).toBe('audit text')

  migrated.close()
})

test('migration 127 is idempotent on re-opened databases', () => {
  const dbPath = createTempDb()

  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('100', 'Create loops table', 1),
      ('101', 'Create loop_large_fields table', 1),
      ('102', 'Create plans table', 1),
      ('103', 'Create review_findings table', 1),
      ('105', 'Create tui_preferences table', 1),
      ('106', 'Drop project_kv table', 1),
      ('107', 'Add workspace_id column', 1),
      ('108', 'Add host_session_id column', 1),
      ('110', 'Drop completion_signal', 1),
      ('111', 'Make scenario nullable', 1),
      ('112', 'Drop audit column', 1),
      ('113', 'Add audit_session_id', 1),
      ('114', 'Ensure scenario nullable', 1),
      ('115', 'Create api_registry', 1),
      ('116', 'Drop api_registry', 1),
      ('117', 'Branch scope review findings', 1),
      ('118', 'Drop audit_session_id', 1),
      ('119', 'Loop scope review findings', 1),
      ('120', 'Loop only review findings', 1),
      ('121', 'Create section_plans', 1),
      ('122', 'Add decomposition state', 1),
      ('123', 'Add section_index', 1),
      ('124', 'Extend phase CHECK', 1),
      ('125', 'Rebuild review_findings PK', 1);

    CREATE TABLE loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing','decomposing','final_auditing')),
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      decomposition_status TEXT NOT NULL DEFAULT 'pending',
      decomposition_mode   TEXT NOT NULL DEFAULT 'agent',
      decomposition_session_id TEXT,
      current_section_index INTEGER NOT NULL DEFAULT 0,
      total_sections       INTEGER NOT NULL DEFAULT 0,
      final_audit_done     INTEGER NOT NULL DEFAULT 0,
      final_audit_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, loop_name)
    );

    CREATE TABLE loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      prompt              TEXT,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    );

    CREATE TABLE plans (
      project_id   TEXT NOT NULL,
      loop_name    TEXT,
      session_id   TEXT,
      content      TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
      UNIQUE (project_id, loop_name),
      UNIQUE (project_id, session_id)
    );

    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
    VALUES ('project-a', 'loop-a', 'running', 'session-1', 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'coding', 1);

    INSERT INTO loop_large_fields (project_id, loop_name, prompt, last_audit_result)
    VALUES ('project-a', 'loop-a', '# Prompt wins', 'audit text');

    INSERT INTO plans (project_id, loop_name, content, updated_at)
    VALUES ('project-a', 'loop-a', '# Old fallback', 1);
  `)
  db.close()

  const db1 = openForgeDatabase(dbPath)
  db1.close()

  const db2 = openForgeDatabase(dbPath)

  const plans = db2.prepare("SELECT COUNT(*) as count FROM plans WHERE project_id = 'project-a' AND loop_name = 'loop-a'").get() as { count: number }
  expect(plans.count).toBe(1)

  const cols = db2.prepare('PRAGMA table_info(loop_large_fields)').all()
  expect(cols.some((col) => (col as { name: string }).name === 'prompt')).toBe(false)

  db2.close()
})

test('migration 129 narrows phase CHECK and drops decomposition columns', () => {
  const dbPath = createTempDb()
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('100', 'Create loops table', 1),
      ('101', 'Create loop_large_fields table', 1),
      ('102', 'Create plans table', 1),
      ('103', 'Create review_findings table', 1),
      ('105', 'Create tui_preferences table', 1),
      ('106', 'Drop project_kv table', 1),
      ('107', 'Add workspace_id column', 1),
      ('108', 'Add host_session_id column', 1),
      ('110', 'Drop completion_signal', 1),
      ('111', 'Make scenario nullable', 1),
      ('112', 'Drop audit column', 1),
      ('113', 'Add audit_session_id', 1),
      ('114', 'Ensure scenario nullable', 1),
      ('115', 'Create api_registry', 1),
      ('116', 'Drop api_registry', 1),
      ('117', 'Branch scope review findings', 1),
      ('118', 'Drop audit_session_id', 1),
      ('119', 'Loop scope review findings', 1),
      ('120', 'Loop only review findings', 1),
      ('121', 'Create section_plans', 1),
      ('122', 'Add decomposition state', 1),
      ('123', 'Add section_index', 1),
      ('124', 'Extend phase CHECK', 1),
      ('125', 'Rebuild review_findings PK', 1),
      ('126', 'Drop final_audit_attempts', 1),
      ('127', 'Consolidate plan storage', 1),
      ('128', 'Add unique index on loops(project_id, loop_name)', 1);

    CREATE TABLE loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing','decomposing','final_auditing')),
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      decomposition_status TEXT NOT NULL DEFAULT 'pending',
      decomposition_mode   TEXT NOT NULL DEFAULT 'agent',
      decomposition_session_id TEXT,
      current_section_index INTEGER NOT NULL DEFAULT 0,
      total_sections       INTEGER NOT NULL DEFAULT 0,
      final_audit_done     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, loop_name)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name ON loops(project_id, loop_name);

    CREATE TABLE loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    );

    CREATE TABLE plans (
      project_id   TEXT NOT NULL,
      loop_name    TEXT,
      session_id   TEXT,
      content      TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
      UNIQUE (project_id, loop_name),
      UNIQUE (project_id, session_id)
    );

    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
    VALUES ('project-a', 'loop-coding', 'running', 'session-1', 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'coding', 1);

    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
    VALUES ('project-a', 'loop-decomp', 'running', 'session-2', 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'decomposing', 1);
  `)
  db.close()

  const migrated = openForgeDatabase(dbPath)

  // decomposing row should be deleted
  const decompRow = migrated.prepare("SELECT * FROM loops WHERE phase = 'decomposing'").get()
  expect(decompRow).toBeFalsy()

  // coding row should remain
  const codingRow = migrated.prepare("SELECT * FROM loops WHERE project_id = 'project-a' AND loop_name = 'loop-coding'").get()
  expect(codingRow).toBeDefined()

  // decomposition columns should no longer exist
  const cols = migrated.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
  expect(cols.some((c) => c.name === 'decomposition_status')).toBe(false)
  expect(cols.some((c) => c.name === 'decomposition_mode')).toBe(false)
  expect(cols.some((c) => c.name === 'decomposition_session_id')).toBe(false)

  // inserting a row with phase='decomposing' should throw
  expect(() => {
    migrated.prepare(`
      INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
      VALUES ('project-b', 'loop-new', 'running', 'session-3', 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'decomposing', 1)
    `).run()
  }).toThrow()

  migrated.close()
})

test('migration 130 creates loop_session_usage table with correct schema', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  expect(tables.some(t => t.name === 'loop_session_usage')).toBe(true)

  const cols = db.prepare('PRAGMA table_info(loop_session_usage)').all() as Array<{ name: string; pk: number; notnull: number }>
  const colNames = cols.map(c => c.name)
  expect(colNames).toContain('project_id')
  expect(colNames).toContain('loop_name')
  expect(colNames).toContain('session_id')
  expect(colNames).toContain('role')
  expect(colNames).toContain('model')
  expect(colNames).toContain('cost')
  expect(colNames).toContain('input_tokens')
  expect(colNames).toContain('output_tokens')
  expect(colNames).toContain('reasoning_tokens')
  expect(colNames).toContain('cache_read_tokens')
  expect(colNames).toContain('cache_write_tokens')
  expect(colNames).toContain('message_count')
  expect(colNames).toContain('captured_at')

  const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk)
  expect(pkCols[0].name).toBe('project_id')
  expect(pkCols[1].name).toBe('loop_name')
  expect(pkCols[2].name).toBe('session_id')
  expect(pkCols[3].name).toBe('model')

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='loop_session_usage'").all() as Array<{ name: string }>
  expect(indexes.some(i => i.name === 'idx_loop_session_usage_project_loop')).toBe(true)

  db.close()
})

test('migration 130 is idempotent on re-opened databases', () => {
  const dbPath = createTempDb()

  const db1 = openForgeDatabase(dbPath)
  db1.close()

  const db2 = openForgeDatabase(dbPath)

  const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  expect(tables.some(t => t.name === 'loop_session_usage')).toBe(true)

  const count = db2.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }
  expect(count.count).toBeGreaterThan(0)

  db2.close()
})

test('migration 131 adds execution_variant and auditor_variant columns to loops', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
  expect(cols.some(c => c.name === 'execution_variant')).toBe(true)
  expect(cols.some(c => c.name === 'auditor_variant')).toBe(true)

  db.close()
})

test('migration 131 is idempotent on re-opened databases', () => {
  const dbPath = createTempDb()

  const db1 = openForgeDatabase(dbPath)
  db1.close()

  const db2 = openForgeDatabase(dbPath)

  const cols = db2.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
  expect(cols.some(c => c.name === 'execution_variant')).toBe(true)
  expect(cols.some(c => c.name === 'auditor_variant')).toBe(true)

  const count = db2.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }
  expect(count.count).toBeGreaterThan(0)

  db2.close()
})
