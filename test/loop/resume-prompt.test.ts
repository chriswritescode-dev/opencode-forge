import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { PluginConfig } from '../../src/types'
import type { LoopState } from '../../src/loop/state'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { buildResumePromptPlan } from '../../src/loop/resume-prompt'

const PROJECT_ID = 'test-project'
const noopLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

describe('buildResumePromptPlan', () => {
  let db: Database
  let service: LoopService

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'resume-prompt-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    service = createLoopService(
      createLoopsRepo(db),
      createPlansRepo(db),
      createReviewFindingsRepo(db),
      PROJECT_ID,
      noopLogger,
      undefined,
      undefined,
      createSectionPlansRepo(db),
    )
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  function seedLoop(state: Partial<LoopState> & Pick<LoopState, 'loopName' | 'phase'>): LoopState {
    const base: LoopState = {
      active: false,
      sessionId: 'session-old',
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp',
      iteration: 3,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      errorCount: 0,
      auditCount: 0,
      status: 'stalled',
      worktree: false,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      ...state,
    } as LoopState
    service.setState(state.loopName, base)
    service.setStatus(state.loopName, 'stalled')
    return base
  }

  function seedSections(loopName: string, total: number, inProgressIndex: number): void {
    const sectionPlansRepo = createSectionPlansRepo(db)
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName,
      sections: Array.from({ length: total }, (_, i) => ({ index: i, title: `S${i}`, content: `Section ${i} content` })),
    })
    for (let i = 0; i < total; i++) {
      sectionPlansRepo.setStatus(PROJECT_ID, loopName, i, i < inProgressIndex ? 'completed' : i === inProgressIndex ? 'in_progress' : 'pending')
    }
  }

  function seedLoopWithSections(
    state: Partial<LoopState> & Pick<LoopState, 'loopName' | 'phase'>,
    totalSections: number,
  ): LoopState {
    // currentSectionIndex defaults to 0 (first section still in progress), matching a loop
    // stopped mid-section; sections are seeded after the loop row (FK enforcement).
    const seeded = seedLoop({ ...state, totalSections, currentSectionIndex: state.currentSectionIndex ?? 0 })
    seedSections(state.loopName, totalSections, state.currentSectionIndex ?? 0)
    return seeded
  }

  const baseConfig: PluginConfig = {
    loop: { enabled: true },
    executionModel: 'prov/exec',
    auditorModel: 'prov/aud',
  }

  test('persisted auditing resumes as coding with the section-initial prompt', () => {
    const state = seedLoopWithSections({ loopName: 'sectioned-auditing', phase: 'auditing' }, 2)

    const plan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(state.loopName)! })

    expect(plan.phase).toBe('coding')
    expect(plan.agent).toBe('code')
    expect(plan.permission).toBe('loop')
    expect(plan.promptText).toBe(service.buildSectionInitialPrompt(state))
    expect(plan.promptText).toContain('Section 0 content')
  })

  test('legacy non-sectioned prompt falls back to the persisted prompt text', () => {
    seedLoop({ loopName: 'legacy-auditing', phase: 'auditing', prompt: 'Legacy plan text' })

    const plan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState('legacy-auditing')! })

    expect(plan.phase).toBe('coding')
    expect(plan.agent).toBe('code')
    expect(plan.permission).toBe('loop')
    expect(plan.promptText).toBe('Legacy plan text')
  })

  test('persisted final_auditing resumes the final audit with the auditor agent and audit permission', () => {
    const state = seedLoopWithSections({ loopName: 'final-audit-loop', phase: 'final_auditing' }, 3)

    const plan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(state.loopName)! })

    expect(plan.phase).toBe('final_auditing')
    expect(plan.agent).toBe('auditor-loop')
    expect(plan.permission).toBe('audit')
    expect(plan.promptText).toBe(service.buildFinalAuditPrompt(service.getAnyState(state.loopName)!))
    expect(plan.model).toEqual({ providerID: 'prov', modelID: 'aud' })
  })

  test('persisted final_audit_fix resumes the fix pass as coding with the fix prompt', () => {
    const state = seedLoop({ loopName: 'fix-loop', phase: 'final_audit_fix', prompt: 'Fix me' }) as LoopState & { prompt?: string }

    const plan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(state.loopName)! })

    expect(plan.phase).toBe('coding')
    expect(plan.agent).toBe('code')
    expect(plan.permission).toBe('loop')
    expect(plan.promptText).toBe(service.buildFinalAuditFixPrompt(state, service.getOutstandingFindings(state.loopName, 'bug')))
  })

  test('goal loop resumes with the continuation prompt restating the goal', () => {
    const state = seedLoop({ loopName: 'goal-loop', phase: 'auditing', kind: 'goal', goal: 'Ship the endpoint.' })

    const plan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(state.loopName)! })

    expect(plan.phase).toBe('coding')
    expect(plan.agent).toBe('code')
    expect(plan.permission).toBe('loop')
    expect(plan.promptText).toBe(service.buildContinuationPrompt(state, undefined))
    expect(plan.promptText).toContain('Ship the endpoint.')
  })

  test('post_action with postAction enabled uses the post-action phase, config skill, and configured model with auditor fallback', () => {
    const state = seedLoopWithSections({ loopName: 'pa-loop', phase: 'post_action' }, 2)

    const config: PluginConfig = {
      loop: { enabled: true, postAction: { enabled: true, skill: 'pr-review', model: 'prov/pa' } },
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
    }

    const plan = buildResumePromptPlan({ service, config, state: service.getAnyState(state.loopName)! })

    expect(plan.phase).toBe('post_action')
    expect(plan.agent).toBe('code')
    expect(plan.promptText).toBe(service.buildPostActionPrompt(service.getAnyState(state.loopName)!, { skill: 'pr-review', prompt: undefined }))
    expect(plan.model).toEqual({ providerID: 'prov', modelID: 'pa' })
    expect(plan.fallbackModel).toEqual({ providerID: 'prov', modelID: 'aud' })
  })

  test('unset state.auditorModel falls back to config.auditorModel and normalizes whitespace', () => {
    const state = seedLoopWithSections({ loopName: 'aud-model-loop', phase: 'final_auditing', auditorModel: '  prov/norm  ' }, 2)

    const plan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(state.loopName)! })

    expect(plan.model).toEqual({ providerID: 'prov', modelID: 'norm' })
    expect(plan.auditorModel).toBe('prov/norm')
  })

  test('variant: auditor phase uses the persisted auditor variant, coding phases keep the execution variant', () => {
    const auditState = seedLoopWithSections({ loopName: 'variant-loop', phase: 'final_auditing', executionVariant: 'exec-v', auditorVariant: 'audit-v' }, 2)

    const auditPlan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(auditState.loopName)! })
    expect(auditPlan.variant).toBe('audit-v')

    const codeState = seedLoop({ loopName: 'variant-code-loop', phase: 'coding', executionVariant: 'exec-v', auditorVariant: 'audit-v', prompt: 'Legacy plan' })
    const codePlan = buildResumePromptPlan({ service, config: baseConfig, state: service.getAnyState(codeState.loopName)! })
    expect(codePlan.variant).toBe('exec-v')
  })
})
