import type { FeatureGroupsRepo } from '../storage/repos/feature-groups-repo'
import type { GroupOrchestrator } from '../services/group-orchestrator'
import type { Logger } from '../types'

export interface GroupOrchestratorEventHookDeps {
  orchestrator: GroupOrchestrator
  repo: FeatureGroupsRepo
  projectId: string
  logger: Logger
}

/**
 * Event hook that translates `session.status` events into orchestrator calls.
 *
 * **Busy‑seen guard**: a session must first go `busy` before its subsequent
 * `idle` is acted upon. This defeats the premature‑idle race where an idle
 * event arrives before the session has even started processing — the same
 * pattern the loop runtime uses via the idle‑gate.
 */
export function createGroupOrchestratorEventHook(deps: GroupOrchestratorEventHookDeps) {
  const { orchestrator, repo, projectId, logger } = deps

  /** Sessions that have been observed in the `busy` state. */
  const busySeen = new Set<string>()

  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> => {
    const event = eventInput.event
    if (!event || event.type !== 'session.status') return

    const status = event.properties?.status as { type?: string } | undefined
    const sessionId = event.properties?.sessionID as string | undefined
    if (!sessionId || !status?.type) return

    if (status.type === 'busy') {
      busySeen.add(sessionId)
      return
    }

    if (status.type !== 'idle') return

    // Ignore idle for sessions never seen busy (premature-idle guard).
    if (!busySeen.has(sessionId)) return
    busySeen.delete(sessionId)

    try {
      // Determine ownership: splitter session or architect session.
      if (repo.getGroupBySplitterSession(projectId, sessionId)) {
        await orchestrator.onSplitterIdle(sessionId)
      } else if (repo.getFeatureByArchitectSession(projectId, sessionId)) {
        await orchestrator.onArchitectIdle(sessionId)
      }
    } catch (err) {
      logger.error(`group-orchestrator-hook: error handling idle for session ${sessionId}:`, err as Error)
    }
  }
}
