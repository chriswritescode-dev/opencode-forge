import type { ToolContext } from './types'
import type { Hooks } from '@opencode-ai/plugin'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import { extractPlanTitle, extractLoopNames, PLAN_EXECUTION_LABELS, type PlanExecutionLabel } from '../utils/plan-execution'
import { buildStartLoopCommand, createForgeExecutionService, type ForgeExecutionRequestContext } from '../services/execution'



function publishPlanApprovalToast(
  ctx: ToolContext,
  _input: { sessionID: string },
  variant: 'success' | 'error' | 'info',
  message: string,
): void {
  ctx.v2.tui?.publish({
    directory: ctx.directory,
    body: {
      type: 'tui.toast.show',
      properties: {
        title: 'Forge plan execution',
        message,
        variant,
        duration: variant === 'error' ? 5000 : 3000,
      },
    },
  }).catch((err) => {
    ctx.logger.error('Plan approval: failed to publish toast', err)
  })
}

async function abortApprovalSourceSession(ctx: ToolContext, sessionID: string): Promise<boolean> {
  const logger = ctx.logger
  const legacyClient = ctx.input?.client
  if (legacyClient?.session) {
    try {
      logger.log(`Plan approval: awaiting legacy session.abort for ${sessionID}`)
      const result = await legacyClient.session.abort({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      } as Parameters<typeof legacyClient.session.abort>[0])
      if ((result as { error?: unknown })?.error) {
        logger.error('Plan approval: legacy session.abort returned error', (result as { error?: unknown }).error)
      } else {
        logger.log(`Plan approval: legacy session.abort resolved for ${sessionID}`)
        return true
      }
    } catch (err) {
      logger.error('Plan approval: legacy session.abort threw', err)
    }
  }
  try {
    logger.log(`Plan approval: awaiting v2.session.abort for ${sessionID}`)
    const v2Result = await ctx.v2.session.abort({ sessionID, directory: ctx.directory })
    if ((v2Result as { error?: unknown })?.error) {
      logger.error('Plan approval: v2.session.abort returned error', (v2Result as { error?: unknown }).error)
      return false
    }
    logger.log(`Plan approval: v2.session.abort resolved for ${sessionID}`)
    return true
  } catch (err) {
    logger.error('Plan approval: v2.session.abort threw', err)
    return false
  }
}

function markApprovalHandled(output: { metadata: unknown }, duplicate = false): void {
  output.metadata = {
    ...(typeof output.metadata === 'object' && output.metadata !== null ? output.metadata : {}),
    forgePlanApprovalHandled: true,
    ...(duplicate ? { forgePlanApprovalDuplicate: true } : {}),
  }
}

function scheduleApprovalDispatch(
  label: PlanExecutionLabel,
  task: () => Promise<void>,
  logger: ToolContext['logger'],
): void {
  void task().catch((err) => {
    logger.error(`Plan approval: "${label}" dispatch failed`, err)
  })
}

const LOOP_BLOCKED_TOOLS: Record<string, string> = {
  question: 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
  'plan-execute': 'The plan-execute tool is not available during a loop. Focus on executing the current plan.',
  loop: 'The loop tool is not available during a loop. Focus on executing the current plan.',
}

interface PendingExecution {
  directory: string
  executionModel?: { providerID: string; modelID: string }
  planText?: string
}

const pendingExecutions = new Map<string, PendingExecution>()
const processedApprovalCalls = new WeakMap<ToolContext, Set<string>>()

export { LOOP_BLOCKED_TOOLS }
export { extractPlanTitle }

function isActiveLoopToolSession(state: { active?: boolean; sessionId?: string; auditSessionId?: string }, sessionID: string): boolean {
  return state.active === true && (state.sessionId === sessionID || state.auditSessionId === sessionID)
}

