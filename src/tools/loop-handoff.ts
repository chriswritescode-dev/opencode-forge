import { tool, type ToolCallContext, type ToolDefinition } from './tool'
import type { ToolContext } from './types'
import { LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME, type LoopPhaseToolName } from '../constants/loop'
import { auditorHandoffSchema, coderHandoffSchema, postActionCompleteSchema } from '../loop/handoff'

const coderShape = coderHandoffSchema.shape
const auditorShape = auditorHandoffSchema.shape

export function createLoopHandoffTools(ctx: ToolContext): Record<string, ToolDefinition> {
  const loop = ctx.loop

  async function record(toolName: LoopPhaseToolName, args: unknown, toolCtx: ToolCallContext): Promise<string> {
    const result = await loop.recordHandoff({ sessionId: toolCtx.sessionID, tool: toolName, args })
    if (!result.ok) return JSON.stringify({ error: result.error })
    const replaced = result.replaced ? ' It replaced your earlier handoff from this turn.' : ''
    return JSON.stringify({ ok: true, message: `Handoff recorded — end your turn now; make no further changes.${replaced}` })
  }

  return {
    [LOOP_HANDOFF_TOOL_NAME]: tool({
      description: 'Record the handoff for the current loop phase, then end your turn. In coding, pass the coder fields: changes, deviations, verification, and optional notes. In auditing, pass the auditor fields: optional summary (required only when the section is clean) and optional notes. Only the loop\'s current session may call this. After it succeeds, make no further changes.',
      args: {
        changes: coderShape.changes.optional().describe('Coder only: what changed and why. At least one entry.'),
        deviations: coderShape.deviations.unwrap().optional().describe('Coder only: where the implementation deviated from the plan section and why.'),
        verification: coderShape.verification.optional().describe('Coder only: every check you ran, its working directory, its outcome, and whether code changed afterwards. At least one entry.'),
        summary: auditorShape.summary.optional().describe('Auditor only: the section summary (done, deviations, followUps). Required for a clean sectioned audit; forbidden while blocking bug findings remain open or for a non-sectioned loop.'),
        notes: coderShape.notes.optional().describe('Optional notes for the next role.'),
      },
      execute: (args, toolCtx) => record(LOOP_HANDOFF_TOOL_NAME, args, toolCtx),
    }),
    [LOOP_COMPLETE_TOOL_NAME]: tool({
      description: 'Record completion of the current post-action session, then end your turn. Pass the outcome, every step with its status, follow-ups, and notes. Only the loop\'s current post-action session may call this. After it succeeds, make no further changes.',
      args: postActionCompleteSchema.shape,
      execute: (args, toolCtx) => record(LOOP_COMPLETE_TOOL_NAME, args, toolCtx),
    }),
  }
}
