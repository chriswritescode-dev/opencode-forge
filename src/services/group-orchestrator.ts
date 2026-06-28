import type { FeatureGroupsRepo, FeatureGroupRow, GroupFeatureRow } from '../storage/repos/feature-groups-repo'
import type { FeatureListResult, ParsedFeature } from '../utils/feature-list-parser'
import type { Logger } from '../types'
import { computeSchedulerActions, type FeatureStage } from './group-scheduler'

/** Simple UUID v4 generator (no crypto dependency needed). */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Maps a loop's terminal state to a group outcome.
 *
 * Uses the persisted `status` field as the source of truth rather than
 * ad-hoc text matching on `terminationReason`, so that all terminal states
 * (including `errored`/`stalled` with reasons like `max_iterations`,
 * `stall_timeout`, etc.) are correctly classified.
 */
export function mapLoopStateToOutcome(
  state: { active: boolean; status: string } | null,
): 'completed' | 'failed' | 'unknown' {
  if (!state) return 'unknown'
  if (state.active) return 'unknown'
  if (state.status === 'completed') return 'completed'
  if (state.status === 'cancelled' || state.status === 'errored' || state.status === 'stalled') return 'failed'
  return 'unknown'
}

// ── Effect interface ──────────────────────────────────────────────────────

export interface GroupEffects {
  spawnSplitterSession(prdText: string): Promise<{ sessionId: string }>
  readSplitterFeatures(sessionId: string): Promise<FeatureListResult>
  spawnArchitectSession(feature: { title: string; description: string }): Promise<{ sessionId: string }>
  capturePlan(sessionId: string): Promise<{ captured: boolean }>
  classifyArchitectFailure(sessionId: string): Promise<{ reason: string }>
  launchLoop(input: { architectSessionId: string; loopName: string }): Promise<
    { ok: true; loopName: string } | { ok: false; error: string }
  >
  cancelLoop(loopName: string): Promise<void>
  loopFinalOutcome(loopName: string): 'completed' | 'failed' | 'unknown'
  generateLoopName(base: string): string
}

// ── Orchestrator types ────────────────────────────────────────────────────

export interface StartGroupInput {
  title: string
  /** PRD text to split into features. Mutually exclusive with `features`. */
  prd?: string
  /** Pre-split features provided directly. Mutually exclusive with `prd`. */
  features?: ParsedFeature[]
  maxConcurrent?: number
  executionModel?: string
  auditorModel?: string
  hostSessionId?: string
}

export interface GroupStatusView {
  group: FeatureGroupRow
  features: GroupFeatureRow[]
}

