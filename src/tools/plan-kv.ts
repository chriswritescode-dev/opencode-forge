import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createPlanTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { plansRepo, loopsRepo, projectId, logger, loopService } = ctx

  return {
    'plan-write': tool({
      description: 'Write or overwrite the entire plan content for the current session. Auto-resolves key to plan:{sessionID}.',
      args: {
        content: z.string().describe('The plan content to write'),
      },
      execute: async (args, context) => {
        const loopName = loopService.resolveLoopName(context.sessionID)
        if (loopName) {
          loopsRepo.updatePrompt(projectId, loopName, args.content)
        } else {
          plansRepo.writeForSession(projectId, context.sessionID, args.content)
        }
        
        const lineCount = args.content.split('\n').length
        logger.log(`plan-write: stored plan for session ${context.sessionID} (${lineCount} lines)`)
        
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
        const existingLoopName = loopService.resolveLoopName(context.sessionID)
        let existing: string | undefined
        if (existingLoopName) {
          existing = loopsRepo.getLarge(projectId, existingLoopName)?.prompt ?? plansRepo.getForLoop(projectId, existingLoopName)?.content
        } else {
          existing = plansRepo.getForSession(projectId, context.sessionID)?.content
        }
        
        if (!existing) {
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
        if (existingLoopName) {
          loopsRepo.updatePrompt(projectId, existingLoopName, updated)
        } else {
          plansRepo.writeForSession(projectId, context.sessionID, updated)
        }
        
        const lineCount = updated.split('\n').length
        logger.log(`plan-edit: updated plan for session ${context.sessionID} (${lineCount} lines)`)
        
        return `Plan updated (${lineCount} lines)`
      },
    }),

    'plan-read': tool({
      description: 'Read the plan for the current session or a specified loop name. Supports pagination with offset/limit and pattern search.',
      args: {
        offset: z.number().optional().describe('Line number to start from (1-indexed)'),
        limit: z.number().optional().describe('Maximum number of lines to return'),
        pattern: z.string().optional().describe('Regex pattern to search for in plan content'),
        loop_name: z.string().optional().describe('Optional loop name to read plan:{loop_name} directly instead of resolving from the current session'),
      },
      execute: async (args, context) => {
        let content: string | undefined
        if (args.loop_name) {
          content = loopsRepo.getLarge(projectId, args.loop_name)?.prompt ?? plansRepo.getForLoop(projectId, args.loop_name)?.content
        } else {
          const resolvedLoopName = loopService.resolveLoopName(context.sessionID)
          if (resolvedLoopName) {
            content = loopsRepo.getLarge(projectId, resolvedLoopName)?.prompt ?? plansRepo.getForLoop(projectId, resolvedLoopName)?.content
          } else {
            content = plansRepo.getForSession(projectId, context.sessionID)?.content
          }
        }
        
        if (!content) {
          logger.log(`plan-read: no plan found for session ${context.sessionID}`)
          return `No plan found for current session`
        }

        logger.log(`plan-read: retrieved plan for session ${context.sessionID}`)
        
        if (args.pattern) {
          let regex: RegExp
          try {
            regex = new RegExp(args.pattern)
          } catch (e) {
            return `Invalid regex pattern: ${(e as Error).message}`
          }

          const lines = content.split('\n')
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

        const lines = content.split('\n')
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
