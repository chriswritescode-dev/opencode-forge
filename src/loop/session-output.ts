import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'

const RECENT_MESSAGES_COUNT = 5

export interface LoopSessionOutput {
  messages: { text: string; cost: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } }[]
  totalCost: number
  totalTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  fileChanges: { additions: number; deletions: number; files: number } | null
}

export async function fetchSessionOutput(
  v2Client: OpencodeClient,
  sessionId: string,
  directory: string,
  logger?: Logger,
): Promise<LoopSessionOutput | null> {
  if (!directory || !sessionId) {
    logger?.debug('fetchSessionOutput: invalid directory or sessionId')
    return null
  }

  try {
    const messagesResult = await v2Client.session.messages({
      sessionID: sessionId,
      directory,
    })

    const messages = (messagesResult.data ?? []) as {
      info: { role: string; cost?: number; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
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

    let totalCost = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalReasoningTokens = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0

    for (const msg of assistantMessages) {
      totalCost += msg.info.cost ?? 0
      const tokens = msg.info.tokens
      if (tokens) {
        totalInputTokens += tokens.input
        totalOutputTokens += tokens.output
        totalReasoningTokens += tokens.reasoning
        totalCacheRead += tokens.cache.read
        totalCacheWrite += tokens.cache.write
      }
    }

    const sessionResult = await v2Client.session.get({ sessionID: sessionId, directory })
    const session = sessionResult.data as { summary?: { additions: number; deletions: number; files: number } } | undefined
    const fileChanges = session?.summary
      ? {
          additions: session.summary.additions,
          deletions: session.summary.deletions,
          files: session.summary.files,
        }
      : null

    return {
      messages: extractedMessages,
      totalCost,
      totalTokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        reasoning: totalReasoningTokens,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
      },
      fileChanges,
    }
  } catch (err) {
    if (logger) {
      logger.error(`Loop: could not fetch session output for ${sessionId}`, err)
    }
    return null
  }
}
