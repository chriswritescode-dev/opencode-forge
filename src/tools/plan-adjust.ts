import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { MAX_TOTAL_SECTIONS } from '../loop/service'

const z = tool.schema

export function createPlanAdjustTool(ctx: ToolContext): ReturnType<typeof tool> {
  const loop = ctx.loop

  return tool({
    description: 'Adjust the remaining (not yet started) sections of the active loop plan. Only callable by the loop auditor. The plan objective and verification are immutable; amendments replace pending sections and are logged.',
    args: {
      sections: z.array(z.object({
        title: z.string(),
        content: z.string(),
      })).min(0).max(MAX_TOTAL_SECTIONS).describe(`Replacement list for remaining sections (from current index + 1 onwards). Omit completed and current sections; the resulting total (completed + current + replacements) may not exceed ${MAX_TOTAL_SECTIONS} sections.`),
      rationale: z.string().min(1).describe('Why the plan needs adjustment. Never use to relax acceptance criteria or verification — the objective is immutable.'),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx?.sessionID ?? ''
      const loopName = loop.service.resolveLoopName(sessionId)

      if (!loopName) {
        return JSON.stringify({ error: 'Not in a loop session. This tool can only be used within an active loop session.' })
      }

      // Guards (loop exists, active, auditing phase, session authorization,
      // section cap) are enforced authoritatively inside adjustRemainingSections
      // under its write lock; the tool only resolves the loop and surfaces errors.
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
