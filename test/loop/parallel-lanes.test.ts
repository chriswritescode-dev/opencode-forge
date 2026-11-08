import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { __resetLoopRuntimeSharedState, createLoop, type Loop } from '../../src/loop/runtime'
import { createPlanAmendmentsRepo } from '../../src/storage/repos/plan-amendments-repo'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import { __resetInFlightGuard } from '../../src/loop/in-flight-guard'
import { createGitService } from '../../src/utils/git-service'
import { forgeLanesDir } from '../../src/workspace/forge-naming'
import { createLane } from '../../src/loop/lanes'
import { createPlanAdjustTool } from '../../src/tools/plan-adjust'
import { performTerminationSideEffects } from '../../src/hooks/host-side-effects'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createMockLogger } from '../helpers/logger'
import { createTestDb } from '../helpers/test-db'
import { buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'
import { recordAuditorHandoff, recordCoderHandoff, recordPostActionComplete } from '../helpers/loop-handoff'

const PROJECT_ID = 'test-project'
const LOOP_NAME = 'diamond-lanes'
const CLEAN_AUDIT = { summary: { done: ['Implemented the section'], deviations: [], followUps: [] } }

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: { enabled: true, defaultMaxIterations: 10 },
}

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8' })
}

function initRepoWithLoopWorktree(rootDir: string): string {
  const repoDir = join(rootDir, 'repo')
  mkdirSync(repoDir)
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: repoDir })
  const baseBranch = git(repoDir, 'rev-parse --abbrev-ref HEAD').trim()
  const loopDir = join(rootDir, 'loop')
  git(repoDir, `worktree add "${loopDir}" -b forge/demo ${baseBranch}`)
  return loopDir
}

