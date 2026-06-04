import type { ToolContext } from '../tools/types'
import type { Logger } from '../types'
import type { PluginInput } from '@opencode-ai/plugin'

export interface PromptAgentDeps {
  /** Legacy in-process client, tried first when present. */
  legacyClient?: PluginInput['client']
  /** OpenCode v2 client used as the fallback transport. */
  v2: ToolContext['v2']
  logger: Logger
  directory: string
}

export interface PromptAgentArgs {
  sessionID: string
  agent: string
  prompt: string
}

/**
 * Sends a prompt to an agent within an existing session, trying the legacy
 * in-process client first (when available) and falling back to the v2 client.
 * Each transport's success/error is logged. Resolves once a transport either
 * succeeds or both have been exhausted; failures are swallowed (logged only).
 */
export async function promptAgentViaClientThenV2(
  deps: PromptAgentDeps,
  args: PromptAgentArgs,
): Promise<void> {
  const { legacyClient, v2, logger, directory } = deps
  const { sessionID, agent, prompt } = args
  const parts = [{ type: 'text' as const, text: prompt }]

  if (legacyClient) {
    try {
      logger.log(`prompt-agent: prompting ${agent} via legacy client for ${sessionID}`)
      const legacyResult = await legacyClient.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: { agent, parts },
      } as Parameters<typeof legacyClient.session.promptAsync>[0]) as unknown as { data?: unknown; error?: unknown }
      if (!legacyResult?.error) {
        logger.log(`prompt-agent: ${agent} prompted via legacy client for ${sessionID}`)
        return
      }
      logger.error('prompt-agent: legacy promptAsync returned error', legacyResult.error)
    } catch (err) {
      logger.error('prompt-agent: legacy promptAsync threw', err)
    }
  }

  try {
    logger.log(`prompt-agent: falling back to v2 promptAsync for ${sessionID}`)
    const v2Result = await v2.session.promptAsync({ sessionID, directory, agent, parts })
    if ((v2Result as { error?: unknown })?.error) {
      logger.error('prompt-agent: v2 promptAsync returned error', (v2Result as { error?: unknown }).error)
      return
    }
    logger.log(`prompt-agent: ${agent} prompted via v2 for ${sessionID}`)
  } catch (err) {
    logger.error('prompt-agent: v2 promptAsync threw', err)
  }
}
