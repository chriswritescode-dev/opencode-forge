import type { Database } from 'bun:sqlite'
import type { GoalOrchestrator } from '../../src/services/goal-orchestrator'
import { createGoalsRepo } from '../../src/storage/repos/goals-repo'
import type { ToolContext } from '../../src/tools/types'
import { PLAN_EXECUTION_LABELS } from '../../src/utils/plan-execution'
import { buildExecutionDeps } from './loop-fixtures'

/**
 * Builds a fully typed `ToolContext` over a migrated test database.
 *
 * Repos, fake client, logger, loop service and loop handler come from
 * `buildExecutionDeps`, so a test overrides only the members it exercises.
 */
export function buildToolContext(overrides: Partial<ToolContext> & { db: Database }): ToolContext {
  const { db, loop, loopHandler, ...contextOverrides } = overrides
  const { deps } = buildExecutionDeps(db, { ...contextOverrides, loop, loopHandler })
  const base: ToolContext = {
    projectId: deps.projectId,
    directory: deps.directory,
    config: deps.config,
    logger: deps.logger as ToolContext['logger'],
    db,
    dataDir: deps.dataDir,
    loopHandler: deps.loopHandler!,
    loop: deps.loop,
    client: deps.client,
    cleanup: async () => {},
    sandboxManager: deps.sandboxManager ?? null,
    plansRepo: deps.plansRepo,
    reviewFindingsRepo: deps.reviewFindingsRepo!,
    loopsRepo: deps.loopsRepo,
    goalsRepo: createGoalsRepo(db),
    goalOrchestrator: {} as GoalOrchestrator,
    sectionPlansRepo: deps.sectionPlansRepo!,
    pendingTeardowns: deps.pendingTeardowns,
    resolveActiveLoopForSession: async (sessionID) => {
      const state = deps.loop.service.resolveActiveLoopForSession(sessionID)
      return state
        ? {
            loopName: state.loopName,
            active: state.active,
            sandbox: state.sandbox,
            worktree: state.worktree,
            worktreeDir: state.worktreeDir,
            workspaceId: state.workspaceId,
          }
        : null
    },
  }
  return { ...base, ...contextOverrides }
}

/** Returns question args whose options are exactly the {@link PLAN_EXECUTION_LABELS} entries. */
export function planApprovalQuestionArgs() {
  return {
    questions: [
      {
        question: 'How do you want to proceed?',
        options: PLAN_EXECUTION_LABELS.map((label) => ({ label, description: '' })),
      },
    ],
  }
}
