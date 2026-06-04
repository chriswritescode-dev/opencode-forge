import type { Logger } from '../types'
import { extractInterjectionText } from '../loop/interjections'

export interface InterjectionCaptureDeps {
  recordUserMessage: (sessionId: string, text: string) => boolean
  logger: Logger
}

export function createInterjectionCaptureHook(deps: InterjectionCaptureDeps) {
  return async (
    input: { sessionID?: string },
    output: { parts?: Array<{ type: string; text?: string }> },
  ): Promise<void> => {
    try {
      const sessionId = input?.sessionID
      if (!sessionId) return
      const text = extractInterjectionText(output?.parts ?? [])
      if (!text) return
      if (deps.recordUserMessage(sessionId, text)) {
        deps.logger.log(`Loop: user interjection captured session=${sessionId}`)
      }
    } catch (err) {
      deps.logger.error('Loop: interjection capture failed', err)
    }
  }
}
