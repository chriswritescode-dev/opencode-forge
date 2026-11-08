import { randomUUID } from 'node:crypto'
import type { PluginConfig, Logger } from '../types'
import type { LoopsRepo, LoopRow } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { SessionSandboxPreferencesRepo } from '../storage/repos/session-sandbox-preferences-repo'
import { getRestartability } from '../loop/restartability'
import { forgeWorktreesRoot, listForgeWorktreeDirs, loopBranchExists } from '../workspace/forge-naming'
import { isSandboxConfigEnabled } from '../sandbox/context'
import { readSandboxOverrides } from '../sandbox/loop-settings'
import { errorMessage } from '../utils/error-message'
import type { LoopInfo } from '../utils/tui-models'
import {
  FORGE_HOST_SANDBOX_DISABLED_ERROR,
  type ForgeHostSandboxSetInput,
  type ForgeHostSandboxSetOutput,
  type ForgeHostSandboxState,
  type ForgeHostSandboxStateOutput,
  type ForgeLoopRestartInput,
  type ForgeLoopRestartOutput,
  type ForgeLoopsOutput,
  type ForgeLoopSidebarOutput,
  type ForgeSessionPlanOutput,
  type ForgeWorktreesOutput,
} from '../host/forge-rpc'

export interface TuiRpcServiceDeps {
  projectId: string
  dataDir: string
  config: PluginConfig
  loopsRepo: LoopsRepo
  plansRepo: PlansRepo
  sandboxPreferences: SessionSandboxPreferencesRepo
  restartLoop(request: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput>
  /** Notified after the desired host-sandbox revision is written. */
  onHostSandboxChanged?: () => void
  logger: Logger
}

export interface TuiRpcService {
  listLoops(): ForgeLoopsOutput
  listLoopSidebar(limit: number): ForgeLoopSidebarOutput
  listWorktrees(): ForgeWorktreesOutput
  getSessionPlan(sessionId: string, projectId?: string): ForgeSessionPlanOutput
  restartLoop(request: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput>
  getHostSandboxState(): ForgeHostSandboxStateOutput
  requestHostSandbox(request: ForgeHostSandboxSetInput): ForgeHostSandboxSetOutput
}

function rowToLoopInfo(row: LoopRow): LoopInfo {
  const restartability = getRestartability({
    loopName: row.loopName,
    status: row.status,
    terminationReason: row.terminationReason,
    worktree: row.worktree,
    worktreeDir: row.worktreeDir,
    active: row.status === 'running',
  }, {
    branchExists: () => loopBranchExists(row, row.projectDir),
  })
  return {
    name: row.loopName,
    status: row.status,
    phase: row.phase,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    sessionId: row.currentSessionId,
    restartable: restartability.restartable,
    restartRequiresForce: restartability.restartRequiresForce,
    restartBlockedMessage: restartability.restartBlockedMessage,
    startedAt: new Date(row.startedAt).toISOString(),
    executionModel: row.executionModel ?? undefined,
    executionVariant: row.executionVariant ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    auditorVariant: row.auditorVariant ?? undefined,
    branch: row.worktreeBranch ?? undefined,
  }
}

/**
 * Session id -> sandbox flag for every session of every running loop, including each active
 * section lane's current and standby sessions. The TUI shows a lane session's sandbox state from
 * this map, so it must not be limited to the loop's lowest-index run.
 */
function collectActiveLoopSandboxes(loopsRepo: LoopsRepo, projectId: string): Record<string, boolean> {
  const sandboxes: Record<string, boolean> = {}
  for (const loop of loopsRepo.listByStatus(projectId, ['running'])) {
    const runKeys = loopsRepo.listActiveRunKeys(projectId, loop.loopName)
    const runs = runKeys.length > 0
      ? runKeys.map((runKey) => loopsRepo.getForRun(projectId, loop.loopName, runKey)).filter((row): row is LoopRow => row !== null)
      : [loop]
    for (const run of runs) {
      if (run.currentSessionId) sandboxes[run.currentSessionId] = run.sandbox
      if (run.standbySessionId) sandboxes[run.standbySessionId] = run.sandbox
    }
  }
  return sandboxes
}

export function createTuiRpcService(deps: TuiRpcServiceDeps): TuiRpcService {
  return {
    listLoops(): ForgeLoopsOutput {
      try {
        return { loops: deps.loopsRepo.listAll(deps.projectId).map((row) => rowToLoopInfo(row)) }
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    listLoopSidebar(limit: number): ForgeLoopSidebarOutput {
      try {
        return { loops: deps.loopsRepo.listSidebarRows(deps.projectId, limit) }
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    listWorktrees(): ForgeWorktreesOutput {
      const root = forgeWorktreesRoot(deps.dataDir)
      try {
        return { root, dirs: listForgeWorktreeDirs(deps.dataDir) }
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    getSessionPlan(sessionId: string, projectId?: string): ForgeSessionPlanOutput {
      try {
        return { plan: deps.plansRepo.getForSession(projectId ?? deps.projectId, sessionId)?.content ?? null }
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    async restartLoop(request: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput> {
      try {
        return await deps.restartLoop(request)
      } catch (err) {
        deps.logger.error('TUI loop restart failed', err)
        return { error: errorMessage(err) }
      }
    },

    getHostSandboxState(): ForgeHostSandboxStateOutput {
      try {
        const pair = deps.sandboxPreferences.getPair(deps.projectId)
        const state: ForgeHostSandboxState = {
          configEnabled: isSandboxConfigEnabled(deps.config),
          desired: pair.desired,
          applied: pair.applied,
          controller: pair.controller,
        }
        const activeLoopSandboxes = collectActiveLoopSandboxes(deps.loopsRepo, deps.projectId)
        if (Object.keys(activeLoopSandboxes).length > 0) {
          state.activeLoopSandboxes = activeLoopSandboxes
        }
        return state
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    requestHostSandbox(request: ForgeHostSandboxSetInput): ForgeHostSandboxSetOutput {
      if (!isSandboxConfigEnabled(deps.config)) {
        return { error: FORGE_HOST_SANDBOX_DISABLED_ERROR }
      }
      if (request.enabled === undefined && request.overrides === undefined) {
        return { error: 'Host sandbox request changes nothing: pass enabled or overrides' }
      }
      let revision: string
      try {
        revision = randomUUID()
        deps.sandboxPreferences.updateDesired(deps.projectId, (current) => {
          const binding = request.enabled !== undefined
            ? { enabled: request.enabled, sessionId: request.sessionId }
            : { enabled: current?.enabled ?? false, sessionId: current?.sessionId ?? request.sessionId }
          const overrides = request.overrides !== undefined ? readSandboxOverrides(request.overrides) : current?.overrides
          return {
            version: 1,
            revision,
            ...binding,
            requestedAt: Date.now(),
            ...(overrides ? { overrides } : {}),
          }
        })
      } catch (err) {
        return { error: errorMessage(err) }
      }
      deps.onHostSandboxChanged?.()
      return { revision }
    },
  }
}
