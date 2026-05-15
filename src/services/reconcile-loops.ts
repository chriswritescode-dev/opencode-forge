/**
 * Init-time reconciliation for forge workspaces.
 *
 * When the plugin starts (or restarts), there may be existing forge workspaces
 * with `extra.forgeLoop` config whose loops were never attached — because the
 * `session.created` event for their session fired before the plugin loaded.
 *
 * This reconciler scans forge workspaces, and for each one with `forgeLoop`
 * config but no `loops` table row, picks the most recent session in that
 * workspace and calls `attachLoopToSession`.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import type { ForgeExecutionServiceDeps } from './execution'
import { attachLoopToSession } from './execution'

interface ReconcileDeps {
  v2: OpencodeClient
  execDeps: ForgeExecutionServiceDeps
  projectId: string
  directory: string
  logger: Logger
  attachLoopToSession?: typeof attachLoopToSession
}

interface ForgeLoopConfig {
  loopName?: string
  hostSessionId?: string
  title?: string
  executionModel?: string
  auditorModel?: string
  decomposerMode?: 'agent' | 'deterministic' | 'disabled'
  planSource?: 'stored' | 'inline'
  planText?: string
  maxIterations?: number
  sandboxEnabled?: boolean
}

interface WorkspaceEntry {
  id: string
  type?: string
  directory?: string | null
  extra?: Record<string, unknown> | null
}

interface SessionEntry {
  id: string
  workspaceID?: string | null
  time?: { created?: number; updated?: number }
}

// Module-level guard so duplicate plugin-factory invocations by OpenCode don't run
// the reconciler concurrently. Keyed by projectId, since legitimate multi-project
// scenarios should still allow one run per project.
const inFlight = new Set<string>()

export async function reconcileForgeWorkspaceLoops(deps: ReconcileDeps): Promise<void> {
  if (inFlight.has(deps.projectId)) {
    deps.logger.log(`reconcileForgeWorkspaceLoops: already running for project ${deps.projectId}, skipping duplicate invocation`)
    return
  }
  inFlight.add(deps.projectId)
  try {
    await runReconcile(deps)
  } finally {
    inFlight.delete(deps.projectId)
  }
}

async function runReconcile(deps: ReconcileDeps): Promise<void> {
  const workspaceApi = deps.v2.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.list !== 'function') {
    deps.logger.log('reconcileForgeWorkspaceLoops: workspace.list unavailable; skipping')
    return
  }

  let workspaces: WorkspaceEntry[]
  try {
    const result = await workspaceApi.list()
    workspaces = ((result as { data?: unknown[] } | undefined)?.data ?? []) as WorkspaceEntry[]
  } catch (err) {
    deps.logger.error('reconcileForgeWorkspaceLoops: workspace.list threw', err)
    return
  }

  deps.logger.log(`reconcileForgeWorkspaceLoops: workspace.list returned ${workspaces.length} workspaces total`)
  const forgeWorkspaces = workspaces.filter((w) => w.type === 'forge')
  deps.logger.log(`reconcileForgeWorkspaceLoops: ${forgeWorkspaces.length} forge workspaces after type filter`)
  if (forgeWorkspaces.length === 0) {
    deps.logger.log('reconcileForgeWorkspaceLoops: no forge workspaces found')
    return
  }

  let attached = 0
  let skipped = 0
  const attachedTargets: Array<{ workspaceId: string; sessionId: string; loopName: string }> = []

  for (const ws of forgeWorkspaces) {
    const extraKeys = ws.extra ? Object.keys(ws.extra) : []
    const cfg = (ws.extra ?? {}).forgeLoop as ForgeLoopConfig | undefined
    if (!cfg || !cfg.loopName) {
      deps.logger.log(`reconcileForgeWorkspaceLoops: skip workspace=${ws.id} reason=no-forgeLoop-config extraKeys=[${extraKeys.join(',')}]`)
      skipped++
      continue
    }

    deps.logger.log(`reconcileForgeWorkspaceLoops: evaluating workspace=${ws.id} loop=${cfg.loopName} planSource=${cfg.planSource ?? 'unset'} hostSessionId="${cfg.hostSessionId ?? ''}"`)

    const existing = deps.execDeps.loopsRepo.get(deps.projectId, cfg.loopName)
    if (existing && existing.status === 'running') {
      // Live loop — already attached and active.
      deps.logger.log(`reconcileForgeWorkspaceLoops: skip workspace=${ws.id} loop=${cfg.loopName} reason=already-running`)
      skipped++
      continue
    }
    if (existing) {
      deps.logger.log(`reconcileForgeWorkspaceLoops: existing loop row for ${cfg.loopName} has status=${existing.status}; will re-attach (terminal row will be cleared by attachLoopToSession)`)
    }

    const session = await findMostRecentSession(deps.v2, ws.id, deps.logger)
    if (!session) {
      deps.logger.log(`reconcileForgeWorkspaceLoops: skip workspace=${ws.id} loop=${cfg.loopName} reason=no-sessions`)
      skipped++
      continue
    }

    deps.logger.log(`reconcileForgeWorkspaceLoops: most-recent session=${session.id} for workspace=${ws.id}`)

    const planText = await resolvePlanText(deps, cfg, session.id)
    if (planText === null) {
      deps.logger.error(`reconcileForgeWorkspaceLoops: skip workspace=${ws.id} loop=${cfg.loopName} reason=plan-not-found planSource=${cfg.planSource ?? 'unset'} hostSessionId="${cfg.hostSessionId ?? ''}" fallbackSessionId=${session.id}`)
      skipped++
      continue
    }
    deps.logger.log(`reconcileForgeWorkspaceLoops: plan resolved for loop=${cfg.loopName} (length=${planText.length})`)

    const resolvedHostSessionId = cfg.hostSessionId && cfg.hostSessionId.length > 0 ? cfg.hostSessionId : session.id

    try {
      const loopFn = deps.attachLoopToSession ?? attachLoopToSession
      const result = await loopFn(
        deps.execDeps,
        { surface: 'tui', projectId: deps.projectId, directory: ws.directory ?? deps.directory },
        {
          sessionId: session.id,
          workspaceId: ws.id,
          worktreeDir: ws.directory ?? '',
          loopName: cfg.loopName,
          displayName: cfg.title ?? cfg.loopName,
          executionName: cfg.loopName,
          hostSessionId: resolvedHostSessionId,
          executionModel: cfg.executionModel,
          auditorModel: cfg.auditorModel,
          maxIterations: cfg.maxIterations ?? 50,
          sandboxEnabled: cfg.sandboxEnabled ?? false,
          decomposerMode: cfg.decomposerMode ?? 'agent',
          planText,
          selectSession: false,
          selectSessionTiming: 'after-prompt',
          startWatchdog: true,
        },
      )
      if (result.ok) {
        attached++
        attachedTargets.push({ workspaceId: ws.id, sessionId: session.id, loopName: cfg.loopName })
        deps.logger.log(`reconcileForgeWorkspaceLoops: attached loop ${cfg.loopName} (workspace=${ws.id} session=${session.id})`)
      } else if (result.code === 'already_attached') {
        skipped++
      } else {
        deps.logger.error(`reconcileForgeWorkspaceLoops: attach failed for loop=${cfg.loopName}: ${result.message}`)
        skipped++
      }
    } catch (err) {
      deps.logger.error(`reconcileForgeWorkspaceLoops: attach threw for loop=${cfg.loopName}`, err)
      skipped++
    }
  }

  deps.logger.log(`reconcileForgeWorkspaceLoops: attached=${attached} skipped=${skipped} scanned=${forgeWorkspaces.length}`)

  for (const target of attachedTargets) {
    deps.logger.log(`reconcileForgeWorkspaceLoops: attached loop ${target.loopName} (workspace=${target.workspaceId} session=${target.sessionId}); user must Warp to the workspace manually — main-plugin tui.selectSession cannot reach user TUI from worktree-bound directory`)
  }
}

async function findMostRecentSession(
  v2: OpencodeClient,
  workspaceId: string,
  logger: Logger,
): Promise<SessionEntry | null> {
  try {
    const result = await v2.session.list({ workspace: workspaceId, limit: 50 })
    const sessions = ((result as { data?: unknown[] } | undefined)?.data ?? []) as SessionEntry[]
    if (sessions.length === 0) return null
    // session.list returns sorted by most recently updated; take the first.
    return sessions[0]
  } catch (err) {
    logger.error(`reconcileForgeWorkspaceLoops: session.list threw for workspace=${workspaceId}`, err)
    return null
  }
}

async function resolvePlanText(
  deps: ReconcileDeps,
  cfg: ForgeLoopConfig,
  fallbackSessionId: string,
): Promise<string | null> {
  if (cfg.planSource === 'inline' && cfg.planText) {
    return cfg.planText
  }
  const lookupSessionId = cfg.hostSessionId && cfg.hostSessionId.length > 0 ? cfg.hostSessionId : fallbackSessionId
  const row = deps.execDeps.plansRepo.getForSession(deps.projectId, lookupSessionId)
  return row ? row.content : null
}
