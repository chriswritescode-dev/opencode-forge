import { describe, it, expect } from 'vitest'
import { nextTransition, type Transition, type TransitionEvent } from '../../src/loop/transitions'
import type { LoopState } from '../../src/loop/state'

function makeState(overrides: Partial<LoopState> & { phase: LoopState['phase'] }): LoopState {
  return {
    active: true,
    sessionId: 'session-1',
    loopName: 'test-loop',
    worktreeDir: '/tmp/test',
    iteration: 1,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,

    currentSectionIndex: 0,
    totalSections: 0,
    ...overrides,
  }
}

describe('nextTransition', () => {
  describe('coding phase', () => {
    it('rotates to auditing on coder-handoff', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'coder-handoff' })
      expect(transition).toEqual({ kind: 'rotate' })
    })

    it('terminates with missing_worktree_dir on missing-worktree-dir event', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'missing-worktree-dir' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'missing_worktree_dir' } })
    })

    it('terminates with session_creation_failed', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'session-creation-failed' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'session_creation_failed' } })
    })

    it('terminates with handoff_missing', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'handoff-missing' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'handoff_missing' } })
    })

    it('terminates with max_iterations on iteration-cap', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'iteration-cap' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'max_iterations' } })
    })

    it('terminates with user_aborted on user-abort', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'user-abort' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'user_aborted' } })
    })

    it('terminates with shutdown', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'shutdown' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'shutdown' } })
    })

    it('terminates with stall_timeout', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'stall-timeout' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'stall_timeout' } })
    })

    it('terminates with error_max_retries', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'error-max-retries', context: 'send prompt' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'error_max_retries', message: 'send prompt' } })
    })
  })

  describe('auditing phase (sectioned)', () => {
    it('advances section on middle section clean', () => {
      const state = makeState({
        phase: 'auditing',
        totalSections: 3,
        currentSectionIndex: 1,
      })
      const transition = nextTransition(state, { type: 'section-clean', isLastOpenSection: false })
      expect(transition).toEqual({ kind: 'advance-section' })
    })

    it('terminates with completed on last open section clean', () => {
      const state = makeState({
        phase: 'auditing',
        totalSections: 3,
        currentSectionIndex: 2,
      })
      const transition = nextTransition(state, { type: 'section-clean', isLastOpenSection: true })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'completed' } })
    })

    it('rotates to coding on dirty section', () => {
      const state = makeState({
        phase: 'auditing',
        totalSections: 3,
        currentSectionIndex: 1,
      })
      const transition = nextTransition(state, { type: 'section-dirty' })
      expect(transition).toEqual({ kind: 'rotate' })
    })
  })

  describe('auditing phase (non-sectioned)', () => {
    it('terminates with completed on audit-clear', () => {
      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        currentSectionIndex: 0,
      })
      const transition = nextTransition(state, { type: 'audit-clear' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'completed' } })
    })

    it('continues on audit-dirty', () => {
      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        currentSectionIndex: 0,
      })
      const transition = nextTransition(state, { type: 'audit-dirty' })
      expect(transition).toEqual({ kind: 'continue' })
    })
  })

  describe('auditing phase common events', () => {
    it('terminates with max_iterations on iteration-cap', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'iteration-cap' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'max_iterations' } })
    })

    it('terminates with user_aborted on user-abort', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'user-abort' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'user_aborted' } })
    })

    it('terminates with shutdown', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'shutdown' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'shutdown' } })
    })

    it('terminates with stall_timeout', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'stall-timeout' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'stall_timeout' } })
    })

    it('terminates with missing_worktree_dir', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'missing-worktree-dir' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'missing_worktree_dir' } })
    })

    it('terminates with handoff_missing', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'handoff-missing' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'handoff_missing' } })
    })
  })

  describe('post_action phase', () => {
    it('terminates with completed on post-action-complete', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'post-action-complete' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'completed' } })
    })

    it('stays best-effort and completes on handoff_missing', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'handoff-missing' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'completed' } })
    })

    it('terminates with max_iterations on iteration-cap', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'iteration-cap' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'max_iterations' } })
    })

    it('terminates with user_aborted on user-abort', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'user-abort' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'user_aborted' } })
    })

    it('terminates with shutdown', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'shutdown' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'shutdown' } })
    })

    it('terminates with stall_timeout', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'stall-timeout' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'stall_timeout' } })
    })

    it('terminates with missing_worktree_dir', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'missing-worktree-dir' })
      expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'missing_worktree_dir' } })
    })
  })



  describe('unhandled events in each phase', () => {
    it('returns noop for unhandled events in coding phase', () => {
      const state = makeState({ phase: 'coding' })
      const transition = nextTransition(state, { type: 'nonexistent-event' as any })
      expect(transition).toEqual({ kind: 'noop' })
    })

    it('returns noop for unhandled events in auditing phase', () => {
      const state = makeState({ phase: 'auditing' })
      const transition = nextTransition(state, { type: 'nonexistent-event' as any })
      expect(transition).toEqual({ kind: 'noop' })
    })

    it('returns noop for unhandled events in post_action phase', () => {
      const state = makeState({ phase: 'post_action' })
      const transition = nextTransition(state, { type: 'nonexistent-event' as any })
      expect(transition).toEqual({ kind: 'noop' })
    })
  })

  describe('cross-phase error events', () => {
    const phases = ['coding', 'auditing', 'post_action'] as const

    phases.forEach(phase => {
      it(`handles error-max-retries in ${phase} phase`, () => {
        const state = makeState({ phase })
        const transition = nextTransition(state, { type: 'error-max-retries', context: 'retry context' })
        expect(transition).toEqual({ kind: 'terminate', reason: { kind: 'error_max_retries', message: 'retry context' } })
      })
    })
  })

  describe('state immutability', () => {
    it('does not modify the input state', () => {
      const state = makeState({ phase: 'coding' })
      const original = JSON.stringify(state)
      nextTransition(state, { type: 'coder-handoff' })
      expect(JSON.stringify(state)).toBe(original)
    })
  })
})
