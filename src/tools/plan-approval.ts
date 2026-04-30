import type { ToolContext } from './types'
import type { Hooks } from '@opencode-ai/plugin'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import { extractPlanTitle, extractLoopNames, PLAN_EXECUTION_LABELS } from '../utils/plan-execution'
import { createForgeExecutionService, type ForgeExecutionRequestContext } from '../services/execution'
import { captureLatestPlanForSession } from '../services/plan-capture'

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

async function resolveCurrentSessionPlan(ctx: ToolContext, sessionID: string): Promise<string | null> {
  const capture = await captureLatestPlanForSession(
    {
      v2: ctx.v2,
      plansRepo: ctx.plansRepo,
      projectId: ctx.projectId,
      directory: ctx.directory,
      logger: ctx.logger,
    },
    sessionID
  )
  
  if (capture.status === 'captured' || capture.status === 'already-current') {
    return capture.planText
  }
  
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
  const { loopService, logger, v2, config } = ctx

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
          const matchedLabel = PLAN_EXECUTION_LABELS.find((l) => answerLower === l.toLowerCase() || answerLower.startsWith(l.toLowerCase()))

          if (matchedLabel && !claimApprovalCall(ctx, input, matchedLabel)) {
            output.output = 'Plan approval already handled.'
            logger.log(`Plan approval: duplicate "${matchedLabel}" call ignored for ${input.callID}`)
            return
          }
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            const planText = await resolveCurrentSessionPlan(ctx, input.sessionID)
            if (!planText) {
              output.output = `${output.output}\n\nError: No captured plan found. Ensure the final plan is wrapped with <!-- forge-plan:start --> and <!-- forge-plan:end -->, or save a plan from the TUI before execution.`
              logger.error('Plan approval: plan not found for "Execute here"')
              return
            }
            
            pendingExecutions.set(input.sessionID, {
              directory: ctx.directory,
              executionModel: parseModelString(ctx.config.executionModel),
              planText,
            })
            
            v2.session.abort({ sessionID: input.sessionID }).catch((err) => {
              logger.error('Plan approval: failed to abort architect session', err)
            })
            
            output.output = `${output.output}\n\nSwitching to code agent for execution...`
            logger.log('Plan approval: "Execute here" — aborting architect, pending code agent switch')
            return
          }
          
          // Programmatic dispatch for "New session" and "Loop" paths
          const planText = await resolveCurrentSessionPlan(ctx, input.sessionID)
          if (!planText) {
            output.output = `${output.output}\n\nError: No captured plan found. Ensure the final plan is wrapped with <!-- forge-plan:start --> and <!-- forge-plan:end -->, or save a plan from the TUI before execution.`
            logger.error('Plan approval: plan not found')
            return
          }
          const title = extractPlanTitle(planText)
          
          if (matchedLabel === 'New session') {
            logger.log('Plan approval: "New session" — creating new session')

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
              plansRepo: ctx.plansRepo,
              loopsRepo: ctx.loopsRepo,
              graphStatusRepo: ctx.graphStatusRepo,
              loopService: ctx.loopService,
              loopHandler: ctx.loopHandler,
              sandboxManager: ctx.sandboxManager,
            })

            const result = await service.dispatch(execCtx, {
              type: 'plan.execute.newSession',
              source: { kind: 'inline', planText },
              title,
              executionModel: config.executionModel,
              lifecycle: {
                selectSession: true,
                abortSourceSession: true,
              },
            })

            if (!result.ok) {
              logger.error('Plan approval: failed to create new session', result.error)
              output.output = 'Creating new session for plan execution... Failed to create session.'
              return
            }

            output.output = `Creating new session for plan execution... Started session ${result.data.sessionId}.`
            logger.log(`Plan approval: new session setup complete (${result.data.sessionId})`)
            return
          }
          
          if (matchedLabel === 'Loop (worktree)' || matchedLabel === 'Loop') {
            const isWorktree = matchedLabel === 'Loop (worktree)'
            // Use explicit loop name from plan (or fallback to title)
            const { executionName } = extractLoopNames(planText)
            const uniqueLoopName = ctx.loopService.generateUniqueLoopName(executionName)
            
            output.output = isWorktree 
              ? 'Starting loop in worktree...' 
              : 'Starting loop in-place...'
            logger.log(`Plan approval: "${matchedLabel}" — starting loop with loop name "${uniqueLoopName}"`)
            
            const executionModel = config.executionModel
            const auditorModel = config.auditorModel
            
            // Build execution request context
            const execCtx: ForgeExecutionRequestContext = {
              surface: 'approval-hook',
              projectId: ctx.projectId,
              directory: ctx.directory,
              sourceSessionId: input.sessionID,
            }
            
            // Create execution service
            const service = createForgeExecutionService({
              projectId: ctx.projectId,
              directory: ctx.directory,
              config,
              logger,
              dataDir: ctx.dataDir,
              v2: ctx.v2,
              plansRepo: ctx.plansRepo,
              loopsRepo: ctx.loopsRepo,
              graphStatusRepo: ctx.graphStatusRepo,
              loopService: ctx.loopService,
              loopHandler: ctx.loopHandler,
              sandboxManager: ctx.sandboxManager,
            })
            
            service.dispatch(execCtx, {
              type: 'loop.start',
              source: { kind: 'inline', planText },
              title: `Loop: ${title}`,
              loopName: uniqueLoopName,
              mode: isWorktree ? 'worktree' : 'in-place',
              maxIterations: config.loop?.defaultMaxIterations ?? 0,
              executionModel,
              auditorModel,
              lifecycle: {
                selectSession: true,
                startWatchdog: true,
              },
            }).then((result) => {
              if (!result.ok) {
                logger.error('Plan approval: loop setup failed, keeping architect session active', result.error)
                return
              }
              logger.log('Plan approval: loop setup complete')
            }).catch((err) => {
              logger.error('Plan approval: execution service threw unexpectedly', err as Error)
            })
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
    
    const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
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
    
    if (promptResult.error) {
      logger.error('Plan approval: failed to switch to code agent', promptResult.error)
    } else {
      const modelInfo = actualModel ? `${actualModel.providerID}/${actualModel.modelID}` : 'default'
      logger.log(`Plan approval: switched to code agent (model: ${modelInfo})`)
    }
  }
}
