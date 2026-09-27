import { randomUUID } from 'node:crypto'
import type { PluginConfig, Logger } from '../types'
import type { LoopsRepo, LoopRow } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { SessionSandboxPreferencesRepo } from '../storage/repos/session-sandbox-preferences-repo'
import { getRestartability } from '../loop/restartability'
import { forgeWorktreesRoot, listForgeWorktreeDirs, loopBranchExists } from '../workspace/forge-naming'
import { isSandboxConfigEnabled } from '../sandbox/context'
import { errorMessage } from '../utils/error-message'
import type { LoopInfo } from '../utils/tui-models'
import {
  FORGE_HOST_SANDBOX_DISABLED_ERROR,
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
  getSessionPlan(sessionId: string): ForgeSessionPlanOutput
  restartLoop(request: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput>
  getHostSandboxState(): ForgeHostSandboxStateOutput
  requestHostSandbox(sessionId: string, enabled: boolean): ForgeHostSandboxSetOutput
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
  }
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

    getSessionPlan(sessionId: string): ForgeSessionPlanOutput {
      try {
        return { plan: deps.plansRepo.getForSession(deps.projectId, sessionId)?.content ?? null }
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
        const activeLoops = deps.loopsRepo.listByStatus(deps.projectId, ['running'])
        if (activeLoops.length > 0) {
          state.activeLoopSandboxes = Object.fromEntries(activeLoops.map((loop) => [loop.currentSessionId, loop.sandbox]))
        }
        return state
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    requestHostSandbox(sessionId: string, enabled: boolean): ForgeHostSandboxSetOutput {
      if (!isSandboxConfigEnabled(deps.config)) {
        return { error: FORGE_HOST_SANDBOX_DISABLED_ERROR }
      }
      let revision: string
      try {
        revision = randomUUID()
        deps.sandboxPreferences.setDesired(deps.projectId, {
          version: 1,
          revision,
          enabled,
          sessionId,
          requestedAt: Date.now(),
        })
      } catch (err) {
        return { error: errorMessage(err) }
      }
      deps.onHostSandboxChanged?.()
      return { revision }
    },
  }
}
