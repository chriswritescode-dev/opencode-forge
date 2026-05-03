import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

import { slugify } from '../utils/logger'
import { formatSessionOutput, formatAuditResult } from '../utils/loop-format'
import { fetchSessionOutput, MAX_RETRIES, type LoopSessionOutput } from '../services/loop'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'
import { buildStartLoopCommand, createForgeExecutionService, type ForgeExecutionRequestContext, type PlanSource } from '../services/execution'
import { captureLatestPlanForSession } from '../services/plan-capture'
import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'

const z = tool.schema

export function createLoopTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { v2, loopService, loopHandler, config, logger } = ctx

  function makeService(sourceSessionId?: string) {
    const execCtx: ForgeExecutionRequestContext = {
      surface: 'tool',
      projectId: ctx.projectId,
      directory: ctx.directory,
      sourceSessionId,
    }
    const service = createForgeExecutionService({
      projectId: ctx.projectId,
      directory: ctx.directory,
      config,
      logger,
      dataDir: ctx.dataDir,
      v2: ctx.v2,
      legacyClient: ctx.input?.client,
      plansRepo: ctx.plansRepo,
      loopsRepo: ctx.loopsRepo,
      graphStatusRepo: ctx.graphStatusRepo,
      loopService: ctx.loopService,
      loopHandler: ctx.loopHandler,
      sandboxManager: ctx.sandboxManager,
    })
    return { service, execCtx }
  }

  return {
    loop: tool({
      description: 'Execute a plan using an iterative development loop. Default runs in current directory. Set worktree to true for isolated git worktree.',
      args: {
        plan: z.string().optional().describe('The full implementation plan. If omitted, reads from the session plan store.'),
        title: z.string().describe('Short title for the session (shown in session list)'),
        worktree: z.boolean().optional().default(false).describe('Run in isolated git worktree instead of current directory'),
        loopName: z.string().optional().describe('Name for the loop (max 25 chars, auto-incremented if collision exists)'),
        hostSessionId: z.string().optional().describe('Host session ID for post-completion redirect'),
      },
      execute: async (args, context) => {
        logger.log(`loop: creating ${args.worktree ? 'worktree' : 'in-place'} loop for plan="${args.title}"`)

        let source: PlanSource
        if (!args.plan) {
          const capture = await captureLatestPlanForSession(
            {
              v2: ctx.v2,
              client: ctx.input.client,
              plansRepo: ctx.plansRepo,
              projectId: ctx.projectId,
              directory: ctx.directory,
              logger: ctx.logger,
            },
            context.sessionID
          )
          
          if (capture.status === 'captured' || capture.status === 'already-current') {
            source = { kind: 'stored', sessionId: context.sessionID }
          } else {
            const planRow = ctx.plansRepo.getForSession(ctx.projectId, context.sessionID)
            if (!planRow) {
              return 'No plan found. Ensure the final plan is wrapped with <!-- forge-plan:start --> and <!-- forge-plan:end --> markers, or pass it directly as the plan argument.'
            }
            source = { kind: 'stored', sessionId: context.sessionID }
          }
        } else {
          source = { kind: 'inline', planText: args.plan }
        }

        const sessionTitle = formatPlanSessionTitle(args.title)
        const executionModel = config.executionModel
        const auditorModel = config.auditorModel
        const loopName = args.loopName ? slugify(args.loopName) : slugify(sessionTitle)

        const { service, execCtx } = makeService(context.sessionID)

        const command = buildStartLoopCommand({
          source,
          title: sessionTitle,
          loopName,
          mode: args.worktree ? 'worktree' : 'in-place',
          maxIterations: config.loop?.defaultMaxIterations ?? 0,
          executionModel,
          auditorModel,
          hostSessionId: args.hostSessionId,
          lifecycle: {
            selectSession: true,
            startWatchdog: true,
          },
        })
        const result = await service.dispatch(execCtx, command)

        if (!result.ok) {
          logger.error('loop: failed to start loop', result.error)
          return `Failed to start loop: ${result.error.message}`
        }

        // Format success message to match existing output
        const maxInfo = result.data.maxIterations > 0 ? result.data.maxIterations.toString() : 'unlimited'
        const modelInfo = result.data.modelUsed ?? 'default'
        const modeInfo = result.data.mode === 'worktree' ? '' : ' (in-place mode)'

        const lines: string[] = [
          `Memory loop activated!${modeInfo}`,
          '',
          `Session: ${result.data.sessionId}`,
          `Title: ${formatLoopSessionTitle(sessionTitle)}`,
        ]

        if (result.data.mode === 'worktree') {
          lines.push(`Loop name: ${result.data.loopName}`)
          lines.push(`Worktree: ${result.data.worktreeDir}`)
          lines.push(`Branch: ${result.data.worktreeBranch ?? 'unknown'}`)
        } else {
          lines.push(`Directory: ${ctx.directory}`)
        }

        lines.push(
          `Model: ${modelInfo}`,
          `Max iterations: ${maxInfo}`,
          '',
          'The loop will automatically continue when the session goes idle.',
          'Your job is done — just confirm to the user that the loop has been launched.',
          'The user can run loop-status or loop-cancel later if needed.',
        )

        return lines.join('\n')
      },
    }),

    'loop-cancel': tool({
      description: 'Cancels the only active loop when called with no arguments. Pass a name to cancel a specific loop.',
      args: {
        name: z.string().optional().describe('Worktree name of the loop to cancel'),
      },
      execute: async (args) => {
        const { service, execCtx } = makeService()
        const result = await service.dispatch(execCtx, {
          type: 'loop.cancel',
          selector: args.name ? { kind: 'partial', name: args.name } : { kind: 'only-active' },
        })
        if (!result.ok) {
          const candidates = result.error.candidates
          if (candidates?.length) return `${result.error.message}\n${candidates.map(c => `- ${c}`).join('\n')}`
          return result.error.message
        }
        const d = result.data
        const modeInfo = !d.worktree ? ' (in-place)' : ''
        const branchInfo = d.worktreeBranch ? `\nBranch: ${d.worktreeBranch}` : ''
        return `Cancelled loop "${d.loopName}"${modeInfo} (was at iteration ${d.iteration}).\nDirectory: ${d.worktreeDir}${branchInfo}`
      },
    }),

    'loop-status': tool({
      description: 'Lists all active loops when called with no arguments. Pass a worktree name for detailed status of a specific loop. Use restart to resume an inactive loop. Use restart with force to force-restart a stuck active loop.',
      args: {
        name: z.string().optional().describe('Worktree name to check for detailed status'),
        restart: z.boolean().optional().default(false).describe('Restart an inactive loop by name'),
        force: z.boolean().optional().default(false).describe('Force restart an active/stuck loop'),
      },
      execute: async (args) => {
        const active = loopService.listActive()

        if (args.restart) {
          if (!args.name) {
            return 'Specify a loop name to restart. Use loop-status to see available loops.'
          }
          const { service, execCtx } = makeService()
          const result = await service.dispatch(execCtx, {
            type: 'loop.restart',
            selector: { kind: 'partial', name: args.name },
            force: args.force,
          })
          if (!result.ok) {
            const label = result.error.code === 'not_found' ? 'Available loops' : 'Matches'
            const candidates = result.error.candidates
            if (candidates?.length) return `${result.error.message}\n\n${label}:\n${candidates.map(c => `- ${c}`).join('\n')}`
            return result.error.message
          }
          const d = result.data
          const modeInfo = !d.worktree ? ' (in-place)' : ''
          const branchInfo = d.worktreeBranch ? `\nBranch: ${d.worktreeBranch}` : ''
          return [
            `Restarted loop "${d.loopName}"${modeInfo}`,
            '',
            `New session: ${d.sessionId}`,
            `Continuing from iteration: ${d.iteration}`,
            `Previous termination: ${d.previousTermination ?? 'unknown'}`,
            `Directory: ${d.worktreeDir}${branchInfo}`,
          ].join('\n')
        }

        if (!args.name) {
          const recent = loopService.listRecent()

          if (active.length === 0) {
            if (recent.length === 0) return 'No loops found.'

            const lines: string[] = ['Recently Completed Loops', '']
            recent.forEach((s, i) => {
              const durationStr = formatDuration(computeElapsedSeconds(s.startedAt, s.completedAt))
              lines.push(`${i + 1}. ${s.loopName}`)
              lines.push(`   Reason: ${s.terminationReason ?? 'unknown'} | Iterations: ${s.iteration} | Duration: ${durationStr} | Completed: ${s.completedAt ?? 'unknown'}`)
              lines.push('')
            })
            lines.push('Use loop-status <name> for detailed info.')
            return lines.join('\n')
          }

          const statuses: Record<string, { type: string; attempt?: number; message?: string; next?: number }> = {}
          try {
            const uniqueDirs = [...new Set(active.map((s) => s.worktreeDir).filter(Boolean))]
            const results = await Promise.allSettled(
              uniqueDirs.map((dir) => v2.session.status({ directory: dir })),
            )
            for (const result of results) {
              if (result.status === 'fulfilled' && result.value.data) {
                Object.assign(statuses, result.value.data)
              }
            }
          } catch {
          }

          const lines: string[] = [`Active Loops (${active.length})`, '']
          active.forEach((s, i) => {
            const duration = formatDuration(computeElapsedSeconds(s.startedAt))
            const iterInfo = s.maxIterations && s.maxIterations > 0 ? `${s.iteration} / ${s.maxIterations}` : `${s.iteration} (unlimited)`
            const sessionStatus = statuses[s.sessionId]?.type ?? 'unavailable'
            const modeIndicator = !s.worktree ? ' (in-place)' : ''
            const stallInfo = loopHandler.getStallInfo(s.loopName!)
            const stallCount = stallInfo?.consecutiveStalls ?? 0
            const stallSuffix = stallCount > 0 ? ` | Stalls: ${stallCount}` : ''
            lines.push(`${i + 1}. ${s.loopName}${modeIndicator}`)
            lines.push(`   Phase: ${s.phase} | Iteration: ${iterInfo} | Duration: ${duration} | Status: ${sessionStatus}${stallSuffix}`)
            lines.push('')
          })

          if (recent.length > 0) {
            lines.push('Recently Completed:')
            lines.push('')
            const limitedRecent = recent.slice(0, 10)
            limitedRecent.forEach((s, i) => {
              const durationStr = formatDuration(computeElapsedSeconds(s.startedAt, s.completedAt))
              lines.push(`${i + 1}. ${s.loopName}`)
              lines.push(`   Reason: ${s.terminationReason ?? 'unknown'} | Iterations: ${s.iteration} | Duration: ${durationStr} | Completed: ${s.completedAt ?? 'unknown'}`)
              lines.push('')
            })
            if (recent.length > 10) {
              lines.push(`   ... and ${recent.length - 10} more. Use loop-status <name> for details.`)
              lines.push('')
            }
          }

          lines.push('Use loop-status <name> for detailed info, or loop-cancel <name> to stop a loop.')
          return lines.join('\n')
        }

        const { match: state, candidates } = loopService.findMatchByName(args.name)
        if (!state) {
          if (candidates.length > 0) {
            return `Multiple loops match "${args.name}":\n${candidates.map((s) => `- ${s.loopName}`).join('\n')}\n\nBe more specific.`
          }
          return `No loop found for loop "${args.name}".`
        }

        if (!state.active) {
          const maxInfo = state.maxIterations && state.maxIterations > 0 ? `${state.iteration} / ${state.maxIterations}` : `${state.iteration} (unlimited)`
          const durationStr = formatDuration(computeElapsedSeconds(state.startedAt, state.completedAt))

          const statusLines: string[] = [
            'Loop Status (Inactive)',
            '',
            `Name: ${state.loopName}`,
            `Session: ${state.sessionId}`,
          ]
          if (!state.worktree) {
            statusLines.push(`Mode: in-place | Directory: ${state.worktreeDir}`)
          } else {
            statusLines.push(`Worktree: ${state.worktreeDir}`)
          }
          statusLines.push(
            `Iteration: ${maxInfo}`,
            `Duration: ${durationStr}`,
            `Reason: ${state.terminationReason ?? 'unknown'}`,
          )
          if (state.worktreeBranch) {
            statusLines.push(`Branch: ${state.worktreeBranch}`)
          }
          statusLines.push(
            `Started: ${state.startedAt}`,
            ...(state.completedAt ? [`Completed: ${state.completedAt}`] : []),
          )
          statusLines.push(
            `Model: ${state.executionModel ?? config.executionModel ?? 'default'}`,
            `Auditor model: ${state.auditorModel ?? config.auditorModel ?? state.executionModel ?? config.executionModel ?? 'default'}`,
          )

          if (state.lastAuditResult) {
            statusLines.push(...formatAuditResult(state.lastAuditResult))
          }

          const sessionOutput = state.worktreeDir ? await fetchSessionOutput(v2, state.sessionId, state.worktreeDir, logger) : null
          if (sessionOutput) {
            statusLines.push('')
            statusLines.push('Session Output:')
            statusLines.push(...formatSessionOutput(sessionOutput))
          }

          return statusLines.join('\n')
        }

        const maxInfo = state.maxIterations && state.maxIterations > 0 ? `${state.iteration} / ${state.maxIterations}` : `${state.iteration} (unlimited)`
        const promptPreview = state.prompt && state.prompt.length > 100 ? `${state.prompt.substring(0, 97)}...` : (state.prompt ?? '')

        let sessionStatus = 'unknown'
        try {
          const statusResult = await v2.session.status({ directory: state.worktreeDir })
          const statuses = statusResult.data as Record<string, { type: string; attempt?: number; message?: string; next?: number }> | undefined
          const status = statuses?.[state.sessionId]
          if (status) {
            sessionStatus = status.type === 'retry'
              ? `retry (attempt ${status.attempt}, next in ${Math.round(((status.next ?? 0) - Date.now()) / 1000)}s)`
              : status.type
          }
        } catch {
          sessionStatus = 'unavailable'
        }

        const duration = formatDuration(computeElapsedSeconds(state.startedAt))

        const stallInfo = loopHandler.getStallInfo(state.loopName!)
        const secondsSinceActivity = stallInfo
          ? Math.round((Date.now() - stallInfo.lastActivityTime) / 1000)
          : null
        const stallCount = stallInfo?.consecutiveStalls ?? 0

        const statusLines: string[] = [
          'Loop Status',
          '',
          `Name: ${state.loopName}`,
          `Session: ${state.sessionId}`,
        ]
        if (!state.worktree) {
          statusLines.push(`Mode: in-place | Directory: ${state.worktreeDir}`)
        } else {
          statusLines.push(`Worktree: ${state.worktreeDir}`)
        }
        statusLines.push(
          `Status: ${sessionStatus}`,
          `Phase: ${state.phase}`,
          `Iteration: ${maxInfo}`,
          `Duration: ${duration}`,
        )
        if (state.worktreeBranch) {
          statusLines.push(`Branch: ${state.worktreeBranch}`)
        }

        let sessionOutput: LoopSessionOutput | null = null
        if (state.worktreeDir) {
          try {
            sessionOutput = await fetchSessionOutput(v2, state.sessionId, state.worktreeDir, logger)
          } catch {
            // Silently ignore fetch errors to avoid cluttering output
          }
        }
        if (sessionOutput) {
          statusLines.push('')
          statusLines.push('Session Output:')
          statusLines.push(...formatSessionOutput(sessionOutput))
        }

        if (state.lastAuditResult) {
          statusLines.push(...formatAuditResult(state.lastAuditResult))
        }

        statusLines.push(
          '',
          `Started: ${state.startedAt}`,
          `Error count: ${state.errorCount} (retries before termination: ${MAX_RETRIES})`,
          `Audit count: ${state.auditCount ?? 0}`,
          `Model: ${state.executionModel ?? config.executionModel ?? 'default'}`,
          `Auditor model: ${state.auditorModel ?? config.auditorModel ?? state.executionModel ?? config.executionModel ?? 'default'}`,
          ...(stallCount > 0 ? [`Stalls: ${stallCount}`] : []),
          ...(secondsSinceActivity !== null ? [`Last activity: ${secondsSinceActivity}s ago`] : []),
          '',
          `Prompt: ${promptPreview}`,
        )

        return statusLines.join('\n')
      },
    }),
  }
}
