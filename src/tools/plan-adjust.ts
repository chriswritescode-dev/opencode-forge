import { tool, type ToolDefinition } from './tool'
import type { ToolContext } from './types'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'

const z = tool.schema

const nonBlankString = z.string().refine((value) => value.trim().length > 0, { error: 'must not be blank or whitespace-only' })

export function createPlanAdjustTool(ctx: ToolContext): ToolDefinition {
  const loop = ctx.loop

  return tool({
    description: 'Adjust the active loop plan during a section audit. Only callable by the loop auditor. Revises the executable section instructions — the section currently being audited (currentSection) and/or the pending suffix (sections). The stored master plan row is unchanged, so the master objective and top-level Verification remain authoritative. Amendments are logged; the tool does not semantically validate the adjusted instructions.',
    args: {
      sections: z.array(z.object({
        title: nonBlankString,
        content: nonBlankString,
        id: z.string().optional().describe('Stable slug for the section, copied from section-read pending_suffix to keep a retained milestone\'s identity (and any dependencies on it) stable across renumbering. Omit to get "section-<n>" generated from its new index.'),
        after: z.array(z.string()).optional().describe('Ids this section depends on: only completed sections, the current section, or earlier entries in this replacements list. Omit to depend on the previous section (the current section for the first entry); pass an empty array for no dependencies. Copy from section-read pending_suffix unless the dependency itself changes.'),
      })).min(0).max(MAX_TOTAL_SECTIONS).optional().describe(`Replacement list for the pending sections after the current one (from current index + 1 onwards). This replaces the entire pending suffix — omissions delete milestones, so include every later milestone you intend to retain. Omit to leave future sections unchanged; pass an empty array to remove the entire pending suffix. The resulting total (completed + current + replacements) may not exceed ${MAX_TOTAL_SECTIONS} sections. Copy each retained milestone's id and after from section-read pending_suffix: ids and dependency edges are validated (unique, known, and pointing only at earlier sections), and an invalid graph writes nothing.`),
      currentSection: z.object({
        title: nonBlankString,
        content: nonBlankString,
      }).optional().describe('Revised plan for the section currently under audit, edited in place (its progress is preserved). If the revision requires code, write severity: bug findings in the same audit so it is re-coded. Revisions must not weaken acceptance criteria or verification merely to obtain a clean audit.'),
      rationale: z.string().min(1).describe('Why the plan needs adjustment. Revisions must not weaken acceptance criteria or verification merely to obtain a clean audit.'),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx?.sessionID ?? ''
      const loopName = loop.service.resolveLoopName(sessionId)

      if (!loopName) {
        return JSON.stringify({ error: 'Not in a loop session. This tool can only be used within an active loop session.' })
      }

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
