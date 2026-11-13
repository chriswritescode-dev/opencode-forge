import { z } from 'zod'
import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import { normalizeTokens, summarizeAssistantUsage, type LoopUsageSummary, type UsageAttribution } from './token-usage'

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

const sessionSummarySchema = z.looseObject({
  summary: z.looseObject({
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
  }).optional(),
})

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
    const messages = await client.session.messages({
      sessionID: sessionId,
      directory,
    })

    const assistantMessages = messages.filter((m) => m.info.role === 'assistant')
    const lastThree = assistantMessages.slice(-RECENT_MESSAGES_COUNT)

    const extractedMessages = lastThree.map((msg) => {
      const text = msg.parts
        .flatMap((p) => (p.type === 'text' && p.text !== undefined ? [p.text] : []))
        .join('\n')
      const cost = msg.info.cost ?? 0
      return {
        text,
        cost,
        tokens: normalizeTokens(msg.info.tokens),
      }
    })

    const attribution: UsageAttribution | undefined = options
      ? { role: options.role ?? 'unknown', fallbackModel: options.fallbackModel }
      : undefined
    const usageSummary = summarizeAssistantUsage(messages, attribution)

    const session = await client.session.get({ sessionID: sessionId, directory })
    const parsedSummary = sessionSummarySchema.safeParse(session)
    const summary = parsedSummary.success ? parsedSummary.data.summary : undefined
    const fileChanges = summary
      ? {
          additions: summary.additions,
          deletions: summary.deletions,
          files: summary.files,
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
