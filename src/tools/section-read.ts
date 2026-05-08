import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createSectionReadTool(ctx: ToolContext): ReturnType<typeof tool> {
  const { loopService } = ctx

  return tool({
    description: 'Read a section plan and its status for the active loop session. If section_index is omitted, returns the lowest-index incomplete section.',
    args: {
      section_index: z.number().optional().describe('Section index to read (0-based). If omitted, reads the lowest-index incomplete section.'),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx?.sessionID ?? ''
      const loopName = loopService.resolveLoopName(sessionId)

      if (!loopName) {
        return JSON.stringify({ error: 'Not in a loop session. This tool can only be used within an active loop session.' })
      }

      const state = loopService.getAnyState(loopName)
      if (!state) return JSON.stringify({ error: `Loop "${loopName}" not found.` })

      if (state.totalSections === 0) {
        return JSON.stringify({ error: 'No sections available. This loop does not use section-based decomposition.' })
      }

      const explicitIndex = args.section_index
      const selectedSection = explicitIndex === undefined
        ? loopService.getNextIncompleteSectionPlan(state)
        : null

      const idx = explicitIndex ?? selectedSection?.sectionIndex ?? state.currentSectionIndex
      if (idx < 0 || idx >= state.totalSections) {
        return JSON.stringify({ error: `Invalid section index ${idx}. Valid range: 0-${state.totalSections - 1}` })
      }

      const section = explicitIndex === undefined && selectedSection?.sectionIndex === idx
        ? selectedSection
        : loopService.getSectionPlan(state, idx)
      if (!section) return JSON.stringify({ error: `Section ${idx} not found in loop "${loopName}".` })

      const digest = loopService.getCompletedSectionDigest(state)
      const summary = digest.find(s => s.index === idx)

      const result = {
        index: idx,
        title: section.title,
        content: section.content,
        status: section.status,
        summary_done: summary?.summaryDone ?? null,
        summary_deviations: summary?.summaryDeviations ?? null,
        summary_follow_ups: summary?.summaryFollowUps ?? null,
      }

      return JSON.stringify(result)
    },
  })
}
