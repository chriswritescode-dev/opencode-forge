import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

import { slugify } from '../utils/logger'
import { formatSessionOutput, formatAuditResult, formatCompletionSummary, formatPostActionReport } from '../utils/loop-format'
import { fetchSessionOutput, type LoopSessionOutput, MAX_RETRIES } from '../loop'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'
import { buildStartLoopCommand, createForgeExecutionService, type ForgeExecutionRequestContext, type PlanSource } from '../services/execution'
import { captureLatestPlanForSession } from '../services/plan-capture'
import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'
import { getRestartability } from '../loop/restartability'
import { loopBranchExists } from '../workspace/forge-naming'

const z = tool.schema

/**
 * Builds the shared "Goal loop activated!" launch success message. The
 * new-session audited path and the execute-goal path differ only in where the
 * session runs (location lines) and how the launch is described (body lines).
 */
function buildGoalLoopActivatedLines(opts: {
  sessionId: string
  loopName: string
  maxIterations?: number
  locationLines: string[]
  bodyLines: string[]
}): string[] {
  const maxInfo = (opts.maxIterations ?? 0) > 0 ? String(opts.maxIterations) : 'unlimited'
  return [
    'Goal loop activated!',
    '',
    `Session: ${opts.sessionId} (new dedicated session)`,
    `Loop name: ${opts.loopName}`,
    ...opts.locationLines,
    `Max iterations: ${maxInfo}`,
    '',
    ...opts.bodyLines,
    'Your job is done — just confirm to the user that the goal loop has been launched.',
    'The user can run loop-status or loop-cancel later if needed.',
  ]
}

