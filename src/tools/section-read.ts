import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createSectionReadTool(ctx: ToolContext): ReturnType<typeof tool> {
  const loop = ctx.loop

  return tool({
    description: 'Read a section plan and its status for the active loop session. If section_index is omitted, returns the lowest-index incomplete section. With pending_suffix: true, returns the ordered pending sections after the current one instead.',
    args: {
      section_index: z.number().optional().describe('Section index to read (0-based). If omitted, reads the lowest-index incomplete section.'),
      pending_suffix: z.boolean().optional().describe('When true, return one JSON object with from_index (current section + 1) and every pending section after the current one, in order. Cannot be combined with section_index.'),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx?.sessionID ?? ''
      const loopName = loop.service.resolveLoopName(sessionId)

      if (!loopName) {
        return JSON.stringify({ error: 'Not in a loop session. This tool can only be used within an active loop session.' })
      }

      const state = loop.service.getAnyState(loopName)
      if (!state) return JSON.stringify({ error: `Loop "${loopName}" not found.` })

      if (state.totalSections === 0) {
        return JSON.stringify({ error: 'No sections available for this loop.' })
      }

      if (args.pending_suffix === true) {
        if (args.section_index !== undefined) {
          return JSON.stringify({ error: 'pending_suffix cannot be combined with section_index. Call section-read with only one of the two.' })
        }
        const sections = loop.service.getSectionPlans(state)
          .filter(r => r.sectionIndex > state.currentSectionIndex && r.status === 'pending')
          .map(r => ({ index: r.sectionIndex, title: r.title, content: r.content, status: r.status }))
        return JSON.stringify({ from_index: state.currentSectionIndex + 1, sections })
      }

      const explicitIndex = args.section_index
      const selectedSection = explicitIndex === undefined
        ? loop.service.getNextIncompleteSectionPlan(state)
        : null

      const idx = explicitIndex ?? selectedSection?.sectionIndex ?? state.currentSectionIndex
      if (idx < 0 || idx >= state.totalSections) {
        return JSON.stringify({ error: `Invalid section index ${idx}. Valid range: 0-${state.totalSections - 1}` })
      }

      const section = explicitIndex === undefined && selectedSection?.sectionIndex === idx
        ? selectedSection
        : loop.service.getSectionPlan(state, idx)
      if (!section) return JSON.stringify({ error: `Section ${idx} not found in loop "${loopName}".` })

      const digest = loop.service.getCompletedSectionDigest(state)
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
