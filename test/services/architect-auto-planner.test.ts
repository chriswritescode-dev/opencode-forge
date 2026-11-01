import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createArchitectAutoPlanner, ARCHITECT_AUTO_AGENT } from '../../src/services/architect-auto-planner'
import type { Logger } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createTestDb } from '../helpers/test-db'

const PROJECT_ID = 'test-project'

const COMPLETE_PLAN = [
  '# Objective',
  'Implement the behavior.',
  'Loop Name: complete-plan',
  '<!-- forge-section -->',
  '## Phase 1: Implement behavior',
  '### Files',
  '- src/example.ts',
  '### Edits',
  '- Implement the behavior.',
  '### Acceptance Criteria',
  '- The behavior works.',
  '### Verification',
  '- `pnpm typecheck`',
  '## Decisions',
  '- None.',
  '## Conventions',
  '- Follow repository conventions.',
  '## Key Context',
  '- None.',
].join('\n\n')

const INCOMPLETE_PLAN = [
  '# Objective',
  'Implement the behavior.',
  'Loop Name: partial-plan',
  '<!-- forge-section -->',
  '## Phase 1: Implement behavior',
].join('\n\n')

function createCapturingLogger(): { logger: Logger; logs: string[] } {
  const logs: string[] = []
  const logger: Logger = {
    log: (message: string) => logs.push(message),
    error: () => {},
    debug: () => {},
  }
  return { logger, logs }
}

describe('createArchitectAutoPlanner', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let testDb: ReturnType<typeof createTestDb>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let logger: Logger

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    plansRepo = createPlansRepo(db)
    logger = createCapturingLogger().logger
  })

  afterEach(() => {
    testDb.cleanup()
  })

  describe('spawn', () => {
    test('creates the session in the given directory and prompts architect-auto with parsed model and variant', async () => {
      const { client, calls } = createFakeForgeClient()
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      const result = await planner.spawn({
        title: 'Plan: feature',
        prompt: 'the feature description',
        directory: '/tmp/planning-worktree',
        model: 'anthropic/claude-sonnet',
        variant: 'high',
      })

      expect(result.sessionId).toBe('ses_fake_1')
      const created = calls.find((c) => c.method === 'session.create')
      expect(created?.params).toMatchObject({ title: 'Plan: feature', directory: '/tmp/planning-worktree' })

      const prompt = calls.find((c) => c.method === 'session.promptAsync')
      expect(prompt?.params).toMatchObject({
        sessionID: 'ses_fake_1',
        directory: '/tmp/planning-worktree',
        agent: ARCHITECT_AUTO_AGENT,
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        variant: 'high',
      })
      expect((prompt?.params as { parts: Array<{ type: string; text: string }> }).parts).toEqual([
        { type: 'text', text: 'the feature description' },
      ])
    })

    test('omits the model and variant when unset', async () => {
      const { client, calls } = createFakeForgeClient()
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      await planner.spawn({ title: 'Plan: feature', prompt: 'desc', directory: '/tmp/planning-worktree' })

      const prompt = calls.find((c) => c.method === 'session.promptAsync')
      expect(prompt?.params).not.toHaveProperty('model')
      expect(prompt?.params).not.toHaveProperty('variant')
    })
  })

  describe('capturePlan', () => {
    test('returns ready for a warning-free stored plan', async () => {
      const { client } = createFakeForgeClient()
      plansRepo.writeForSession(PROJECT_ID, 'ses_ready', COMPLETE_PLAN)
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      await expect(planner.capturePlan('ses_ready', '/tmp/planning-worktree')).resolves.toEqual({ ready: true })
    })

    test('returns not-ready with the structure warnings for an incomplete plan', async () => {
      const { client } = createFakeForgeClient()
      plansRepo.writeForSession(PROJECT_ID, 'ses_partial', INCOMPLETE_PLAN)
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      const readiness = await planner.capturePlan('ses_partial', '/tmp/planning-worktree')
      expect(readiness.ready).toBe(false)
      if (readiness.ready) return
      expect(readiness.reason).toContain('Stored plan is incomplete:')
      expect(readiness.reason).toContain('Section 1 is missing required headings')
    })

    test('returns not-ready when no plan exists', async () => {
      const { client } = createFakeForgeClient()
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      const readiness = await planner.capturePlan('ses_missing', '/tmp/planning-worktree')
      expect(readiness.ready).toBe(false)
      if (readiness.ready) return
      expect(readiness.reason).toBe('No stored plan found after capture')
    })
  })

  describe('latestAssistantText', () => {
    test('returns the newest assistant text part', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => ([
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'older user text' }] },
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'older assistant text' }] },
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'newer user text' }] },
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'newest assistant text' }] },
          ]),
        },
      })
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      await expect(planner.latestAssistantText('ses_1', '/tmp/planning-worktree')).resolves.toBe('newest assistant text')
    })

    test('returns null when no assistant text exists', async () => {
      const { client } = createFakeForgeClient()
      const planner = createArchitectAutoPlanner({ client, plansRepo, projectId: PROJECT_ID, logger })

      await expect(planner.latestAssistantText('ses_1', '/tmp/planning-worktree')).resolves.toBeNull()
    })
  })
})
