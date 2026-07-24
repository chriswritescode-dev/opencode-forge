import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { MAX_TOTAL_SECTIONS } from '../loop/service'

const z = tool.schema

export function createPlanAdjustTool(ctx: ToolContext): ReturnType<typeof tool> {
  const loop = ctx.loop

  return tool({
    description: 'Adjust the active loop plan during a section audit. Only callable by the loop auditor. Can revise the section currently being audited (currentSection) and/or replace the remaining not-yet-started sections (sections). Already-completed sections and the plan objective/verification are immutable. Amendments are logged.',
    args: {
      sections: z.array(z.object({
        title: z.string(),
        content: z.string(),
      })).min(0).max(MAX_TOTAL_SECTIONS).optional().describe(`Replacement list for the pending sections after the current one (from current index + 1 onwards). Omit to leave future sections unchanged; pass an empty array to remove the entire pending suffix. The resulting total (completed + current + replacements) may not exceed ${MAX_TOTAL_SECTIONS} sections.`),
      currentSection: z.object({
        title: z.string(),
        content: z.string(),
      }).optional().describe('Revised plan for the section currently under audit, edited in place (its progress is preserved). If the revision means the existing work no longer satisfies the section, also write bug findings so it is re-coded. Never relax acceptance criteria or verification — the objective is immutable.'),
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
        currentSection: args.currentSection,
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
