import { describe, it, expect, vi } from 'vitest'
import { isWorkspaceNotFoundError } from '../src/hooks/loop'
import { createWorkspaceLifecycle } from '../src/loop/runtime-workspace'
import type { LoopState } from '../src/loop/state'
import type { Logger } from '../src/types'
import { createFakeForgeClient } from './helpers/fake-client'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    active: true,
    sessionId: 'sess-1',
    loopName: 'branch-loop',
    worktreeDir: '/tmp/wt',
    projectDir: '/tmp/project',
    worktreeBranch: 'feature/custom',
    iteration: 1,
    maxIterations: 0,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,
    status: 'running',
    worktree: true,
    phase: 'coding',
    currentSectionIndex: 0,
    totalSections: 0,
    ...overrides,
  }
}

describe('workspace recovery', () => {
  describe('isWorkspaceNotFoundError', () => {
    it('returns true for Error with Workspace not found message', () => {
      const err = new Error('Workspace not found: wrk_x')
      expect(isWorkspaceNotFoundError(err)).toBe(true)
    })

    it('returns true for string message with Workspace not found', () => {
      const msg = 'Workspace not found: wrk_y'
      expect(isWorkspaceNotFoundError(msg)).toBe(true)
    })

    it('returns true for JSON-stringified error data', () => {
      const data = { message: 'Workspace not found' }
      expect(isWorkspaceNotFoundError(data)).toBe(true)
    })

    it('returns false for unrelated errors', () => {
      const err = new Error('Connection timeout')
      expect(isWorkspaceNotFoundError(err)).toBe(false)
    })

    it('handles null/undefined gracefully', () => {
      expect(isWorkspaceNotFoundError(null)).toBe(false)
      expect(isWorkspaceNotFoundError(undefined)).toBe(false)
    })
  })

  describe('branch re-provisioning', () => {
    it('recoverFromMissingWorkspace re-provisions with the persisted branch', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws_recovered', directory: '/tmp/wt', branch: 'feature/custom' }),
        },
      })
      const loopService = { clearWorkspaceId: vi.fn(), setWorkspaceId: vi.fn() } as any
      const lifecycle = createWorkspaceLifecycle({ client, logger: mockLogger, loopService })
      const state = makeState({ workspaceId: 'ws_missing' })

      const result = await lifecycle.recoverFromMissingWorkspace('branch-loop', state, 'sess-1', 'test')

      expect(result).toEqual({ workspaceId: 'ws_recovered', recovered: true })
      const createArgs = (client.workspace.create as any).mock.calls[0][0]
      expect(createArgs.extra.branch).toBe('feature/custom')
      expect(state.workspaceId).toBe('ws_recovered')
      expect(loopService.setWorkspaceId).toHaveBeenCalledWith('branch-loop', 'ws_recovered')
    })

    it('ensureWorkspaceForLoop provisions with the persisted branch', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws_provisioned', directory: '/tmp/wt', branch: 'feature/custom' }),
        },
      })
      const loopService = { clearWorkspaceId: vi.fn(), setWorkspaceId: vi.fn() } as any
      const lifecycle = createWorkspaceLifecycle({ client, logger: mockLogger, loopService })
      const state = makeState({ workspaceId: undefined })

      const result = await lifecycle.ensureWorkspaceForLoop('branch-loop', state, 'test')

      expect(result).toEqual({ workspaceId: 'ws_provisioned' })
      const createArgs = (client.workspace.create as any).mock.calls[0][0]
      expect(createArgs.extra.branch).toBe('feature/custom')
      expect(state.workspaceId).toBe('ws_provisioned')
    })
  })
})
