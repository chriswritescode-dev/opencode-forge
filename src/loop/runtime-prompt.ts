import type { ForgeClient, SessionPromptAsyncParams } from '../client/port'
import type { Logger, PluginConfig } from '../types'
import type { LoopService } from './service'
import { sendLoopPrompt } from './send-loop-prompt'
import { resolveLoopModel } from '../utils/loop-helpers'
import { markPromptSent } from './idle-gate'
import { promptAuditSession } from '../utils/audit-session'

interface AuditPromptInput {
  sessionId: string
  worktreeDir: string
  workspaceId?: string
  prompt: string
  auditorModel?: { providerID: string; modelID: string }
  auditorVariant?: string
}

export interface PromptDispatchDeps {
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  loopService: LoopService
  projectId: string
}

export interface SendPromptInput {
  loopName: string
  sessionId: string
  promptText: string
  agent: 'code' | 'auditor-loop'
  model?: { providerID: string; modelID: string } | null
  fallbackModel?: { providerID: string; modelID: string } | null
  variant?: string
  fallbackVariant?: string
}

export interface PromptDispatch {
  sendPromptWithFallback(input: SendPromptInput): Promise<{ error?: unknown; usedModel?: { providerID: string; modelID: string } | undefined }>

  getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ error: string | null; errorSignal: { name?: string; message?: string; statusCode?: number } | null; lastMessageRole: string }>
}

export function createPromptDispatch(deps: PromptDispatchDeps): PromptDispatch {
  const { client, logger, getConfig, loopService, projectId } = deps

  async function sendPromptWithFallback(input: SendPromptInput): Promise<{ error?: unknown; usedModel?: { providerID: string; modelID: string } | undefined }> {
    const { loopName, sessionId, promptText, agent } = input

    if (agent === 'auditor-loop') {
      const auditorModel = input.model != null ? input.model : undefined
      const { result, usedModel } = await sendLoopPrompt({
        projectId, loopName, sessionId, agent: 'auditor-loop', logger,
        primaryModel: auditorModel,
        performPrompt: async (model) => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) throw new Error('loop_cancelled')
          markPromptSent(projectId, loopName, sessionId, logger)
          const auditParams: AuditPromptInput = {
            sessionId,
            worktreeDir: freshState.worktreeDir,
            workspaceId: freshState.workspaceId,
            prompt: promptText,
          }
          if (model) {
            auditParams.auditorModel = model
            if (input.variant) auditParams.auditorVariant = input.variant
          }
          const r = await promptAuditSession(client, auditParams)
          return r.ok ? {} : { error: r.error }
        },
      })
      return { error: result.error, usedModel }
    }

    const effectiveModel = input.model != null ? input.model : resolveLoopModel(getConfig(), loopService, loopName)
    const { result, usedModel } = await sendLoopPrompt({
      projectId, loopName, sessionId, agent: 'code', logger,
      primaryModel: effectiveModel,
      fallbackModel: input.fallbackModel,
      performPrompt: async (model) => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        markPromptSent(projectId, loopName, sessionId, logger)
        const isFallbackAttempt = input.fallbackModel != null && model === input.fallbackModel
        const variant = isFallbackAttempt ? input.fallbackVariant : input.variant
        try {
          const promptParams: SessionPromptAsyncParams = {
            sessionID: sessionId,
            directory: freshState.worktreeDir,
            agent: 'code',
            parts: [{ type: 'text', text: promptText }],
          }
          if (freshState.workspaceId) promptParams.workspace = freshState.workspaceId
          if (model) {
            promptParams.model = model
            if (variant) promptParams.variant = variant
          }
          await client.session.promptAsync(promptParams)
          return {}
        } catch (err) {
          return { error: err }
        }
      },
    })
    return { error: result.error, usedModel }
  }

  async function getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ error: string | null; errorSignal: { name?: string; message?: string; statusCode?: number } | null; lastMessageRole: string }> {
    try {
      const messages = await client.session.messages({
        sessionID: sessionId,
        directory: worktreeDir,
        limit: 4,
      })

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null

      if (!lastMessage) {
        return { error: null, errorSignal: null, lastMessageRole: 'none' }
      }

      if (lastMessage.info.role !== 'assistant') {
        logger.log(`Loop: no assistant message found in session ${sessionId}, last message role: ${lastMessage.info.role ?? 'unknown'}`)
        return { error: null, errorSignal: null, lastMessageRole: lastMessage.info.role ?? 'unknown' }
      }

      const lastAssistant = lastMessage
      const error = lastAssistant.info.error?.data?.message ?? lastAssistant.info.error?.name ?? null
      const errorSignal = lastAssistant.info.error
        ? {
            name: lastAssistant.info.error.name,
            message: lastAssistant.info.error.data?.message,
            statusCode: lastAssistant.info.error.data?.statusCode,
          }
        : null

      if (lastAssistant.info.finish && lastAssistant.info.finish !== 'stop') {
        logger.log(`Loop: assistant message in session ${sessionId} is not final yet (finish=${lastAssistant.info.finish})`)
        return { error, errorSignal, lastMessageRole: `assistant:${lastAssistant.info.finish}` }
      }

      return { error, errorSignal, lastMessageRole: 'assistant' }
    } catch (err) {
      logger.error(`Loop: could not read session messages`, err)
      return { error: null, errorSignal: null, lastMessageRole: 'error' }
    }
  }

  return {
    sendPromptWithFallback,
    getLastAssistantInfo,
  }
}
