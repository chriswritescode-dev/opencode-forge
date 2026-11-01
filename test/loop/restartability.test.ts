import { describe, it, expect } from 'vitest'
import { getRestartability } from '../../src/loop/restartability'
import { makeLoopState } from '../helpers/loop-fixtures'

const STATE_DEFAULTS = {
  active: false,
  sessionId: 'session-1',
  worktreeDir: '/tmp/forge/worktrees/test-loop',
  projectDir: '/tmp/project',
  worktreeBranch: 'forge/test-loop',
  iteration: 5,
  maxIterations: 10,
  status: 'cancelled',
  terminationReason: 'user_aborted',
} as const

describe('getRestartability', () => {
  it('blocks completed loops regardless of branch/worktree', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS, status: 'completed', terminationReason: 'completed' })
    const result = getRestartability(state, {
      worktreeExists: () => true,
      branchExists: () => true,
    })
    expect(result.restartable).toBe(false)
    expect(result.restartBlockedReason).toBe('completed')
  })

  it('restarts a cancelled loop when the worktree directory exists', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS })
    const result = getRestartability(state, { worktreeExists: () => true })
    expect(result.restartable).toBe(true)
    expect(result.restartRequiresForce).toBe(false)
  })

  it('allows restart when the worktree dir is missing but the branch survives', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS })
    const result = getRestartability(state, {
      worktreeExists: () => false,
      branchExists: () => true,
    })
    expect(result.restartable).toBe(true)
    expect(result.restartBlockedReason).toBeUndefined()
  })

  it('blocks restart when both the worktree dir and the branch are gone', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS })
    const result = getRestartability(state, {
      worktreeExists: () => false,
      branchExists: () => false,
    })
    expect(result.restartable).toBe(false)
    expect(result.restartBlockedReason).toBe('missing_worktree')
    expect(result.restartBlockedMessage).toContain('worktree directory no longer exists')
  })

  it('blocks restart when the worktree dir is missing and no branch predicate is provided', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS })
    const result = getRestartability(state, { worktreeExists: () => false })
    expect(result.restartable).toBe(false)
    expect(result.restartBlockedReason).toBe('missing_worktree')
  })

  it('does not probe the branch when the worktree directory still exists', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS })
    let probed = false
    const result = getRestartability(state, {
      worktreeExists: () => true,
      branchExists: () => {
        probed = true
        return false
      },
    })
    expect(result.restartable).toBe(true)
    expect(probed).toBe(false)
  })

  it('requires force for active loops even when restartable', () => {
    const state = makeLoopState({ ...STATE_DEFAULTS, active: true, status: 'running', terminationReason: undefined })
    const result = getRestartability(state, { worktreeExists: () => true })
    expect(result.restartable).toBe(true)
    expect(result.restartRequiresForce).toBe(true)
    expect(result.restartBlockedReason).toBe('active_requires_force')
  })
})
