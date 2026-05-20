import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import type { ForgeExecutionServiceDeps, PlanSource } from '../services/execution'
import { attachLoopToSession } from '../services/execution'
import { classifyForgeWorkspace, isPendingAttachWorkspace } from '../workspace/classify-stale'
import { removeForgeWorkspaceWithContext } from '../workspace/remove-with-context'
import { getForgeWorkspaceLoopName } from '../workspace/forge-worktree'

export interface ForgeSessionAttachHookDeps {
  v2: ReturnType<typeof createV2Client>
  execDeps: ForgeExecutionServiceDeps
  projectId: string
  directory: string
  logger: Logger
  attachLoopToSession?: typeof attachLoopToSession
}

interface WorkspaceEntry {
  id: string
  type: string
  directory?: string | undefined
  extra?: Record<string, unknown> | undefined
}

export function createForgeSessionAttachHook(deps: ForgeSessionAttachHookDeps) {
  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }) => {
    if (eventInput.event.type !== 'session.created') return

    const sessionInfo = eventInput.event.properties?.info as Record<string, unknown> | undefined
    const sessionId = sessionInfo?.id as string | undefined
    const workspaceId = sessionInfo?.workspaceID as string | undefined
    const sessionDirectory = sessionInfo?.directory as string | undefined
    const sessionProjectId = (sessionInfo?.projectID as string | undefined) ?? deps.projectId
    if (!sessionId || !workspaceId) return

    await attachForgeSession(deps, {
      sessionId,
      workspaceId,
      sessionDirectory,
      sessionProjectId,
      sendInitialPrompt: true,
      selectSession: true,
    })
  }
}

export function createForgeSessionMessageAttachHook(deps: ForgeSessionAttachHookDeps) {
  return async (input: { sessionID: string }) => {
    const sessionId = input.sessionID
    if (!sessionId) return

    const sessionResult = await deps.v2.session?.get?.({ sessionID: sessionId }).catch(() => null)
    const sessionInfo = (sessionResult?.data ?? null) as Record<string, unknown> | null
    const workspaceId = sessionInfo?.workspaceID as string | undefined
    if (!workspaceId) return

    await attachForgeSession(deps, {
      sessionId,
      workspaceId,
      sessionDirectory: sessionInfo?.directory as string | undefined,
      sessionProjectId: (sessionInfo?.projectID as string | undefined) ?? deps.projectId,
      sendInitialPrompt: false,
      selectSession: false,
    })
  }
}

