import { describe, test, expect, vi } from 'vitest'
import { classifyForgeWorkspace } from '../../src/workspace/classify-stale'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'

function createMockLoopsRepo(overrides?: Partial<LoopsRepo>): LoopsRepo {
  return {
    insert: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    getLarge: vi.fn(),
    getBySessionId: vi.fn(),
    listByStatus: vi.fn(),
    listAll: vi.fn(),
    updatePhase: vi.fn(),
    updateIteration: vi.fn(),
    incrementError: vi.fn(),
    resetError: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setWorkspaceId: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setModelFailed: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
    setSandboxContainer: vi.fn(),
    setStatus: vi.fn(),
    setPhaseAndResetError: vi.fn(),
    replaceSession: vi.fn(),
    restart: vi.fn(),
    terminate: vi.fn(),
    delete: vi.fn(),
    findPartial: vi.fn(),
    setCurrentSectionIndex: vi.fn(),
    setTotalSections: vi.fn(),
    setFinalAuditDone: vi.fn(),
    ...overrides,
  }
}

describe('classifyForgeWorkspace', () => {
  const projectId = 'test-project'
  const projectDirectory = '/tmp/test-project'

  test('non-forge workspace → keep/not-forge', () => {
    const entry = { id: 'ws1', type: 'worktree', extra: {} }
    const result = classifyForgeWorkspace(entry, createMockLoopsRepo(), projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'not-forge' })
  })

  test('missing forgeLoop.loopName → keep/no-loop-name', () => {
    const entry = { id: 'ws1', type: 'forge', extra: { forgeLoop: {} } }
    const result = classifyForgeWorkspace(entry, createMockLoopsRepo(), projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'no-loop-name' })
  })

  test('missing extra.projectDirectory → keep/no-project-directory', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: { forgeLoop: { loopName: 'test-loop' } },
    }
    const result = classifyForgeWorkspace(entry, createMockLoopsRepo(), projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'no-project-directory' })
  })

  test('projectDirectory mismatch → keep/wrong-project', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory: '/tmp/other-project',
      },
    }
    const result = classifyForgeWorkspace(entry, createMockLoopsRepo(), projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'wrong-project' })
  })

  test('missing row in loopsRepo → remove-fully/missing-row', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({ get: vi.fn().mockReturnValue(null) })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'remove-fully', reason: 'missing-row', loopName: 'test-loop' })
  })

  test('running loop → keep/running', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'test-loop', status: 'running' }),
    })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'running' })
  })

  test('completed loop → remove-fully/completed', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'test-loop', status: 'completed' }),
    })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'remove-fully', reason: 'completed', loopName: 'test-loop' })
  })

  test('cancelled loop → remove-registration-only/restartable-terminal', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'test-loop', status: 'cancelled' }),
    })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'remove-registration-only', reason: 'restartable-terminal', loopName: 'test-loop' })
  })

  test('errored loop → remove-registration-only/restartable-terminal', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'test-loop', status: 'errored' }),
    })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'remove-registration-only', reason: 'restartable-terminal', loopName: 'test-loop' })
  })

  test('stalled loop → remove-registration-only/restartable-terminal', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        forgeLoop: { loopName: 'test-loop' },
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'test-loop', status: 'stalled' }),
    })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'remove-registration-only', reason: 'restartable-terminal', loopName: 'test-loop' })
  })
})
