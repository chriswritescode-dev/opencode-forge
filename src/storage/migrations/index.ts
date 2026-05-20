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
  {
    id: '118',
    description: 'Drop audit_session_id column from loops table (single-session loop model)',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'audit_session_id')) return
      db.run(loadSql('118_drop_audit_session_id_from_loops.sql'))
    },
  },
  {
    id: '119',
    description: 'Add loop_name scope to review_findings; drop legacy branch-only rows',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'loop_name') && !cols.some((c) => c.name === 'branch')) return
      db.run(loadSql('119_loop_scope_review_findings.sql'))
    },
  },
  {
    id: '120',
    description: 'Drop branch scope from review_findings table',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>
      const pkInfo = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>
      const hasBranch = cols.some((c) => c.name === 'branch')
      const hasLoopOnlyPk =
        pkInfo.find((c) => c.name === 'project_id')?.pk === 1 &&
        pkInfo.find((c) => c.name === 'loop_name')?.pk === 2 &&
        pkInfo.find((c) => c.name === 'file')?.pk === 3 &&
        pkInfo.find((c) => c.name === 'line')?.pk === 4
      if (!hasBranch && hasLoopOnlyPk) return
      db.run(loadSql('120_loop_only_review_findings.sql'))
    },
  },
  {
    id: '121',
    description: 'Create section_plans table for decomposed section plans',
    apply: (db: Database) => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='section_plans'").all()
      if (tables.length > 0) return
      db.run(loadSql('121_create_section_plans.sql'))
    },
  },
  {
    id: '122',
    description: 'Add decomposition state columns to loops table',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'decomposition_status')) return
      db.run(loadSql('122_add_decomposition_state_to_loops.sql'))
    },
  },
  {
    id: '123',
    description: 'Add section_index column to review_findings table',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'section_index')) return
      db.run(loadSql('123_add_section_index_to_review_findings.sql'))
    },
  },
  {
    id: '124',
    description: 'Extend loops phase CHECK to include decomposing and final_auditing',
    apply: (db: Database) => {
      const phases = db.prepare("SELECT DISTINCT phase FROM loops").all() as Array<{ phase: string }>
      const hasNewPhases = phases.some(p => p.phase === 'decomposing' || p.phase === 'final_auditing')
      if (hasNewPhases) return
      db.run(loadSql('124_extend_loops_phase_check.sql'))
    },
  },
  {
    id: '125',
    description: 'Rebuild review_findings with section_index in primary key for section-scoped deduplication',
    apply: (db: Database) => {
      const pkInfo = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>
      if (pkInfo.some(c => c.name === 'section_index' && c.pk > 0)) return
      db.run(loadSql('125_add_section_index_to_review_findings_pk.sql'))
    },
  },
  {
    id: '126',
    description: 'Drop final_audit_attempts column from loops table',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'final_audit_attempts')) return
      db.run(loadSql('126_drop_final_audit_attempts_from_loops.sql'))
    },
  },
  {
    id: '127',
    description: 'Consolidate loop plan storage: backfill prompt into plans, remove prompt column from loop_large_fields',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loop_large_fields)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'prompt')) {
        // prompt already removed, just ensure index exists
        db.run("CREATE INDEX IF NOT EXISTS idx_plans_project_updated_at ON plans(project_id, updated_at DESC)")
        return
      }
      db.run(loadSql('127_consolidate_loop_plan_storage.sql'))
    },
  },
  {
    id: '128',
    description: 'Add unique index on loops(project_id, loop_name) for FK compliance with section_plans',
    apply: (db: Database) => {
      db.run(loadSql('128_add_loops_project_name_unique_index.sql'))
    },
  },
  {
    id: '129',
    description: 'Remove decomposer columns and decomposing phase',
    apply: (db: Database) => {
      db.run(loadSql('129_remove_decomposer.sql'))
    },
  },
  {
    id: '130',
    description: 'Create loop_session_usage table for persisting token usage snapshots',
    apply: (db: Database) => {
      db.run(loadSql('130_create_loop_session_usage.sql'))
    },
  },
  {
    id: '131',
    description: 'Add execution and auditor model variant columns to loops table',
    apply: (db: Database) => {
      const cols = db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'execution_variant')) return
      db.run(loadSql('131_add_loop_model_variants.sql'))
    },
  },

]
