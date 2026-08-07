import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createPlanTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { plansRepo, projectId, logger } = ctx
  const loop = ctx.loop

  return {
    'plan-read': tool({
      description: 'Read the plan for the current session or loop with the same offset and limit options as the Read tool, or list/search recent project plans.',
      args: {
        offset: z.number().int().nonnegative().optional().describe('When reading a plan: the line number to start reading from (1-indexed)'),
        limit: z.number().int().nonnegative().optional().describe('When reading a plan: the maximum number of lines to read (defaults to 2000)'),
        count: z.number().int().nonnegative().optional().describe('When recent is true: the number of recent plans to list or search (defaults to 20, capped at 100)'),
        pattern: z.string().optional().describe('Regex pattern to search for in plan content'),
        loop_name: z.string().optional().describe('Optional loop name to read plan:{loop_name} directly instead of resolving from the current session'),
        session_id: z.string().optional().describe('Explicit session ID to read plan from'),
        recent: z.boolean().optional().describe('List or search recent project-scoped plans instead of reading a specific plan'),
      },
      execute: async (args, context) => {
        if (args.recent) {
          if (args.pattern) {
            let regex: RegExp
            try {
              regex = new RegExp(args.pattern)
            } catch (e) {
              return `Invalid regex pattern: ${(e as Error).message}`
            }
            const matches = plansRepo.searchRecent(projectId, regex, { limit: args.count })
            if (matches.length === 0) {
              return 'No matching recent plans found'
            }
            const rows = matches.map((row) => {
              const identity = row.loopName ? `loop: ${row.loopName}` : `session: ${row.sessionId}`
              const updated = new Date(row.updatedAt).toISOString()
              const contentLines = row.content.split('\n')
              const title = contentLines[0] || ''
              // Find first line matching the regex (including title on line 1)
              for (let i = 0; i < contentLines.length; i++) {
                regex.lastIndex = 0
                if (regex.test(contentLines[i])) {
                  return `  ${identity} | ${updated} | ${title}\n    Line ${i + 1}: ${contentLines[i]}`
                }
              }
              return `  ${identity} | ${updated} | ${title}`
            })
            return `Found ${matches.length} recent plan match(es) for /${args.pattern}/.\n${rows.join('\n')}`
          }
          const results = plansRepo.listRecent(projectId, { limit: args.count })
          if (results.length === 0) {
            return 'No recent plans found'
          }
          const header = `Recent plans for project ${projectId} (${results.length} found)`
          const rows = results.map((row) => {
            const identity = row.loopName ? `loop: ${row.loopName}` : `session: ${row.sessionId}`
            const updated = new Date(row.updatedAt).toISOString()
            const title = (row.content.split('\n')[0] || '').trim()
            const preview = (row.content.split('\n').slice(1, 3).join(' ') || '').trim()
            return `  ${identity} | ${updated} | ${title}\n    ${preview}`
          })
          return `${header}\n${rows.join('\n')}`
        }

        let content: string | undefined
        if (args.loop_name) {
          content = plansRepo.getForLoop(projectId, args.loop_name)?.content
        } else if (args.session_id) {
          content = plansRepo.getForSession(projectId, args.session_id)?.content
        } else {
          const resolvedLoopName = loop.service.resolveLoopName(context.sessionID)
          if (resolvedLoopName) {
            content = plansRepo.getForLoop(projectId, resolvedLoopName)?.content
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

        const offset = args.offset || 1
        const limit = args.limit ?? 2000
        const resultLines = lines.slice(offset - 1, offset - 1 + limit)

        const numberedLines = resultLines.map((line, i) => {
          return `${offset + i}: ${line}`
        })

        const header = `(${totalLines} lines total)`
        const output = `${header}\n${numberedLines.join('\n')}`
        if (offset - 1 + limit < totalLines) {
          const last = offset + resultLines.length - 1
          const next = last + 1
          return `${output}\n(Showing lines ${offset}-${last} of ${totalLines}. Use offset=${next} to continue.)`
        }
        return output
      },
    }),
  }
}