describe('parallel section lanes', () => {
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof buildLoopRuntime>['loopService']
  let loopsRepo: ReturnType<typeof buildLoopRuntime>['loopsRepo']
  let sectionPlansRepo: ReturnType<typeof buildLoopRuntime>['sectionPlansRepo']
  let rootDir: string
  let loopDir: string
  let loop: Loop | null = null

  beforeEach(() => {
    __resetIdleGate()
    __resetInFlightGuard()
    __resetLoopRuntimeSharedState()
    rootDir = mkdtempSync(join(tmpdir(), 'forge-parallel-lanes-'))
    loopDir = initRepoWithLoopWorktree(rootDir)
    testDb = createTestDb({ path: join(rootDir, 'forge.db') })
  })

  afterEach(() => {
    if (loop) {
      loop.clearAllRetryTimeouts()
      loop = null
    }
    testDb.cleanup()
    rmSync(rootDir, { recursive: true, force: true })
    __resetIdleGate()
    __resetInFlightGuard()
    vi.useRealTimers()
  })

  function seedDiamond(maxParallelSections: number): void {
    loopService.setState(LOOP_NAME, makeLoopState({
      loopName: LOOP_NAME,
      sessionId: 'seed-session',
      worktree: true,
      worktreeDir: loopDir,
      workspaceId: 'ws_lane',
      maxParallelSections,
      maxIterations: 10,
      iteration: 1,
      totalSections: 0,
      currentSectionIndex: 0,
      sectionRunKind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
    }))
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, id: 'a', after: [], title: 'Section A', content: 'A body.\n\n### Files\n- a.txt' },
        { index: 1, id: 'b', after: ['a'], title: 'Section B', content: 'B body.\n\n### Files\n- b.txt' },
        { index: 2, id: 'c', after: ['a'], title: 'Section C', content: 'C body.\n\n### Files\n- c.txt' },
        { index: 3, id: 'd', after: ['b', 'c'], title: 'Section D', content: 'D body.\n\n### Files\n- d.txt' },
      ],
    })
    loopService.setTotalSections(LOOP_NAME, 4)
  }

  function build(): ReturnType<typeof createFakeForgeClient>['calls'] {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Section work complete.' }] },
        ],
      },
    })
    const runtime = buildLoopRuntime(testDb.db, {
      client,
      config: mockConfig,
      gitService: createGitService(),
    })
    loopService = runtime.loopService
    loopsRepo = runtime.loopsRepo
    sectionPlansRepo = runtime.sectionPlansRepo
    loop = runtime.loop
    return calls
  }

  function buildWithPlanAmendments(): ReturnType<typeof createFakeForgeClient>['calls'] {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Section work complete.' }] },
        ],
      },
    })
    const repos = buildLoopRuntime(testDb.db, {
      client,
      config: mockConfig,
      gitService: createGitService(),
    })
    const runtime = createLoop({
      loopsRepo: repos.loopsRepo,
      plansRepo: repos.plansRepo,
      reviewFindingsRepo: repos.reviewFindingsRepo,
      sectionPlansRepo: repos.sectionPlansRepo,
      loopTransitionsRepo: repos.loopTransitionsRepo,
      planAmendmentsRepo: createPlanAmendmentsRepo(testDb.db),
      projectId: PROJECT_ID,
      client,
      logger: createMockLogger(),
      getConfig: () => mockConfig,
      gitService: createGitService(),
    })
    loopService = runtime.service
    loopsRepo = repos.loopsRepo
    sectionPlansRepo = repos.sectionPlansRepo
    loop = runtime
    return calls
  }

  function idle(sessionId: string): Promise<void> {
    return loop!.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: sessionId } })
  }

  async function completeSessionTurn(sessionId: string): Promise<void> {
    await loop!.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID: sessionId } })
    await idle(sessionId)
  }

  async function runSection(sectionId: string, file: string): Promise<void> {
    const coding = loopService.getRunState(LOOP_NAME, `section:${sectionId}`)
    expect(coding).not.toBeNull()
    writeFileSync(join(coding!.runDir, file), `${file}\n`)
    await recordCoderHandoff(loop!, coding!.sessionId)
    await completeSessionTurn(coding!.sessionId)

    const auditing = loopService.getRunState(LOOP_NAME, `section:${sectionId}`)
    expect(auditing).not.toBeNull()
    expect(auditing!.phase).toBe('auditing')
    await recordAuditorHandoff(loop!, auditing!.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(auditing!.sessionId)
  }

  test('a diamond runs A alone, then B and C concurrently, then D from the merged tip', async () => {
    const calls = build()
    seedDiamond(2)

    await loop!.startReadySections(LOOP_NAME)

    const a = loopService.getRunState(LOOP_NAME, 'section:a')!
    expect(a.laneDir).toBe(join(forgeLanesDir(loopDir), 'a'))
    expect(loopService.listActiveRunStates(LOOP_NAME).filter((run) => run.sectionRunKind === 'section').map((run) => run.sectionId)).toEqual(['a'])
    expect(loopService.getRunState(LOOP_NAME, 'section:b')).toBeNull()
    expect(loopService.getRunState(LOOP_NAME, 'section:c')).toBeNull()

    await runSection('a', 'a.txt')
    expect(existsSync(forgeLanesDir(loopDir) + '/a')).toBe(false)
    expect(sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 0)!.status).toBe('completed')

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b.laneDir).toBe(join(forgeLanesDir(loopDir), 'b'))
    expect(c.laneDir).toBe(join(forgeLanesDir(loopDir), 'c'))
    expect(b.sessionId).not.toBe(c.sessionId)
    expect(loopService.getRunState(LOOP_NAME, 'section:d')).toBeNull()

    await runSection('b', 'b.txt')
    expect(loopService.getRunState(LOOP_NAME, 'section:c')).not.toBeNull()
    expect(loopService.getRunState(LOOP_NAME, 'section:d')).toBeNull()

    await runSection('c', 'c.txt')

    const d = loopService.getRunState(LOOP_NAME, 'section:d')!
    expect(d.laneDir).toBe(join(forgeLanesDir(loopDir), 'd'))
    expect(readFileSync(join(d.runDir, 'b.txt'), 'utf-8')).toBe('b.txt\n')
    expect(readFileSync(join(d.runDir, 'c.txt'), 'utf-8')).toBe('c.txt\n')

    await runSection('d', 'd.txt')

    const finished = loopService.getAnyState(LOOP_NAME)!
    expect(finished.terminationReason).toBe('completed')
    expect(sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 3)!.status).toBe('completed')
    expect(git(loopDir, 'rev-list --merges --count HEAD').trim()).toBe('4')
    for (const [sectionId, lane] of Object.entries({ a, b, c, d })) {
      expect(existsSync(lane.laneDir!), `lane ${sectionId} should be removed`).toBe(false)
    }
    expect(finished.iteration).toBe(5)

    const laneSessionCreates = calls.filter((call) =>
      call.method === 'session.create'
      && String((call.params as { directory?: string }).directory).includes('.lanes'))
    expect(laneSessionCreates.length).toBeGreaterThan(0)
    expect(laneSessionCreates.every((call) => (call.params as { workspaceID?: string }).workspaceID === undefined)).toBe(true)

    const lanePrompts = calls.filter((call) =>
      call.method === 'session.promptAsync'
      && String((call.params as { directory?: string }).directory).includes('.lanes'))
    expect(lanePrompts.length).toBeGreaterThan(0)
    expect(lanePrompts.every((call) => (call.params as { workspace?: string }).workspace === undefined)).toBe(true)
  })


  test('a lane loop enters post-action in the loop worktree after the last lane merges', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Section work complete.' }] },
        ],
      },
    })
    const runtime = buildLoopRuntime(testDb.db, {
      client,
      config: { ...mockConfig, loop: { enabled: true, defaultMaxIterations: 10, postAction: { enabled: true, skill: 'pr-review' } } },
      gitService: createGitService(),
    })
    loopService = runtime.loopService
    sectionPlansRepo = runtime.sectionPlansRepo
    loop = runtime.loop

    loopService.setState(LOOP_NAME, makeLoopState({
      loopName: LOOP_NAME,
      sessionId: 'seed-session',
      worktree: true,
      worktreeDir: loopDir,
      maxParallelSections: 2,
      maxIterations: 10,
      iteration: 1,
      totalSections: 0,
      currentSectionIndex: 0,
      sectionRunKind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
    }))
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, id: 'a', after: [], title: 'Section A', content: 'A body.\n\n### Files\n- a.txt' },
        { index: 1, id: 'b', after: ['a'], title: 'Section B', content: 'B body.\n\n### Files\n- b.txt' },
      ],
    })
    loopService.setTotalSections(LOOP_NAME, 2)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')
    await runSection('b', 'b.txt')

    const postAction = loopService.getActiveState(LOOP_NAME)!
    expect(postAction.phase).toBe('post_action')
    expect(postAction.runDir).toBe(loopDir)
    expect(postAction.laneDir).toBeFalsy()

    await recordPostActionComplete(loop!, postAction.sessionId)
    await completeSessionTurn(postAction.sessionId)

    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBe('completed')
    expect(existsSync(join(forgeLanesDir(loopDir), 'a'))).toBe(false)
    expect(existsSync(join(forgeLanesDir(loopDir), 'b'))).toBe(false)
  })


  test('an in-place attached first section runs in the loop worktree, then later sections use lanes', async () => {
    build()
    loopService.setState(LOOP_NAME, makeLoopState({
      loopName: LOOP_NAME,
      sessionId: 'attached-coder',
      worktree: true,
      worktreeDir: loopDir,
      maxParallelSections: 2,
      maxIterations: 10,
      iteration: 1,
      totalSections: 0,
      currentSectionIndex: 0,
      sectionRunKind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
    }))
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, id: 'a', after: [], title: 'Section A', content: 'A body.\n\n### Files\n- a.txt' },
        { index: 1, id: 'b', after: ['a'], title: 'Section B', content: 'B body.\n\n### Files\n- b.txt' },
        { index: 2, id: 'c', after: ['a'], title: 'Section C', content: 'C body.\n\n### Files\n- c.txt' },
      ],
    })
    loopService.setTotalSections(LOOP_NAME, 3)
    loopService.activateSectionRun(
      LOOP_NAME,
      { kind: 'section', sectionId: 'a', sectionIndex: 0 },
      { sessionId: 'attached-coder', phase: 'coding', standbySessionId: null },
      { exclusive: true },
    )

    writeFileSync(join(loopDir, 'a.txt'), 'a.txt\n')
    await recordCoderHandoff(loop!, 'attached-coder')
    await idle('attached-coder')

    const auditing = loopService.getRunState(LOOP_NAME, 'section:a')!
    expect(auditing.phase).toBe('auditing')
    expect(auditing.laneDir).toBeUndefined()
    await recordAuditorHandoff(loop!, auditing.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(auditing.sessionId)

    expect(loopService.getRunState(LOOP_NAME, 'section:a')).toBeNull()
    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b.laneDir).toBe(join(forgeLanesDir(loopDir), 'b'))
    expect(c.laneDir).toBe(join(forgeLanesDir(loopDir), 'c'))
    expect(readFileSync(join(b.runDir, 'a.txt'), 'utf-8')).toBe('a.txt\n')
  })

  test('an in-place attached section blocks lane starts until it retires', async () => {
    build()
    loopService.setState(LOOP_NAME, makeLoopState({
      loopName: LOOP_NAME,
      sessionId: 'attached-coder',
      worktree: true,
      worktreeDir: loopDir,
      maxParallelSections: 2,
      maxIterations: 10,
      iteration: 1,
      totalSections: 0,
      currentSectionIndex: 0,
      sectionRunKind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
    }))
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, id: 'a', after: [], title: 'Section A', content: 'A body.\n\n### Files\n- a.txt' },
        { index: 1, id: 'b', after: [], title: 'Section B', content: 'B body.\n\n### Files\n- b.txt' },
      ],
    })
    loopService.setTotalSections(LOOP_NAME, 2)
    loopService.activateSectionRun(
      LOOP_NAME,
      { kind: 'section', sectionId: 'a', sectionIndex: 0 },
      { sessionId: 'attached-coder', phase: 'coding', standbySessionId: null },
      { exclusive: true },
    )

    await loop!.startReadySections(LOOP_NAME)

    expect(loopService.getRunState(LOOP_NAME, 'section:b')).toBeNull()
    expect(existsSync(join(forgeLanesDir(loopDir), 'b'))).toBe(false)

    writeFileSync(join(loopDir, 'a.txt'), 'a.txt\n')
    await recordCoderHandoff(loop!, 'attached-coder')
    await idle('attached-coder')

    const auditing = loopService.getRunState(LOOP_NAME, 'section:a')!
    expect(auditing.phase).toBe('auditing')
    await recordAuditorHandoff(loop!, auditing.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(auditing.sessionId)

    expect(loopService.getRunState(LOOP_NAME, 'section:a')).toBeNull()
    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(b.laneDir).toBe(join(forgeLanesDir(loopDir), 'b'))
  })

  test('a lane merge conflict returns the section to coding and merges after the markers are resolved', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Section work complete.' }] },
        ],
      },
    })
    const runtime = buildLoopRuntime(testDb.db, {
      client,
      config: mockConfig,
      gitService: createGitService(),
    })
    loopService = runtime.loopService
    sectionPlansRepo = runtime.sectionPlansRepo
    loop = runtime.loop
    const reviewFindingsRepo = runtime.reviewFindingsRepo

    loopService.setState(LOOP_NAME, makeLoopState({
      loopName: LOOP_NAME,
      sessionId: 'seed-session',
      worktree: true,
      worktreeDir: loopDir,
      workspaceId: 'ws_lane',
      maxParallelSections: 2,
      maxIterations: 10,
      iteration: 1,
      totalSections: 0,
      currentSectionIndex: 0,
      sectionRunKind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
    }))
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, id: 'a', after: [], title: 'Section A', content: 'A body.\n\n### Files\n- a.txt' },
        { index: 1, id: 'b', after: ['a'], title: 'Section B', content: 'B body.\n\n### Files\n- b.txt' },
        { index: 2, id: 'c', after: ['a'], title: 'Section C', content: 'C body.\n\n### Files\n- c.txt' },
      ],
    })
    loopService.setTotalSections(LOOP_NAME, 3)

    await loop!.startReadySections(LOOP_NAME)

    const a = loopService.getRunState(LOOP_NAME, 'section:a')!
    writeFileSync(join(a.runDir, 'a.txt'), 'a.txt\n')
    await recordCoderHandoff(loop!, a.sessionId)
    await completeSessionTurn(a.sessionId)
    const aAudit = loopService.getRunState(LOOP_NAME, 'section:a')!
    expect(aAudit.phase).toBe('auditing')
    await recordAuditorHandoff(loop!, aAudit.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(aAudit.sessionId)

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(b).not.toBeNull()
    writeFileSync(join(b.runDir, 'b.txt'), 'b.txt\n')
    writeFileSync(join(b.runDir, 'shared.txt'), 'from b\n')
    await recordCoderHandoff(loop!, b.sessionId)
    await completeSessionTurn(b.sessionId)
    const bAudit = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(bAudit.phase).toBe('auditing')
    await recordAuditorHandoff(loop!, bAudit.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(bAudit.sessionId)

    expect(loopService.getRunState(LOOP_NAME, 'section:b')).toBeNull()
    expect(git(loopDir, 'show HEAD:shared.txt')).toBe('from b\n')

    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(c).not.toBeNull()
    writeFileSync(join(c.runDir, 'c.txt'), 'c.txt\n')
    writeFileSync(join(c.runDir, 'shared.txt'), 'from c\n')
    await recordCoderHandoff(loop!, c.sessionId)
    await completeSessionTurn(c.sessionId)
    const cAudit = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(cAudit.phase).toBe('auditing')
    await recordAuditorHandoff(loop!, cAudit.sessionId, CLEAN_AUDIT)

    const headBefore = git(loopDir, 'rev-parse HEAD').trim()
    expect(git(loopDir, 'status --porcelain').trim()).toBe('')
    await completeSessionTurn(cAudit.sessionId)

    expect(git(loopDir, 'rev-parse HEAD').trim()).toBe(headBefore)
    expect(git(loopDir, 'status --porcelain').trim()).toBe('')
    const retried = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(retried).not.toBeNull()
    expect(retried.phase).toBe('coding')
    expect(retried.laneDir).toBe(c.laneDir)
    expect(retried.runDir).toBe(c.laneDir)
    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBeFalsy()
    const bugs = reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME, 2)
      .filter((finding) => finding.severity === 'bug')
    expect(bugs).toHaveLength(1)
    expect(bugs[0].file).toBe('shared.txt')
    expect(bugs[0].line).toBe(1)
    expect(bugs[0].description).toContain('shared.txt')
    expect(existsSync(c.laneDir!)).toBe(true)

    writeFileSync(join(retried.runDir, 'shared.txt'), 'resolved\n')
    await recordCoderHandoff(loop!, retried.sessionId)
    await completeSessionTurn(retried.sessionId)
    const retryAudit = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(retryAudit.phase).toBe('auditing')
    reviewFindingsRepo.delete(PROJECT_ID, 'shared.txt', 1, { loopName: LOOP_NAME, sectionIndex: 2 })
    await recordAuditorHandoff(loop!, retryAudit.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(retryAudit.sessionId)

    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBe('completed')
    expect(readFileSync(join(loopDir, 'shared.txt'), 'utf-8')).toBe('resolved\n')
    expect(existsSync(c.laneDir!)).toBe(false)
    expect(git(loopDir, 'status --porcelain').trim()).toBe('')
    expect(git(loopDir, 'rev-parse HEAD').trim()).not.toBe(headBefore)
  })

  test('maxParallelSections 1 keeps the same plan serial in the loop worktree with no lane', async () => {
    build()
    seedDiamond(1)

    await loop!.startReadySections(LOOP_NAME)

    expect(existsSync(forgeLanesDir(loopDir))).toBe(false)
    expect(loopService.listActiveRunStates(LOOP_NAME).every((run) => run.laneDir === undefined)).toBe(true)
    const active = loopService.getActiveState(LOOP_NAME)!
    expect(active.laneDir).toBeUndefined()
    expect(active.runDir).toBe(loopDir)
  })

  test('cancel aborts every active lane session and keeps its lane worktree and uncommitted files', async () => {
    const calls = build()
    seedDiamond(2)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()
    writeFileSync(join(b.runDir, 'b-wip.txt'), 'b-wip\n')
    writeFileSync(join(c.runDir, 'c-wip.txt'), 'c-wip\n')

    expect(loop!.getStallInfo(LOOP_NAME)).not.toBeNull()

    calls.length = 0
    await loop!.cancel(LOOP_NAME)

    const aborted = calls
      .filter((call) => call.method === 'session.abort')
      .map((call) => (call.params as { sessionID?: string }).sessionID)
    expect(aborted).toContain(b.sessionId)
    expect(aborted).toContain(c.sessionId)

    expect(loopService.getAnyState(LOOP_NAME)!.active).toBe(false)
    expect(existsSync(b.laneDir!)).toBe(true)
    expect(existsSync(c.laneDir!)).toBe(true)
    expect(readFileSync(join(b.runDir, 'b-wip.txt'), 'utf-8')).toBe('b-wip\n')
    expect(readFileSync(join(c.runDir, 'c-wip.txt'), 'utf-8')).toBe('c-wip\n')
    expect(loop!.getStallInfo(LOOP_NAME)).toBeNull()
  })

  test('restart resumes both lanes, recreating a deleted lane from the loop tip and reusing the surviving one', async () => {
    const calls = build()
    seedDiamond(2)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()
    writeFileSync(join(b.runDir, 'b-wip.txt'), 'b-wip\n')
    writeFileSync(join(c.runDir, 'c-wip.txt'), 'c-wip\n')

    await loop!.cancel(LOOP_NAME)
    rmSync(b.laneDir!, { recursive: true, force: true })

    loopsRepo.restart(PROJECT_ID, LOOP_NAME, {
      sessionId: b.sessionId,
      phase: 'coding',
      iteration: 1,
      auditCount: 0,
      sandbox: false,
      sandboxContainer: null,
      workspaceId: null,
      auditorModel: null,
      currentSectionIndex: 0,
      totalSections: 4,
      startedAt: Date.now(),
      keepActiveRuns: true,
    })

    const resumed = await loop!.resumeLanes(LOOP_NAME)
    expect(resumed).not.toBeNull()
    expect(resumed!.sectionId).toBe('b')

    const rb = loopService.getRunState(LOOP_NAME, 'section:b')
    const rc = loopService.getRunState(LOOP_NAME, 'section:c')
    expect(rb).not.toBeNull()
    expect(rc).not.toBeNull()
    expect(resumed!.sessionId).toBe(rb!.sessionId)
    expect(rb!.sessionId).not.toBe(b.sessionId)
    expect(rc!.sessionId).not.toBe(c.sessionId)
    expect(existsSync(rb!.laneDir!)).toBe(true)
    expect(existsSync(rc!.laneDir!)).toBe(true)
    expect(rb!.laneBaseCommit).toBe(git(loopDir, 'rev-parse HEAD').trim())
    expect(readFileSync(join(rc!.runDir, 'c-wip.txt'), 'utf-8')).toBe('c-wip\n')

    const prompted = calls
      .filter((call) => call.method === 'session.promptAsync')
      .map((call) => (call.params as { sessionID?: string }).sessionID)
    expect(prompted).toContain(rb!.sessionId)
    expect(prompted).toContain(rc!.sessionId)
  })

  test('restarting a running lane aborts its session and restarts coding in the same lane', async () => {
    const calls = build()
    seedDiamond(2)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()

    writeFileSync(join(c.runDir, 'c.txt'), 'c.txt\n')
    await recordCoderHandoff(loop!, c.sessionId)
    await completeSessionTurn(c.sessionId)

    const cAudit = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(cAudit.phase).toBe('auditing')
    expect(cAudit.sessionId).not.toBe(c.sessionId)

    calls.length = 0
    await loop!.restartRunCoding(LOOP_NAME, 'section:c', 'test reason')

    expect(loopService.getAnyState(LOOP_NAME)!.active).toBe(true)
    const restarted = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(restarted).not.toBeNull()
    expect(restarted.phase).toBe('coding')
    expect(restarted.laneDir).toBe(c.laneDir)
    expect(restarted.runDir).toBe(c.runDir)
    expect(restarted.sessionId).not.toBe(cAudit.sessionId)

    const aborted = calls
      .filter((call) => call.method === 'session.abort')
      .map((call) => (call.params as { sessionID?: string }).sessionID)
    expect(aborted).toContain(cAudit.sessionId)

    const restartPrompt = calls.find((call) =>
      call.method === 'session.promptAsync'
      && (call.params as { sessionID?: string }).sessionID === restarted.sessionId)
    expect(restartPrompt).toBeDefined()
    expect(JSON.stringify(restartPrompt!.params)).toContain('instructions changed')

    const bUntouched = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(bUntouched.sessionId).toBe(b.sessionId)
    expect(bUntouched.phase).toBe('coding')
    expect(bUntouched.runDir).toBe(b.runDir)

    await runSection('c', 'c.txt')
    await runSection('b', 'b.txt')
    await runSection('d', 'd.txt')

    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBe('completed')
  })

  test('editing a completed section reopens it and it runs again in a new lane', async () => {
    buildWithPlanAmendments()
    seedDiamond(2)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')

    const aDone = sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 0)!
    expect(aDone.status).toBe('completed')
    expect(aDone.completedAt).not.toBeNull()

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    writeFileSync(join(b.runDir, 'b.txt'), 'b.txt\n')
    await recordCoderHandoff(loop!, b.sessionId)
    await completeSessionTurn(b.sessionId)

    const bAudit = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(bAudit.phase).toBe('auditing')

    const tool = createPlanAdjustTool({ loop } as any)
    const result = JSON.parse(await tool.execute({
      edits: [{ id: 'a', title: 'Section A again', content: 'A body again.\n\n### Files\n- a2.txt' }],
      rationale: 'A must be redone',
    } as any, { sessionID: bAudit.sessionId } as any))
    expect(result.ok).toBe(true)

    const reopened = sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 0)!
    expect(reopened.status).toBe('pending')
    expect(reopened.completedAt).toBeNull()
    expect(reopened.checkpointCommit).toBe(aDone.checkpointCommit)
    expect(reopened.title).toBe('Section A again')

    expect(loopService.getRunState(LOOP_NAME, 'section:b')!.sessionId).toBe(bAudit.sessionId)
    expect(loopService.getRunState(LOOP_NAME, 'section:c')!.sessionId).toBe(c.sessionId)

    await recordAuditorHandoff(loop!, bAudit.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(bAudit.sessionId)
    await runSection('c', 'c.txt')

    const aRerun = loopService.getRunState(LOOP_NAME, 'section:a')!
    expect(aRerun).not.toBeNull()
    expect(aRerun.laneDir).toBe(join(forgeLanesDir(loopDir), 'a'))
    await runSection('a', 'a2.txt')

    const aAgain = sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 0)!
    expect(aAgain.status).toBe('completed')
    expect(existsSync(join(forgeLanesDir(loopDir), 'a'))).toBe(false)
    expect(git(loopDir, 'show HEAD:a2.txt')).toBe('a2.txt\n')

    await runSection('d', 'd.txt')

    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBe('completed')
  })

  test('an auditor in one lane edits a running section and restarts it in its lane', async () => {
    buildWithPlanAmendments()
    seedDiamond(2)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()

    writeFileSync(join(b.runDir, 'b.txt'), 'b.txt\n')
    await recordCoderHandoff(loop!, b.sessionId)
    await completeSessionTurn(b.sessionId)
    const bAudit = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(bAudit.phase).toBe('auditing')

    const tool = createPlanAdjustTool({ loop } as any)
    const result = JSON.parse(await tool.execute({
      edits: [{ id: 'c', title: 'Section C v2', content: 'C body v2.\n\n### Files\n- c.txt' }],
      rationale: 'C needs a different approach',
    } as any, { sessionID: bAudit.sessionId } as any))
    expect(result.ok).toBe(true)

    const edited = sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 2)!
    expect(edited.title).toBe('Section C v2')
    expect(edited.content).toContain('C body v2')

    const restarted = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(restarted).not.toBeNull()
    expect(restarted.phase).toBe('coding')
    expect(restarted.laneDir).toBe(c.laneDir)
    expect(restarted.runDir).toBe(c.runDir)
    expect(restarted.sessionId).not.toBe(c.sessionId)

    const bStillAuditing = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(bStillAuditing.sessionId).toBe(bAudit.sessionId)
    expect(bStillAuditing.phase).toBe('auditing')
    expect(loopService.getAnyState(LOOP_NAME)!.active).toBe(true)

    await recordAuditorHandoff(loop!, bAudit.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(bAudit.sessionId)
    await runSection('c', 'c.txt')
    await runSection('d', 'd.txt')

    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBe('completed')
  })

  test('a pending dependent waits for a reopened section to complete', async () => {
    buildWithPlanAmendments()
    loopService.setState(LOOP_NAME, makeLoopState({
      loopName: LOOP_NAME,
      sessionId: 'seed-session',
      worktree: true,
      worktreeDir: loopDir,
      workspaceId: 'ws_lane',
      maxParallelSections: 2,
      maxIterations: 10,
      iteration: 1,
      totalSections: 0,
      currentSectionIndex: 0,
      sectionRunKind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
    }))
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, id: 'a', after: [], title: 'Section A', content: 'A body.\n\n### Files\n- a.txt' },
        { index: 1, id: 'b', after: ['a'], title: 'Section B', content: 'B body.\n\n### Files\n- b.txt' },
        { index: 2, id: 'c', after: ['a'], title: 'Section C', content: 'C body.\n\n### Files\n- c.txt' },
        { index: 3, id: 'e', after: ['a'], title: 'Section E', content: 'E body.\n\n### Files\n- e.txt' },
        { index: 4, id: 'd', after: ['b', 'c'], title: 'Section D', content: 'D body.\n\n### Files\n- d.txt' },
      ],
    })
    loopService.setTotalSections(LOOP_NAME, 5)

    await loop!.startReadySections(LOOP_NAME)
    await runSection('a', 'a.txt')

    const b = loopService.getRunState(LOOP_NAME, 'section:b')!
    const c = loopService.getRunState(LOOP_NAME, 'section:c')!
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()
    expect(loopService.getRunState(LOOP_NAME, 'section:e')).toBeNull()

    writeFileSync(join(b.runDir, 'b.txt'), 'b.txt\n')
    await recordCoderHandoff(loop!, b.sessionId)
    await completeSessionTurn(b.sessionId)
    const bAudit = loopService.getRunState(LOOP_NAME, 'section:b')!
    expect(bAudit.phase).toBe('auditing')

    const tool = createPlanAdjustTool({ loop } as any)
    const result = JSON.parse(await tool.execute({
      edits: [{ id: 'a', title: 'Section A again', content: 'A body again.\n\n### Files\n- a2.txt' }],
      rationale: 'A must be redone before its dependents run',
    } as any, { sessionID: bAudit.sessionId } as any))
    expect(result.ok).toBe(true)

    const reopened = sectionPlansRepo.get(PROJECT_ID, LOOP_NAME, 0)!
    expect(reopened.status).toBe('pending')
    expect(reopened.completedAt).toBeNull()
    expect(loopService.getRunState(LOOP_NAME, 'section:e')).toBeNull()
    expect(loopService.getRunState(LOOP_NAME, 'section:b')!.sessionId).toBe(bAudit.sessionId)
    expect(loopService.getRunState(LOOP_NAME, 'section:c')!.sessionId).toBe(c.sessionId)

    await recordAuditorHandoff(loop!, bAudit.sessionId, CLEAN_AUDIT)
    await completeSessionTurn(bAudit.sessionId)

    const aRerun = loopService.getRunState(LOOP_NAME, 'section:a')!
    expect(aRerun).not.toBeNull()
    expect(aRerun.laneDir).toBe(join(forgeLanesDir(loopDir), 'a'))
    expect(loopService.getRunState(LOOP_NAME, 'section:e')).toBeNull()

    await runSection('a', 'a2.txt')
    expect(loopService.getRunState(LOOP_NAME, 'section:e')).not.toBeNull()

    await runSection('c', 'c.txt')
    await runSection('e', 'e.txt')
    await runSection('d', 'd.txt')

    expect(loopService.getAnyState(LOOP_NAME)!.terminationReason).toBe('completed')
  })

  test('completed teardown removes every lane worktree and lane branch', async () => {
    build()
    seedDiamond(2)

    const gitService = createGitService()
    const laneLogger = createMockLogger()
    const laneA = createLane({ git: gitService, logger: laneLogger, loopName: LOOP_NAME, worktreeDir: loopDir, sectionId: 'a' })
    const laneB = createLane({ git: gitService, logger: laneLogger, loopName: LOOP_NAME, worktreeDir: loopDir, sectionId: 'b' })
    expect(existsSync(laneA.laneDir)).toBe(true)
    expect(existsSync(laneB.laneDir)).toBe(true)
    expect(git(join(rootDir, 'repo'), 'branch --list "forge-lane/*"')).not.toBe('')

    const state = loopService.getAnyState(LOOP_NAME)!
    const logger = createMockLogger()
    const { client } = createFakeForgeClient({
      workspace: { list: async () => [], remove: async () => {} },
    })

    vi.stubEnv('FORGE_UNWARP_SETTLE_MS', '0')
    try {
      await performTerminationSideEffects(state, { kind: 'completed' }, state.sessionId, {
        client,
        logger,
        getConfig: () => mockConfig,
      })
    } finally {
      vi.unstubAllEnvs()
    }

    expect(existsSync(forgeLanesDir(loopDir))).toBe(false)
    expect(existsSync(loopDir)).toBe(false)
    expect(git(join(rootDir, 'repo'), 'branch --list "forge-lane/*"').trim()).toBe('')
  })
})
