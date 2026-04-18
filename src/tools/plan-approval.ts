import type { ToolContext } from './types'
import type { Hooks } from '@opencode-ai/plugin'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import { setupLoop } from './loop'
import { DEFAULT_COMPLETION_SIGNAL } from '../services/loop'
import { extractPlanTitle, extractLoopNames, PLAN_EXECUTION_LABELS } from '../utils/plan-execution'

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

export { LOOP_BLOCKED_TOOLS }
export { extractPlanTitle }

export function createToolExecuteBeforeHook(ctx: ToolContext): Hooks['tool.execute.before'] {
  const { loopService, logger } = ctx

  return async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { args: unknown }
  ) => {
    const loopName = loopService.resolveLoopName(input.sessionID)
    const state = loopName ? loopService.getActiveState(loopName) : null
    if (!state?.active) return

    if (!(input.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocking ${input.tool} tool before execution in ${state.phase} phase for session ${input.sessionID}`)

    throw new Error(LOOP_BLOCKED_TOOLS[input.tool]!)
  }
}

export function createToolExecuteAfterHook(ctx: ToolContext): Hooks['tool.execute.after'] {
  const { loopService, logger, plansRepo, projectId, v2, config } = ctx

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
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            // Read plan from plans repo (same as "New session" path)
            const planRow = plansRepo.getForSession(projectId, input.sessionID)
            if (!planRow) {
              output.output = `${output.output}\n\nError: No cached plan found. Please ensure the plan is written via plan-write before approval.`
              logger.error('Plan approval: plan not found for "Execute here"')
              return
            }
            const planText = planRow.content
            
            // Delete from plans repo after reading (consistent with other paths)
            plansRepo.deleteForSession(projectId, input.sessionID)
            
            pendingExecutions.set(input.sessionID, {
              directory: ctx.directory,
              executionModel: parseModelString(ctx.config.executionModel),
              planText,
            })
            
            ctx.v2.session.abort({ sessionID: input.sessionID }).catch((err) => {
              logger.error('Plan approval: failed to abort architect session', err)
            })
            
            output.output = `${output.output}\n\nSwitching to code agent for execution...`
            logger.log('Plan approval: "Execute here" — aborting architect, pending code agent switch')
            return
          }
          
          // Programmatic dispatch for "New session" and "Loop" paths
          const planRow = plansRepo.getForSession(projectId, input.sessionID)
          if (!planRow) {
            output.output = `${output.output}\n\nError: No cached plan found. Please ensure the plan is written via plan-write before approval.`
            logger.error('Plan approval: plan not found')
            return
          }
          
          const planText = planRow.content
          const title = extractPlanTitle(planText)
          
          if (matchedLabel === 'New session') {
            logger.log('Plan approval: "New session" — creating new session')
            
            const executionModel = parseModelString(config.executionModel)
            
            v2.session.create({ title, directory: ctx.directory }).then((createResult) => {
              if (createResult.error || !createResult.data) {
                logger.error('Plan approval: failed to create new session', createResult.error)
                output.output = 'Creating new session for plan execution... Failed to create session.'
                return
              }
              const newSessionId = createResult.data.id
              
              plansRepo.deleteForSession(projectId, input.sessionID)
              
              retryWithModelFallback(
                () => v2.session.promptAsync({
                  sessionID: newSessionId,
                  directory: ctx.directory,
                  agent: 'code',
                  parts: [{ type: 'text', text: planText }],
                  ...(executionModel ? { model: executionModel } : {}),
                }),
                () => v2.session.promptAsync({
                  sessionID: newSessionId,
                  directory: ctx.directory,
                  agent: 'code',
                  parts: [{ type: 'text', text: planText }],
                }),
                executionModel,
                logger,
              ).then(({ result }) => {
                if (result.error) {
                  logger.error('Plan approval: failed to send plan to new session', result.error)
                } else {
                  v2.tui.selectSession({ sessionID: newSessionId }).catch((err) => {
                    logger.error('Plan approval: failed to navigate TUI', err)
                  })
                }
              })
            }).catch((err) => {
              logger.error('Plan approval: failed to create new session', err)
              output.output = 'Creating new session for plan execution... Failed to create session.'
            })
            
            v2.session.abort({ sessionID: input.sessionID }).catch((err) => {
              logger.error('Plan approval: failed to abort architect session', err)
            })
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
            
            const loopModel = parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
            const executionModel = config.loop?.model ?? config.executionModel
            const auditorModel = config.auditorModel ?? config.loop?.model ?? config.executionModel
            
            // Defer architect session abort until setupLoop completes, so we can roll back on failure.
            // The plan row in plansRepo is kept until success — if setupLoop fails the user can retry.
            setupLoop(ctx, {
              prompt: planText,
              sessionTitle: `Loop: ${title}`,
              loopName: uniqueLoopName,
              completionSignal: DEFAULT_COMPLETION_SIGNAL,
              maxIterations: config.loop?.defaultMaxIterations ?? 0,
              audit: true,
              agent: 'code',
              model: loopModel,
              worktree: isWorktree,
              executionModel: executionModel,
              auditorModel: auditorModel,
              onLoopStarted: (id) => ctx.loopHandler.startWatchdog(id),
            }).then((result) => {
              // setupLoop returns a multi-line success string starting with "Memory loop activated!".
              // Any other non-empty string indicates a failure (e.g. "Failed to create worktree.",
              // "Loop session created but failed to send prompt.", etc.).
              const isSuccess = typeof result === 'string' && result.startsWith('Memory loop activated')
              if (!isSuccess) {
                logger.error('Plan approval: loop setup failed, keeping architect session active', result)
                // Plan row stays in plansRepo so the user can retry from the same architect session.
                return
              }
              logger.log('Plan approval: loop setup complete, aborting architect session')
              plansRepo.deleteForSession(projectId, input.sessionID)
              v2.session.abort({ sessionID: input.sessionID }).catch((err) => {
                logger.error('Plan approval: failed to abort architect session', err)
              })
            }).catch((err) => {
              logger.error('Plan approval: setupLoop threw unexpectedly', err)
              // Unexpected throw — abort the architect session but leave the plan row so the user can retry.
              v2.session.abort({ sessionID: input.sessionID }).catch((abortErr) => {
                logger.error('Plan approval: failed to abort architect session', abortErr)
              })
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
    if (!state?.active) return

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
