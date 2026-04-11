import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { injectBranchField } from '../utils/git-branch'

const z = tool.schema

export function createReviewTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { kvService, projectId, logger, loopService } = ctx

  return {
    'review-write': tool({
      description: 'Store a code review finding with file location, severity, and description. Automatically injects branch field.',
      args: {
        file: z.string().describe('The file path where the finding is located'),
        line: z.number().describe('The line number of the finding'),
        severity: z.enum(['bug', 'warning']).describe('The severity of the finding'),
        description: z.string().describe('Clear description of the issue'),
        scenario: z.string().describe('The specific conditions under which this issue manifests'),
        status: z.string().default('open').describe('The status of the finding (default: "open")'),
      },
      execute: async (args) => {
        const key = `review-finding:${args.file}:${args.line}`
        const value = {
          severity: args.severity,
          file: args.file,
          line: args.line,
          description: args.description,
          scenario: args.scenario,
          status: args.status,
          date: new Date().toISOString().split('T')[0],
        }

        injectBranchField(value, ctx.directory, loopService)

        kvService.set(projectId, key, value)
        logger.log(`review-write: stored finding at ${args.file}:${args.line} (${args.severity})`)
        
        return `Stored review finding at ${args.file}:${args.line} (${args.severity})`
      },
    }),

    'review-read': tool({
      description: 'Retrieve code review findings. No args lists all findings. Use file to filter by file path. Use pattern for regex search.',
      args: {
        file: z.string().optional().describe('Filter findings by file path'),
        pattern: z.string().optional().describe('Regex pattern to search across findings'),
      },
      execute: async (args) => {
        let findings = kvService.listByPrefix(projectId, 'review-finding:')

        if (args.file) {
          findings = findings.filter((f) => f.key.startsWith(`review-finding:${args.file}:`))
        }

        if (args.pattern) {
          let regex: RegExp
          try {
            regex = new RegExp(args.pattern)
          } catch (e) {
            return `Invalid regex pattern: ${(e as Error).message}`
          }

          const matchedFindings = []
          for (const finding of findings) {
            const valueStr = typeof finding.data === 'string' 
              ? finding.data 
              : JSON.stringify(finding.data, null, 2)
            if (regex.test(valueStr)) {
              matchedFindings.push(finding)
            }
          }
          findings = matchedFindings
        }

        if (findings.length === 0) {
          return 'No review findings found.'
        }

        const formatted = findings.map((f) => {
          const data = f.data as Record<string, unknown>
          return `- **${f.key}**\n  - Severity: ${String(data.severity)}\n  - File: ${String(data.file)}:${Number(data.line)}\n  - Description: ${String(data.description)}\n  - Scenario: ${String(data.scenario)}\n  - Status: ${String(data.status)}\n  - Branch: ${String(data.branch || 'N/A')}`
        })

        logger.log(`review-read: found ${findings.length} findings`)
        return `${findings.length} review finding${findings.length === 1 ? '' : 's'}:\n\n${formatted.join('\n\n')}`
      },
    }),

    'review-delete': tool({
      description: 'Delete a code review finding by file and line number.',
      args: {
        file: z.string().describe('The file path of the finding to delete'),
        line: z.number().describe('The line number of the finding to delete'),
      },
      execute: async (args) => {
        const key = `review-finding:${args.file}:${args.line}`
        kvService.delete(projectId, key)
        logger.log(`review-delete: deleted finding at ${args.file}:${args.line}`)
        return `Deleted review finding at ${args.file}:${args.line}`
      },
    }),
  }
}
