import { randomBytes } from 'node:crypto'
import { tool, type ToolDefinition } from './tool'
import type { ToolContext } from './types'
import { slugify } from '../utils/logger'
import { DEFAULT_GOAL_MAX_CHUNKS, MAX_GOAL_MAX_CHUNKS } from '../constants/goal'
import type { GoalChunkRow, GoalRow, GoalTask } from '../storage/repos/goals-repo'

const z = tool.schema

function generateGoalId(title: string): string {
  return `${slugify(title).slice(0, 40)}-${randomBytes(3).toString('hex')}`
}

function iso(timestamp: number | null): string {
  return timestamp === null ? 'unknown' : new Date(timestamp).toISOString()
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim()
}

function goalModelsLine(goal: GoalRow): string {
  const execution = goal.executionModel ?? 'default'
  const auditor = goal.auditorModel ?? 'default'
  return `Models: execution ${execution} (variant ${goal.executionVariant ?? 'default'}) | auditor ${auditor} (variant ${goal.auditorVariant ?? 'default'})`
}

function formatGoalListItem(goal: GoalRow, chunks: GoalChunkRow[]): string[] {
  const completed = chunks.filter((chunk) => chunk.stage === 'completed').length
  const lines = [
    `- ${goal.title} (${goal.goalId})`,
    `  Status: ${goal.status} | Chunks: ${completed}/${chunks.length} | Tasks: ${goal.tasks.length}`,
  ]
  const current = chunks.find((chunk) => chunk.stage !== 'completed')
  if (current) {
    const loop = current.loopName ? ` loop ${current.loopName}` : ''
    lines.push(`  Current: chunk ${current.chunkIndex + 1} ${current.stage}${loop}`)
  }
  if (goal.error) lines.push(`  Error: ${goal.error}`)
  return lines
}

function formatGoalDetail(goal: GoalRow, chunks: GoalChunkRow[]): string {
  const lines = [
    `Goal: ${goal.goalId}`,
    `Title: ${goal.title}`,
    `Status: ${goal.status}`,
    `Created: ${iso(goal.createdAt)}`,
  ]
  if (goal.completedAt !== null) lines.push(`Completed: ${iso(goal.completedAt)}`)
  if (goal.error) lines.push(`Error: ${goal.error}`)
  lines.push(`Max chunks: ${goal.maxChunks}`, goalModelsLine(goal), `Objective: ${goal.objective}`, '', 'Tasks:')
  if (goal.tasks.length === 0) {
    lines.push('- (none)')
  } else {
    for (const task of goal.tasks) {
      lines.push(task.ref ? `- [${task.ref}] ${task.title}` : `- ${task.title}`)
    }
  }
  lines.push('', 'Chunks:')
  if (chunks.length === 0) {
    lines.push('- (none)')
  } else {
    for (const chunk of chunks) {
      lines.push(`${chunk.chunkIndex + 1}. ${chunk.title ?? '(planning)'} — ${chunk.stage}`)
      if (chunk.loopName) lines.push(`   Loop: ${chunk.loopName}`)
      if (chunk.branch) lines.push(`   Branch: ${chunk.branch}`)
      if (chunk.summary) lines.push(`   Summary: ${firstLine(chunk.summary)}`)
    }
  }
  return lines.join('\n')
}

