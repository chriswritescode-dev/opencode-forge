import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createPlanAdjustTool(ctx: ToolContext): ReturnType<typeof tool> {
  const loop = ctx.loop

  return tool({
    description: 'Adjust the remaining (not yet started) sections of the active loop plan. Only callable by the loop auditor. The plan objective and verification are immutable; amendments replace pending sections and are logged.',
    args: {
      sections: z.array(z.object({
        title: z.string(),
        content: z.string(),
      })).min(0).max(20).describe('Replacement list for remaining sections (from current index + 1 onwards). Omit completed/curre section; max 20 total sections allowed.'),
      rationale: z.string().min(1).describe('Why the plan needs adjustment. Never use to relax acceptance criteria or verification — the objective is immutable.'),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx?.sessionID ?? ''
      const loopName = loop.service.resolveLoopName(sessionId)

      if (!loopName) {
        return JSON.stringify({ error: 'Not in a loop session. This tool can only be used within an active loop session.' })
      }

      const state = loop.service.getAnyState(loopName)
      if (!state) return JSON.stringify({ error: `Loop "${loopName}" not found.` })

      if (!state.active) {
        return JSON.stringify({ error: `Loop "${loopName}" is not active.` })
      }

      if (state.phase !== 'auditing') {
        return JSON.stringify({ error: `Plan adjustment is only allowed during auditing phase (current phase: ${state.phase}).` })
      }

      if (state.sessionId !== sessionId) {
        return JSON.stringify({ error: `Session mismatch: this tool can only be used by the current auditor session for loop "${loopName}".` })
      }

      const result = await loop.service.adjustRemainingSections(loopName, {
        sections: args.sections,
        rationale: args.rationale,
        auditorSessionId: sessionId,
      })

      if (!result.ok) {
        return JSON.stringify({ error: result.error })
      }

      return JSON.stringify({ ok: true, total_sections: result.totalSections })
    },
  })
}
