import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

export function createGroupTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { groupOrchestrator, featureGroupsRepo, projectId } = ctx

  return {
    'launch-group': tool({
      description:
        'Launch a group of features from a PRD or pre-split feature list. Requires exactly one of prd or features.',
      args: {
        title: z.string().describe('Short title for the group'),
        prd: z
          .string()
          .optional()
          .describe('PRD text to split into features (mutually exclusive with features)'),
        features: z
          .array(
            z.object({
              title: z.string(),
              description: z.string(),
            }),
          )
          .optional()
          .describe('Pre-split features (mutually exclusive with prd)'),
        maxConcurrentLoops: z.number().optional().describe('Maximum number of concurrent loops'),
        loopNamePrefix: z
          .string()
          .optional()
          .describe('Prefix for loop names (reserved for future use)'),
      },
      execute: async (args, context) => {
        const prdProvided = args.prd !== undefined
        const featuresProvided = args.features !== undefined
        if (prdProvided && featuresProvided) {
          return 'Provide either prd or features, not both.'
        }
        const hasUsablePrd = prdProvided && args.prd!.length > 0
        const hasUsableFeatures = featuresProvided && args.features!.length > 0
        if (!hasUsablePrd && !hasUsableFeatures) {
          return 'Provide either prd (PRD text to split) or features (pre-split feature list), but not both.'
        }

        const result = await groupOrchestrator.startGroup({
          title: args.title,
          ...(args.prd ? { prd: args.prd } : { features: args.features!.map(f => ({ title: f.title, description: f.description })) }),
          ...(args.maxConcurrentLoops !== undefined ? { maxConcurrent: args.maxConcurrentLoops } : {}),
          hostSessionId: context.sessionID,
        })

        const featureCount = args.features?.length
        const lines: string[] = [
          `Group "${args.title}" launched!`,
          '',
          `Group ID: ${result.groupId}`,
          `Status: ${result.status}`,
        ]
        if (featureCount !== undefined) {
          lines.push(`Features: ${featureCount}`)
        }
        lines.push('', 'Use group-status to monitor progress.')

        return lines.join('\n')
      },
    }),

    'group-status': tool({
      description:
        'Lists all groups when called with no arguments. Pass a groupId for detailed status of a specific group. Use restart to resume a cancelled/errored/interrupted group.',
      args: {
        groupId: z.string().optional().describe('Group ID for detailed status'),
        restart: z
          .boolean()
          .optional()
          .default(false)
          .describe('Restart a non-completed, non-running group by groupId'),
      },
      execute: async args => {
        if (args.restart) {
          if (!args.groupId) {
            return 'Specify a groupId to restart. Use group-status to see available groups.'
          }
          const result = await groupOrchestrator.restartGroup(args.groupId)
          return result.message
        }

        const views = groupOrchestrator.getStatus(
          args.groupId ? { groupId: args.groupId } : undefined,
        )

        if (views.length === 0) {
          if (args.groupId) {
            return `Group ${args.groupId} not found.`
          }
          return 'No groups found.'
        }

        if (args.groupId) {
          // Detailed view for a single group
          const { group, features } = views[0]

          const lines: string[] = [
            'Group Status',
            '',
            `Group ID: ${group.groupId}`,
            `Title: ${group.title}`,
            `Status: ${group.status}`,
            `Created: ${new Date(group.createdAt).toISOString()}`,
          ]
          if (group.completedAt) {
            lines.push(`Completed: ${new Date(group.completedAt).toISOString()}`)
          }
          if (group.error) {
            lines.push(`Error: ${group.error}`)
          }
          lines.push('')
          lines.push(`Features (${features.length}):`)
          lines.push('')
          for (const f of features) {
            const loopInfo = f.loopName ? ` | Loop: ${f.loopName}` : ''
            const errorInfo = f.error ? ` | Error: ${f.error}` : ''
            lines.push(`  ${f.featureIndex}. ${f.title}`)
            lines.push(`     Stage: ${f.stage}${loopInfo}${errorInfo}`)
          }

          return lines.join('\n')
        }

        // List view: all groups with per-feature stage counts
        const lines: string[] = ['Groups', '']
        for (const view of views) {
          const { group, features } = view
          const stageCounts: Record<string, number> = {}
          for (const f of features) {
            stageCounts[f.stage] = (stageCounts[f.stage] || 0) + 1
          }
          const stageSummary = Object.entries(stageCounts)
            .map(([stage, count]) => `${stage}: ${count}`)
            .join(', ')
          lines.push(`- ${group.title} (${group.groupId})`)
          lines.push(`  Status: ${group.status} | ${stageSummary}`)
          lines.push('')
        }
        lines.push(
          'Use group-status <groupId> for details, or group-cancel <groupId> to stop a group.',
        )

        return lines.join('\n')
      },
    }),

    'group-cancel': tool({
      description: 'Cancel a group by its groupId. Optionally cancel running loops within the group.',
      args: {
        groupId: z.string().describe('Group ID to cancel'),
        cancelRunningLoops: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also cancel running loops for non-terminal features'),
      },
      execute: async args => {
        const group = featureGroupsRepo.getGroup(projectId, args.groupId)
        if (!group) {
          return `Group ${args.groupId} not found.`
        }

        await groupOrchestrator.cancelGroup(args.groupId, {
          cancelRunningLoops: args.cancelRunningLoops,
        })
        return `Cancelled group "${group.title}" (${args.groupId}).`
      },
    }),
  }
}
