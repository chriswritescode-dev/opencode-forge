import { z } from 'zod'
import type { Logger } from '../types'
import type { ForgeClient, ForgeEvent, WorkspaceExtra } from '../client/port'
import type { ForgeExecutionServiceDeps, ForgeLoopExtra, PlanSource } from '../services/execution'
import { attachLoopToSession } from '../services/execution'
import { resolveSandboxContextForLoop, isSandboxEnabled } from '../sandbox/context'
import { classifyForgeWorkspace, isPendingAttachWorkspace } from '../workspace/classify-stale'
import { removeForgeWorkspaceWithContext } from '../workspace/remove-with-context'
import { getForgeWorkspaceForgeLoop, getForgeWorkspaceLoopName, getForgeWorkspaceProjectDirectory, type ForgeWorkspaceEntry } from '../workspace/forge-worktree'
import { publishToast } from '../utils/toast'

export interface ForgeSessionAttachHookDeps {
  client: ForgeClient
  execDeps: ForgeExecutionServiceDeps
  projectId: string
  directory: string
  logger: Logger
  attachLoopToSession?: typeof attachLoopToSession
}

const sessionCreatedInfoSchema = z.looseObject({
  info: z.looseObject({
    id: z.string().optional(),
    workspaceID: z.string().optional(),
    directory: z.string().optional(),
    projectID: z.string().optional(),
  }).optional(),
})

const sessionRecordSchema = z.looseObject({
  workspaceID: z.string().optional(),
  directory: z.string().optional(),
  projectID: z.string().optional(),
})

export function createForgeSessionAttachHook(deps: ForgeSessionAttachHookDeps) {
  return async (eventInput: { event: { type: string; properties?: ForgeEvent['properties'] } }) => {
    if (eventInput.event.type !== 'session.created') return

    const parsed = sessionCreatedInfoSchema.safeParse(eventInput.event.properties)
    if (!parsed.success) return
    const sessionInfo = parsed.data.info
    const sessionId = sessionInfo?.id
    const workspaceId = sessionInfo?.workspaceID
    const sessionDirectory = sessionInfo?.directory
    const sessionProjectId = sessionInfo?.projectID ?? deps.projectId
    if (!sessionId || !workspaceId) return

    await attachForgeSession(deps, {
      sessionId,
      workspaceId,
      sessionDirectory,
      sessionProjectId,
      sendInitialPrompt: true,
    })
  }
}