async function attachForgeSession(
  deps: ForgeSessionAttachHookDeps,
  input: {
    sessionId: string
    workspaceId: string
    sessionDirectory?: string
    sessionProjectId: string
    sendInitialPrompt: boolean
    selectSession: boolean
  },
): Promise<void> {
    const { sessionId, workspaceId, sessionDirectory, sessionProjectId, sendInitialPrompt, selectSession } = input
    let ws = await findWorkspaceById(deps, workspaceId, sessionDirectory)
    if (!ws) {
      await new Promise<void>((r) => setTimeout(r, 100))
      ws = await findWorkspaceById(deps, workspaceId, sessionDirectory)
      if (!ws) {
        deps.logger.log(
          `[forge-session-attach] skip session=${sessionId}: workspace ${workspaceId} not found ` +
          `via experimental.workspace.list directory=${sessionDirectory ?? '(none)'} ` +
          `(cross-project or sync lag)`,
        )
        if (sessionDirectory) {
          publishAttachFailureToast(
            deps,
            sessionDirectory,
            `Forge loop (workspace ${workspaceId})`,
            'Workspace not visible from this plugin instance — open the TUI in the loop\'s project.',
          )
        }
        return
      }
    }

    if (ws.type !== 'forge') {
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=non-forge-type type=${ws.type}`)
      return
    }

    const loopName = getForgeWorkspaceLoopName(ws)
    if (!loopName) {
      const extraKeys = ws.extra ? Object.keys(ws.extra) : []
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=no-loop-name extraKeys=[${extraKeys.join(',')}]`)
      return
    }

    const cfg = (ws.extra ?? {}).forgeLoop as {
      hostSessionId?: string
      title?: string
      executionModel?: string
      auditorModel?: string
      executionVariant?: string
      auditorVariant?: string
      planSource?: 'stored' | 'inline'
      planText?: string
      initialPromptOwner?: 'server' | 'tui'
      maxIterations?: number
      sandboxEnabled?: boolean
    } | undefined

    if (cfg?.initialPromptOwner === 'tui' && sendInitialPrompt) {
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${loopName} reason=tui-owned-initial-prompt`)
      return
    }

    // Build a synthetic entry for classification. If extra.projectDirectory is missing,
    // synthesize it from ws.directory so the classifier can still check the loop row.
    // This ensures the attach hook handles workspaces created by older code paths that
    // didn't stamp extra.projectDirectory.
    const ws_extra_proj = (ws.extra ?? {}).projectDirectory as string | undefined
    const projectDirectory = ws_extra_proj ?? ws.directory ?? deps.directory
    const classifyEntry = {
      id: workspaceId,
      type: ws.type,
      extra: ws_extra_proj
        ? (ws.extra ?? {})
        : { ...(ws.extra ?? {}), projectDirectory },
    }
    const action = classifyForgeWorkspace(
      classifyEntry,
      deps.execDeps.loopsRepo,
      sessionProjectId,
      projectDirectory,
    )

    if (action.action === 'keep' && action.reason !== 'running' && action.reason !== 'pending-attach') {
      // bad config or wrong-project — toast and bail, do not attach
      deps.logger.log(
        `[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=${action.reason}`,
      )
      return
    }

    if ((action.action === 'remove-fully' && action.reason === 'missing-row') || (action.action === 'keep' && action.reason === 'pending-attach')) {
      // Fresh attach (no loop row yet) - proceed to attach
      if (!cfg) {
        if (action.action === 'remove-fully') {
          await removeForgeWorkspaceWithContext(
            { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
            { workspaceId, loopName, action: 'remove-fully', reasonLabel: 'attach-missing-row-no-config' },
          )
          publishAttachFailureToast(
            deps,
            ws.directory ?? deps.directory,
            `Forge loop "${loopName}"`,
            'Loop metadata missing. Removed stale workspace registration.',
          )
        } else {
          const extraKeys = ws.extra ? Object.keys(ws.extra) : []
          deps.logger.log(`[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=no-forgeLoop-config extraKeys=[${extraKeys.join(',')}]`)
        }
        return
      }
      if (action.action === 'remove-fully' && cfg.initialPromptOwner === 'tui' && !isPendingAttachWorkspace(classifyEntry)) {
        await removeForgeWorkspaceWithContext(
          { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
          { workspaceId, loopName, action: 'remove-fully', reasonLabel: 'attach-expired-pending' },
        )
        publishAttachFailureToast(
          deps,
          ws.directory ?? deps.directory,
          `Forge loop "${loopName}"`,
          'Loop attach window expired. Run a new plan to start fresh.',
        )
        return
      }
      deps.logger.log(`[forge-session-attach] session=${sessionId} loop=${loopName} projectId=${sessionProjectId} proceeding (fresh-attach)`)
    } else if (action.action === 'keep' && action.reason === 'running') {
      // Running loop but no in-memory state: this is the plugin-reload recovery case
      // However, the loop is already running, so we should NOT re-attach
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${loopName} reason=already-running`)
      return
    } else if (action.action === 'remove-fully' && action.reason === 'completed') {
      // Completed loop: remove workspace + toast
      await removeForgeWorkspaceWithContext(
        { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
        { workspaceId, loopName, action: 'remove-fully', reasonLabel: 'attach-safety-net-completed' },
      )
      publishAttachFailureToast(
        deps,
        ws.directory ?? deps.directory,
        `Forge loop "${loopName}"`,
        'Loop already completed. Run a new plan to start fresh.',
      )
      return
    } else if (action.action === 'remove-registration-only') {
      // Restartable (cancelled/errored/stalled): remove registration, preserve worktree for manual restart
      await removeForgeWorkspaceWithContext(
        { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
        { workspaceId, loopName, action: 'remove-registration-only', reasonLabel: 'attach-safety-net-restartable' },
      )
      publishAttachFailureToast(
        deps,
        ws.directory ?? deps.directory,
        `Forge loop "${loopName}"`,
        `Loop "${loopName}" is in terminal status. Use Loop-status restart to resume.`,
      )
      return
    } else {
      // Fallback: should not reach here
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${loopName} reason=unexpected-classification`)
      return
    }

    if (!cfg) return

    const resolvedHostSessionId = cfg.hostSessionId && cfg.hostSessionId.length > 0
      ? cfg.hostSessionId
      : sessionId

    const planSource: PlanSource =
      cfg.planSource === 'inline' && cfg.planText
        ? { kind: 'inline', planText: cfg.planText }
        : { kind: 'stored', sessionId: resolvedHostSessionId }

    let planText: string
    if (planSource.kind === 'inline') {
      planText = planSource.planText
    } else {
      const row = deps.execDeps.plansRepo.getForSession(sessionProjectId, planSource.sessionId)
      if (!row) {
        deps.logger.error(`[forge-session-attach] plan not found for session=${planSource.sessionId} loop=${loopName} workspace=${workspaceId}`)
        publishAttachFailureToast(deps, ws.directory ?? deps.directory, `Forge loop "${loopName}"`, 'No stored plan found for this loop. Re-run "Execute → Loop" from a session that has a captured plan.')
        await removeForgeWorkspaceWithContext(
          { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
          { workspaceId, loopName, action: 'remove-fully', reasonLabel: 'attach-no-plan' },
        )
        return
      }
      planText = row.content
    }

    try {
      const loopFn = deps.attachLoopToSession ?? attachLoopToSession
      const result = await loopFn(
        deps.execDeps,
        { surface: 'tui', projectId: sessionProjectId, directory: ws.directory ?? deps.directory },
        {
          sessionId,
          workspaceId,
          worktreeDir: ws.directory ?? '',
          loopName,
          displayName: cfg.title ?? loopName,
          executionName: loopName,
          hostSessionId: resolvedHostSessionId,
          executionModel: cfg.executionModel,
          auditorModel: cfg.auditorModel,
          executionVariant: cfg.executionVariant,
          auditorVariant: cfg.auditorVariant,
          maxIterations: cfg.maxIterations ?? 50,
          sandboxEnabled: cfg.sandboxEnabled ?? false,
          planText,
           selectSession,
           selectSessionTiming: 'after-prompt',
           startWatchdog: true,
           sendInitialPrompt,
         },
       )
        if (!result.ok && result.code === 'conflict') {
          const row = deps.execDeps.loopsRepo.get(sessionProjectId, loopName)
          const removalAction = row?.status === 'cancelled' || row?.status === 'errored' || row?.status === 'stalled'
            ? 'remove-registration-only'
            : 'remove-fully'
          publishAttachFailureToast(
            deps,
            ws.directory ?? deps.directory,
            `Forge loop "${loopName}"`,
            removalAction === 'remove-registration-only'
              ? `Loop "${loopName}" is in terminal status. Use Loop-status restart to resume.`
              : `Failed to start loop: ${result.message}`,
          )
          await removeForgeWorkspaceWithContext(
            { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
            { workspaceId, loopName, action: removalAction, reasonLabel: 'attach-conflict-terminal' },
          )
        } else if (!result.ok && result.code !== 'already_attached') {
          publishAttachFailureToast(deps, ws.directory ?? deps.directory, `Forge loop "${loopName}"`, `Failed to start loop: ${result.message}`)
          await removeForgeWorkspaceWithContext(
            { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
            { workspaceId, loopName, action: 'remove-fully', reasonLabel: 'attach-failed' },
          )
        }
      } catch (err) {
        deps.logger.error('[forge-session-attach] attachLoopToSession threw', err)
        publishAttachFailureToast(deps, ws.directory ?? deps.directory, `Forge loop "${loopName}"`, 'Failed to start loop (unexpected error). Check forge logs.')
        await removeForgeWorkspaceWithContext(
          { v2: deps.v2, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
          { workspaceId, loopName, action: 'remove-fully', reasonLabel: 'attach-error' },
        )
      }
}

function publishAttachFailureToast(
  deps: ForgeSessionAttachHookDeps,
  directory: string,
  title: string,
  message: string,
): void {
  const tui = deps.v2.tui
  if (!tui || typeof tui.publish !== 'function') return
  tui.publish({
    directory,
    body: {
      type: 'tui.toast.show',
      properties: { title, message, variant: 'error', duration: 6000 },
    },
  }).catch((err) => {
    deps.logger.error('[forge-session-attach] failed to publish toast', err)
  })
}

async function findWorkspaceById(
  deps: ForgeSessionAttachHookDeps,
  workspaceId: string,
  directory?: string,
): Promise<WorkspaceEntry | null> {
  try {
    const result = await deps.v2.experimental.workspace.list(
      directory ? { directory } : undefined,
    )
    const entries = (result.data ?? []) as WorkspaceEntry[]
    return entries.find((e) => e.id === workspaceId) ?? null
  } catch {
    return null
  }
}
