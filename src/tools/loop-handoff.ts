import { tool, type ToolCallContext } from './tool'
import type { ToolContext } from './types'
import { LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME, type LoopPhaseToolName } from '../constants/loop'
import { auditorHandoffFields, coderHandoffFields, postActionCompleteFields, type HandoffArgs } from '../loop/handoff'

export function createLoopHandoffTools(ctx: ToolContext) {
  const loop = ctx.loop

  async function record(toolName: LoopPhaseToolName, args: HandoffArgs, toolCtx: ToolCallContext): Promise<string> {
    const result = await loop.recordHandoff({ sessionId: toolCtx.sessionID, tool: toolName, args, signal: toolCtx.signal })
    if (!result.ok) return JSON.stringify({ error: result.error })
    const replaced = result.replaced ? ' It replaced your earlier handoff from this turn.' : ''
    return JSON.stringify({ ok: true, message: `Handoff recorded — end your turn now; make no further changes.${replaced}` })
  }

  return {
    [LOOP_HANDOFF_TOOL_NAME]: tool({
      description: 'Record the handoff for the current loop phase, then end your turn. In coding, pass the coder fields: changes, deviations, verification, and optional notes. In auditing, pass the auditor fields: optional summary (required only when the section is clean) and optional notes. Only the loop\'s current session may call this. After it succeeds, make no further changes.',
      args: {
        changes: coderHandoffFields.changes.optional().describe('Coder only: what changed and why. At least one entry.'),
        deviations: coderHandoffFields.deviations.unwrap().optional().describe('Coder only: where the implementation deviated from the plan section and why.'),
        verification: coderHandoffFields.verification.optional().describe('Coder only: every check you ran, its working directory, its outcome, and whether code changed afterwards. At least one entry.'),
        summary: auditorHandoffFields.summary.optional().describe('Auditor only: the section summary (done, deviations, followUps). Required for a clean sectioned audit; forbidden while blocking bug findings remain open or for a non-sectioned loop.'),
        notes: coderHandoffFields.notes.optional().describe('Optional notes for the next role.'),
      },
      execute: (args, toolCtx) => record(LOOP_HANDOFF_TOOL_NAME, args, toolCtx),
    }),
    [LOOP_COMPLETE_TOOL_NAME]: tool({
      description: 'Record completion of the current post-action session, then end your turn. Pass the outcome, every step with its status, follow-ups, and notes. Only the loop\'s current post-action session may call this. After it succeeds, make no further changes.',
      args: postActionCompleteFields,
      execute: (args, toolCtx) => record(LOOP_COMPLETE_TOOL_NAME, args, toolCtx),
    }),
  }
}
