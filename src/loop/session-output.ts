import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import { summarizeAssistantUsage, type LoopUsageSummary, type UsageAttribution } from './token-usage'

const RECENT_MESSAGES_COUNT = 5

export interface LoopSessionOutput {
  messages: { text: string; cost: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } }[]
  totalCost: number
  totalTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  fileChanges: { additions: number; deletions: number; files: number } | null
  usageSummary?: LoopUsageSummary
}

export interface FetchSessionOutputOptions {
  fallbackModel?: string
  role?: 'code' | 'auditor' | 'unknown'
}

export async function fetchSessionOutput(
  client: ForgeClient,
  sessionId: string,
  directory: string,
  logger?: Logger,
  options?: FetchSessionOutputOptions,
): Promise<LoopSessionOutput | null> {
  if (!directory || !sessionId) {
    logger?.debug('fetchSessionOutput: invalid directory or sessionId')
    return null
  }

  try {
    const messages = (await client.session.messages({
      sessionID: sessionId,
      directory,
    })) as unknown as {
      info: {
        role: string
        cost?: number
        tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
        model?: string
        modelID?: string
        modelId?: string
        provider?: string
        providerID?: string
        model_name?: string
      }
      parts: { type: string; text?: string }[]
    }[]

    const assistantMessages = messages.filter((m) => m.info.role === 'assistant')
    const lastThree = assistantMessages.slice(-RECENT_MESSAGES_COUNT)

    const extractedMessages = lastThree.map((msg) => {
      const text = msg.parts
        .filter((p) => p.type === 'text' && p.text !== undefined)
        .map((p) => p.text!)
        .join('\n')
      const cost = msg.info.cost ?? 0
      const tokens = msg.info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      return {
        text,
        cost,
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cacheRead: tokens.cache.read,
          cacheWrite: tokens.cache.write,
        },
      }
    })

    // Use shared token usage extraction for aggregate totals
    const attribution: UsageAttribution | undefined = options
      ? { role: options.role ?? 'unknown', fallbackModel: options.fallbackModel }
      : undefined
    const usageSummary = summarizeAssistantUsage(messages, attribution)

    const session = await client.session.get({ sessionID: sessionId, directory }) as unknown as { summary?: { additions: number; deletions: number; files: number } } | undefined
    const fileChanges = session?.summary
      ? {
          additions: session.summary.additions,
          deletions: session.summary.deletions,
          files: session.summary.files,
        }
      : null

    return {
      messages: extractedMessages,
      totalCost: usageSummary.totalCost,
      totalTokens: {
        input: usageSummary.totalTokens.input,
        output: usageSummary.totalTokens.output,
        reasoning: usageSummary.totalTokens.reasoning,
        cacheRead: usageSummary.totalTokens.cacheRead,
        cacheWrite: usageSummary.totalTokens.cacheWrite,
      },
      fileChanges,
      usageSummary,
    }
  } catch (err) {
    if (logger) {
      logger.error(`Loop: could not fetch session output for ${sessionId}`, err)
    }
    return null
  }
}