function claimApprovalCall(ctx: ToolContext, input: { sessionID: string; callID: string }, label: string): boolean {
  let processed = processedApprovalCalls.get(ctx)
  if (!processed) {
    processed = new Set<string>()
    processedApprovalCalls.set(ctx, processed)
  }
  const key = `${input.sessionID}:${input.callID}:${label}`
  if (processed.has(key)) return false
  if (processed.size > 1000) processed.clear()
  processed.add(key)
  return true
}

function resolveCurrentSessionPlan(ctx: ToolContext, sessionID: string): string | null {
  return ctx.plansRepo.getForSession(ctx.projectId, sessionID)?.content ?? null
}

export function createToolExecuteBeforeHook(ctx: ToolContext): Hooks['tool.execute.before'] {
  const { loopService, logger } = ctx

  return async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { args: unknown }
  ) => {
    const loopName = loopService.resolveLoopName(input.sessionID)
    const state = loopName ? loopService.getActiveState(loopName) : null
    if (!state?.active || !isActiveLoopToolSession(state, input.sessionID)) return

    if (!(input.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocking ${input.tool} tool before execution in ${state.phase} phase for session ${input.sessionID}`)

    throw new Error(LOOP_BLOCKED_TOOLS[input.tool]!)
  }
}

export function createToolExecuteAfterHook(ctx: ToolContext): Hooks['tool.execute.after'] {
  const { loopService, logger, config } = ctx

  return async (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => {
    if (input.tool === 'question') {
      const args = input.args as { questions?: Array<{ options?: Array<{ label: string }> }> } | undefined
      const options = args?.questions?.[0]?.options
      if (options) {
        const labels = options.map((o) => o.label.toLowerCase())
        const hasExecuteHere = labels.some((l) => l === 'execute here' || l.startsWith('execute here'))
        const isPlanApproval = hasExecuteHere || PLAN_EXECUTION_LABELS.every((l) => labels.includes(l))
        if (isPlanApproval) {
          const metadata = output.metadata as { answers?: string[][] } | undefined
          const answer = metadata?.answers?.[0]?.[0]?.trim() ?? output.output.trim()
          const answerLower = answer.toLowerCase()
          const matchedLabel = PLAN_EXECUTION_LABELS.find((l) =>
            answerLower === l.toLowerCase() || answerLower.startsWith(l.toLowerCase())
          )

          if (matchedLabel && !claimApprovalCall(ctx, input, matchedLabel)) {
            markApprovalHandled(output, true)
            logger.log(`Plan approval: duplicate "${matchedLabel}" call ignored for ${input.callID}`)
            logger.log(`Plan approval: duplicate "${matchedLabel}" — awaiting source session abort`)
            await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log(`Plan approval: duplicate "${matchedLabel}" — abort completed`)
            return
          }

          if (matchedLabel) {
            markApprovalHandled(output)
            logger.log(`Plan approval: question answer matched "${matchedLabel}" for call ${input.callID}`)
            logger.log(`Plan approval: answer value="${answer}" matched label="${matchedLabel}"`)
          }
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            const planText = resolveCurrentSessionPlan(ctx, input.sessionID)
            if (!planText) {
              publishPlanApprovalToast(ctx, input, 'error', 'Plan not found for execution')
              logger.error('Plan approval: plan not found for "Execute here"')
              await abortApprovalSourceSession(ctx, input.sessionID)
              logger.log('Plan approval: "Execute here" — abort completed (plan not found)')
              return
            }
            
            pendingExecutions.set(input.sessionID, {
              directory: ctx.directory,
              executionModel: parseModelString(ctx.config.executionModel),
              planText,
            })

            logger.log('Plan approval: "Execute here" — pending code agent switch set; awaiting source session abort')
            await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log('Plan approval: "Execute here" — abort completed')
            return
          }
          
          // Programmatic dispatch for "New session" and "Loop" paths
          const planText = resolveCurrentSessionPlan(ctx, input.sessionID)
          if (!planText) {
            publishPlanApprovalToast(ctx, input, 'error', 'Plan not found for execution')
            logger.error('Plan approval: plan not found')
            await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log('Plan approval: plan not found — abort completed')
            return
          }
          const title = extractPlanTitle(planText)
          
          const execCtx: ForgeExecutionRequestContext = {
            surface: 'approval-hook',
            projectId: ctx.projectId,
            directory: ctx.directory,
            sourceSessionId: input.sessionID,
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
          
          if (matchedLabel === 'New session') {
            logger.log('Plan approval: "New session" — scheduling service.dispatch(plan.execute.newSession)')
            scheduleApprovalDispatch('New session', async () => {
              logger.log(`Plan approval [New session]: starting service.dispatch`)
              const result = await service.dispatch(execCtx, {
                type: 'plan.execute.newSession',
                source: { kind: 'inline', planText },
                title,
                executionModel: config.executionModel,
                lifecycle: {
                  selectSession: true,
                  selectSessionTiming: 'after-prompt',
                  abortSourceSession: false,
                  deleteSessionOnPromptFailure: false,
                  returnToSourceOnPromptFailure: false,
                },
              })
              logger.log(`Plan approval [New session]: service.dispatch returned ok=${result.ok}`)
              if (!result.ok) {
                logger.error('Plan approval [New session]: dispatch failed', result.error)
                publishPlanApprovalToast(ctx, input, 'error', `Failed to start new session: ${result.error.message}`)
                return
              }
              publishPlanApprovalToast(ctx, input, 'success', 'Started new plan execution session')
            }, logger)

            logger.log('Plan approval: "New session" — awaiting source session abort')
            const aborted = await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log(`Plan approval: "New session" — abort completed (success=${aborted})`)
            return
          }
          
          if (matchedLabel === 'Loop (worktree)' || matchedLabel === 'Loop') {
            const isWorktree = matchedLabel === 'Loop (worktree)'
            const { executionName } = extractLoopNames(planText)
            const uniqueLoopName = ctx.loopService.generateUniqueLoopName(executionName)

            logger.log(`Plan approval: "${matchedLabel}" — scheduling dispatch IIFE for loop "${uniqueLoopName}"`)

            const executionModel = config.executionModel
            const auditorModel = config.auditorModel

            // Schedule dispatch FIRST
            scheduleApprovalDispatch(matchedLabel, async () => {
              logger.log(`Plan approval [${matchedLabel}]: starting service.dispatch for "${uniqueLoopName}"`)
              const command = buildStartLoopCommand({
                source: { kind: 'inline', planText },
                title,
                loopName: uniqueLoopName,
                mode: isWorktree ? 'worktree' : 'in-place',
                maxIterations: config.loop?.defaultMaxIterations ?? 0,
                executionModel,
                auditorModel,
                hostSessionId: input.sessionID,
                lifecycle: {
                  selectSession: true,
                  startWatchdog: true,
                  abortSourceSessionOnSuccess: false,
                },
              })
              const result = await service.dispatch(execCtx, command)
              logger.log(`Plan approval [${matchedLabel}]: service.dispatch returned ok=${result.ok}`)
              if (!result.ok) {
                logger.error('Plan approval: loop setup failed', result.error)
                publishPlanApprovalToast(ctx, input, 'error', `Failed to start loop: ${result.error.message}`)
                return
              }
              publishPlanApprovalToast(ctx, input, 'success', `Started ${isWorktree ? 'worktree ' : ''}loop: ${uniqueLoopName}`)
              logger.log('Plan approval: loop setup complete')
            }, logger)

            logger.log(`Plan approval: "${matchedLabel}" — awaiting source session abort`)
            const aborted = await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log(`Plan approval: "${matchedLabel}" — abort completed (success=${aborted})`)
            return
          }
          
          // Custom answer fallback
              output.output = `${output.output}\n\n<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, use the appropriate tool (plan-execute or loop) based on their intent. If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>`
          logger.log(`Plan approval: detected custom answer`)
        }
      }
      return
    }

    const loopName = loopService.resolveLoopName(input.sessionID)
    const state = loopName ? loopService.getActiveState(loopName) : null
    if (!state?.active || !isActiveLoopToolSession(state, input.sessionID)) return

    if (!(input.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocked ${input.tool} tool in ${state.phase} phase for session ${input.sessionID}`)
    
    output.title = 'Tool blocked'
    output.output = LOOP_BLOCKED_TOOLS[input.tool]!
  }
}

