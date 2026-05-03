import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface Migration {
  id: string
  description: string
  apply: (db: Database) => void
}

function loadSql(filename: string): string {
  return readFileSync(join(__dirname, filename), 'utf-8')
}

export const migrations: Migration[] = [
  {
    id: '100',
    description: 'Create loops table for typed loop state storage',
    apply: (db: Database) => {
      db.run(loadSql('100_create_loops.sql'))
    },
  },
  {
    id: '101',
    description: 'Create loop_large_fields table for prompt and audit result',
    apply: (db: Database) => {
      db.run(loadSql('101_create_loop_large_fields.sql'))
    },
  },
  {
    id: '102',
    description: 'Create plans table for session-staged and loop-bound plans',
    apply: (db: Database) => {
      db.run(loadSql('102_create_plans.sql'))
    },
  },
  {
    id: '103',
    description: 'Create review_findings table for write-once review findings',
    apply: (db: Database) => {
      db.run(loadSql('103_create_review_findings.sql'))
    },
  },
  {
    id: '105',
    description: 'Create tui_preferences table for TUI recent models and execution preferences',
    apply: (db: Database) => {
      db.run(loadSql('105_create_tui_preferences.sql'))
    },
  },
  {
    id: '106',
    description: 'Drop project_kv table (replaced by typed repos + tui_preferences)',
    apply: (db: Database) => {
      db.run(loadSql('106_drop_project_kv.sql'))
    },
  },
  {
    id: '107',
    description: 'Add workspace_id column to loops table for workspace-backed worktree switching',
    apply: (db: Database) => {
      // Guard against test databases or legacy environments where the column
      // was added out-of-band. SQLite does not support `ADD COLUMN IF NOT EXISTS`.
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'workspace_id')) return
      db.run(loadSql('107_add_workspace_id_to_loops.sql'))
    },
  },
  {
    id: '108',
    description: 'Add host_session_id column to loops table for post-completion redirect',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'host_session_id')) return
      db.run(loadSql('108_add_host_session_id_to_loops.sql'))
    },
  },
  {
    id: '110',
    description: 'Drop completion_signal column from loops table (dead mechanism removal)',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'completion_signal')) return
      db.run(loadSql('110_drop_completion_signal_from_loops.sql'))
    },
  },
  {
    id: '111',
    description: 'Make scenario column nullable in review_findings table',
    apply: (db: Database) => {
      db.run(loadSql('111_make_scenario_nullable.sql'))
    },
  },
  {
    id: '112',
    description: 'Drop audit column from loops table (dead flag removal)',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'audit')) return
      db.run(loadSql('112_drop_audit_from_loops.sql'))
    },
  },
  {
    id: '113',
    description: 'Add audit_session_id column to loops table for audit session isolation',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'audit_session_id')) return
      db.run(loadSql('113_add_audit_session_id_to_loops.sql'))
    },
  },
  {
    id: '114',
    description: 'Ensure scenario column is nullable in review_findings table',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; notnull: number }>
      const scenario = cols.find((c) => c.name === 'scenario')
      if (!scenario || scenario.notnull === 0) return
      db.run(`
        CREATE TABLE review_findings_new (
          project_id   TEXT NOT NULL,
          file         TEXT NOT NULL,
          line         INTEGER NOT NULL,
          severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
          description  TEXT NOT NULL,
          scenario     TEXT,
          branch       TEXT,
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (project_id, file, line)
        );
        INSERT INTO review_findings_new SELECT * FROM review_findings;
        DROP TABLE review_findings;
        ALTER TABLE review_findings_new RENAME TO review_findings;
        CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch);
      `)
    },
  },
  {
    id: '115',
    description: 'Create api_registry table for HTTP control plane (historical - dropped in 116)',
    apply: (db: Database) => {
      db.run(loadSql('115_create_api_registry.sql'))
    },
  },
  {
    id: '116',
    description: 'Drop api_registry table (bus-RPC migration - HTTP control plane removed)',
    apply: (db: Database) => {
      db.run(loadSql('116_drop_api_registry.sql'))
    },
  },
  {
    id: '117',
    description: 'Add branch to primary key for review_findings table (branch-scoped findings)',
    apply: (db: Database) => {
      // Guard: check if branch is already in primary key
      const pkInfo = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>
      const hasBranchInPk = pkInfo.some((c) => c.name === 'branch' && c.pk > 0)
      if (hasBranchInPk) return

      db.run(loadSql('117_branch_scope_review_findings.sql'))
    },
  },

]