export function createForgeSessionMessageAttachHook(deps: ForgeSessionAttachHookDeps) {
  return async (input: { sessionID: string }) => {
    const sessionId = input.sessionID
    if (!sessionId) return

    const fetched = await deps.client.session.get({ sessionID: sessionId }).then(
      (data) => sessionRecordSchema.safeParse(data),
      () => undefined,
    )
    if (!fetched?.success) return
    const workspaceId = fetched.data.workspaceID
    if (!workspaceId) return

    await attachForgeSession(deps, {
      sessionId,
      workspaceId,
      sessionDirectory: fetched.data.directory,
      sessionProjectId: fetched.data.projectID ?? deps.projectId,
      sendInitialPrompt: false,
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
  },
): Promise<void> {
    const { sessionId, workspaceId, sessionDirectory, sessionProjectId, sendInitialPrompt } = input
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

    const cfg = getForgeWorkspaceForgeLoop(ws)

    if (cfg?.initialPromptOwner === 'tui' && sendInitialPrompt) {
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${loopName} reason=tui-owned-initial-prompt`)
      return
    }

    const wsExtra: WorkspaceExtra = ws.extra ?? {}
    const wsExtraProjectDirectory = getForgeWorkspaceProjectDirectory(ws)
    const projectDirectory = wsExtraProjectDirectory ?? ws.directory ?? deps.directory
    const classifyEntry: ForgeWorkspaceEntry = {
      id: workspaceId,
      type: ws.type,
      extra: wsExtraProjectDirectory ? wsExtra : { ...wsExtra, projectDirectory },
    }
    const action = classifyForgeWorkspace(
      classifyEntry,
      deps.execDeps.loopsRepo,
      sessionProjectId,
      projectDirectory,
    )

    const isTerminalNameConflict =
      action.action === 'keep' &&
      action.reason === 'pending-start' &&
      cfg?.initialPromptOwner === 'tui' &&
      isPendingAttachWorkspace(classifyEntry)

    if (action.action === 'keep' && action.reason !== 'running' && action.reason !== 'pending-attach' && !isTerminalNameConflict) {
      deps.logger.log(
        `[forge-session-attach] skip session=${sessionId} workspace=${workspaceId} reason=${action.reason}`,
      )
      return
    }

    if ((action.action === 'remove-fully' && action.reason === 'missing-row') || (action.action === 'keep' && action.reason === 'pending-attach') || isTerminalNameConflict) {
      if (!cfg) {
        if (action.action === 'remove-fully') {
          await removeForgeWorkspaceWithContext(
            { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
            { workspaceId, loopName, action: 'remove-fully' },
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
          { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
          { workspaceId, loopName, action: 'remove-fully' },
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
      deps.logger.log(`[forge-session-attach] skip session=${sessionId} loop=${loopName} reason=already-running`)
      return
    } else if (action.action === 'remove-fully' && action.reason === 'completed') {
      await removeForgeWorkspaceWithContext(
        { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
        { workspaceId, loopName, action: 'remove-fully' },
      )
      publishAttachFailureToast(
        deps,
        ws.directory ?? deps.directory,
        `Forge loop "${loopName}"`,
        'Loop already completed. Run a new plan to start fresh.',
      )
      return
    } else if (action.action === 'remove-registration-only') {
      await removeForgeWorkspaceWithContext(
        { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
        { workspaceId, loopName, action: 'remove-registration-only' },
      )
      publishAttachFailureToast(
        deps,
        ws.directory ?? deps.directory,
        `Forge loop "${loopName}"`,
        `Loop "${loopName}" is in terminal status. Use Loop-status restart to resume.`,
      )
      return
    } else {
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
          { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
          { workspaceId, loopName, action: 'remove-fully' },
        )
        return
      }
      planText = row.content
    }

    try {
      const sandbox = await resolveAttachSandbox(deps, cfg, loopName, ws.directory ?? deps.directory)
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
          sandboxEnabled: sandbox.enabled,
          sandboxContainer: sandbox.containerName,
          planText,
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
            { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
            { workspaceId, loopName, action: removalAction },
          )
        } else if (!result.ok && result.code !== 'already_attached') {
          const row = deps.execDeps.loopsRepo.get(sessionProjectId, loopName)
          const removalAction = row?.status === 'cancelled' || row?.status === 'errored' || row?.status === 'stalled'
            ? 'remove-registration-only'
            : 'remove-fully'
          publishAttachFailureToast(deps, ws.directory ?? deps.directory, `Forge loop "${loopName}"`, removalAction === 'remove-registration-only'
            ? `Loop "${loopName}" is in terminal status. Use Loop-status restart to resume.`
            : `Failed to start loop: ${result.message}`)
          await removeForgeWorkspaceWithContext(
            { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
            { workspaceId, loopName, action: removalAction },
          )
        }
      } catch (err) {
        deps.logger.error('[forge-session-attach] attachLoopToSession threw', err)
        publishAttachFailureToast(deps, ws.directory ?? deps.directory, `Forge loop "${loopName}"`, 'Failed to start loop (unexpected error). Check forge logs.')
        await removeForgeWorkspaceWithContext(
          { client: deps.client, pendingTeardowns: deps.execDeps.pendingTeardowns, logger: deps.logger },
          { workspaceId, loopName, action: 'remove-fully' },
        )
      }
}

async function resolveAttachSandbox(
  deps: ForgeSessionAttachHookDeps,
  cfg: Pick<ForgeLoopExtra, 'sandboxEnabled' | 'sandboxContainer'> | undefined,
  loopName: string,
  worktreeDir: string | undefined,
): Promise<{ enabled: boolean; containerName?: string }> {
  if (cfg?.sandboxEnabled === false) return { enabled: false }
  if (!isSandboxEnabled(deps.execDeps.config, deps.execDeps.sandboxManager)) return { enabled: false }

  const sandbox = await resolveSandboxContextForLoop(
    deps.execDeps.sandboxManager,
    { loopName, active: true, sandbox: true, worktreeDir },
    deps.logger,
    { throwOnRestoreError: true },
  )
  if (sandbox) {
    return { enabled: true, containerName: sandbox.containerName }
  }

  if (!worktreeDir) {
    return { enabled: false }
  }

  return { enabled: cfg?.sandboxEnabled ?? false, containerName: cfg?.sandboxContainer }
}

function publishAttachFailureToast(
  deps: ForgeSessionAttachHookDeps,
  directory: string,
  title: string,
  message: string,
): void {
  publishToast({
    client: deps.client,
    directory,
    logger: deps.logger,
    title,
    message,
    variant: 'error',
    duration: 6000,
    logPrefix: '[forge-session-attach] failed to publish toast',
  })
}

async function findWorkspaceById(
  deps: ForgeSessionAttachHookDeps,
  workspaceId: string,
  directory?: string,
): Promise<ForgeWorkspaceEntry | null> {
  try {
    const entries = await deps.client.workspace.list(directory ? { directory } : undefined)
    return entries.find((e) => e.id === workspaceId) ?? null
  } catch {
    return null
  }
}
