import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { assertWritableSession } from './session-write-guard'
import {
  formatGoalBriefSummary,
  hasPlanStructureViolations,
  summarizeGoalBrief,
} from '../utils/goal-brief'

const z = tool.schema

export function createGoalAuthoringTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  return {
    'goal-write': tool({
      description:
        'Create, overwrite, or append to the goal brief stored for the current session. The goal brief is the launch input for the Forge execution dialog and is authored before a loop is launched, not from inside a running loop. Phases and section markers belong in the plan, not the brief; goal-write rejects content that carries plan structure (<!-- forge-section --> markers or ## Phase headings).',
      args: {
        content: z
          .string()
          .min(1)
          .describe('Goal brief markdown. Use ## headings for Goal, Context, Constraints, and Acceptance Criteria.'),
        append: z
          .boolean()
          .optional()
          .describe(
            'Append to the existing stored brief instead of replacing it. Two newlines are inserted between the existing content and the new fragment. Creates the brief when none exists.',
          ),
      },
      execute: async (args, context) => {
        const guard = assertWritableSession(ctx, context.sessionID, {
          artifactLabel: 'goal brief',
          amendGuidance: 'Goal briefs are authored before launch, not from inside a running loop.',
        })
        if (guard) return guard

        let next: string
        if (args.append) {
          const existing = ctx.goalBriefsRepo.getForSession(ctx.projectId, context.sessionID)
          next = existing ? `${existing.content.trimEnd()}\n\n${args.content}` : args.content
        } else {
          next = args.content
        }

        const structure = summarizeGoalBrief(next)
        if (hasPlanStructureViolations(structure)) {
          return `goal-write failed: a goal brief must not contain plan structure.\n${formatGoalBriefSummary(structure)}`
        }

        ctx.goalBriefsRepo.writeForSession(ctx.projectId, context.sessionID, next)
        ctx.logger.log(
          `goal-write: ${args.append ? 'appended to' : 'wrote'} goal brief for session ${context.sessionID} (${next.length} chars)`,
        )
        return formatGoalBriefSummary(structure)
      },
    }),
  }
}
