import { describe, test, expect } from 'vitest'
import { resolveForgeLoopExtraSpec } from '../../src/services/execution'

describe('resolveForgeLoopExtraSpec', () => {
  test('goal kind with non-blank goal returns trimmed goal', () => {
    expect(resolveForgeLoopExtraSpec({ kind: 'goal', goal: 'do the thing' })).toEqual({
      ok: true,
      kind: 'goal',
      goal: 'do the thing',
    })
  })

  test('goal kind trims surrounding whitespace from goal', () => {
    expect(resolveForgeLoopExtraSpec({ kind: 'goal', goal: '  do the thing  ' })).toEqual({
      ok: true,
      kind: 'goal',
      goal: 'do the thing',
    })
  })

  test('goal kind with blank goal is rejected', () => {
    expect(resolveForgeLoopExtraSpec({ kind: 'goal', goal: '   ' })).toEqual({
      ok: false,
      error: 'forgeLoop.kind is "goal" but forgeLoop.goal is missing or blank',
    })
  })

  test('goal kind with missing goal is rejected', () => {
    expect(resolveForgeLoopExtraSpec({ kind: 'goal' })).toEqual({
      ok: false,
      error: 'forgeLoop.kind is "goal" but forgeLoop.goal is missing or blank',
    })
  })

  test('goal kind with non-string goal is rejected', () => {
    expect(resolveForgeLoopExtraSpec({ kind: 'goal', goal: 42 } as unknown as Parameters<typeof resolveForgeLoopExtraSpec>[0])).toEqual({
      ok: false,
      error: 'forgeLoop.kind is "goal" but forgeLoop.goal is missing or blank',
    })
    expect(resolveForgeLoopExtraSpec({ kind: 'goal', goal: null } as unknown as Parameters<typeof resolveForgeLoopExtraSpec>[0])).toEqual({
      ok: false,
      error: 'forgeLoop.kind is "goal" but forgeLoop.goal is missing or blank',
    })
    expect(resolveForgeLoopExtraSpec({ kind: 'goal', goal: { text: 'x' } } as unknown as Parameters<typeof resolveForgeLoopExtraSpec>[0])).toEqual({
      ok: false,
      error: 'forgeLoop.kind is "goal" but forgeLoop.goal is missing or blank',
    })
  })

  test('plan kind with inline planSource and planText returns planText', () => {
    expect(resolveForgeLoopExtraSpec({ planSource: 'inline', planText: 'X' })).toEqual({
      ok: true,
      kind: 'plan',
      planText: 'X',
    })
  })

  test('undefined config yields a plan result with empty planText (backwards compat)', () => {
    expect(resolveForgeLoopExtraSpec(undefined)).toEqual({
      ok: true,
      kind: 'plan',
      planText: '',
    })
  })

  test('config without kind or planText yields empty planText', () => {
    expect(resolveForgeLoopExtraSpec({ planSource: 'stored' })).toEqual({
      ok: true,
      kind: 'plan',
      planText: '',
    })
  })

  test('kind: "plan" is treated as a plan loop', () => {
    expect(resolveForgeLoopExtraSpec({ kind: 'plan', planSource: 'inline', planText: 'Y' })).toEqual({
      ok: true,
      kind: 'plan',
      planText: 'Y',
    })
  })
})
