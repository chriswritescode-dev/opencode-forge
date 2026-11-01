import { describe, test, expect, afterEach } from 'vitest'
import { createToolExecuteAfterHook } from '../../src/hooks/plan-approval'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { buildToolContext, planApprovalQuestionArgs } from '../helpers/tool-context'

describe('plan-approval afterHook dedupes by plan content regardless of updatedAt', () => {
  const openDbs: TestDb[] = []

  afterEach(() => {
    for (const testDb of openDbs) testDb.cleanup()
    openDbs.length = 0
  })

  function createPlanContext(projectId: string, directory: string, sessionID: string, planContent: string) {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const ctx = buildToolContext({ db: testDb.db, projectId, directory })
    ctx.plansRepo.writeForSession(projectId, sessionID, planContent)
    return { ctx, plansRepo: ctx.plansRepo }
  }

  test('two "Execute here" answers with same content but bumped updatedAt: second is duplicate', async () => {
    const projectId = `proj-${Math.random().toString(36).slice(2)}`
    const directory = `/tmp/${projectId}`
    const sessionID = 'sess-1'
    const planContent = '# Plan Title\n\nSame body.'
    const { ctx, plansRepo } = createPlanContext(projectId, directory, sessionID, planContent)
    const firstUpdatedAt = plansRepo.getForSession(projectId, sessionID)!.updatedAt
    const hook = createToolExecuteAfterHook(ctx)
    const args = planApprovalQuestionArgs()

    const output1 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-A', args }, output1)

    const meta1 = output1.metadata as { forgePlanApprovalHandled?: boolean; forgePlanApprovalDuplicate?: boolean }
    expect(meta1.forgePlanApprovalHandled).toBe(true)
    expect(meta1.forgePlanApprovalDuplicate).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 5))
    plansRepo.writeForSession(projectId, sessionID, planContent)
    const refreshed = plansRepo.getForSession(projectId, sessionID)!
    expect(refreshed.updatedAt).toBeGreaterThan(firstUpdatedAt)

    const output2 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-B', args }, output2)

    const meta2 = output2.metadata as { forgePlanApprovalHandled?: boolean; forgePlanApprovalDuplicate?: boolean }
    expect(meta2.forgePlanApprovalHandled).toBe(true)
    expect(meta2.forgePlanApprovalDuplicate).toBe(true)
  })

  test('two "Execute here" answers with different plan content: second is NOT duplicate', async () => {
    const projectId = `proj-${Math.random().toString(36).slice(2)}`
    const directory = `/tmp/${projectId}`
    const sessionID = 'sess-2'
    const { ctx, plansRepo } = createPlanContext(projectId, directory, sessionID, '# Plan A')
    const hook = createToolExecuteAfterHook(ctx)
    const args = planApprovalQuestionArgs()

    const output1 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-A', args }, output1)
    const meta1 = output1.metadata as { forgePlanApprovalDuplicate?: boolean }
    expect(meta1.forgePlanApprovalDuplicate).toBeUndefined()

    plansRepo.writeForSession(projectId, sessionID, '# Plan B — different body')

    const output2 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-B', args }, output2)
    const meta2 = output2.metadata as { forgePlanApprovalDuplicate?: boolean }
    expect(meta2.forgePlanApprovalDuplicate).toBeUndefined()
  })
})
