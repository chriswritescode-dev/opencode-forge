import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface Migration {
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
    id: '104',
    description: 'Create graph_status table for graph indexing state',
    apply: (db: Database) => {
      db.run(loadSql('104_create_graph_status.sql'))
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
]
