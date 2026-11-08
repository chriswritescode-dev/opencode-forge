import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { __resetLoopRuntimeSharedState, type Loop } from '../../src/loop/runtime'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import { __resetInFlightGuard } from '../../src/loop/in-flight-guard'
import { createGitService } from '../../src/utils/git-service'
import { forgeLanesDir } from '../../src/workspace/forge-naming'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
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
    sectionPlansRepo = runtime.sectionPlansRepo
    loop = runtime.loop
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
})
