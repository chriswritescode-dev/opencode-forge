import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createPlanTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { kvService, projectId, logger, loopService } = ctx

  function resolvePlanKey(sessionID: string): string {
    const worktreeName = loopService.resolveWorktreeName(sessionID)
    if (worktreeName) {
      return `plan:${worktreeName}`
    }
    return `plan:${sessionID}`
  }

  return {
    'plan-write': tool({
      description: 'Write or overwrite the entire plan content for the current session. Auto-resolves key to plan:{sessionID}.',
      args: {
        content: z.string().describe('The plan content to write'),
      },
      execute: async (args, context) => {
        const key = resolvePlanKey(context.sessionID)
        kvService.set(projectId, key, args.content)
        
        const lineCount = args.content.split('\n').length
        logger.log(`plan-write: stored plan at ${key} (${lineCount} lines)`)
        
        return `Plan stored (${lineCount} lines)`
      },
    }),

    'plan-edit': tool({
      description: 'Edit the plan by finding old_string and replacing with new_string. Fails if old_string is not found or is not unique.',
      args: {
        old_string: z.string().describe('The string to find in the plan'),
        new_string: z.string().describe('The string to replace it with'),
      },
      execute: async (args, context) => {
        const key = resolvePlanKey(context.sessionID)
        const existing = kvService.get<string>(projectId, key)
        
        if (existing === null) {
          return `No plan found for session ${context.sessionID}`
        }

        const occurrences = existing.split(args.old_string).length - 1
        if (occurrences === 0) {
          return `old_string not found in plan`
        }
        if (occurrences > 1) {
          return `old_string found ${occurrences} times - must be unique`
        }

        const updated = existing.replace(args.old_string, args.new_string)
        kvService.set(projectId, key, updated)
        
        const lineCount = updated.split('\n').length
        logger.log(`plan-edit: updated plan at ${key} (${lineCount} lines)`)
        
        return `Plan updated (${lineCount} lines)`
      },
    }),

    'plan-read': tool({
      description: 'Read the plan for the current session. Supports pagination with offset/limit and pattern search.',
      args: {
        offset: z.number().optional().describe('Line number to start from (1-indexed)'),
        limit: z.number().optional().describe('Maximum number of lines to return'),
        pattern: z.string().optional().describe('Regex pattern to search for in plan content'),
      },
      execute: async (args, context) => {
        const key = resolvePlanKey(context.sessionID)
        const value = kvService.get<string>(projectId, key)
        
        if (value === null) {
          logger.log(`plan-read: no plan found for session ${context.sessionID}`)
          return `No plan found for current session`
        }

        logger.log(`plan-read: retrieved plan from ${key}`)
        
        if (args.pattern) {
          let regex: RegExp
          try {
            regex = new RegExp(args.pattern)
          } catch (e) {
            return `Invalid regex pattern: ${(e as Error).message}`
          }

          const lines = value.split('\n')
          const matches: Array<{ lineNum: number; text: string }> = []
          
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ lineNum: i + 1, text: lines[i] })
            }
          }

          if (matches.length === 0) {
            return 'No matches found in plan'
          }

          return `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:\n\n${matches.map((m) => `  Line ${m.lineNum}: ${m.text}`).join('\n')}`
        }

        const lines = value.split('\n')
        const totalLines = lines.length

        let resultLines = lines
        if (args.offset !== undefined) {
          const startIdx = args.offset - 1
          resultLines = resultLines.slice(Math.max(0, startIdx))
        }
        if (args.limit !== undefined) {
          resultLines = resultLines.slice(0, args.limit)
        }

        const numberedLines = resultLines.map((line, i) => {
          const originalLineNum = args.offset !== undefined ? args.offset + i : i + 1
          return `${originalLineNum}: ${line}`
        })

        const header = `(${totalLines} lines total)`
        return `${header}\n${numberedLines.join('\n')}`
      },
    }),
  }
}
