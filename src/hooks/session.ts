import type { Logger, CompactionConfig } from '../types'
import type { PluginInput } from '@opencode-ai/plugin'

export interface SessionHooks {
  onMessage: (input: unknown, output: unknown) => Promise<void>
  onEvent: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
  onCompacting: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string }
  ) => Promise<void>
}

interface ChatMessageInput {
  sessionID?: string
}

interface EventInput {
  event: {
    type: string
    properties?: Record<string, unknown>
  }
}

interface CompactingInput {
  sessionID: string
}

interface CompactingOutput {
  context: string[]
  prompt?: string
}

const LOGGED_EVENTS = new Set(['session.compacted', 'session.status', 'session.updated', 'session.created'])

function formatEventProperties(props?: Record<string, unknown>): string {
  if (!props) return ''
  try {
    return ' ' + JSON.stringify(props)
  } catch {
    return ''
  }
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  customPrompt: true,
  maxContextTokens: 4000,
}

const COMPACTION_PROMPT: string = `You are generating a continuation context for a coding session. Your summary will be the ONLY context after compaction.
Preserve everything needed for seamless continuation.

## CRITICAL - Preserve These Verbatim
1. The current task/objective (quote the user's original request exactly)
2. ALL file paths being actively worked on (with what's being done)
3. Key decisions made and their rationale
4. Any corrections or gotchas discovered during the session
5. Todo list state (what's done, in progress, pending)

## Structure Your Summary As:

### Active Task
[Verbatim objective + what was happening when compaction fired]

### Key Context
[Decisions, constraints, user preferences, corrections]

### Active Files
[filepath -> what's being done to it]

### Next Steps
[What should happen immediately after compaction]

## Rules
- Use specific file paths.
- State what tools returned, not just that they were called
- Prefer completeness over brevity - this is the agent's entire working memory`

export function createSessionHooks(
  projectId: string,
  logger: Logger,
  _ctx: PluginInput,
  config?: CompactionConfig
): SessionHooks {
  const initializedSessions = new Set<string>()
  const compactionConfig = { ...DEFAULT_COMPACTION_CONFIG, ...config }

  return {
    async onMessage(input, _output) {
      const chatInput = input as ChatMessageInput
      const sessionId = chatInput.sessionID
      if (!sessionId) return
      if (!initializedSessions.has(sessionId)) {
        logger.log(`Session initialized: ${sessionId} (project ${projectId})`)
        initializedSessions.add(sessionId)
      }
    },
    async onEvent(input: EventInput) {
      const { event } = input
      if (event && LOGGED_EVENTS.has(event.type)) {
        logger.log(`Event received: ${event.type}${formatEventProperties(event.properties)}`)
      }
      if (event?.type !== 'session.compacted') return

      const sessionId = (event.properties?.sessionId as string) ??
                        (event.properties?.sessionID as string)
      if (!sessionId) {
        logger.log(`session.compacted event missing sessionId`)
        return
      }

      logger.log(`Session compacted for project ${projectId}`)
    },
    async onCompacting(input: CompactingInput, output: CompactingOutput) {
      const { sessionID: sessionId } = input
      logger.log(`Compacting hook fired for project ${projectId}, session ${sessionId}`)

      if (compactionConfig.customPrompt) {
        output.prompt = COMPACTION_PROMPT
        logger.log(`Compacting: set custom compaction prompt`)
      }
    },
  }
}
