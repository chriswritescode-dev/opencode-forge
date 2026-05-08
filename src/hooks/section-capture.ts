import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { Logger, DecomposerConfig } from '../types'
import { extractSections } from '../utils/section-capture'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

export function createSectionCaptureHook(deps: {
  loopsRepo: LoopsRepo
  sectionPlansRepo: SectionPlansRepo
  logger: Logger
  config: () => DecomposerConfig
  projectId: string
  v2Client?: OpencodeClient
}) {
  const textBuffers = new Map<string, string>()
  const persistedCounts = new Map<string, number>()
  const lastEventCounts = new Map<string, number>()

  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }) => {
    if (eventInput.event?.type === 'message.part.updated') {
      const sessionID = eventInput.event.properties?.sessionID as string | undefined
      const part = eventInput.event.properties?.part as { type?: string; text?: string; messageID?: string } | undefined
      if (!sessionID || part?.type !== 'text' || !part.text) return

      const loop = deps.loopsRepo.getBySessionId(deps.projectId, sessionID)
      if (!loop) return
      if (loop.decompositionSessionId !== sessionID || loop.decompositionStatus !== 'running') return

      textBuffers.set(sessionID, part.text)

      const cfg = deps.config()
      const sections = extractSections(part.text, { maxSections: cfg.maxSections })
      const prevPersisted = persistedCounts.get(sessionID) ?? 0
      const prevLastEvent = lastEventCounts.get(sessionID) ?? 0

      if (sections.length > prevLastEvent) {
        lastEventCounts.set(sessionID, sections.length)
      } else if (sections.length > prevPersisted && sections.length === prevLastEvent) {
        deps.sectionPlansRepo.bulkInsert({
          projectId: deps.projectId,
          loopName: loop.loopName,
          sections,
        })
        persistedCounts.set(sessionID, sections.length)
        deps.logger.log(`section-capture: captured ${sections.length} stable sections for session ${sessionID}`)
      }
    }

    if (eventInput.event?.type === 'session.status') {
      const status = eventInput.event.properties?.status as { type?: string } | undefined
      if (status?.type !== 'idle') return

      const sessionID = eventInput.event.properties?.sessionID as string | undefined
      if (!sessionID) return

      const loop = deps.loopsRepo.getBySessionId(deps.projectId, sessionID)
      if (!loop) return
      if (loop.decompositionSessionId !== sessionID || loop.decompositionStatus !== 'running') return

      let text = textBuffers.get(sessionID) ?? ''

      // Always attempt to fetch the complete final assistant transcript at idle.
      // The streamed buffer may be stale/truncated; the session's final transcript
      // contains the full output including any complete markers.
      if (deps.v2Client) {
        try {
          const messagesResult = await deps.v2Client.session.messages({
            sessionID,
            directory: loop.worktreeDir || '',
            limit: 4,
          })
          const messages = (messagesResult.data ?? []) as Array<{
            info: { role: string; finish?: string }
            parts: Array<{ type: string; text?: string }>
          }>
          const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant' && (!m.info.finish || m.info.finish === 'stop'))
          if (lastAssistant) {
            const fetchedText = lastAssistant.parts
              .filter(p => p.type === 'text' && typeof p.text === 'string')
              .map(p => p.text as string)
              .join('\n')
            if (fetchedText.length > text.length) {
              text = fetchedText
              deps.logger.log(`section-capture: fetched ${text.length} chars of assistant text at idle for session ${sessionID}`)
            }
          }
        } catch (err) {
          deps.logger.error(`section-capture: failed to fetch assistant messages at idle for session ${sessionID}`, err)
        }
      }

      const cfg = deps.config()
      const finalSections = extractSections(text, { maxSections: cfg.maxSections })
      const prevPersisted = persistedCounts.get(sessionID) ?? 0

      if (finalSections.length > prevPersisted) {
        deps.sectionPlansRepo.bulkInsert({
          projectId: deps.projectId,
          loopName: loop.loopName,
          sections: finalSections,
        })
        persistedCounts.set(sessionID, finalSections.length)
      } else if (finalSections.length > 0) {
        deps.sectionPlansRepo.updateContent(deps.projectId, loop.loopName, finalSections)
      }

      const count = Math.max(persistedCounts.get(sessionID) ?? 0, finalSections.length)

      if (count > 0) {
        deps.loopsRepo.setDecompositionStatus(deps.projectId, loop.loopName, 'completed')
        deps.loopsRepo.setTotalSections(deps.projectId, loop.loopName, count)
        deps.logger.log(`section-capture: decomposition completed with ${count} sections for loop ${loop.loopName}`)
      } else {
        deps.loopsRepo.setDecompositionStatus(deps.projectId, loop.loopName, 'failed')
        deps.logger.log(`section-capture: no sections found for loop ${loop.loopName}, marking failed`)
      }

      textBuffers.delete(sessionID)
      persistedCounts.delete(sessionID)
      lastEventCounts.delete(sessionID)
    }
  }
}