export function createLoopTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { loopHandler, config, logger } = ctx

  /**
   * Detects when a newly created loop session resolved to a different opencode
   * project than the one this plugin/TUI instance is scoped to. This happens
   * when the launch directory had no git commit when opencode started (project
   * id derives from the root commit), and it makes the session invisible to the
   * TUI session list and un-navigable. Best effort — returns null when scopes
   * match or the lookup fails.
   */
  async function projectScopeWarning(sessionId: string): Promise<string | null> {
    try {
      const info = await ctx.client.session.get({ sessionID: sessionId })
      const sessionProject = (info as { projectID?: string })?.projectID
      if (sessionProject && sessionProject !== ctx.projectId) {
        logger.error(`loop: project scope mismatch — session ${sessionId} belongs to project ${sessionProject}, but this instance is scoped to ${ctx.projectId}`)
        return [
          '',
          `WARNING: The new session belongs to project ${sessionProject}, but this opencode instance is scoped to project ${ctx.projectId}.`,
          'This usually means the directory had no git commit when opencode started, so the TUI cannot list or switch to the new session.',
          'The loop keeps running. Restart opencode in this directory to make the session visible.',
        ].join('\n')
      }
    } catch {
      // Best effort only — never block a successful launch on this check.
    }
    return null
  }

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
      client: ctx.client,
      plansRepo: ctx.plansRepo,
      loopsRepo: ctx.loopsRepo,
      loopHandler: ctx.loopHandler,
      loop: ctx.loop,
      sandboxManager: ctx.sandboxManager,
      sectionPlansRepo: ctx.sectionPlansRepo,
      reviewFindingsRepo: ctx.reviewFindingsRepo,
      loopSessionUsageRepo: ctx.loopSessionUsageRepo,
      newSessionOutcomesRepo: ctx.newSessionOutcomesRepo,
      newSessionCancellationsRepo: ctx.newSessionCancellationsRepo,
      workspaceStatusRegistry: ctx.workspaceStatusRegistry,
      pendingTeardowns: ctx.pendingTeardowns,
    })
    return { service, execCtx }
  }

   

  return {
    'execute-plan': tool({
      description: "Execute a plan using an iterative development loop in an isolated git worktree (sandboxed). Set mode='new-session' to instead launch the plan as an audited goal-style loop in a fresh session in the project directory (no worktree, no sandbox): the auditor validates each coding pass and the loop continues until the audit is clear.",
      args: {
        plan: z.string().optional().describe('The full implementation plan. If omitted, reads from the session plan store — except for cross-process new-session launches (crossProcess=true), which OMIT it and resolve the plan the TUI panel staged in the shared Forge database keyed by requestNonce.'),
        title: z.string().describe('Short title for the session (shown in session list)'),
        loopName: z.string().optional().describe('Name for the loop (max 25 chars, auto-incremented if collision exists)'),
        hostSessionId: z.string().optional().describe('Host session ID for post-completion redirect. Applies only to loop mode, where the TUI redirects back to this session after worktree teardown. Ignored in new-session mode: the audited session always attributes its host metadata to the invoking session and never redirects.'),
        mode: z.enum(['loop', 'new-session']).optional().default('loop')
          .describe("Execution mode. 'loop' (default) runs an iterative loop in an isolated git worktree. 'new-session' runs an audited goal-style loop in a fresh session in the project directory (no worktree, no sandbox); tracked by loop-status and loop-cancel. Falls back to a plain standalone session when loops are disabled or the project has no commit."),
        executionModel: z.string().optional().describe('Override the code agent model (provider/model). Defaults to plugin config executionModel.'),
        auditorModel: z.string().optional().describe('Override the auditor model (provider/model). Defaults to plugin config auditorModel.'),
        executionVariant: z.string().optional().describe('Override the code agent variant. Defaults to plugin config executionVariant.'),
        auditorVariant: z.string().optional().describe('Override the auditor variant. Defaults to plugin config auditorVariant.'),
        requestNonce: z.string().optional().describe('Per-launch correlation id minted by the TUI execute-plan panel and forwarded verbatim into `ForgeExecutionRequestContext.requestId` so the panel can confirm and cancel the launch across processes. REQUIRED when `crossProcess=true`; direct `/execute-plan` invocations omit it.'),
        crossProcess: z.boolean().optional().default(false).describe('Set to true ONLY by the TUI execute-plan panel when launching New session cross-process via host-agent `promptAsync`. Direct `/execute-plan` invocations omit it. When true, `requestNonce` becomes mandatory so a malformed cross-process request where the host agent dropped the nonce is rejected before any session/loop is provisioned, and the `plan` argument is omitted: the panel stages the plan text in the shared Forge database before dispatch and this tool resolves it by requestNonce.'),
      },
      execute: async (args, context) => {
        logger.log(`loop: creating loop for plan="${args.title}"`)

        if (args.mode === 'new-session' && args.crossProcess && !args.requestNonce) {
          // Cross-process correlation: a TUI panel New session launch flows
          // through `promptAsync` into this tool and MUST carry the panel-minted
          // nonce so the panel can confirm and cancel the launch against the
          // shared `loop_new_session_outcomes` store. Without one, a panel
          // timeout + user retry could provision an uncorrelated session the
          // panel can neither confirm nor cancel. Direct `/execute-plan`
          // invocations never set `crossProcess` and launch in-process, where
          // the tool result itself (not a polled outcome) confirms the launch,
          // so they need no nonce. The schema makes both fields optional only
          // because ZodRawShape field schemas cannot express a cross-field
          // requirement; enforce the cross-process pair here, BEFORE any
          // session/loop is provisioned. The plan-approval hook and in-process
          // bridge dispatch `plan.execute.newSession` directly via
          // `service.dispatch`, bypassing this tool, so they remain safe.
          logger.error('loop: rejected cross-process new-session launch without requestNonce')
          return 'Failed to start new session: a requestNonce correlation id is required for cross-process new-session launches (crossProcess=true). The launching panel must forward one verbatim; direct `/execute-plan` invocations should omit crossProcess instead.'
        }

        let source: PlanSource
        if (args.mode === 'new-session' && args.crossProcess && !args.plan) {
          // Cross-process staged-plan protocol: the TUI panel stages the full
          // plan text in the shared Forge database keyed by this launch's
          // nonce BEFORE dispatching the host instruction, so the host LLM
          // forwards only the nonce instead of re-emitting the plan verbatim.
          // A missing staged plan means the launch cannot be trusted — the
          // panel staged it pre-dispatch, so absence implies the row was
          // pruned/expired or this server reads a different database. Never
          // fall back to the session plan store here: it belongs to the host
          // session and could execute the wrong plan.
          const stagedPlan = ctx.newSessionRequestsRepo?.findPlan(ctx.projectId, args.requestNonce!) ?? null
          if (stagedPlan === null) {
            logger.error(`loop: rejected cross-process new-session launch — no staged plan for requestNonce=${args.requestNonce}`)
            return 'Failed to start new session: no staged plan was found for this cross-process launch (requestNonce not present in the shared Forge database). The launching panel stages the plan before dispatch, so a missing record means it expired/was pruned or the server reads a different database; the launch cannot be trusted. Relaunch from the TUI panel instead of retrying this invocation.'
          }
          source = { kind: 'inline', planText: stagedPlan }
        } else if (!args.plan) {
          const capture = await captureLatestPlanForSession(
            {
              client: ctx.client,
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

        const executionModel = config.executionModel
        const { service, execCtx } = makeService(context.sessionID)
        if (args.requestNonce) {
          execCtx.requestId = args.requestNonce
        }

        if (args.mode === 'new-session') {
          const result = await service.dispatch(execCtx, {
            type: 'plan.execute.newSession',
            source,
            title: args.title,
            loopName: args.loopName,
            executionModel: args.executionModel ?? executionModel,
            auditorModel: args.auditorModel,
            executionVariant: args.executionVariant,
            auditorVariant: args.auditorVariant,
            lifecycle: {
              selectSession: true,
              selectSessionTiming: 'after-prompt',
              deleteSessionOnPromptFailure: true,
            },
          })

          if (!result.ok) {
            logger.error('loop: failed to start new session', result.error)
            return `Failed to start new session: ${result.error.message}`
          }

          if (result.data.loopName) {
            const modelInfo = result.data.modelUsed ?? 'default'
            const lines = buildGoalLoopActivatedLines({
              sessionId: result.data.sessionId,
              loopName: result.data.loopName,
              maxIterations: result.data.maxIterations,
              locationLines: [
                'Directory: project directory (no worktree)',
                `Model: ${modelInfo}`,
              ],
              bodyLines: [
                'A new code session has been created in the project directory to implement the plan.',
                'The plan runs as an audited loop: the auditor reviews each coding pass and the loop continues until the audit is clear.',
                'That session implements the plan — NOT this one. Do not edit files or attempt the plan here.',
              ],
            })

            const scopeWarning = await projectScopeWarning(result.data.sessionId)
            if (scopeWarning) lines.push(scopeWarning)

            return lines.join('\n')
          }

          const modelInfo = result.data.modelUsed ?? 'default'
          return [
            'New session started (one-shot fallback)',
            '',
            `Session: ${result.data.sessionId}`,
            `Title: ${result.data.title}`,
            `Model: ${modelInfo}`,
            '',
            'Loop tracking was unavailable (loops disabled or the project has no commit), so the plan runs as a standalone one-shot session in the project directory without an auditor.',
            'This session is not tracked by loop-status or loop-cancel.',
            'Your job is done — just confirm to the user that the new session has been launched.',
          ].join('\n')
        }

        const sessionTitle = formatPlanSessionTitle(args.title)
        const auditorModel = config.auditorModel
        const loopName = args.loopName ? slugify(args.loopName) : slugify(sessionTitle)

        const command = buildStartLoopCommand({
          source,
          title: sessionTitle,
          loopName,
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
        const lines: string[] = [
          'Memory loop activated!',
          '',
          `Session: ${result.data.sessionId}`,
          `Title: ${formatLoopSessionTitle(sessionTitle)}`,
        ]

        lines.push(`Loop name: ${result.data.loopName}`)
        lines.push(`Worktree: ${result.data.worktreeDir}`)
        lines.push(`Branch: ${result.data.worktreeBranch ?? 'unknown'}`)

        lines.push(
          `Model: ${modelInfo}`,
          `Max iterations: ${maxInfo}`,
          '',
          'The loop will automatically continue when the session goes idle.',
          'Your job is done — just confirm to the user that the loop has been launched.',
          'The user can run loop-status or loop-cancel later if needed.',
        )

        const scopeWarning = await projectScopeWarning(result.data.sessionId)
        if (scopeWarning) lines.push(scopeWarning)

        return lines.join('\n')
      },
    }),

    'execute-goal': tool({
      description: 'Start a managed goal loop that runs in a new dedicated session: creates an isolated Forge worktree and code session, sends the goal as the initial prompt, registers the new session as the loop executor, and starts the watchdog. The invoking session remains hostSessionId and is not warped or mutated.',
      args: {
        goal: z.string().describe('The goal to execute. Non-empty free text; the first line is used to derive a title/loop name when omitted.'),
        title: z.string().optional().describe('Short title for the loop (derived from the goal when omitted)'),
        loopName: z.string().optional().describe('Name for the loop (max 25 chars, auto-incremented if collision exists; derived from the title when omitted)'),
        maxIterations: z.number().optional().describe('Maximum loop iterations (defaults to plugin config loop.defaultMaxIterations)'),
        hostSessionId: z.string().optional().describe('Host session ID for post-completion redirect'),
      },
      execute: async (args, context) => {
        const goalText = (args.goal ?? '').trim()
        if (!goalText) {
          return 'Goal text is required. Pass a non-empty goal argument.'
        }

        logger.log(`loop: starting goal loop for goal="${goalText.slice(0, 80)}"`)

        const { service, execCtx } = makeService(context.sessionID)
        const result = await service.dispatch(execCtx, {
          type: 'goal.start',
          goal: goalText,
          title: args.title,
          loopName: args.loopName,
          maxIterations: args.maxIterations,
          hostSessionId: args.hostSessionId,
          executorSessionId: context.sessionID,
        })

        if (!result.ok) {
          logger.error('loop: failed to start goal loop', result.error)
          return `Failed to start goal loop: ${result.error.message}`
        }

        const lines = buildGoalLoopActivatedLines({
          sessionId: result.data.sessionId,
          loopName: result.data.loopName,
          maxIterations: result.data.maxIterations,
          locationLines: [
            `Worktree: ${result.data.worktreeDir}`,
            `Branch: ${result.data.worktreeBranch ?? 'unknown'}`,
          ],
          bodyLines: [
            'A new code session has been created in the worktree with the goal as the initial prompt.',
            'That session implements the goal — NOT this one. Do not edit files or attempt the goal here.',
          ],
        })

        const scopeWarning = await projectScopeWarning(result.data.sessionId)
        if (scopeWarning) lines.push(scopeWarning)

        return lines.join('\n')
      },
    }),

    'loop-cancel': tool({
      description: 'Cancels the only active loop when called with no arguments. Pass a name to cancel a specific loop.',
      args: {
        name: z.string().optional().describe('Loop name to cancel'),
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
        const branchInfo = d.worktreeBranch ? `\nBranch: ${d.worktreeBranch}` : ''
        return `Cancelled loop "${d.loopName}" (was at iteration ${d.iteration}).\nDirectory: ${d.worktreeDir}${branchInfo}`
      },
    }),

    'loop-status': tool({
      description: 'Lists all active loops when called with no arguments. Pass a loop name for detailed status of a specific loop. Use restart to explicitly resume a non-completed loop. Running loops require force. Completed loops cannot restart.',
      args: {
        name: z.string().optional().describe('Loop name to check for detailed status'),
        restart: z.boolean().optional().default(false).describe('Restart a non-completed loop by name. Running loops require force.'),
        force: z.boolean().optional().default(false).describe('Force restart an active/stuck loop'),
      },
      execute: async (args) => {
        const active = ctx.loop.listActive()

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
          const branchInfo = d.worktreeBranch ? `\nBranch: ${d.worktreeBranch}` : ''
          return [
            `Restarted loop "${d.loopName}"`,
            '',
            `New session: ${d.sessionId}`,
            `Continuing from iteration: ${d.iteration}`,
            `Directory: ${d.worktreeDir}${branchInfo}`,
          ].join('\n')
        }

        if (!args.name) {
          const recent = ctx.loop.listRecent()

          if (active.length === 0) {
            if (recent.length === 0) {
              // Even with no active loops, show cumulative usage if available
              const loopsRepo = ctx.loopsRepo
              const allLoopNames = new Set<string>()
              for (const loop of loopsRepo.listAll(ctx.projectId)) {
                allLoopNames.add(loop.loopName)
              }
              
              const usageLines: string[] = []
              if (ctx.loopSessionUsageRepo) {
                for (const loopName of allLoopNames) {
                  const aggregate = ctx.loopSessionUsageRepo.getAggregate(ctx.projectId, loopName)
                  if (aggregate) {
                    const { aggregateToUsageSummary, formatUsageSummary } = await import('../utils/loop-format')
                    const summary = aggregateToUsageSummary(aggregate)
                    usageLines.push(`Loop: ${loopName}`)
                    usageLines.push(...formatUsageSummary(summary).map(l => `  ${l}`))
                    usageLines.push('')
                  }
                }
              }
              
              if (usageLines.length > 0) {
                return ['Cumulative Loop Usage', '', ...usageLines].join('\n')
              }
              
              return 'No loops found.'
            }

            const lines: string[] = ['Recent Loops', '']
            recent.forEach((s, i) => {
              const durationStr = formatDuration(computeElapsedSeconds(s.startedAt, s.completedAt))
              lines.push(`${i + 1}. ${s.loopName}`)
              lines.push(`   Status: ${s.terminationReason ?? 'unknown'} | Iterations: ${s.iteration} | Duration: ${durationStr} | Completed: ${s.completedAt ?? 'unknown'}`)
              lines.push('')
            })
            lines.push('Use loop-status <name> for detailed info.')
            return lines.join('\n')
          }

          const statuses: Record<string, { type: string; attempt?: number; message?: string; next?: number }> = {}
          try {
            const uniqueDirs = [...new Set(active.map((s) => s.worktreeDir).filter(Boolean))]
            const results = await Promise.allSettled(
              uniqueDirs.map((dir) => ctx.client.session.status({ directory: dir })),
            )
            for (const result of results) {
              if (result.status === 'fulfilled' && result.value) {
                Object.assign(statuses, result.value)
              }
            }
          } catch {
          }

          const lines: string[] = [`Active Loops (${active.length})`, '']
          active.forEach((s, i) => {
            const duration = formatDuration(computeElapsedSeconds(s.startedAt))
            const iterInfo = s.maxIterations && s.maxIterations > 0 ? `${s.iteration} / ${s.maxIterations}` : `${s.iteration} (unlimited)`
            // Check if any session registered to this loop is busy (main + child/subagent sessions)
            const isBusy = Object.entries(statuses).some(([sid, v]) =>
              ctx.loop.service.resolveLoopName(sid) === s.loopName && v.type === 'busy',
            )
            const sessionStatus = isBusy ? 'busy' : (statuses[s.sessionId]?.type ?? 'unavailable')
            const stallInfo = loopHandler.getStallInfo(s.loopName!)
            const stallCount = stallInfo?.consecutiveStalls ?? 0
            const stallReason = stallInfo?.lastReason ? ` (${stallInfo.lastReason})` : ''
            const stallSuffix = stallCount > 0 ? ` | Stalls: ${stallCount}${stallReason}` : ''
            lines.push(`${i + 1}. ${s.loopName}`)
            lines.push(`   Phase: ${s.phase} | Iteration: ${iterInfo} | Duration: ${duration} | Status: ${sessionStatus}${stallSuffix}`)
            lines.push('')
          })

          if (recent.length > 0) {
            lines.push('Recent Loops:')
            lines.push('')
            const limitedRecent = recent.slice(0, 10)
            limitedRecent.forEach((s, i) => {
              const durationStr = formatDuration(computeElapsedSeconds(s.startedAt, s.completedAt))
              lines.push(`${i + 1}. ${s.loopName}`)
              lines.push(`   Status: ${s.terminationReason ?? 'unknown'} | Iterations: ${s.iteration} | Duration: ${durationStr} | Completed: ${s.completedAt ?? 'unknown'}`)
              lines.push('')
            })
            if (recent.length > 10) {
              lines.push(`   ... and ${recent.length - 10} more. Use loop-status <name> for details.`)
              lines.push('')
            }
          }

          lines.push('Use loop-status <name> for detailed info, or loop-cancel <name> to stop a loop.')
          lines.push('Use loop-status <name> restart=true force=true to force-restart a stuck running loop.')
          return lines.join('\n')
        }

        const { match: state, candidates } = ctx.loop.findMatchByName(args.name)
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
            `${state.worktree === false ? 'Directory' : 'Worktree'}: ${state.worktreeDir}`,
          ]
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

          if (state.postActionReport) {
            statusLines.push(...formatPostActionReport(state.postActionReport))
          } else if (state.completionSummary) {
            statusLines.push(...formatCompletionSummary(state.completionSummary))
          }

          if (state.lastAuditResult) {
            statusLines.push(...formatAuditResult(state.lastAuditResult))
          }

          const sessionOutput = state.worktreeDir ? await fetchSessionOutput(
            ctx.client,
            state.sessionId,
            state.worktreeDir,
            logger,
            {
              fallbackModel: state.phase === 'auditing' || state.phase === 'final_auditing'
                ? (state.auditorModel ?? state.executionModel ?? config.executionModel)
                : (state.executionModel ?? config.executionModel),
              role: state.phase === 'auditing' || state.phase === 'final_auditing' ? 'auditor' : 'code',
            },
          ) : null
          if (sessionOutput) {
            statusLines.push('')
            statusLines.push('Session Output:')
            statusLines.push(...formatSessionOutput(sessionOutput))
          }

          // Add restartability display
          const restartability = getRestartability(state, {
            branchExists: () => loopBranchExists(state, ctx.directory),
          })
          if (!restartability.restartable) {
            if (restartability.restartBlockedReason === 'completed') {
              statusLines.push('Restart: not available (completed)')
            } else if (restartability.restartBlockedMessage) {
              statusLines.push(`Restart blocked: ${restartability.restartBlockedMessage}`)
            }
          } else {
            statusLines.push(`Restart: available with loop-status name=${state.loopName} restart=true`)
          }

          // Add cumulative usage (merged persisted + live, with double-count prevention)
          const { buildCumulativeUsage, formatUsageSummary } = await import('../utils/loop-format')
          const cumulativeSummary = buildCumulativeUsage(
            ctx.loopSessionUsageRepo,
            ctx.projectId,
            state.loopName,
            state.sessionId,
            sessionOutput,
          )
          if (cumulativeSummary) {
            statusLines.push('')
            statusLines.push('Cumulative Usage:')
            statusLines.push(...formatUsageSummary(cumulativeSummary).map(l => `  ${l}`))
          }

          return statusLines.join('\n')
        }

        const maxInfo = state.maxIterations && state.maxIterations > 0 ? `${state.iteration} / ${state.maxIterations}` : `${state.iteration} (unlimited)`
        const specification = state.kind === 'goal' ? state.goal : state.prompt
        const specificationPreview = specification && specification.length > 100 ? `${specification.substring(0, 97)}...` : (specification ?? '')

        let sessionStatus = 'unknown'
        try {
          const statusResult = await ctx.client.session.status({ directory: state.worktreeDir })
          const statuses = statusResult as Record<string, { type: string; attempt?: number; message?: string; next?: number }> | undefined
          // Check if any session registered to this loop is busy (main + child/subagent sessions)
          const isBusy = Object.entries(statuses ?? {}).some(([sid, s]) =>
            ctx.loop.service.resolveLoopName(sid) === state.loopName && s.type === 'busy',
          )
          if (isBusy) {
            sessionStatus = 'busy'
          } else {
            const status = statuses?.[state.sessionId]
            if (status) {
              sessionStatus = status.type === 'retry'
                ? `retry (attempt ${status.attempt}, next in ${Math.round(((status.next ?? 0) - Date.now()) / 1000)}s)`
                : status.type
            }
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
        const stallReason = stallInfo?.lastReason
        const stallStatus = stallInfo?.lastStatus
        const stallError = stallInfo?.lastError

        const statusLines: string[] = [
          'Loop Status',
          '',
          `Name: ${state.loopName}`,
          `Session: ${state.sessionId}`,
          `${state.worktree === false ? 'Directory' : 'Worktree'}: ${state.worktreeDir}`,
        ]
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
            sessionOutput = await fetchSessionOutput(
              ctx.client,
              state.sessionId,
              state.worktreeDir,
              logger,
              {
                fallbackModel: state.phase === 'auditing' || state.phase === 'final_auditing'
                  ? (state.auditorModel ?? state.executionModel ?? config.auditorModel ?? config.executionModel)
                  : (state.executionModel ?? config.executionModel),
                role: state.phase === 'auditing' || state.phase === 'final_auditing' ? 'auditor' : 'code',
              },
            )
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

        // Add restartability display for active loops using shared helper
        const restartability = getRestartability(state, {
          branchExists: () => loopBranchExists(state, ctx.directory),
        })
        if (!restartability.restartable) {
          if (restartability.restartBlockedMessage) {
            statusLines.push(`Restart blocked: ${restartability.restartBlockedMessage}`)
          }
        } else if (restartability.restartRequiresForce) {
          statusLines.push('Restart: available with force=true')
        } else {
          statusLines.push(`Restart: available with loop-status name=${state.loopName} restart=true`)
        }

        // Add cumulative usage (merged persisted + live, with double-count prevention)
        const { buildCumulativeUsage, formatUsageSummary } = await import('../utils/loop-format')
        const cumulativeSummary = buildCumulativeUsage(
          ctx.loopSessionUsageRepo,
          ctx.projectId,
          state.loopName,
          state.sessionId,
          sessionOutput,
        )
        if (cumulativeSummary) {
          statusLines.push('')
          statusLines.push('Cumulative Usage:')
          statusLines.push(...formatUsageSummary(cumulativeSummary).map(l => `  ${l}`))
        }

        statusLines.push(
          '',
          `Started: ${state.startedAt}`,
          `Error count: ${state.errorCount} (retries before termination: ${MAX_RETRIES})`,
          `Audit count: ${state.auditCount ?? 0}`,
          `Model: ${state.executionModel ?? config.executionModel ?? 'default'}`,
          `Auditor model: ${state.auditorModel ?? config.auditorModel ?? state.executionModel ?? config.executionModel ?? 'default'}`,
          ...(stallCount > 0 ? [`Stalls: ${stallCount}`] : []),
          ...(stallReason ? [`Last stall reason: ${stallReason}`] : []),
          ...(stallStatus ? [`Last stall status: ${stallStatus}`] : []),
          ...(stallError ? [`Last stall error: ${stallError}`] : []),
          ...(secondsSinceActivity !== null ? [`Last activity: ${secondsSinceActivity}s ago`] : []),
          '',
          `${state.kind === 'goal' ? 'Goal' : 'Prompt'}: ${specificationPreview}`,
        )

        return statusLines.join('\n')
      },
    }),

  }
}
