import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import type { ForgeExecutionServiceDeps, PlanSource } from '../services/execution'
import { attachLoopToSession } from '../services/execution'

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
            'Workspace not visible from this plugin instance - open the TUI in the loop\'s project, or run the reconciler.',
          )
        }
        return
      }
    }

    if (ws.type !== 'forge') {
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=non-forge-type type=${ws.type}`)
      return
    }

    const cfg = (ws.extra ?? {}).forgeLoop as {
      loopName?: string
      hostSessionId?: string
      title?: string
      executionModel?: string
      auditorModel?: string
      planSource?: 'stored' | 'inline'
      planText?: string
      initialPromptOwner?: 'server' | 'tui'
      maxIterations?: number
      sandboxEnabled?: boolean
    } | undefined

    if (!cfg || !cfg.loopName) {
      const extraKeys = ws.extra ? Object.keys(ws.extra) : []
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=no-forgeLoop-config extraKeys=[${extraKeys.join(',')}]`)
      return
    }

    if (cfg.initialPromptOwner === 'tui' && sendInitialPrompt) {
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${cfg.loopName} reason=tui-owned-initial-prompt`)
      return
    }

    const existing = deps.execDeps.loopsRepo.get(sessionProjectId, cfg.loopName)
    if (existing) {
      if (existing.status === 'running') {
        deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${cfg.loopName} reason=already-running`)
        return
      }
      // Terminal rows must not auto-resurrect. Manual restart goes through
      // Loop-status restart, which uses a separate execution path.
      const cleanupLabel = existing.status === 'completed' ? `; removing orphan workspace=${workspaceId}` : '; preserving restartable workspace'
      deps.logger.log(
        `[forge-session-attach] refuse session=${sessionId} loop=${cfg.loopName} reason=terminal-loop-row status=${existing.status}${cleanupLabel}`,
      )
      const message = `Loop "${cfg.loopName}" is in terminal status "${existing.status}". Auto-resurrect disabled — use Loop-status restart to resume manually.`
      if (existing.status === 'completed') {
        await failAndCleanup(deps, workspaceId, ws.directory ?? deps.directory, cfg.loopName, message)
      } else {
        publishAttachFailureToast(deps, ws.directory ?? deps.directory, cfg.loopName, message)
      }
      return
    }
    deps.logger.log(`[forge-session-attach] session=${sessionId} loop=${cfg.loopName} projectId=${sessionProjectId} proceeding`)

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
        deps.logger.error(`[forge-session-attach] plan not found for session=${planSource.sessionId} loop=${cfg.loopName} workspace=${workspaceId}`)
        await failAndCleanup(
          deps,
          workspaceId,
          ws.directory ?? deps.directory,
          cfg.loopName,
          'No stored plan found for this loop. Re-run "Execute → Loop" from a session that has a captured plan.',
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
          loopName: cfg.loopName,
          displayName: cfg.title ?? cfg.loopName,
          executionName: cfg.loopName,
          hostSessionId: resolvedHostSessionId,
          executionModel: cfg.executionModel,
          auditorModel: cfg.auditorModel,
          maxIterations: cfg.maxIterations ?? 50,
          sandboxEnabled: cfg.sandboxEnabled ?? false,
          planText,
           selectSession,
           selectSessionTiming: 'after-prompt',
           startWatchdog: true,
           sendInitialPrompt,
         },
       )
      if (!result.ok && result.code !== 'already_attached') {
        await failAndCleanup(
          deps,
          workspaceId,
          ws.directory ?? deps.directory,
          cfg.loopName,
          `Failed to start loop: ${result.message}`,
        )
      }
    } catch (err) {
      deps.logger.error('[forge-session-attach] attachLoopToSession threw', err)
      await failAndCleanup(
        deps,
        workspaceId,
        ws.directory ?? deps.directory,
        cfg.loopName,
        'Failed to start loop (unexpected error). Check forge logs.',
      )
    }
}

async function failAndCleanup(
  deps: ForgeSessionAttachHookDeps,
  workspaceId: string,
  directory: string,
  loopName: string,
  message: string,
): Promise<void> {
  publishAttachFailureToast(deps, directory, `Forge loop "${loopName}"`, message)
  await removeOrphanWorkspace(deps, workspaceId, loopName)
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

async function removeOrphanWorkspace(
  deps: ForgeSessionAttachHookDeps,
  workspaceId: string,
  loopName: string,
): Promise<void> {
  const workspaceApi = deps.v2.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.remove !== 'function') {
    deps.logger.error(`[forge-session-attach] cannot remove orphan workspace ${workspaceId} for loop ${loopName}: experimental.workspace.remove unavailable`)
    return
  }
  try {
    const result = await workspaceApi.remove({ id: workspaceId })
    if ('error' in result && result.error) {
      deps.logger.error(`[forge-session-attach] failed to remove orphan workspace ${workspaceId} for loop ${loopName}`, result.error)
      return
    }
    deps.logger.log(`[forge-session-attach] removed orphan workspace ${workspaceId} for loop ${loopName}`)
  } catch (err) {
    deps.logger.error(`[forge-session-attach] threw removing orphan workspace ${workspaceId} for loop ${loopName}`, err)
  }
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
