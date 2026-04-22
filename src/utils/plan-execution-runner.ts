/**
 * Shared plan execution logic used by both the plan-execute tool and API handlers.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import { parseModelString, retryWithModelFallback } from './model-fallback'

export interface PlanExecutionParams {
  planText: string
  title: string
  directory: string
  projectId: string
  sessionId: string
  executionModel?: string
  v2: OpencodeClient
  logger: Logger
  mode: 'new-session' | 'execute-here'
  targetSessionId?: string // required for execute-here
}

export interface PlanExecutionResult {
  sessionId: string
  modelUsed: string | null
  mode: 'new-session' | 'execute-here'
}

export async function runPlanExecution(
  params: PlanExecutionParams
): Promise<PlanExecutionResult> {
  const {
    planText,
    title,
    directory,
    executionModel,
    v2,
    logger,
    mode,
    targetSessionId,
  } = params

  const sessionTitle = title.length > 60 ? `${title.substring(0, 57)}...` : title
  const parsedModel = parseModelString(executionModel)

  if (mode === 'execute-here') {
    if (!targetSessionId) {
      throw new Error('execute-here mode requires targetSessionId')
    }

    const inPlacePrompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${planText}`

    const { result: promptResult, usedModel: actualModel } =
      await retryWithModelFallback(
        () =>
          v2.session.promptAsync({
            sessionID: targetSessionId,
            directory,
            agent: 'code',
            parts: [{ type: 'text' as const, text: inPlacePrompt }],
            ...(parsedModel ? { model: parsedModel } : {}),
          }),
        () =>
          v2.session.promptAsync({
            sessionID: targetSessionId,
            directory,
            agent: 'code',
            parts: [{ type: 'text' as const, text: inPlacePrompt }],
          }),
        parsedModel,
        logger
      )

    if (promptResult.error) {
      logger.error(`plan-execute: in-place execution failed`, promptResult.error)
      throw new Error(
        `Failed to execute in-place: ${JSON.stringify(promptResult.error)}`
      )
    }

    const modelInfo = actualModel
      ? `${actualModel.providerID}/${actualModel.modelID}`
      : null

    return {
      sessionId: targetSessionId,
      modelUsed: modelInfo,
      mode: 'execute-here',
    }
  }

  // new-session mode
  const createResult = await v2.session.create({
    title: sessionTitle,
    directory,
  })

  if (createResult.error || !createResult.data) {
    logger.error(`plan-execute: failed to create session`, createResult.error)
    throw new Error('Failed to create new session')
  }

  const newSessionId = createResult.data.id
  logger.log(`plan-execute: created session=${newSessionId}`)

  const { result: promptResult, usedModel: actualModel } =
    await retryWithModelFallback(
      () =>
        v2.session.promptAsync({
          sessionID: newSessionId,
          directory,
          parts: [{ type: 'text' as const, text: planText }],
          agent: 'code',
          model: parsedModel!,
        }),
      () =>
        v2.session.promptAsync({
          sessionID: newSessionId,
          directory,
          parts: [{ type: 'text' as const, text: planText }],
          agent: 'code',
        }),
      parsedModel,
      logger
    )

  if (promptResult.error) {
    logger.error(`plan-execute: failed to prompt session`, promptResult.error)
    throw new Error(
      `Session created (${newSessionId}) but failed to send plan`
    )
  }

  logger.log(`plan-execute: prompted session=${newSessionId}`)

  const modelInfo = actualModel
    ? `${actualModel.providerID}/${actualModel.modelID}`
    : null

  return {
    sessionId: newSessionId,
    modelUsed: modelInfo,
    mode: 'new-session',
  }
}
