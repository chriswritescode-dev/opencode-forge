import { expect } from 'vitest'
import { LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME } from '../../src/constants/loop'
import type { Loop } from '../../src/loop/runtime'
import type { AuditorHandoffPayload, CoderHandoffPayload, PostActionCompletePayload } from '../../src/loop/handoff'

export function coderPayload(overrides: Partial<CoderHandoffPayload> = {}): CoderHandoffPayload {
  return {
    changes: [{ summary: 'Implemented the requested change', reason: 'Satisfies the section acceptance criteria' }],
    deviations: [],
    verification: [{ command: 'pnpm typecheck', cwd: '.', outcome: 'pass', changedAfter: false }],
    ...overrides,
  }
}

export function postActionPayload(overrides: Partial<PostActionCompletePayload> = {}): PostActionCompletePayload {
  return {
    outcome: 'completed',
    steps: [{ name: 'Post-action workflow', status: 'done' }],
    followUps: [],
    ...overrides,
  }
}

export async function recordCoderHandoff(
  loop: Loop,
  sessionId: string,
  overrides: Partial<CoderHandoffPayload> = {},
): Promise<void> {
  const result = await loop.recordHandoff({
    sessionId,
    tool: LOOP_HANDOFF_TOOL_NAME,
    args: coderPayload(overrides),
  })
  expect(result.ok).toBe(true)
}

export async function recordAuditorHandoff(
  loop: Loop,
  sessionId: string,
  args: AuditorHandoffPayload = {},
): Promise<void> {
  const result = await loop.recordHandoff({ sessionId, tool: LOOP_HANDOFF_TOOL_NAME, args })
  expect(result.ok).toBe(true)
}

export async function recordPostActionComplete(
  loop: Loop,
  sessionId: string,
  overrides: Partial<PostActionCompletePayload> = {},
): Promise<void> {
  const result = await loop.recordHandoff({
    sessionId,
    tool: LOOP_COMPLETE_TOOL_NAME,
    args: postActionPayload(overrides),
  })
  expect(result.ok).toBe(true)
}