export function createGoalTools(ctx: ToolContext): Record<string, ToolDefinition> {
  return {
    'goal-write': tool({
      description:
        'Save the ordered goal (objective and task list) for this session as a draft. The next loop launched from this session becomes chunk 1; later chunks are planned and launched automatically, each stacked on the previous chunk branch, until every task is done.',
      args: {
        title: z.string().describe('Short title for the goal; also seeds the generated goal id.'),
        objective: z.string().describe('The goal objective, verbatim plus any clarified scope.'),
        tasks: z
          .array(
            z.object({
              ref: z.string().optional().describe('Ticket or issue identifier, when the task maps to one.'),
              title: z.string().describe('Short task title.'),
              details: z
                .string()
                .optional()
                .describe('Self-contained summary of the task including its acceptance criteria.'),
            }),
          )
          .optional()
          .describe('The ordered task list; each task becomes its own chunk.'),
        maxChunks: z
          .number()
          .int()
          .min(1)
          .max(MAX_GOAL_MAX_CHUNKS)
          .optional()
          .describe(`Maximum number of chunks to run. Defaults to ${DEFAULT_GOAL_MAX_CHUNKS}.`),
      },
      execute: async (args, context) => {
        const title = args.title.trim()
        if (!title) return 'goal-write failed: title is required.'
        const objective = args.objective.trim()
        if (!objective) return 'goal-write failed: objective is required.'

        const rawTasks = args.tasks ?? []
        for (let i = 0; i < rawTasks.length; i++) {
          if (!rawTasks[i].title.trim()) {
            return `goal-write failed: task ${i + 1} has an empty title.`
          }
        }

        const maxChunks = args.maxChunks ?? DEFAULT_GOAL_MAX_CHUNKS
        if (maxChunks < 1 || maxChunks > MAX_GOAL_MAX_CHUNKS) {
          return `goal-write failed: maxChunks must be between 1 and ${MAX_GOAL_MAX_CHUNKS}.`
        }

        const active = ctx.goalsRepo.getActiveForSession(ctx.projectId, context.sessionID)
        if (active) {
          return `This session already has goal ${active.goalId} (${active.status}). Cancel it before defining a new goal.`
        }

        const tasks: GoalTask[] = rawTasks.map((task) => {
          const ref = task.ref?.trim()
          const details = task.details?.trim()
          return {
            title: task.title.trim(),
            ...(ref ? { ref } : {}),
            ...(details ? { details } : {}),
          }
        })

        const goal = ctx.goalsRepo.saveDraft({
          projectId: ctx.projectId,
          goalId: generateGoalId(title),
          title,
          objective,
          tasks,
          hostSessionId: context.sessionID,
          maxChunks,
        })

        ctx.logger.log(`goal-write: saved draft goal ${goal.goalId} for session ${context.sessionID}`)

        const lines = [
          `Goal draft saved: ${goal.goalId}`,
          `Title: ${goal.title}`,
          `Tasks: ${goal.tasks.length}`,
        ]
        for (const task of goal.tasks) {
          lines.push(task.ref ? `- [${task.ref}] ${task.title}` : `- ${task.title}`)
        }
        lines.push(
          `Max chunks: ${goal.maxChunks}`,
          'Next: write the detailed loop plan for chunk 1 (the first task) with plan-write. When the user launches it as a loop, it becomes chunk 1 of this goal; later chunks are planned and launched automatically with the same models and sandbox settings.',
        )
        return lines.join('\n')
      },
    }),

    'goal-status': tool({
      description:
        'Lists goals when called with no arguments. Pass goalId for details. Use restart to resume a paused goal (optionally raising maxChunks) or to recover an interrupted one; force discards planning that is still marked in flight.',
      args: {
        goalId: z.string().optional().describe('Goal id to show in detail, or to restart when restart=true.'),
        restart: z.boolean().optional().default(false).describe('Restart a paused or interrupted goal. Requires goalId.'),
        force: z.boolean().optional().default(false).describe('Discard planning that is still marked in flight when restarting.'),
        maxChunks: z
          .number()
          .int()
          .min(1)
          .max(MAX_GOAL_MAX_CHUNKS)
          .optional()
          .describe('Raise the goal chunk limit when restarting.'),
      },
      execute: async (args) => {
        if (args.restart) {
          if (!args.goalId) {
            return 'Specify a goal id to restart. Use goal-status to see available goals.'
          }
          return ctx.goalOrchestrator.restart(args.goalId, { maxChunks: args.maxChunks, force: args.force ?? false })
        }

        if (args.goalId) {
          const goal = ctx.goalsRepo.getGoal(ctx.projectId, args.goalId)
          if (!goal) return `Goal ${args.goalId} not found.`
          return formatGoalDetail(goal, ctx.goalsRepo.listChunks(ctx.projectId, goal.goalId))
        }

        const goals = ctx.goalsRepo.listGoals(ctx.projectId)
        if (goals.length === 0) return 'No goals found.'

        const lines = [`Goals (${goals.length})`, '']
        for (const goal of goals) {
          lines.push(...formatGoalListItem(goal, ctx.goalsRepo.listChunks(ctx.projectId, goal.goalId)))
          lines.push('')
        }
        lines.push('Use goal-status <goalId> for details, or goal-cancel <goalId> to cancel a goal.')
        return lines.join('\n')
      },
    }),

    'goal-cancel': tool({
      description: 'Cancel a goal by goalId. Optionally cancel its running chunk loop.',
      args: {
        goalId: z.string().describe('Goal id to cancel.'),
        cancelRunningLoops: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also cancel the goal chunk loop that is currently running.'),
      },
      execute: async (args) => {
        const goal = ctx.goalsRepo.getGoal(ctx.projectId, args.goalId)
        if (!goal) return `Goal ${args.goalId} not found.`
        return ctx.goalOrchestrator.cancel(args.goalId, { cancelRunningLoops: args.cancelRunningLoops ?? false })
      },
    }),
  }
}