export interface GroupOrchestrator {
  startGroup(input: StartGroupInput): Promise<{ groupId: string; status: string }>
  onSplitterIdle(sessionId: string): Promise<void>
  onArchitectIdle(sessionId: string): Promise<void>
  onLoopTerminated(loopName: string): Promise<void>
  restartGroup(groupId: string): Promise<{ ok: boolean; message: string }>
  cancelGroup(groupId: string, opts?: { cancelRunningLoops?: boolean }): Promise<void>
  getStatus(selector?: { groupId?: string }): GroupStatusView[]
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createGroupOrchestrator(deps: {
  projectId: string
  repo: FeatureGroupsRepo
  effects: GroupEffects
  cap: () => number
  logger: Logger
}): GroupOrchestrator {
  const { projectId, repo, effects, cap, logger } = deps

  // Phase 8: premature-idle guard (busySeen set + hasBusyBeenSeen) goes here

  const ACTIVE_GROUP_STATUSES = new Set<FeatureGroupRow['status']>(['extracting', 'planning', 'running'])
  function isGroupActive(status: FeatureGroupRow['status']): boolean {
    return ACTIVE_GROUP_STATUSES.has(status)
  }

  /** Re-read the group after an await; return false if it's gone or no longer active. */
  function groupStillActive(groupId: string, hint: string): boolean {
    const g = repo.getGroup(projectId, groupId)
    if (!g || !isGroupActive(g.status)) {
      logger.log(`group-orchestrator: ${hint} — group ${groupId} is ${g?.status ?? 'gone'}, skipping`)
      return false
    }
    return true
  }

  // ── drive ──────────────────────────────────────────────────────────────
  async function drive(groupId: string): Promise<void> {
    const features = repo.listFeatures(projectId, groupId)
    const capValue = cap()

    const decision = computeSchedulerActions(
      features.map(f => ({ featureIndex: f.featureIndex, stage: f.stage })),
      capValue,
    )

    // Launch planning sessions for pending features
    for (const idx of decision.toPlan) {
      if (!groupStillActive(groupId, 'toPlan iteration start')) return
      const claimed = repo.claimFeatureStage(projectId, groupId, idx, 'pending', 'planning')
      if (!claimed) continue

      const feature = features.find(f => f.featureIndex === idx)
      if (!feature) continue

      // Bump generation so post-await revalidation can detect restart+reclaim.
      repo.incrementFeatureAttempts(projectId, groupId, idx)
      const generation = feature.attempts + 1

      const { sessionId } = await effects.spawnArchitectSession({
        title: feature.title,
        description: feature.description,
      })

      // Re-validate: group was not interrupted during the async call
      if (!groupStillActive(groupId, 'spawnArchitectSession after-await')) return

      // Re-validate: ensure feature is still in planning stage AND has the same
      // generation (was not reclaimed by a restart during the async call).
      const recheck = repo.listFeatures(projectId, groupId).find(f => f.featureIndex === idx)
      if (!recheck || recheck.stage !== 'planning' || recheck.attempts !== generation) {
        logger.log(
          `group-orchestrator: spawned architect session ${sessionId} but feature ${idx} is ${recheck?.stage ?? 'gone'} (attempts ${recheck?.attempts ?? '?'}, expected ${generation}) after await — skipping`,
        )
        continue
      }

      repo.setFeatureArchitectSession(projectId, groupId, idx, sessionId)
      logger.log(`group-orchestrator: spawned architect session ${sessionId} for feature ${idx} in group ${groupId}`)
    }

    // Launch loops for planned features
    for (const idx of decision.toLaunch) {
      if (!groupStillActive(groupId, 'toLaunch iteration start')) return
      const claimed = repo.claimFeatureStage(projectId, groupId, idx, 'planned', 'launching')
      if (!claimed) continue

      const feature = features.find(f => f.featureIndex === idx)
      if (!feature) continue

      // Bump generation so post-await revalidation can detect restart+reclaim.
      repo.incrementFeatureAttempts(projectId, groupId, idx)
      const generation = feature.attempts + 1

      const loopName = effects.generateLoopName(`${groupId}-${feature.title}`)
      const result = await effects.launchLoop({
        architectSessionId: feature.architectSessionId ?? '',
        loopName,
      })

      if (result.ok) {
        // Use the authoritative loop name returned by launchLoop; the service
        // may have auto-renamed it (e.g. on concurrent collision).
        const launchedLoopName = result.loopName

        // Re-validate: group was not interrupted during the async call.
        // If the group is no longer active, best-effort cancel the just-launched
        // loop so it is not left untracked/running.
        if (!groupStillActive(groupId, 'launchLoop after-await')) {
          try {
            await effects.cancelLoop(launchedLoopName)
            logger.log(`group-orchestrator: cancelled untracked loop ${launchedLoopName} for feature ${idx}`)
          } catch (err) {
            logger.error(`group-orchestrator: failed to cancel untracked loop ${launchedLoopName} for feature ${idx}: ${err}`)
          }
          return
        }

        // Re-validate: ensure feature is still in launching stage AND has the
        // same generation (was not reclaimed by a restart).  If the generation
        // changed, a replacement claim owns the feature — cancel our loop.
        const recheckLaunch = repo.listFeatures(projectId, groupId).find(f => f.featureIndex === idx)
        if (!recheckLaunch || recheckLaunch.stage !== 'launching' || recheckLaunch.attempts !== generation) {
          logger.log(
            `group-orchestrator: launched loop ${launchedLoopName} for feature ${idx} but feature is ${recheckLaunch?.stage ?? 'gone'} (attempts ${recheckLaunch?.attempts ?? '?'}, expected ${generation}) after await — cancelling orphaned loop`,
          )
          // Best-effort cancel the orphaned loop.
          try {
            await effects.cancelLoop(launchedLoopName)
          } catch (err) {
            logger.error(`group-orchestrator: failed to cancel orphaned loop ${launchedLoopName} for feature ${idx}: ${err}`)
          }
          continue
        }

        repo.setFeatureLoopName(projectId, groupId, idx, launchedLoopName)
        repo.claimFeatureStage(projectId, groupId, idx, 'launching', 'running')
        logger.log(`group-orchestrator: launched loop ${launchedLoopName} for feature ${idx} in group ${groupId}`)
      } else {
        // Re-validate: group was not interrupted during the async call
        if (!groupStillActive(groupId, 'launchLoop failure after-await')) return

        // Re-validate: ensure feature is still in launching stage AND has the
        // same generation before marking failed — a restart+reclaim invalidates
        // this failure.
        const recheckFail = repo.listFeatures(projectId, groupId).find(f => f.featureIndex === idx)
        if (!recheckFail || recheckFail.stage !== 'launching' || recheckFail.attempts !== generation) {
          logger.log(
            `group-orchestrator: launch failed for feature ${idx} but feature stage/attempts changed after await — skipping`,
          )
          continue
        }

        repo.setFeatureError(projectId, groupId, idx, result.error, 'failed')
        logger.log(`group-orchestrator: failed to launch loop for feature ${idx} in group ${groupId}: ${result.error}`)
      }
    }

    // Re-read features and group after side effects to compute fresh group status.
    // This avoids a stale decision when a launch failure makes all features terminal.
    const freshGroup = repo.getGroup(projectId, groupId)
    if (!freshGroup) return

    // If the group was externally cancelled/interrupted during the side effects,
    // don't overwrite that terminal status.
    if (!isGroupActive(freshGroup.status)) {
      logger.log(`group-orchestrator: drive for group ${groupId} skipping status update — group is ${freshGroup.status}`)
      return
    }

    const fresh = repo.listFeatures(projectId, groupId)
    const allTerminal = fresh.every(f => f.stage === 'completed' || f.stage === 'failed' || f.stage === 'cancelled')
    const anyRunning = fresh.some(f => f.stage === 'planned' || f.stage === 'launching' || f.stage === 'running')

    if (allTerminal) {
      repo.setGroupStatus(projectId, groupId, 'completed', { completedAt: Date.now() })
      logger.log(`group-orchestrator: group ${groupId} completed`)
    } else {
      repo.setGroupStatus(projectId, groupId, anyRunning ? 'running' : 'planning')
    }
  }

  // ── startGroup ─────────────────────────────────────────────────────────
  async function startGroup(input: StartGroupInput): Promise<{ groupId: string; status: string }> {
    const groupId = generateId()

    if (input.prd) {
      repo.createGroup({
        projectId,
        groupId,
        title: input.title,
        status: 'extracting',
        prdText: input.prd,
        maxConcurrent: input.maxConcurrent,
        executionModel: input.executionModel ?? null,
        auditorModel: input.auditorModel ?? null,
        hostSessionId: input.hostSessionId ?? null,
      })

      const { sessionId } = await effects.spawnSplitterSession(input.prd)
      repo.setSplitterSession(projectId, groupId, sessionId)
      logger.log(`group-orchestrator: started group ${groupId} as extracting, splitter session ${sessionId}`)

      return { groupId, status: 'extracting' }
    }

    repo.createGroup({
      projectId,
      groupId,
      title: input.title,
      status: 'planning',
      prdText: null,
      maxConcurrent: input.maxConcurrent,
      executionModel: input.executionModel ?? null,
      auditorModel: input.auditorModel ?? null,
      hostSessionId: input.hostSessionId ?? null,
    })

    repo.insertFeatures(projectId, groupId, input.features ?? [])
    logger.log(
      `group-orchestrator: started group ${groupId} as planning with ${input.features?.length ?? 0} features`,
    )

    await drive(groupId)

    return { groupId, status: 'planning' }
  }

  // ── onSplitterIdle ──────────────────────────────────────────────────────
  async function onSplitterIdle(sessionId: string): Promise<void> {
    const group = repo.getGroupBySplitterSession(projectId, sessionId)
    if (!group) {
      logger.log(`group-orchestrator: onSplitterIdle called for unknown session ${sessionId}`)
      return
    }

    // Guard: only proceed if the group is still extracting (not cancelled/errored/interrupted)
    if (group.status !== 'extracting') {
      logger.log(`group-orchestrator: onSplitterIdle for session ${sessionId} ignoring — group ${group.groupId} is ${group.status}`)
      return
    }

    // Phase 8: premature-idle guard will check hasBusyBeenSeen here
    const result = await effects.readSplitterFeatures(sessionId)

    // Re-validate: ensure group is still extracting with the SAME splitter
    // session after the async call.  A restart may have replaced the splitter
    // session, making this result stale — applying it would overwrite the
    // replacement session's authoritative features.
    const freshGroup = repo.getGroup(projectId, group.groupId)
    if (!freshGroup || freshGroup.status !== 'extracting' || freshGroup.splitterSessionId !== sessionId) {
      logger.log(
        `group-orchestrator: onSplitterIdle for session ${sessionId} aborting — group ${group.groupId} is ${freshGroup?.status ?? 'gone'} after await${freshGroup && freshGroup.splitterSessionId !== sessionId ? ' (splitter session replaced)' : ''}`,
      )
      return
    }

    if (!result.ok) {
      repo.setGroupStatus(projectId, group.groupId, 'errored', {
        error: `feature extraction failed: ${result.reason}`,
      })
      logger.log(`group-orchestrator: splitter ${sessionId} extraction failed: ${result.reason}`)
      return
    }

    repo.insertFeatures(projectId, group.groupId, result.features)
    repo.setGroupStatus(projectId, group.groupId, 'planning')
    logger.log(`group-orchestrator: splitter ${sessionId} extracted ${result.features.length} features`)

    await drive(group.groupId)
  }

  // ── onArchitectIdle ────────────────────────────────────────────────────
  async function onArchitectIdle(sessionId: string): Promise<void> {
    const feature = repo.getFeatureByArchitectSession(projectId, sessionId)
    if (!feature) {
      logger.log(`group-orchestrator: onArchitectIdle called for unknown session ${sessionId}`)
      return
    }

    // Guard: only proceed if the feature is still planning and its group is active
    if (feature.stage !== 'planning') {
      logger.log(`group-orchestrator: onArchitectIdle for session ${sessionId} ignoring — feature ${feature.featureIndex} is ${feature.stage}`)
      return
    }
    const group = repo.getGroup(projectId, feature.groupId)
    if (!group || !isGroupActive(group.status)) {
      logger.log(`group-orchestrator: onArchitectIdle for session ${sessionId} ignoring — group ${feature.groupId} is ${group?.status ?? 'unknown'}`)
      return
    }

    // Phase 8: premature-idle guard will check hasBusyBeenSeen here
    const { captured } = await effects.capturePlan(sessionId)

    // Re-validate: group was not interrupted during the async call
    if (!groupStillActive(feature.groupId, 'capturePlan after-await')) return

    if (captured) {
      // Re-validate: ensure this architect session is still attached to the feature
      // after the await. restartGroup may have reset the stage and replaced the
      // session via resetFeatureStage (which clears architect_session_id).
      const freshFeature = repo.getFeatureByArchitectSession(projectId, sessionId)
      if (!freshFeature || freshFeature.stage !== 'planning') {
        logger.log(
          `group-orchestrator: architect ${sessionId} plan captured but feature ${feature.featureIndex} no longer in planning stage after await`,
        )
        return
      }

      const claimed = repo.claimFeatureStage(projectId, feature.groupId, feature.featureIndex, 'planning', 'planned')
      if (!claimed) {
        logger.log(`group-orchestrator: architect ${sessionId} plan captured but feature ${feature.featureIndex} no longer in planning stage`)
        return
      }
      logger.log(`group-orchestrator: architect ${sessionId} plan captured for feature ${feature.featureIndex}`)
    } else {
      const { reason } = await effects.classifyArchitectFailure(sessionId)

      // Re-validate: group was not interrupted during the async call
      if (!groupStillActive(feature.groupId, 'classifyArchitectFailure after-await')) return

      // Re-validate: ensure feature is still in planning stage after the async call
      const freshFeature = repo.getFeatureByArchitectSession(projectId, sessionId)
      if (!freshFeature || freshFeature.stage !== 'planning') {
        logger.log(
          `group-orchestrator: architect ${sessionId} failure classified but feature ${feature.featureIndex} no longer in planning stage — skipping`,
        )
        return
      }

      repo.setFeatureError(projectId, feature.groupId, feature.featureIndex, reason, 'failed')
      logger.log(`group-orchestrator: architect ${sessionId} failed for feature ${feature.featureIndex}: ${reason}`)
    }

    await drive(feature.groupId)
  }

  // ── onLoopTerminated ───────────────────────────────────────────────────
  async function onLoopTerminated(loopName: string): Promise<void> {
    const feature = repo.getFeatureByLoopName(projectId, loopName)
    if (!feature) {
      logger.log(`group-orchestrator: onLoopTerminated called for non-group loop ${loopName}`)
      return
    }

    // Guard: only proceed if the feature is still running (not cancelled/errored/completed)
    if (feature.stage !== 'running') {
      logger.log(`group-orchestrator: onLoopTerminated for loop ${loopName} ignoring — feature ${feature.featureIndex} is ${feature.stage}`)
      return
    }

    // Guard: only proceed if the owning group is still active (not interrupted/cancelled/errored/completed)
    const group = repo.getGroup(projectId, feature.groupId)
    if (!group || !isGroupActive(group.status)) {
      logger.log(
        `group-orchestrator: onLoopTerminated for loop ${loopName} ignoring — group ${feature.groupId} is ${group?.status ?? 'gone'}`,
      )
      return
    }

    const outcome = effects.loopFinalOutcome(loopName)

    if (outcome === 'completed') {
      const claimed = repo.claimFeatureStage(projectId, feature.groupId, feature.featureIndex, 'running', 'completed')
      if (!claimed) {
        logger.log(`group-orchestrator: loop ${loopName} completed but feature ${feature.featureIndex} no longer in running stage`)
        return
      }
      logger.log(`group-orchestrator: loop ${loopName} completed feature ${feature.featureIndex}`)
    } else if (outcome === 'failed') {
      repo.setFeatureError(projectId, feature.groupId, feature.featureIndex, 'Loop execution failed', 'failed')
      logger.log(`group-orchestrator: loop ${loopName} failed feature ${feature.featureIndex}`)
    } else {
      // unknown outcome — leave feature in running stage
      logger.log(`group-orchestrator: loop ${loopName} outcome unknown for feature ${feature.featureIndex}`)
      return
    }

    await drive(feature.groupId)
  }

  // ── restartGroup ───────────────────────────────────────────────────────
  async function restartGroup(groupId: string): Promise<{ ok: boolean; message: string }> {
    const group = repo.getGroup(projectId, groupId)
    if (!group) {
      return { ok: false, message: `Group ${groupId} not found` }
    }

    if (group.status === 'completed') {
      return { ok: false, message: `Group ${groupId} is already completed and cannot be restarted` }
    }

    if (group.status === 'cancelled') {
      return { ok: false, message: `Group ${groupId} is cancelled and cannot be restarted` }
    }

    if (group.status !== 'interrupted' && group.status !== 'errored') {
      return { ok: false, message: `Group ${groupId} is in status ${group.status} and cannot be restarted` }
    }

    const features = repo.listFeatures(projectId, groupId)

    // Reset stuck stages: planning → pending, launching → planned
    // Use resetFeatureStage for planning → pending to atomically clear the stale
    // architect_session_id, preventing abandoned architect idle events from interfering.
    for (const f of features) {
      if (f.stage === 'planning') {
        repo.resetFeatureStage(projectId, groupId, f.featureIndex, 'planning', 'pending')
      } else if (f.stage === 'launching') {
        repo.claimFeatureStage(projectId, groupId, f.featureIndex, 'launching', 'planned')
      }
    }

    // Re-spawn splitter if group was errored or interrupted with no features and has prdText
    if ((group.status === 'errored' || group.status === 'interrupted') && features.length === 0 && group.prdText) {
      const { sessionId } = await effects.spawnSplitterSession(group.prdText)

      // Re-validate: group wasn't externally cancelled/completed during the await
      const gAfter = repo.getGroup(projectId, groupId)
      if (!gAfter || gAfter.status === 'cancelled' || gAfter.status === 'completed') {
        logger.log(`group-orchestrator: restartGroup ${groupId} aborting — group is ${gAfter?.status ?? 'gone'} after await`)
        return { ok: false, message: `Group ${groupId} state changed during restart` }
      }

      repo.setSplitterSession(projectId, groupId, sessionId)
      repo.setGroupStatus(projectId, groupId, 'extracting')
      logger.log(`group-orchestrator: restarted group ${groupId} as extracting with new splitter ${sessionId}`)
      return { ok: true, message: `Group ${groupId} restarted as extracting` }
    }

    // Determine new status: running if any features are in running stages, else planning
    const runningStages = new Set<FeatureStage>(['planned', 'launching', 'running'])
    const hasRunning = features.some(f => runningStages.has(f.stage))
    const newStatus = hasRunning ? 'running' : 'planning'
    repo.setGroupStatus(projectId, groupId, newStatus)
    logger.log(`group-orchestrator: restarted group ${groupId} as ${newStatus}`)

    await drive(groupId)

    return { ok: true, message: `Group ${groupId} restarted as ${newStatus}` }
  }

  // ── cancelGroup ────────────────────────────────────────────────────────
  async function cancelGroup(groupId: string, opts?: { cancelRunningLoops?: boolean }): Promise<void> {
    const group = repo.getGroup(projectId, groupId)
    if (!group) return

    // Snapshot features before mutating — state-first: mark group and features
    // cancelled immediately so the group is inactive.  Late callbacks that check
    // isGroupActive / groupStillActive will bail, preventing resurrection.
    const features = repo.listFeatures(projectId, groupId)
    const terminalStages = new Set<FeatureStage>(['completed', 'failed', 'cancelled'])
    const runningLoops: string[] = []

    for (const f of features) {
      if (terminalStages.has(f.stage)) continue

      if (opts?.cancelRunningLoops && f.loopName && (f.stage === 'launching' || f.stage === 'running')) {
        runningLoops.push(f.loopName)
      }
    }

    // State-first: mark all non-terminal features cancelled and set group cancelled.
    for (const f of features) {
      if (terminalStages.has(f.stage)) continue
      repo.setFeatureError(projectId, groupId, f.featureIndex, '', 'cancelled')
    }
    repo.setGroupStatus(projectId, groupId, 'cancelled')
    logger.log(`group-orchestrator: cancelled group ${groupId}`)

    // Best-effort external cancellation after state is safe.
    // A failure to cancel a loop does NOT undo the cancellation.
    for (const loopName of runningLoops) {
      try {
        await effects.cancelLoop(loopName)
      } catch (err) {
        logger.error(`group-orchestrator: failed to cancel loop ${loopName} for group ${groupId}: ${err}`)
      }
    }
  }

  // ── getStatus ──────────────────────────────────────────────────────────
  function getStatus(selector?: { groupId?: string }): GroupStatusView[] {
    if (selector?.groupId) {
      const group = repo.getGroup(projectId, selector.groupId)
      if (!group) return []
      const features = repo.listFeatures(projectId, selector.groupId)
      return [{ group, features }]
    }

    const groups = repo.listGroups(projectId)
    return groups.map(group => ({
      group,
      features: repo.listFeatures(projectId, group.groupId),
    }))
  }

  return {
    startGroup,
    onSplitterIdle,
    onArchitectIdle,
    onLoopTerminated,
    restartGroup,
    cancelGroup,
    getStatus,
  }
}
