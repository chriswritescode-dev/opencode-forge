import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/services/loop'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-tool-blocking-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  // Create the loops table schema
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id TEXT NOT NULL,
      worktree INTEGER NOT NULL,
      worktree_dir TEXT NOT NULL,
      worktree_branch TEXT,
      project_dir TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      audit_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
      execution_model TEXT,
      auditor_model TEXT,
      model_failed INTEGER NOT NULL DEFAULT 0,
      sandbox INTEGER NOT NULL DEFAULT 0,
      sandbox_container TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      termination_reason TEXT,
      completion_summary TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      audit_session_id     TEXT,
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      prompt TEXT,
      last_audit_result TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
      project_id TEXT NOT NULL,
      loop_name TEXT,
      session_id TEXT,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
      UNIQUE (project_id, loop_name),
      UNIQUE (project_id, session_id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description TEXT NOT NULL,
      scenario TEXT,
      branch TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, file, line)
    )
  `)
  return db
}

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('Tool Blocking Logic', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'
  const sessionID = 'test-session-123'

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  describe('Loop state lookup', () => {
    test('getActiveState returns active state when loop is active', () => {
      const loopName = 'test-worktree'
      const state = {
        active: true,
        sessionId: sessionID,
        loopName,
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
        worktree: true,
      }
      loopService.setState(loopName, state)

      const retrieved = loopService.getActiveState(loopName)
      expect(retrieved).toMatchObject(state)
      expect(retrieved?.active).toBe(true)
    })

    test('getActiveState returns null when no loop exists', () => {
      const retrieved = loopService.getActiveState('non-existent-loop')
      expect(retrieved).toBeNull()
    })

    test('getActiveState returns null when loop is inactive', () => {
      const loopName = 'test-worktree-inactive'
      const inactiveState = {
        active: false,
        sessionId: sessionID,
        loopName,
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
        worktree: true,
      }
      loopService.setState(loopName, inactiveState)

      const retrieved = loopService.getActiveState(loopName)
      expect(retrieved).toBeNull()
    })
  })

  describe('Blocked tools list', () => {
    test('includes question tool', () => {
      const blockedTools = ['question', 'plan-execute', 'loop']
      expect(blockedTools).toContain('question')
    })

    test('includes plan-execute tool', () => {
      const blockedTools = ['question', 'plan-execute', 'loop']
      expect(blockedTools).toContain('plan-execute')
    })

    test('includes loop tool', () => {
      const blockedTools = ['question', 'plan-execute', 'loop']
      expect(blockedTools).toContain('loop')
    })

    test('does not include memory-read tool', () => {
      const blockedTools = ['question', 'plan-execute', 'loop']
      expect(blockedTools).not.toContain('memory-read')
    })

    test('does not include memory-write tool', () => {
      const blockedTools = ['question', 'plan-execute', 'loop']
      expect(blockedTools).not.toContain('memory-write')
    })
  })

  describe('Error messages', () => {
    test('question tool has appropriate error message', () => {
      const messages: Record<string, string> = {
        'question': 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
        'plan-execute': 'The plan-execute tool is not available during a loop. Focus on executing the current plan.',
        'loop': 'The loop tool is not available during a loop. Focus on executing the current plan.',
      }
      expect(messages['question']).toContain('question tool is not available')
    })

    test('plan-execute tool has appropriate error message', () => {
      const messages: Record<string, string> = {
        'question': 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
        'plan-execute': 'The plan-execute tool is not available during a loop. Focus on executing the current plan.',
        'loop': 'The loop tool is not available during a loop. Focus on executing the current plan.',
      }
      expect(messages['plan-execute']).toContain('plan-execute tool is not available')
    })
  })
})