export function createPlanApprovalEventHook(ctx: ToolContext) {
  const { v2, logger } = ctx
  
  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }) => {
    if (eventInput.event?.type !== 'session.status') return

    const status = eventInput.event.properties?.status as { type?: string } | undefined
    if (status?.type !== 'idle') return

    const sessionID = eventInput.event.properties?.sessionID as string
    if (!sessionID) return
    
    const pending = pendingExecutions.get(sessionID)
    if (!pending) return
    
    pendingExecutions.delete(sessionID)
    
    const planRef = pending.planText
      ? `\n\nImplementation Plan:\n${pending.planText}`
      : '\n\nPlan reference: Execute the implementation plan from this conversation. Review all phases above and implement each one.'
    
    const inPlacePrompt = `The architect agent has created an implementation plan. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.${planRef}`
    
    const legacyClient = ctx.input?.client

    // Try legacy client first (in-process fetch, always reliable)
    if (legacyClient) {
      try {
        logger.log(`createPlanApprovalEventHook: trying legacy promptAsync for ${sessionID}`)
        const { result, usedModel } = await retryWithModelFallback(
          () => legacyClient.session.promptAsync({
            path: { id: sessionID },
            query: { directory: pending.directory },
            body: {
              agent: 'code',
              parts: [{ type: 'text' as const, text: inPlacePrompt }],
              ...(pending.executionModel ? { model: pending.executionModel } : {}),
            },
          } as Parameters<typeof legacyClient.session.promptAsync>[0]) as unknown as Promise<{ data?: unknown; error?: unknown }>,
          () => legacyClient.session.promptAsync({
            path: { id: sessionID },
            query: { directory: pending.directory },
            body: {
              agent: 'code',
              parts: [{ type: 'text' as const, text: inPlacePrompt }],
            },
          } as Parameters<typeof legacyClient.session.promptAsync>[0]) as unknown as Promise<{ data?: unknown; error?: unknown }>,
          pending.executionModel,
          logger,
        )
        if (!(result as { error?: unknown })?.error) {
          const modelInfo = usedModel ? `${usedModel.providerID}/${usedModel.modelID}` : 'default'
          logger.log(`Plan approval: switched to code agent via legacy client (model: ${modelInfo})`)
          return
        }
        logger.error('createPlanApprovalEventHook: legacy promptAsync returned error', (result as { error?: unknown }).error)
      } catch (err) {
        logger.error('createPlanApprovalEventHook: legacy promptAsync threw', err)
      }
    }

    // Fallback to v2
    try {
      logger.log(`createPlanApprovalEventHook: falling back to v2 promptAsync for ${sessionID}`)
      const { result, usedModel } = await retryWithModelFallback(
        () => v2.session.promptAsync({
          sessionID,
          directory: pending.directory,
          agent: 'code',
          parts: [{ type: 'text' as const, text: inPlacePrompt }],
          ...(pending.executionModel ? { model: pending.executionModel } : {}),
        }),
        () => v2.session.promptAsync({
          sessionID,
          directory: pending.directory,
          agent: 'code',
          parts: [{ type: 'text' as const, text: inPlacePrompt }],
        }),
        pending.executionModel,
        logger,
      )
      if ((result as { error?: unknown })?.error) {
        logger.error('Plan approval: v2 promptAsync returned error', (result as { error?: unknown }).error)
        return
      }
      const modelInfo = usedModel ? `${usedModel.providerID}/${usedModel.modelID}` : 'default'
      logger.log(`Plan approval: switched to code agent via v2 client (model: ${modelInfo})`)
    } catch (err) {
      logger.error('createPlanApprovalEventHook: v2 promptAsync threw', err)
    }
  }
}
