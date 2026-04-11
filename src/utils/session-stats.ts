import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

export interface SessionStats {
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  messages: {
    total: number
    assistant: number
  }
  fileChanges: {
    additions: number
    deletions: number
    files: number
  } | null
  timing: {
    created: string
    updated: string
    durationMs: number
  } | null
  lastActivity: {
    summary: string
    toolCalls: Array<{ tool: string; title: string; status: string }>
  } | null
}

type PartAny = {
  type: string
  text?: string
  tool?: string
  description?: string
  agent?: string
  state?: {
    status: string
    title?: string
    output?: string
    error?: string
    input?: Record<string, unknown>
  }
  error?: { message?: string; name?: string }
}

function extractActivity(
  parts: PartAny[],
): { summary: string; toolCalls: Array<{ tool: string; title: string; status: string }> } | null {
  const toolCalls: Array<{ tool: string; title: string; status: string }> = []
  const textLines: string[] = []
  const toolLines: string[] = []
  const subtaskLines: string[] = []
  const reasoningLines: string[] = []

  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      textLines.push(p.text.trim())
    } else if (p.type === 'tool' && p.tool && p.state) {
      const s = p.state
      const name = p.tool
      const status = s.status
      if (status === 'completed') {
        const title = s.title ?? name
        toolCalls.push({ tool: name, title, status: 'completed' })
        toolLines.push(`[done] ${name}: ${title}`)
      } else if (status === 'running') {
        const title = s.title ?? name
        toolCalls.push({ tool: name, title, status: 'running' })
        toolLines.push(`[running] ${name}: ${title}`)
      } else if (status === 'error') {
        const msg = s.error ?? 'error'
        toolCalls.push({ tool: name, title: msg, status: 'error' })
        toolLines.push(`[error] ${name}: ${msg}`)
      } else if (status === 'pending') {
        toolCalls.push({ tool: name, title: name, status: 'pending' })
        toolLines.push(`[pending] ${name}`)
      }
    } else if (p.type === 'subtask' && p.description) {
      const agentLabel = p.agent ? `${p.agent}: ` : ''
      subtaskLines.push(`-> ${agentLabel}${p.description}`)
    } else if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) {
      reasoningLines.push(p.text.trim())
    }
  }

  // Priority: text > tool titles > subtask > reasoning
  let summary = ''
  if (textLines.length > 0) {
    summary = textLines.join('\n')
  } else if (toolLines.length > 0) {
    summary = toolLines.join('\n')
  } else if (subtaskLines.length > 0) {
    summary = subtaskLines.join('\n')
  } else if (reasoningLines.length > 0) {
    summary = reasoningLines.join('\n')
  }

  if (!summary && toolCalls.length === 0) return null
  return { summary, toolCalls }
}

export async function fetchSessionStats(
  api: TuiPluginApi,
  sessionId: string,
  directory: string,
): Promise<SessionStats | null> {
  if (!directory || !sessionId) {
    return null
  }

  try {
    const messagesResult = await api.client.session.messages({
      sessionID: sessionId,
      directory,
    })

    const messages = (messagesResult.data ?? []) as Array<{
      info: {
        role: string
        cost?: number
        tokens?: {
          input: number
          output: number
          reasoning: number
          cache: { read: number; write: number }
        }
      }
      parts: PartAny[]
    }>

    const assistantMessages = messages.filter((m) => m.info.role === 'assistant')

    // Walk backwards through the last 3 assistant messages to find meaningful activity
    let lastActivity: { summary: string; toolCalls: Array<{ tool: string; title: string; status: string }> } | null = null
    for (let i = assistantMessages.length - 1; i >= Math.max(0, assistantMessages.length - 3); i--) {
      const result = extractActivity(assistantMessages[i].parts)
      if (result) {
        lastActivity = result
        break
      }
    }

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalReasoningTokens = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    let totalCost = 0

    for (const msg of messages) {
      totalCost += msg.info.cost ?? 0
      const tokens = msg.info.tokens
      if (tokens) {
        totalInputTokens += tokens.input ?? 0
        totalOutputTokens += tokens.output ?? 0
        totalReasoningTokens += tokens.reasoning ?? 0
        totalCacheRead += tokens.cache?.read ?? 0
        totalCacheWrite += tokens.cache?.write ?? 0
      }
    }

    const sessionResult = await api.client.session.get({
      sessionID: sessionId,
      directory,
    })
    const session = sessionResult.data as
      | {
          summary?: { additions: number; deletions: number; files: number }
          time?: { created: string; updated: string }
        }
      | undefined

    const fileChanges = session?.summary
      ? {
          additions: session.summary.additions,
          deletions: session.summary.deletions,
          files: session.summary.files,
        }
      : null

    const timing = session?.time?.created && session?.time?.updated
      ? {
          created: session.time.created,
          updated: session.time.updated,
          durationMs:
            new Date(session.time.updated).getTime() -
            new Date(session.time.created).getTime(),
        }
      : null

    return {
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        reasoning: totalReasoningTokens,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total:
          totalInputTokens +
          totalOutputTokens +
          totalReasoningTokens +
          totalCacheRead +
          totalCacheWrite,
      },
      cost: totalCost,
      messages: {
        total: messages.length,
        assistant: assistantMessages.length,
      },
      fileChanges,
      timing,
      lastActivity,
    }
  } catch {
    return null
  }
}
