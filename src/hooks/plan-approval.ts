import { z } from 'zod'
import type { ToolContext } from '../tools/types'
import type { ToolAfterHook, ToolAfterInput, ToolAfterOutput, ToolArgs, ToolBeforeHook, ToolBeforeInput, ToolBeforeOutput, ToolMetadata } from './tool-hook-types'
import type { ForgeEvent } from '../client/port'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import { extractPlanExecutionMetadata, PLAN_EXECUTION_LABELS, type PlanExecutionLabel } from '../utils/plan-execution'
import { createForgeExecutionService, type ForgeExecutionRequestContext } from '../services/execution'
import { publishToast } from '../utils/toast'

function publishPlanApprovalToast(
  ctx: ToolContext,
  _input: { sessionID: string },
  variant: 'success' | 'error' | 'info',
  message: string,
): void {
  publishToast({
    client: ctx.client,
    directory: ctx.directory,
    logger: ctx.logger,
    title: 'Forge plan execution',
    message,
    variant,
    duration: variant === 'error' ? 5000 : 3000,
    logPrefix: 'Plan approval: failed to publish toast',
  })
}

async function abortApprovalSourceSession(ctx: ToolContext, sessionID: string): Promise<boolean> {
  const logger = ctx.logger
  try {
    logger.log(`Plan approval: awaiting session.abort for ${sessionID}`)
    await ctx.client.session.abort({ sessionID, directory: ctx.directory })
    logger.log(`Plan approval: session.abort resolved for ${sessionID}`)
    return true
  } catch (err) {
    logger.error('Plan approval: session.abort threw', err)
    return false
  }
}

