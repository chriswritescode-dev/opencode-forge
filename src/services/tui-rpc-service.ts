import { randomUUID } from 'node:crypto'
import { readdirSync } from 'fs'
import { join } from 'path'
import type { PluginConfig, Logger } from '../types'
import type { LoopsRepo, LoopRow } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { SessionSandboxPreferencesRepo } from '../storage/repos/session-sandbox-preferences-repo'
import { getRestartability } from '../loop/restartability'
import { forgeWorktreesRoot, loopBranchExists } from '../workspace/forge-naming'
import { isSandboxConfigEnabled } from '../sandbox/context'
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
  sectionPlansRepo: SectionPlansRepo
  plansRepo: PlansRepo
  sandboxPreferences: SessionSandboxPreferencesRepo
  restartLoop(request: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput>
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const cap200 = (s: string | null | undefined): string | null =>
  s ? (s.length > 200 ? s.slice(0, 200) : s) : null

function buildSectionViews(rows: SectionPlanRow[]): NonNullable<LoopInfo['sections']> {
  return rows.map((sp) => ({
    index: sp.sectionIndex,
    title: sp.title,
    status: sp.status,
    attempts: sp.attempts,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    summaryDone: cap200(sp.summaryDone),
    summaryDeviations: cap200(sp.summaryDeviations),
    summaryFollowUps: cap200(sp.summaryFollowUps),
  }))
}

function rowToLoopInfo(row: LoopRow, sectionPlans?: SectionPlanRow[]): LoopInfo {
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
  const base: LoopInfo = {
    name: row.loopName,
    status: row.status,
    phase: row.phase,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    sessionId: row.currentSessionId,
    active: row.status === 'running',
    restartable: restartability.restartable,
    restartRequiresForce: restartability.restartRequiresForce,
    restartBlockedMessage: restartability.restartBlockedMessage,
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    terminationReason: row.terminationReason ?? undefined,
    worktree: row.worktree || undefined,
    worktreeDir: row.worktreeDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    auditorVariant: row.auditorVariant ?? undefined,
    executionVariant: row.executionVariant ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    hostSessionId: row.hostSessionId ?? undefined,
    currentSectionIndex: row.currentSectionIndex,
    totalSections: row.totalSections,
    finalAuditDone: !!row.finalAuditDone,
  }
  if (sectionPlans && sectionPlans.length > 0) {
    return { ...base, sections: buildSectionViews(sectionPlans) }
  }
  return base
}

export function createTuiRpcService(deps: TuiRpcServiceDeps): TuiRpcService {
  return {
    listLoops(): ForgeLoopsOutput {
      try {
        const loops = deps.loopsRepo.listAll(deps.projectId).map((row) => {
          const plans = deps.sectionPlansRepo.list(deps.projectId, row.loopName)
          return rowToLoopInfo(row, plans.length > 0 ? plans : undefined)
        })
        return { loops }
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
        const dirs = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, entry.name))
        return { root, dirs }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { root, dirs: [] }
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
      try {
        const revision = randomUUID()
        deps.sandboxPreferences.setDesired(deps.projectId, {
          version: 1,
          revision,
          enabled,
          sessionId,
          requestedAt: Date.now(),
        })
        return { revision }
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },
  }
}
