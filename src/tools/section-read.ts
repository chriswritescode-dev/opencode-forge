import { tool, type ToolDefinition } from './tool'
import type { ToolContext } from './types'
import { formatSectionStatusTable } from '../loop/prompts'
import { pendingSuffixStart } from '../loop/section-graph'

const z = tool.schema

export function createSectionReadTool(ctx: ToolContext): ToolDefinition {
  const loop = ctx.loop

  return tool({
    description: 'Read a section plan and its status for the active loop session. If section_index is omitted, returns the next ready section (the first open section whose dependencies are all completed). With pending_suffix: true, returns the ordered pending sections after the current one instead. With overview: true, returns the loop\'s section status table instead.',
    args: {
      section_index: z.number().optional().describe('Section index to read (0-based). If omitted, reads the next ready section (the first open section whose dependencies are all completed).'),
      pending_suffix: z.boolean().optional().describe('When true, return one JSON object with from_index and every pending section the current section may replace, in order. Cannot be combined with section_index or overview.'),
      overview: z.boolean().optional().describe('When true, return the loop\'s section status table (index, id, title, after, status, lane, checkpoint) instead of one section. Cannot be combined with section_index or pending_suffix.'),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx?.sessionID ?? ''
      const runState = loop.service.getRunStateForSession(sessionId)
      const loopName = runState?.loopName ?? loop.service.resolveLoopName(sessionId)

      if (!loopName) {
        return JSON.stringify({ error: 'Not in a loop session. This tool can only be used within an active loop session.' })
      }

      const state = runState ?? loop.service.getAnyState(loopName)
      if (!state) return JSON.stringify({ error: `Loop "${loopName}" not found.` })

      if (state.totalSections === 0) {
        return JSON.stringify({ error: 'No sections available for this loop.' })
      }

      if (args.overview === true) {
        if (args.section_index !== undefined || args.pending_suffix === true) {
          return JSON.stringify({ error: 'overview cannot be combined with section_index or pending_suffix. Call section-read with only one of the three.' })
        }
        const rows = loop.service.getSectionPlans(state)
        return JSON.stringify({
          from_index: pendingSuffixStart(rows, state.currentSectionIndex),
          status_table: formatSectionStatusTable(rows, loop.service.listActiveRunStates(state.loopName)),
        })
      }

      if (args.pending_suffix === true) {
        if (args.section_index !== undefined) {
          return JSON.stringify({ error: 'pending_suffix cannot be combined with section_index. Call section-read with only one of the two.' })
        }
        const rows = loop.service.getSectionPlans(state)
        const fromIndex = pendingSuffixStart(rows, state.currentSectionIndex)
        const sections = rows
          .filter(r => r.sectionIndex >= fromIndex && r.status === 'pending')
          .map(r => ({ index: r.sectionIndex, id: r.sectionId, after: r.dependsOn, title: r.title, content: r.content, status: r.status }))
        return JSON.stringify({ from_index: fromIndex, sections })
      }

      const explicitIndex = args.section_index
      const selectedSection = explicitIndex === undefined
        ? (runState
            ? loop.service.getSectionPlan(runState, runState.currentSectionIndex)
            : loop.service.getNextReadySectionPlan(state))
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
        id: section.sectionId,
        after: section.dependsOn,
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