function markApprovalHandled(output: ToolAfterOutput, duplicate = false): void {
  const handled: ToolMetadata = { ...output.metadata, forgePlanApprovalHandled: true }
  output.metadata = duplicate ? { ...handled, forgePlanApprovalDuplicate: true } : handled
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

const LOOP_BLOCKED_TOOLS = new Map<string, string>([
  ['question', 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.'],
  ['execute-plan', 'The execute-plan tool is not available during a loop. Focus on executing the current plan.'],
])

interface ExecutePromptParams {
  sessionID: string
  directory: string
  agent: string
  parts: Array<{ type: 'text'; text: string }>
  model?: { providerID: string; modelID: string }
}

interface PendingExecution {
  directory: string
  executionModel?: { providerID: string; modelID: string }
  planText?: string
}

const pendingExecutions = new Map<string, PendingExecution>()
const processedApprovalCalls = new WeakMap<ToolContext, Set<string>>()
const claimedApprovalPlans = new Set<string>()

interface LoopToolBlockingDeps {
  resolveActiveLoopForSession?: (sessionID: string) => Promise<{ active?: boolean; loopName?: string; phase?: string } | null>
}

async function resolveBlockedLoopToolState(
  loop: ToolContext['loop'],
  sessionID: string,
  deps: LoopToolBlockingDeps,
): Promise<{ active?: boolean; loopName?: string; phase?: string } | null> {
  if (deps.resolveActiveLoopForSession) return deps.resolveActiveLoopForSession(sessionID)

  return loop.service.resolveActiveLoopForSession(sessionID)
}

function hashApprovalPlan(planText: string): string {
  let hash = 5381
  for (let i = 0; i < planText.length; i += 1) {
    hash = ((hash << 5) + hash) ^ planText.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function claimApprovalCall(ctx: ToolContext, input: { sessionID: string; callID?: string }, label: string, planKey: string): boolean {
  let processed = processedApprovalCalls.get(ctx)
  if (!processed) {
    processed = new Set<string>()
    processedApprovalCalls.set(ctx, processed)
  }
  const callKey = `${input.sessionID}:${input.callID ?? ''}:${label}`
  if (processed.has(callKey)) return false
  if (processed.size > 1000) processed.clear()
  processed.add(callKey)

  const planApprovalKey = `${ctx.projectId}:${ctx.directory}:${input.sessionID}:${planKey}`
  if (claimedApprovalPlans.has(planApprovalKey)) return false
  claimedApprovalPlans.add(planApprovalKey)
  return true
}

function resolveCurrentSessionPlan(ctx: ToolContext, sessionID: string): { content: string; key: string } | null {
  const plan = ctx.plansRepo.getForSession(ctx.projectId, sessionID)
  if (!plan) return null
  return {
    content: plan.content,
    key: hashApprovalPlan(plan.content),
  }
}

const questionAnswersSchema = z.array(z.array(z.string()))

const planApprovalQuestionArgsSchema = z.looseObject({
  questions: z.array(z.looseObject({
    options: z.array(z.looseObject({ label: z.string().optional() })).optional(),
  })).optional(),
})

function isPlanApprovalQuestionArgs(args: ToolArgs): boolean {
  const parsed = planApprovalQuestionArgsSchema.safeParse(args)
  if (!parsed.success) return false
  const options = parsed.data.questions?.[0]?.options
  if (!options) return false
  const labels = options.map((o) => (o.label ?? '').toLowerCase())
  return PLAN_EXECUTION_LABELS.every((l) => labels.includes(l.toLowerCase()))
}

export function createToolExecuteBeforeHook(ctx: ToolContext, deps: LoopToolBlockingDeps = {}): ToolBeforeHook {
  const loop = ctx.loop
  const { logger } = ctx

  return async (
    input: ToolBeforeInput,
    _output: ToolBeforeOutput
  ) => {
    const blockedMessage = LOOP_BLOCKED_TOOLS.get(input.tool)
    if (blockedMessage === undefined) return
    const state = await resolveBlockedLoopToolState(loop, input.sessionID, deps)
    if (!state?.active) return

    logger.log(`Loop: blocking ${input.tool} tool before execution in ${state.phase} phase for session ${input.sessionID}`)

    throw new Error(blockedMessage)
  }
}

export function createToolExecuteAfterHook(ctx: ToolContext, deps: LoopToolBlockingDeps = {}): ToolAfterHook {
  const loop = ctx.loop
  const { logger, config } = ctx

  return async (
    input: ToolAfterInput,
    output: ToolAfterOutput
  ) => {
    const blockedMessage = LOOP_BLOCKED_TOOLS.get(input.tool)
    let blockedState: { active?: boolean; loopName?: string; phase?: string } | null = null
    if (blockedMessage !== undefined) {
      blockedState = await resolveBlockedLoopToolState(loop, input.sessionID, deps)
    }
    if (blockedState?.active && blockedMessage !== undefined) {
      logger.log(`Loop: blocked ${input.tool} tool in ${blockedState.phase} phase for session ${input.sessionID}`)
      output.title = 'Tool blocked'
      output.output = blockedMessage
      return
    }

    if (input.tool === 'question' && isPlanApprovalQuestionArgs(input.args)) {
          const answers = questionAnswersSchema.safeParse(output.metadata.answers)
          const answer = (answers.success ? answers.data[0]?.[0]?.trim() : undefined) ?? output.output.trim()
          const answerLower = answer.toLowerCase()
          const matchedLabel = PLAN_EXECUTION_LABELS.find((l) =>
            answerLower === l.toLowerCase() || answerLower.startsWith(l.toLowerCase())
          )

          if (matchedLabel) {
            markApprovalHandled(output)
            logger.log(`Plan approval: question answer matched "${matchedLabel}" for call ${input.callID}`)
            logger.log(`Plan approval: answer value="${answer}" matched label="${matchedLabel}"`)
          }
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            const plan = resolveCurrentSessionPlan(ctx, input.sessionID)
            if (!plan) {
              publishPlanApprovalToast(ctx, input, 'error', 'Plan not found for execution')
              logger.error('Plan approval: plan not found for "Execute here"')
              await abortApprovalSourceSession(ctx, input.sessionID)
              logger.log('Plan approval: "Execute here" — abort completed (plan not found)')
              return
            }

            if (!claimApprovalCall(ctx, input, matchedLabel, plan.key)) {
              markApprovalHandled(output, true)
              logger.log(`Plan approval: duplicate "${matchedLabel}" call ignored for ${input.callID}`)
              logger.log(`Plan approval: duplicate "${matchedLabel}" — awaiting source session abort`)
              await abortApprovalSourceSession(ctx, input.sessionID)
              logger.log(`Plan approval: duplicate "${matchedLabel}" — abort completed`)
              return
            }
            
            pendingExecutions.set(input.sessionID, {
              directory: ctx.directory,
              executionModel: parseModelString(ctx.config.executionModel),
              planText: plan.content,
            })

            logger.log('Plan approval: "Execute here" — pending code agent switch set; awaiting source session abort')
            await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log('Plan approval: "Execute here" — abort completed')
            return
          }
          
          if (matchedLabel === 'Loop') {
            output.output = `${output.output}\n\n<system-reminder>\nThe user selected "Loop". Launch the loop now by calling the \`execute-plan\` tool with a short \`title\`. The implementation plan is already stored for this session, so you do not need to pass the plan text. Do not ask any further questions and do not call the question tool again — just call the \`execute-plan\` tool.\n</system-reminder>`
            logger.log('Plan approval: "Loop" selected — deferring to agent execute-plan tool call (auto-dispatch removed)')
            return
          }
          
          const plan = resolveCurrentSessionPlan(ctx, input.sessionID)
          if (!plan) {
            publishPlanApprovalToast(ctx, input, 'error', 'Plan not found for execution')
            logger.error('Plan approval: plan not found')
            await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log('Plan approval: plan not found — abort completed')
            return
          }
          const planText = plan.content
          const { title } = extractPlanExecutionMetadata(planText)

          if (matchedLabel && !claimApprovalCall(ctx, input, matchedLabel, plan.key)) {
            markApprovalHandled(output, true)
            logger.log(`Plan approval: duplicate "${matchedLabel}" call ignored for ${input.callID}`)
            logger.log(`Plan approval: duplicate "${matchedLabel}" — awaiting source session abort`)
            await abortApprovalSourceSession(ctx, input.sessionID)
            logger.log(`Plan approval: duplicate "${matchedLabel}" — abort completed`)
            return
          }
           
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
            client: ctx.client,
            plansRepo: ctx.plansRepo,
            loopsRepo: ctx.loopsRepo,
            loopHandler: ctx.loopHandler,
            loop,
            sandboxManager: ctx.sandboxManager,
            sectionPlansRepo: ctx.sectionPlansRepo,
            pendingTeardowns: ctx.pendingTeardowns,
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
                  abortSourceSession: false,
                  deleteSessionOnPromptFailure: false,
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
          
          output.output = `${output.output}\n\n<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, ask the question tool again with one of: "New session", "Execute here", or "Loop". If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>`
          logger.log(`Plan approval: detected custom answer`)
      return
    }

  }
}

const sessionStatusPropertiesSchema = z.looseObject({
  sessionID: z.string(),
  status: z.looseObject({ type: z.string().optional() }).optional(),
})

export function createPlanApprovalEventHook(ctx: ToolContext) {
  const { logger } = ctx

  return async (eventInput: { event: { type: string; properties?: ForgeEvent['properties'] } }) => {
    if (eventInput.event?.type !== 'session.status') return

    const properties = sessionStatusPropertiesSchema.safeParse(eventInput.event.properties)
    if (!properties.success) return
    if (properties.data.status?.type !== 'idle') return

    const sessionID = properties.data.sessionID

    const pending = pendingExecutions.get(sessionID)
    if (!pending) return

    pendingExecutions.delete(sessionID)

    const planRef = pending.planText
      ? `\n\nImplementation Plan:\n${pending.planText}`
      : '\n\nPlan reference: Execute the implementation plan from this conversation. Review all phases above and implement each one.'

    const executeHerePrompt = `The architect agent has created an implementation plan. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.${planRef}`

    const promptAsyncEnvelope = (params: ExecutePromptParams): Promise<{ error?: unknown }> =>
      ctx.client.session.promptAsync(params).then(
        () => ({}),
        (error) => ({ error }),
      )

    const promptParams: ExecutePromptParams = {
      sessionID,
      directory: pending.directory,
      agent: 'code',
      parts: [{ type: 'text', text: executeHerePrompt }],
    }

    try {
      logger.log(`createPlanApprovalEventHook: prompting session ${sessionID}`)
      const { result, usedModel } = await retryWithModelFallback(
        () => promptAsyncEnvelope(pending.executionModel ? { ...promptParams, model: pending.executionModel } : promptParams),
        () => promptAsyncEnvelope(promptParams),
        pending.executionModel,
        logger,
      )
      if (result.error) {
        logger.error('Plan approval: promptAsync returned error', result.error)
        return
      }
      const modelInfo = usedModel ? `${usedModel.providerID}/${usedModel.modelID}` : 'default'
      logger.log(`Plan approval: switched to code agent (model: ${modelInfo})`)
    } catch (err) {
      logger.error('createPlanApprovalEventHook: promptAsync threw', err)
    }
  }
}
