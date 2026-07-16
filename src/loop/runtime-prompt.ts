import type { ForgeClient } from '../client/port'
import type { Logger, PluginConfig } from '../types'
import type { LoopService } from './service'
import { sendLoopPrompt } from './send-loop-prompt'
import { resolveLoopModel } from '../utils/loop-helpers'
import { markPromptSent } from './idle-gate'
import { promptAuditSession } from '../utils/audit-session'

export interface PromptDispatchDeps {
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  loopService: LoopService
}

export interface SendPromptInput {
  loopName: string
  sessionId: string
  promptText: string
  agent: 'code' | 'auditor-loop'
  model?: { providerID: string; modelID: string } | null
  /** Model used for the fallback attempt when the primary model fails. Defaults to the
   *  session/default model. */
  fallbackModel?: { providerID: string; modelID: string } | null
  variant?: string
}

export interface PromptDispatch {
  sendPromptWithFallback(input: SendPromptInput): Promise<{ error?: unknown; usedModel?: { providerID: string; modelID: string } | undefined }>

  getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ text: string | null; error: string | null; errorSignal: { name?: string; message?: string; statusCode?: number } | null; lastMessageRole: string }>

  getAssistantTranscript(sessionId: string, worktreeDir: string): Promise<string | null>
}

export function createPromptDispatch(deps: PromptDispatchDeps): PromptDispatch {
  const { client, logger, getConfig, loopService } = deps

  async function sendPromptWithFallback(input: SendPromptInput): Promise<{ error?: unknown; usedModel?: { providerID: string; modelID: string } | undefined }> {
    const { loopName, sessionId, promptText, agent } = input

    if (agent === 'auditor-loop') {
      const auditorModel = input.model != null ? input.model : undefined
      const { result, usedModel } = await sendLoopPrompt({
        loopName, sessionId, agent: 'auditor-loop', logger,
        primaryModel: auditorModel,
        performPrompt: async (model) => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) throw new Error('loop_cancelled')
          markPromptSent(loopName, sessionId, logger)
          const r = await promptAuditSession(client, {
            sessionId,
            worktreeDir: freshState.worktreeDir,
            workspaceId: freshState.workspaceId,
            prompt: promptText,
            ...(model ? { auditorModel: model, ...(input.variant ? { auditorVariant: input.variant } : {}) } : {}),
          })
          return r.ok ? {} : { error: r.error }
        },
      })
      return { error: result.error, usedModel }
    }

    const effectiveModel = input.model != null ? input.model : resolveLoopModel(getConfig(), loopService, loopName)
    const { result, usedModel } = await sendLoopPrompt({
      loopName, sessionId, agent: 'code', logger,
      primaryModel: effectiveModel,
      fallbackModel: input.fallbackModel,
      performPrompt: async (model) => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        markPromptSent(loopName, sessionId, logger)
        try {
          await client.session.promptAsync({
            sessionID: sessionId,
            directory: freshState.worktreeDir,
            ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
            agent: 'code',
            parts: [{ type: 'text' as const, text: promptText }],
            ...(model ? { model, ...(input.variant ? { variant: input.variant } : {}) } : {}),
          })
          return {}
        } catch (err) {
          return { error: err }
        }
      },
    })
    return { error: result.error, usedModel }
  }

  async function getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ text: string | null; error: string | null; errorSignal: { name?: string; message?: string; statusCode?: number } | null; lastMessageRole: string }> {
    try {
      const messages = await client.session.messages({
        sessionID: sessionId,
        directory: worktreeDir,
        limit: 4,
      }) as Array<{
        info: { role: string; finish?: string; error?: { name?: string; data?: { message?: string; statusCode?: number } } }
        parts: Array<{ type: string; text?: string }>
      }>

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null

      if (!lastMessage) {
        return { text: null, error: null, errorSignal: null, lastMessageRole: 'none' }
      }

      if (lastMessage.info.role !== 'assistant') {
        logger.log(`Loop: no assistant message found in session ${sessionId}, last message role: ${lastMessage.info.role ?? 'unknown'}`)
        return { text: null, error: null, errorSignal: null, lastMessageRole: lastMessage.info.role ?? 'unknown' }
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
        return { text: null, error, errorSignal, lastMessageRole: `assistant:${lastAssistant.info.finish}` }
      }

      const text = lastAssistant.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n') || null

      return { text, error, errorSignal, lastMessageRole: 'assistant' }
    } catch (err) {
      logger.error(`Loop: could not read session messages`, err)
      return { text: null, error: null, errorSignal: null, lastMessageRole: 'error' }
    }
  }

  /**
   * Join the text of every assistant message in a session into a single markdown
   * transcript. Used to preserve the full post-action (e.g. pr-review) output
   * before the session is deleted on loop termination.
   */
  async function getAssistantTranscript(sessionId: string, worktreeDir: string): Promise<string | null> {
    try {
      const messages = await client.session.messages({
        sessionID: sessionId,
        directory: worktreeDir,
      }) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string }>
      }>

      const texts = messages
        .filter((m) => m.info.role === 'assistant')
        .map((m) => m.parts
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('\n'))
        .filter((t) => t.trim() !== '')

      return texts.length > 0 ? texts.join('\n\n---\n\n') : null
    } catch (err) {
      logger.error(`Loop: could not read session transcript for ${sessionId}`, err)
      return null
    }
  }

  return {
    sendPromptWithFallback,
    getLastAssistantInfo,
    getAssistantTranscript,
  }
}
