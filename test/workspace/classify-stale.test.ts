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

  test('missing extra.loopName → keep/no-loop-name', () => {
    const entry = { id: 'ws1', type: 'forge', extra: {} }
    const result = classifyForgeWorkspace(entry, createMockLoopsRepo(), projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'no-loop-name' })
  })

  test('missing extra.projectDirectory → keep/no-project-directory', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: { loopName: 'test-loop' },
    }
    const result = classifyForgeWorkspace(entry, createMockLoopsRepo(), projectId, projectDirectory)
    expect(result).toEqual({ action: 'keep', reason: 'no-project-directory' })
  })

  test('projectDirectory mismatch → keep/wrong-project', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        loopName: 'test-loop',
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
        loopName: 'test-loop',
        projectDirectory,
      },
    }
    const loopsRepo = createMockLoopsRepo({ get: vi.fn().mockReturnValue(null) })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)
    expect(result).toEqual({ action: 'remove-fully', reason: 'missing-row', loopName: 'test-loop' })
  })

  test('missing row with pending TUI attach inside grace window → keep/pending-attach', () => {
    const nowMs = 10_000
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        loopName: 'test-loop',
        projectDirectory,
        forgeLoop: {
          initialPromptOwner: 'tui',
          pendingAttachStartedAt: nowMs - 1_000,
        },
      },
    }
    const loopsRepo = createMockLoopsRepo({ get: vi.fn().mockReturnValue(null) })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory, { nowMs, pendingAttachGraceMs: 5_000 })
    expect(result).toEqual({ action: 'keep', reason: 'pending-attach' })
  })

  test('missing row with expired TUI attach grace → remove-fully/missing-row', () => {
    const nowMs = 10_000
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        loopName: 'test-loop',
        projectDirectory,
        forgeLoop: {
          initialPromptOwner: 'tui',
          pendingAttachStartedAt: nowMs - 10_000,
        },
      },
    }
    const loopsRepo = createMockLoopsRepo({ get: vi.fn().mockReturnValue(null) })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory, { nowMs, pendingAttachGraceMs: 5_000 })
    expect(result).toEqual({ action: 'remove-fully', reason: 'missing-row', loopName: 'test-loop' })
  })

  test('missing row with fresh workspace creation timestamp → keep/pending-start', () => {
    const nowMs = 10_000
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        loopName: 'test-loop',
        projectDirectory,
        workspaceCreatedAt: nowMs - 1_000,
      },
    }
    const loopsRepo = createMockLoopsRepo({ get: vi.fn().mockReturnValue(null) })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory, { nowMs, pendingAttachGraceMs: 5_000 })
    expect(result).toEqual({ action: 'keep', reason: 'pending-start' })
  })

  test('missing row with expired workspace creation timestamp → remove-fully/missing-row', () => {
    const nowMs = 10_000
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        loopName: 'test-loop',
        projectDirectory,
        workspaceCreatedAt: nowMs - 10_000,
      },
    }
    const loopsRepo = createMockLoopsRepo({ get: vi.fn().mockReturnValue(null) })
    const result = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory, { nowMs, pendingAttachGraceMs: 5_000 })
    expect(result).toEqual({ action: 'remove-fully', reason: 'missing-row', loopName: 'test-loop' })
  })

  test('running loop → keep/running', () => {
    const entry = {
      id: 'ws1',
      type: 'forge',
      extra: {
        loopName: 'test-loop',
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
        loopName: 'test-loop',
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
        loopName: 'test-loop',
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
        loopName: 'test-loop',
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
        loopName: 'test-loop',
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
