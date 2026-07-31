import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { normalizePastedPlanText } from '../utils/marked-plan-parser'
import { writeSessionPlanContent } from '../services/plan-capture'
import { formatPlanStructureSummary, summarizePlanStructure } from '../utils/plan-structure'

const z = tool.schema

/**
 * Returns an error message when the session is currently driving a running
 * loop, else null. The stored plan for a running loop is amended only via
 * `plan-adjust` during a section audit, so direct authoring from inside such a
 * session is blocked. Sessions whose loop has already terminated stay writable.
 */
function assertWritableSession(ctx: ToolContext, sessionID: string): string | null {
  const state = ctx.loop.service.resolveActiveLoopForSession(sessionID)
  if (state) {
    return (
      `Cannot modify the plan from an active loop session (loop: ${state.loopName}). ` +
      `The stored plan for a running loop is amended with plan-adjust during a section audit.`
    )
  }
  return null
}

/**
 * Wraps `normalizePastedPlanText` and maps its reasons to user-facing messages
 * for the `plan-write` tool. Returns the normalized body on success.
 */
function normalizeFragment(content: string): { ok: true; text: string } | { ok: false; message: string } {
  const result = normalizePastedPlanText(content)
  if (result.ok) {
    return { ok: true, text: result.planText }
  }
  switch (result.reason) {
    case 'empty':
      return { ok: false, message: 'content is empty.' }
    case 'multiple':
      return { ok: false, message: 'content contains more than one <!-- forge-plan:start --> / <!-- forge-plan:end --> pair.' }
    case 'unterminated':
      return { ok: false, message: 'content contains an unbalanced <!-- forge-plan:start --> / <!-- forge-plan:end --> marker.' }
  }
}

/**
 * Writes the plan text through the shared session-scoped write path and
 * returns a structural report (counts + warnings) for the architect.
 */
function writeAndReport(
  ctx: ToolContext,
  sessionID: string,
  planText: string,
  prefix?: string,
  sectionDetail?: 'all' | 'latest',
): string {
  const result = writeSessionPlanContent(
    { plansRepo: ctx.plansRepo, projectId: ctx.projectId, directory: ctx.directory, logger: ctx.logger },
    sessionID,
    planText,
  )
  return `${prefix ?? ''}${formatPlanStructureSummary(summarizePlanStructure(result.planText), { sectionDetail })}`
}

export function createPlanAuthoringTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  return {
    'plan-write': tool({
      description:
        'Create, overwrite, or append to the implementation plan stored for the current session. This is the plan of record used by execute-plan and by the plan approval flow. Author long plans incrementally with append instead of emitting the whole plan in chat.',
      args: {
        content: z
          .string()
          .min(1)
          .describe(
            'Stored plan markdown. Use <!-- forge-section --> markers before each ## Phase heading.',
          ),
        append: z
          .boolean()
          .optional()
          .describe(
            'Append to the existing stored plan instead of replacing it. Two newlines are inserted between the existing content and the new fragment. Creates the plan when none exists.',
          ),
      },
      execute: async (args, context) => {
        const guard = assertWritableSession(ctx, context.sessionID)
        if (guard) return guard

        const normalized = normalizeFragment(args.content)
        if (!normalized.ok) return `plan-write failed: ${normalized.message}`

        let next: string
        if (args.append) {
          const existing = ctx.plansRepo.getForSession(ctx.projectId, context.sessionID)
          next = existing ? `${existing.content.trimEnd()}\n\n${normalized.text}` : normalized.text
        } else {
          next = normalized.text
        }

        ctx.logger.log(
          `plan-write: ${args.append ? 'appended to' : 'wrote'} plan for session ${context.sessionID} (${next.length} chars)`,
        )
        return writeAndReport(ctx, context.sessionID, next, undefined, args.append ? 'latest' : 'all')
      },
    }),

    'plan-edit': tool({
      description:
        'Edit the implementation plan stored for the current session by exact string replacement, the same way the Edit tool edits a file. Use plan-read to get the current text before editing. Do not include plan-read\'s "N: " line-number prefixes in oldString.',
      args: {
        oldString: z
          .string()
          .min(1)
          .describe('Exact text to replace, including indentation. Must match exactly once unless replaceAll is true.'),
        newString: z.string().describe('Replacement text. Must differ from oldString.'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of requiring a unique match.'),
      },
      execute: async (args, context) => {
        const guard = assertWritableSession(ctx, context.sessionID)
        if (guard) return guard

        const existing = ctx.plansRepo.getForSession(ctx.projectId, context.sessionID)
        if (!existing) {
          return 'plan-edit failed: no plan stored for this session. Use plan-write to create it first.'
        }

        if (args.oldString === args.newString) {
          return 'plan-edit failed: oldString and newString are identical.'
        }

        const parts = existing.content.split(args.oldString)
        const occurrences = parts.length - 1
        if (occurrences === 0) {
          return (
            'plan-edit failed: oldString not found in the stored plan. ' +
            'Use plan-read to inspect the current text; whitespace and indentation must match exactly.'
          )
        }
        if (occurrences > 1 && !args.replaceAll) {
          return (
            `plan-edit failed: found ${occurrences} matches for oldString. ` +
            'Add surrounding context to make it unique, or set replaceAll: true.'
          )
        }

        const next = args.replaceAll
          ? parts.join(args.newString)
          : parts[0] + args.newString + parts.slice(1).join(args.oldString)

        if (next.trim() === '') {
          return (
            'plan-edit failed: replacement would leave the plan empty. ' +
            'Keep non-whitespace content in newString, or use plan-write to replace the plan.'
          )
        }

        ctx.logger.log(
          `plan-edit: replaced ${occurrences} occurrence(s) for session ${context.sessionID}`,
        )
        return writeAndReport(ctx, context.sessionID, next, `Replaced ${occurrences} occurrence(s).\n`)
      },
    }),
  }
}
