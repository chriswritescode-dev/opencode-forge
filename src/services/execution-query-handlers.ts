/**
 * Forge Execution Service - Loop Query Handlers
 *
 * Extracted from execution.ts. Contains the read-only status handler and the
 * cancel handler for loops. Types and response helpers come from
 * ./execution-types to avoid any cycle back into the execution facade.
 */

import { findPartialMatch } from '../utils/partial-match'
import { aggregateToUsageSummary } from '../utils/loop-format'
import { existsSync } from 'fs'
import { terminationStatusFor, parseTerminationReasonString } from '../loop'
import { getRestartability } from '../loop/restartability'
import { loopBranchExists } from '../workspace/forge-naming'

import {
  ok,
  fail,
  type ForgeExecutionRequestContext,
  type ForgeExecutionResponse,
  type ForgeExecutionServiceDeps,
  type CancelLoopCommand,
  type GetLoopStatusCommand,
  type LoopStatusView,
  type LoopStatusResult,
  type LoopCancelledResult,
} from './execution-types'

// ============================================================================
// Handler factory
// ============================================================================

export function createLoopQueryHandlers(deps: ForgeExecutionServiceDeps) {
  async function handleLoopStatus(
    _ctx: ForgeExecutionRequestContext,
    command: GetLoopStatusCommand,
  ): Promise<ForgeExecutionResponse<LoopStatusResult>> {
    let states: import('../loop/state').LoopState[]

    if (command.selector?.kind === 'only-active') {
      states = deps.loop.listActive()
    } else {
      const active = deps.loop.listActive()
      const recent = deps.loop.listRecent()
      states = [...active, ...recent]
    }

    // Apply selector filtering
    if (command.selector?.kind === 'exact' || command.selector?.kind === 'partial') {
      const { match, candidates } = findPartialMatch(
        command.selector.name,
        states,
        (s) => [s.loopName, s.worktreeBranch].filter(Boolean) as string[]
      )

      if (!match && candidates.length === 0 && command.selector.kind === 'exact') {
        return fail('not_found', 404, `No loop found for "${command.selector.name}"`)
      }

      if (!match && candidates.length > 0) {
        return fail('conflict', 409, `Multiple loops match "${command.selector.name}"`, undefined, candidates.map(s => s.loopName))
      }

      if (match) {
        states = [match]
      } else {
        states = []
      }
    }

    // Limit results
    const limit = command.limit ?? 20
    if (states.length > limit) {
      states = states.slice(0, limit)
    }

    const statusFromState = (state: import('../loop/state').LoopState): LoopStatusView['status'] => {
      if (state.active) return 'running'
      if (state.terminationReason) return terminationStatusFor(parseTerminationReasonString(state.terminationReason))
      return 'completed'
    }

    // Convert to status views
    const loops: LoopStatusView[] = states.map(state => {
      const cap200 = (s: string | null | undefined): string | null =>
        s ? (s.length > 200 ? s.slice(0, 200) : s) : null
      const sectionViews = state.totalSections > 0
        ? (() => {
            const digest = deps.loop.service.getCompletedSectionDigest(state)
            const sectionByIndex = new Map(
              (deps.sectionPlansRepo?.list(deps.projectId, state.loopName) ?? []).map(s => [s.sectionIndex, s] as const),
            )
            return Array.from({ length: state.totalSections }, (_, i) => {
              const section = sectionByIndex.get(i)
              const summary = digest.find(s => s.index === i)
              return {
                index: i,
                title: section?.title ?? `Section ${i + 1}`,
                status: section?.status ?? 'pending',
                attempts: section?.attempts ?? 0,
                startedAt: section?.startedAt,
                completedAt: section?.completedAt,
                summaryDone: cap200(summary?.summaryDone),
                summaryDeviations: cap200(summary?.summaryDeviations),
                summaryFollowUps: cap200(summary?.summaryFollowUps),
              }
            })
          })()
        : undefined

      // Fetch cumulative usage from persisted aggregate
      let usage: import('../loop/token-usage').LoopUsageSummary | undefined
      if (deps.loopSessionUsageRepo) {
        const aggregate = deps.loopSessionUsageRepo.getAggregate(deps.projectId, state.loopName)
        if (aggregate) {
          usage = aggregateToUsageSummary(aggregate)
        }
      }

      const restartability = getRestartability(state, {
        worktreeExists: existsSync,
        branchExists: () => loopBranchExists(state, _ctx.directory),
      })

      return {
        loopName: state.loopName,
        displayName: state.loopName, // Could extract from plan if needed
        kind: state.kind ?? 'plan',
        goal: state.goal,
        status: statusFromState(state),
        phase: state.phase,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        sessionId: state.sessionId,
        active: state.active,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        terminationReason: state.terminationReason,
        completionSummary: state.completionSummary,
        worktree: !!state.worktree,
        worktreeDir: state.worktreeDir,
        worktreeBranch: state.worktreeBranch,
        executionModel: state.executionModel,
        auditorModel: state.auditorModel,
        workspaceId: state.workspaceId,
        hostSessionId: state.hostSessionId,
        currentSectionIndex: state.currentSectionIndex,
        totalSections: state.totalSections,
        finalAuditDone: state.finalAuditDone,
        usage,
        restartable: restartability.restartable,
        restartRequiresForce: restartability.restartRequiresForce,
        restartBlockedReason: restartability.restartBlockedReason,
        restartBlockedMessage: restartability.restartBlockedMessage,
        sections: sectionViews,
      }
    })

    const active = loops.filter(l => l.active)
    const recent = loops.filter(l => !l.active)

    return ok({
      operation: 'loop.status',
      loops,
      active,
      recent,
    })
  }

  async function handleLoopCancel(
    _ctx: ForgeExecutionRequestContext,
    command: CancelLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopCancelledResult>> {
    if (!deps.loopHandler) {
      return fail('internal_error', 500, 'Loop handler not available')
    }

    let state: import('../loop/state').LoopState

    // Resolve loop by selector
    if (!command.selector || command.selector.kind === 'only-active') {
      const active = deps.loop.listActive()
      if (active.length === 0) return fail('not_found', 404, 'No active loops.')
      if (active.length !== 1) {
        return fail('conflict', 409, 'Multiple active loops. Specify a name.', undefined, active.map(s => s.loopName))
      }
      state = active[0]
    } else {
      const name = command.selector.name
      const { match, candidates } = deps.loop.findMatchByName(name)
      if (!match) {
        if (candidates.length > 0) {
          return fail('conflict', 409, `Multiple loops match "${name}". Be more specific.`, undefined, candidates.map(s => s.loopName))
        }
        const recent = deps.loop.listRecent()
        const foundRecent = recent.find(s => s.loopName === name || (s.worktreeBranch && s.worktreeBranch.toLowerCase().includes(name.toLowerCase())))
        if (foundRecent) {
          return fail('conflict', 409, `Loop "${foundRecent.loopName}" has already completed.`)
        }
        return fail('not_found', 404, `No active loop found for loop "${name}".`)
      }
      state = match
      if (!state.active) {
        return fail('conflict', 409, `Loop "${state.loopName}" has already completed.`)
      }
    }

    await deps.loopHandler.cancelBySessionId(state.sessionId)
    deps.logger.log(`loop-cancel: cancelled loop for session=${state.sessionId} at iteration ${state.iteration}`)

    let worktreeRemoved = false
    const cleanupRequested = command.cleanupWorktree ?? deps.config.loop?.cleanupWorktree
    if (cleanupRequested && state.worktree && state.worktreeDir) {
      const { cleanupLoopWorktree } = await import('../utils/worktree-cleanup')
      const result = await cleanupLoopWorktree({
        worktreeDir: state.worktreeDir,
        logPrefix: 'loop-cancel',
        logger: deps.logger,
      })
      worktreeRemoved = result.removed
    }

    return ok({
      operation: 'loop.cancel',
      loopName: state.loopName,
      sessionId: state.sessionId,
      iteration: state.iteration,
      worktreeDir: state.worktreeDir,
      worktreeRemoved,
      worktree: !!state.worktree,
      worktreeBranch: state.worktreeBranch,
    })
  }

  return { handleLoopStatus, handleLoopCancel }
}
