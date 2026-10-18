import { describe, test, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLoopChangeNotifier } from '../../src/host/forge-core'
import { acquireGoalOrchestratorDb, type GoalOrchestrator } from '../../src/services/goal-orchestrator'
import { closeDatabase, hasTable, initializeDatabase } from '../../src/storage'
import type { Logger } from '../../src/types'

function createHarness() {
  const onLoopSettled = vi.fn(async (_loopName: string) => {})
  const orchestrator = { onLoopSettled } as unknown as GoalOrchestrator
  const publishLoopsChanged = vi.fn()
  const errors: unknown[] = []
  const logger: Logger = {
    log: () => {},
    error: (_message: string, err?: unknown) => {
      errors.push(err)
    },
    debug: () => {},
  }

  const notify = createLoopChangeNotifier({
    directory: '/tmp/project',
    projectId: 'test-project',
    publishLoopsChanged,
    getGoalOrchestrator: () => orchestrator,
    logger,
  })

  return { notify, onLoopSettled, publishLoopsChanged, errors }
}

describe('createLoopChangeNotifier', () => {
  test('routes a settled loop to the goal orchestrator and publishes the change', () => {
    const { notify, onLoopSettled, publishLoopsChanged } = createHarness()

    notify('settled', 'chunk-loop', { projectDir: '/tmp/project' })

    expect(onLoopSettled).toHaveBeenCalledWith('chunk-loop')
    expect(publishLoopsChanged).toHaveBeenCalledTimes(1)
  })

  test('does not touch the goal orchestrator for other reasons', () => {
    const { notify, onLoopSettled, publishLoopsChanged } = createHarness()

    notify('terminate', 'chunk-loop')
    notify('insert', 'chunk-loop')

    expect(onLoopSettled).not.toHaveBeenCalled()
    expect(publishLoopsChanged).toHaveBeenCalledTimes(2)
  })

  test('publishes without an orchestrator and never throws', () => {
    const publishLoopsChanged = vi.fn()
    const notify = createLoopChangeNotifier({
      directory: '/tmp/project',
      projectId: 'test-project',
      publishLoopsChanged,
      getGoalOrchestrator: () => undefined,
      logger: { log: () => {}, error: () => {}, debug: () => {} },
    })

    expect(() => notify('settled', 'chunk-loop')).not.toThrow()
    expect(publishLoopsChanged).toHaveBeenCalledTimes(1)
  })

  test('catches a rejected settled dispatch and logs it', async () => {
    const { notify, onLoopSettled, errors } = createHarness()
    onLoopSettled.mockRejectedValue(new Error('boom'))

    notify('settled', 'chunk-loop')
    await vi.waitFor(() => expect(errors).toHaveLength(1))
  })
})

describe('acquireGoalOrchestratorDb', () => {
  test('shares one handle per forge database path', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'forge-goal-db-'))
    try {
      const first = acquireGoalOrchestratorDb(dataDir)
      const second = acquireGoalOrchestratorDb(dataDir)

      expect(second).toBe(first)
      expect(hasTable(first, 'goals')).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('outlives an instance database handle that closes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'forge-goal-db-'))
    try {
      const shared = acquireGoalOrchestratorDb(dataDir)
      const instanceDb = initializeDatabase(dataDir, { completedLoopTtlMs: 1234 })
      closeDatabase(instanceDb)

      expect(hasTable(shared, 'goal_chunks')).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
