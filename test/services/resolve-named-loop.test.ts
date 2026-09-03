import { describe, test, expect } from 'vitest'
import { resolveNamedLoop } from '../../src/services/execution'
import type { LoopState } from '../../src/loop/state'
import type { Loop } from '../../src/loop/runtime'

function makeLoopState(loopName: string, worktreeBranch?: string): LoopState {
  return {
    active: false,
    sessionId: `sess-${loopName}`,
    loopName,
    worktreeDir: `/tmp/${loopName}`,
    ...(worktreeBranch ? { worktreeBranch } : {}),
    iteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,
    status: 'completed',
    phase: 'coding',
    currentSectionIndex: 0,
    totalSections: 0,
    finalAuditDone: false,
  }
}

describe('resolveNamedLoop', () => {
  const name = 'my-loop'

  test('returns the matching state', () => {
    const state = makeLoopState(name)
    const loop = {
      findMatchByName: () => ({ match: state, candidates: [] }),
      listLoopNames: () => [name],
    } as unknown as Loop

    const result = resolveNamedLoop({ loop }, name)
    expect(result).toEqual({ state })
  })

  test('ambiguous name returns conflict with candidate loop names', () => {
    const loop = {
      findMatchByName: () => ({
        match: null,
        candidates: [makeLoopState('loop-a', 'forge/loop-a'), makeLoopState('loop-b', 'forge/loop-b')],
      }),
      listLoopNames: () => ['loop-a', 'loop-b', 'loop-c'],
    } as unknown as Loop

    const result = resolveNamedLoop({ loop }, name)
    expect('response' in result && result.response.ok).toBe(false)
    if (!('response' in result)) throw new Error('expected response')
    expect(result.response.error).toEqual({
      code: 'conflict',
      status: 409,
      message: `Multiple loops match "${name}". Be more specific.`,
      details: undefined,
      candidates: ['loop-a', 'loop-b'],
    })
  })

  test('unknown name returns not_found with available loop names without hydrating plans', () => {
    const listLoopNames = () => ['loop-a', 'loop-b']
    const loop = {
      findMatchByName: () => ({ match: null, candidates: [] }),
      listLoopNames,
    } as unknown as Loop

    const result = resolveNamedLoop({ loop }, name)
    expect('response' in result && result.response.ok).toBe(false)
    if (!('response' in result)) throw new Error('expected response')
    expect(result.response.error).toEqual({
      code: 'not_found',
      status: 404,
      message: `No loop found for "${name}".`,
      details: undefined,
      candidates: ['loop-a', 'loop-b'],
    })
  })

  test('not-found path never calls plan-hydrating listings', () => {
    const loop = {
      findMatchByName: () => ({ match: null, candidates: [] }),
      listLoopNames: () => [],
    } as unknown as Loop

    const result = resolveNamedLoop({ loop }, name)
    expect('response' in result && result.response.error.candidates).toEqual([])
  })
})
