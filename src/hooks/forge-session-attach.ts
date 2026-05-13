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
    if (!sessionId || !workspaceId) return

    let ws = await findWorkspaceById(deps, workspaceId)
    if (!ws) {
      await new Promise<void>((r) => setTimeout(r, 100))
      ws = await findWorkspaceById(deps, workspaceId)
      if (!ws) return
    }

    if (ws.type !== 'forge') return

    const cfg = (ws.extra ?? {}).forgeLoop as {
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
    } | undefined

    if (!cfg || !cfg.loopName) return

    const planSource: PlanSource =
      cfg.planSource === 'inline' && cfg.planText
        ? { kind: 'inline', planText: cfg.planText }
        : { kind: 'stored', sessionId: cfg.hostSessionId ?? sessionId }

    let planText: string
    if (planSource.kind === 'inline') {
      planText = planSource.planText
    } else {
      const row = deps.execDeps.plansRepo.getForSession(deps.projectId, planSource.sessionId)
      if (!row) {
        deps.logger.error(`[forge-session-attach] plan not found for session=${planSource.sessionId}`)
        return
      }
      planText = row.content
    }

    try {
      await attachLoopToSession(
        deps.execDeps,
        { surface: 'tui', projectId: deps.projectId, directory: ws.directory ?? deps.directory },
        {
          sessionId,
          workspaceId,
          worktreeDir: ws.directory ?? '',
          loopName: cfg.loopName,
          displayName: cfg.title ?? cfg.loopName,
          executionName: cfg.loopName,
          hostSessionId: cfg.hostSessionId,
          executionModel: cfg.executionModel,
          auditorModel: cfg.auditorModel,
          maxIterations: cfg.maxIterations ?? 50,
          sandboxEnabled: cfg.sandboxEnabled ?? false,
          decomposerMode: cfg.decomposerMode ?? 'agent',
          planText,
          selectSession: true,
          selectSessionTiming: 'after-prompt',
          startWatchdog: true,
        },
      )
    } catch (err) {
      deps.logger.error('[forge-session-attach] attachLoopToSession threw', err)
    }
  }
}

async function findWorkspaceById(
  deps: ForgeSessionAttachHookDeps,
  workspaceId: string,
): Promise<WorkspaceEntry | null> {
  try {
    const result = await deps.v2.experimental.workspace.list()
    const entries = (result.data ?? []) as WorkspaceEntry[]
    return entries.find((e) => e.id === workspaceId) ?? null
  } catch {
    return null
  }
}
