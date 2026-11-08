import type { Logger, LoopConfig } from '../types'
import type { LoopsRepo, LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
import type { LoopState } from './state'
import type { LoopLane, SectionRunTarget } from './section-run'
import type { SectionRunActivateFields } from '../storage/repos/section-runs-repo'
import { auditScope, loopRowToState, loopStateToRow } from './state'
import { createHash, randomUUID } from 'node:crypto'
import type { LoopAttemptsRepo, LoopAttemptRow } from '../storage/repos/loop-attempts-repo'
import { captureAuditSnapshot, compareAuditSnapshots, deleteAuditSnapshot } from '../utils/audit-snapshot'
import {
  buildContinuationPrompt as _buildContinuationPrompt,
  buildPlanInitialPrompt as _buildPlanInitialPrompt,
  buildAuditPrompt as _buildAuditPrompt,
  buildSectionInitialPrompt as _buildSectionInitialPrompt,
  buildSectionAuditPrompt as _buildSectionAuditPrompt,
  buildSectionContinuationPrompt as _buildSectionContinuationPrompt,
  buildCoderFollowUpPrompt as _buildCoderFollowUpPrompt,
  buildAuditFollowUpPrompt as _buildAuditFollowUpPrompt,
  buildPostActionPrompt as _buildPostActionPrompt,
  type PostActionPromptOptions,
  type PromptContext,
} from './prompts'
import { terminationStatusFor, terminationReasonToString, type TerminationReason } from './termination'
import { bumpRecurrence, findingRecurrenceKey, hasEscalatedFindings } from './finding-recurrence'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'
import { extractSectionFiles } from '../utils/plan-structure'
import { canonicalizePath } from '../sandbox/path'
import { parseForgeLaneDir } from '../workspace/forge-naming'
import { blockingBugFindings, isFindingInSectionScope, resolveSectionScope, type SectionScope } from './section-scope'
import { generatedSectionId, isLastOpenSectionIndex, pendingSuffixStart, selectNextSection, validateSectionGraph, type SectionGraphNode } from './section-graph'
import type { PlanSection } from '../services/deterministic-decomposer'
import { attemptCodeGraphReportPath, buildCodeGraphPromptBlock, sectionCodeGraphReportPath } from './code-graph'
import type { LoopHandoffRecord, LoopHandoffRecordFor, LoopHandoffRole, LoopHandoffWriteInput } from './handoff'
import { stripLeadingStructuralOrdinal } from '../utils/format'

export const MAX_RETRIES = 3
const STALL_TIMEOUT_MS = 60_000
const MAX_CONSECUTIVE_STALLS = 5
const BUSY_STALL_TIMEOUT_MS = 900_000

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/** A per-run mutator target: an explicit lane, or a loop name for the loop's primary run. */
type LoopLaneRef = LoopLane | string

function laneRef(ref: LoopLaneRef): { loopName: string; runKey: string | undefined } {
  return typeof ref === 'string'
    ? { loopName: ref, runKey: undefined }
    : { loopName: ref.loopName, runKey: ref.sectionRunKey }
}

/**
 * Reasons a loop row changed. `terminate` fires when the terminal status is
 * persisted; `settled` fires once afterwards, once termination side effects
 * (teardown commit, sandbox stop, worktree cleanup) have finished.
 */
export type LoopChangeReason =
  | 'insert' | 'delete' | 'terminate' | 'settled'
  | 'rotate' | 'phase' | 'iteration'
  | 'status' | 'session'
  | 'sandbox' | 'workspace' | 'audit-result' | 'post-action-report'
  | 'model-failed' | 'error' | 'sections-adjusted' | 'auditor-fallback'

export type LoopChangeNotifier = (reason: LoopChangeReason, loopName: string, hint?: { projectDir?: string; worktreeDir?: string }) => void

export interface LoopService {
  getActiveState(name: string): LoopState | null
  /** The loop row joined to one specific active section run, or null when that run is absent/finished. */
  getRunState(name: string, runKey: string): LoopState | null
  /** Every active section run of a running loop, primary first. */
  listActiveRunStates(name: string): LoopState[]
  /** The active section run that owns `sessionId`, or null when the session is not any running loop's current run session. */
  getRunStateForSession(sessionId: string): LoopState | null
  /** Activate (insert or reactivate) one section run row; `exclusive` finishes the loop's other active runs first. */
  activateSectionRun(loopName: string, target: SectionRunTarget, fields: SectionRunActivateFields, opts?: { exclusive?: boolean }): void
  /** Mark one section run finished. */
  finishRun(lane: LoopLaneRef): void
  /** Persist the loop-wide iteration counter. */
  setIteration(name: string, iteration: number): void
  getAnyState(name: string): LoopState | null
  setState(name: string, state: LoopState): void
  /** In-place row restore via UPDATE (preserves child rows such as loop_transitions/section_plans that would be cascade-deleted by deleteState + setState). Falls back to INSERT if the row was concurrently deleted. */
  restoreState(name: string, state: LoopState): void
  deleteState(name: string): void
  registerLoopSession(sessionId: string, lane: LoopLaneRef): void
  resolveLoopName(sessionId: string): string | null
  /**
   * The loop this session is currently driving, or null. `resolveLoopName`
   * matches terminated loops too, so every "is this session inside a running
   * loop" check must go through here instead of testing loop-row existence.
   * The session is matched through the loop's active section run.
   */
  resolveActiveLoopForSession(sessionId: string): LoopState | null
  findActiveByWorktreeDir(directory: string, options?: { worktreeOnly?: boolean }): LoopState | null
  buildContinuationPrompt(state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string
  /** Short same-section retry prompt for a reused coder session; the session already holds the plan and history. */
  buildCoderFollowUpPrompt(state: LoopState, outstandingBugs?: ReviewFindingRow[], notice?: string): string
  /** Short same-section follow-up prompt for a reused audit session. */
  buildAuditFollowUpPrompt(state: LoopState): string
  buildAuditPrompt(state: LoopState): string
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  getStallTimeoutMs(): number
  getMaxConsecutiveStalls(): number
  getBusyStallTimeoutMs(): number
  terminateAll(): Promise<void>
  hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean
  getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  /**
   * Bug findings that block the current section: cross-section findings and
   * findings attributed to the current section or a section it depends on. On
   * the last open section every finding blocks. Every bug blocks a
   * non-sectioned loop.
   */
  getBlockingBugFindings(state: LoopState): ReviewFindingRow[]
  /** The sections whose findings block the current section (see `resolveSectionScope`). */
  getSectionScope(state: LoopState): SectionScope
  /**
   * Whether any bug finding that blocks the current section (sectioned loops)
   * or the plan (non-sectioned loops) has reached the recurrence escalation
   * threshold. Escalated findings force fresh sessions for both roles.
   */
  hasEscalatedBugFindings(state: LoopState): boolean
  setCoderDecisions(name: string, decisions: string | null): void
  captureAttempt(state: LoopState, completionKey: string, decisions: string | null): Promise<boolean>
  finishAttempt(state: LoopState, outcome: 'clean' | 'dirty'): void
  getAttemptHistory(name: string, scope?: string, limit?: number, beforeId?: number): LoopAttemptRow[]
  bumpFindingRecurrence(name: string, findings: ReviewFindingRow[]): void
  resetSectionRecurrence(name: string, sectionIndex: number): void
  getPlanText(loopName: string, sessionId: string): string | null
  incrementError(lane: LoopLaneRef): number
  resetError(lane: LoopLaneRef): void
  /** Compare-and-swap advance of the auditor fallback index; returns the new index on success or null when the loop is absent/non-running/index mismatch. */
  advanceAuditorFallbackIndex(lane: LoopLaneRef, fromIndex: number, toIndex: number): number | null
  /** Reset the auditor fallback index to 0 after a successful audit; returns true when a running row was actually changed. */
  resetAuditorFallbackIndex(lane: LoopLaneRef): boolean
  setPhase(lane: LoopLaneRef, phase: LoopState['phase']): void
  setPhaseAndResetError(lane: LoopLaneRef, phase: LoopState['phase']): void
  setModelFailed(lane: LoopLaneRef, failed: boolean): void
  setLastAuditResult(name: string, text: string): void
  clearLastAuditResult(name: string): void
  setPostActionReport(name: string, text: string): void
  setSandboxContainer(name: string, containerName: string | null): void
  /**
   * Record (or clear, with null) the other role's session kept for reuse on the
   * next same-section phase switch.
   */
  setStandbySessionId(lane: LoopLaneRef, sessionId: string | null): void
  setStatus(name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'): void
  clearWorkspaceId(name: string): void
  setWorkspaceId(name: string, workspaceId: string): void
  terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void
  replaceSession(lane: LoopLaneRef, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getSectionPlans(state: LoopState): SectionPlanRow[]
  /** Persist a section's code-graph report and write it into the loop worktree. */
  recordSectionCodeGraph(state: LoopState, index: number, text: string): void
  /** Record the commit sha of a completed section's checkpoint commit. */
  setSectionCheckpointCommit(loopName: string, index: number, sha: string): void
  /** Persist an audit attempt's code-graph report and write it into the loop worktree. */
  recordAttemptCodeGraph(state: LoopState, attempt: LoopAttemptRow, text: string): void
  /** The newest attempt row for the state's current audit scope, or null when attempts are not stored. */
  getLatestAttempt(state: LoopState): LoopAttemptRow | null
  getNextReadySectionPlan(state: LoopState): SectionPlanRow | null
  /** Repo-relative files a section plans to touch; the parallel scheduler's single source of file lists. */
  sectionFilesOf(row: SectionPlanRow): string[]
  getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[]

  buildPlanInitialPrompt(planText: string): string
  buildSectionInitialPrompt(state: LoopState): string
  buildSectionAuditPrompt(state: LoopState): string
  buildSectionContinuationPrompt(state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string
  buildPostActionPrompt(state: LoopState, opts: PostActionPromptOptions): string
  completeSection(loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }): void
  incrementSectionAttempts(loopName: string, index: number): void
  resetSectionForRewind(loopName: string, index: number): void
  setCurrentSectionIndex(lane: LoopLaneRef, index: number): void
  /**
   * Whether `state` is the loop's last open section: every other section plan
   * row is already completed. Covers both the final index and the rewind case
   * where all later sections finished before the current one.
   */
  isLastOpenSection(state: LoopState): boolean
  startSection(loopName: string, index: number): void
  bulkInsertSections(loopName: string, sections: PlanSection[]): void
  setTotalSections(loopName: string, total: number): void
  recordTransition(name: string, entry: {
    eventType: string
    transitionKind: string
    fromPhase: string
    toPhase: string | null
    status?: string | null
    reason?: string | null
    iteration: number
    sectionIndex?: number | null
  }): void
  recordTerminalTransition(name: string, entry: {
    reason: TerminationReason
    fromPhase: string
    iteration: number
    sectionIndex: number | null
    eventType?: string
  }): void
  recordPendingHandoff(input: LoopHandoffWriteInput): { record: LoopHandoffRecord; replaced: boolean }
  getPendingHandoff(loopName: string, sectionRunKey: string): LoopHandoffRecord | null
  /** Applies the session's pending handoff only when its role matches; any other pending row is left untouched. */
  applyPendingHandoff<R extends LoopHandoffRole>(loopName: string, sectionRunKey: string, sessionId: string, role: R): LoopHandoffRecordFor<R> | null
  /** Omitting `sectionRunKey` discards every pending handoff of the loop (cancel/restart path). */
  discardPendingHandoff(loopName: string, sectionRunKey?: string): void
  listHandoffs(loopName: string, limit?: number): LoopHandoffRecord[]
  adjustRemainingSections(name: string, args: {
    sections?: { title: string; content: string; id?: string; after?: string[] }[]
    currentSection?: { title: string; content: string }
    /**
     * Id-addressed edits to any section: updates its text, reopens a completed
     * section, and reports running lanes that must restart coding.
     */
    edits?: { id: string; title: string; content: string; after?: string[] }[]
    rationale: string
    auditorSessionId: string
  }): Promise<{ ok: true; totalSections: number; restartRuns: string[] } | { ok: false; error: string }>
}

export function createLoopService(
  loopsRepo: LoopsRepo,
  plansRepo: PlansRepo,
  reviewFindingsRepo: ReviewFindingsRepo,
  projectId: string,
  logger: Logger,
  loopConfig?: LoopConfig,
  notify?: LoopChangeNotifier,
  sectionPlansRepo?: SectionPlansRepo,
  loopTransitionsRepo?: LoopTransitionsRepo,
  planAmendmentsRepo?: PlanAmendmentsRepo,
  runExclusive?: <T>(loopName: string, fn: () => Promise<T>) => Promise<T>,
  loopAttemptsRepo?: LoopAttemptsRepo,
  codeGraphEnabled = true,
): LoopService {
  const notifyLoopChange: LoopChangeNotifier = notify ?? (() => {})
  const coderDecisionsByLoop = new Map<string, string>()
  const findingRecurrenceByLoop = new Map<string, Map<string, number>>()

  function hydratePlanFromPlans(state: LoopState): LoopState {
    const planRow = plansRepo.getForLoopOrSession?.(projectId, state.loopName, state.sessionId) ?? null
    if (planRow) {
      state.prompt = planRow.content
    }
    return state
  }

  function getAnyState(name: string): LoopState | null {
    const row = loopsRepo.get(projectId, name)
    if (!row) return null
    const large = loopsRepo.getLarge(projectId, name)
    const state = loopRowToState(row, large)
    return hydratePlanFromPlans(state)
  }

  function getActiveState(name: string): LoopState | null {
    const state = getAnyState(name)
    if (!state?.active) {
      return null
    }
    return state
  }

  function getRunState(name: string, runKey: string): LoopState | null {
    const row = loopsRepo.getForRun(projectId, name, runKey)
    if (!row || row.runStatus !== 'active') return null
    const large = loopsRepo.getLarge(projectId, name)
    return hydratePlanFromPlans(loopRowToState(row, large))
  }

  function getRunStateForSession(sessionId: string): LoopState | null {
    const row = loopsRepo.getBySessionId(projectId, sessionId)
    if (!row || row.runStatus !== 'active') return null
    const large = loopsRepo.getLarge(projectId, row.loopName)
    return hydratePlanFromPlans(loopRowToState(row, large))
  }

  function listActiveRunStates(name: string): LoopState[] {
    const large = loopsRepo.getLarge(projectId, name)
    const states: LoopState[] = []
    for (const runKey of loopsRepo.listActiveRunKeys(projectId, name)) {
      const row = loopsRepo.getForRun(projectId, name, runKey)
      if (row?.runStatus === 'active') states.push(hydratePlanFromPlans(loopRowToState(row, large)))
    }
    return states
  }

  /**
   * Shared persistence body for {@link setState} (fresh INSERT) and
   * {@link restoreState} (in-place UPDATE preserving child rows).
   */
  function persistState(name: string, state: LoopState, mode: 'insert' | 'restore'): void {
    const label = mode === 'insert' ? 'setState' : 'restoreState'
    if (state.loopName !== name) {
      throw new Error(`${label}: name parameter "${name}" does not match state.loopName "${state.loopName}"`)
    }
    const row = loopStateToRow(state, projectId)
    const large: LoopLargeFields = {
      lastAuditResult: state.lastAuditResult ?? null,
      postActionReport: state.postActionReport ?? null,
    }
    if (mode === 'insert') {
      const ok = loopsRepo.insert(row, large)
      if (!ok) {
        throw new Error(`setState: loop "${name}" already exists`)
      }
    } else {
      loopsRepo.restore(row, large)
    }
    if (state.prompt) {
      plansRepo.writeForLoop(projectId, name, state.prompt)
    }
    notifyLoopChange(mode === 'insert' ? 'insert' : 'rotate', name, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
  }

  function setState(name: string, state: LoopState): void {
    persistState(name, state, 'insert')
  }

  function deleteState(name: string): void {
    const state = getAnyState(name)
    const snapshots: LoopAttemptRow[] = []
    let beforeId: number | undefined
    for (;;) {
      const page = getAttemptHistory(name, undefined, 100, beforeId)
      snapshots.push(...page.filter(row => row.snapshotRef !== null))
      if (page.length < 100) break
      beforeId = page[0].id
    }
    loopsRepo.delete(projectId, name)
    plansRepo.deleteForLoop(projectId, name)
    coderDecisionsByLoop.delete(name)
    findingRecurrenceByLoop.delete(name)
    void (async () => {
      for (const snapshot of snapshots) {
        await deleteAuditSnapshot(snapshot.worktreeDir, snapshot.snapshotRef!, logger).catch(err => logger.error('Loop: deleted-loop checkpoint cleanup failed', err))
      }
    })()
    notifyLoopChange('delete', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function restoreState(name: string, state: LoopState): void {
    persistState(name, state, 'restore')
  }

  function setStatus(name: string, status: LoopRow['status']): void {
    const state = getAnyState(name)
    loopsRepo.setStatus(projectId, name, status)
    notifyLoopChange('status', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function registerLoopSession(sessionId: string, ref: LoopLaneRef): void {
    const { loopName, runKey } = laneRef(ref)
    const state = getAnyState(loopName)
    loopsRepo.setCurrentSessionId(projectId, loopName, sessionId, runKey)
    notifyLoopChange('session', loopName, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function resolveLoopName(sessionId: string): string | null {
    return loopsRepo.getBySessionId(projectId, sessionId)?.loopName ?? null
  }

  function resolveActiveLoopForSession(sessionId: string): LoopState | null {
    const state = getRunStateForSession(sessionId)
    return state && state.sessionId === sessionId && state.active ? state : null
  }

  /**
   * Resolves a lane directory to the active section run whose `laneDir` matches;
   * any other directory matches a loop worktree exactly.
   */
  function findActiveByWorktreeDir(directory: string, options?: { worktreeOnly?: boolean }): LoopState | null {
    const canonical = canonicalizePath(directory)
    const lane = parseForgeLaneDir(directory)
    if (lane) {
      const loopWorktree = canonicalizePath(lane.loopWorktreeDir)
      for (const row of loopsRepo.listByStatus(projectId, ['running'])) {
        if (!row.worktreeDir || canonicalizePath(row.worktreeDir) !== loopWorktree) continue
        if (options?.worktreeOnly && !row.worktree) continue
        for (const state of listActiveRunStates(row.loopName)) {
          if (state.laneDir && canonicalizePath(state.laneDir) === canonical) return state
        }
      }
      return null
    }
    for (const state of listActive()) {
      if (!state.worktreeDir) continue
      if (options?.worktreeOnly && !state.worktree) continue
      if (canonicalizePath(state.worktreeDir) === canonical) return state
    }
    return null
  }

  function replaceSession(ref: LoopLaneRef, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    const replace = () => loopsRepo.replaceSession(projectId, name, {
      sessionId: opts.newSessionId,
      phase: opts.phase,
      iteration: opts.iteration,
      resetError: opts.resetError,
      auditCount: opts.auditCount,
      lastAuditResult: opts.lastAuditResult,
    }, runKey)
    if (state && loopAttemptsRepo && opts.phase === 'auditing') {
      loopAttemptsRepo.bindAudit(projectId, name, auditScope({ ...state, phase: opts.phase }), state.sessionId, opts.newSessionId, replace)
    } else replace()
    notifyLoopChange('rotate', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function activateSectionRun(
    loopName: string,
    target: SectionRunTarget,
    fields: SectionRunActivateFields,
    opts?: { exclusive?: boolean },
  ): void {
    const state = getAnyState(loopName)
    loopsRepo.activateSectionRun(projectId, loopName, target, fields, { exclusive: opts?.exclusive ?? false })
    notifyLoopChange('rotate', loopName, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function finishRun(ref: LoopLaneRef): void {
    const { loopName: name, runKey } = laneRef(ref)
    if (!runKey) return
    const state = getAnyState(name)
    loopsRepo.finishRun(projectId, name, runKey)
    notifyLoopChange('rotate', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setIteration(name: string, iteration: number): void {
    const state = getAnyState(name)
    loopsRepo.updateIteration(projectId, name, iteration)
    notifyLoopChange('iteration', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function getFindingRecurrence(loopName?: string): Map<string, number> {
    if (!loopName) return new Map()
    if (loopAttemptsRepo) {
      const state = getAnyState(loopName)
      if (!state) return new Map()
      const counts = new Map<string, number>()
      let candidates: Set<string> | undefined
      let beforeId: number | undefined
      for (;;) {
        const rows = loopAttemptsRepo.list(projectId, loopName, auditScope(state), 100, beforeId)
        for (const row of rows.slice().reverse()) {
          if (!row.outcome) continue
          if (row.outcome === 'clean') return counts
          const keys = new Set((row.findingsAfter ?? []).filter(f => f.severity === 'bug').map(findingRecurrenceKey))
          candidates = candidates ? new Set([...candidates].filter(key => keys.has(key))) : keys
          if (candidates.size === 0) return counts
          for (const key of candidates) counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        if (rows.length < 100) return counts
        beforeId = rows[0].id
      }
    }
    return findingRecurrenceByLoop.get(loopName) ?? new Map()
  }

  const _promptCtx: PromptContext = { getPlanTextForState, getOutstandingFindings, getSectionPlan, getSectionPlans, getCompletedSectionDigest, getCoderDecisions, getFindingRecurrence, getAttemptHistory: getPromptAttemptHistory, getBlockingBugFindings, getSectionScope, getSectionCodeGraphBlock, getAttemptCodeGraphBlock, getActiveRunStates: (state) => listActiveRunStates(state.loopName) }

  function buildContinuationPrompt(state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string {
    return _buildContinuationPrompt(_promptCtx, state, notice, outstandingBugs)
  }

  function buildCoderFollowUpPrompt(state: LoopState, outstandingBugs?: ReviewFindingRow[], notice?: string): string {
    return _buildCoderFollowUpPrompt(_promptCtx, state, outstandingBugs, notice)
  }

  function buildAuditFollowUpPrompt(state: LoopState): string {
    return _buildAuditFollowUpPrompt(_promptCtx, state)
  }

  function getPlanTextForState(state: LoopState): string | null {
    return plansRepo.getForLoopOrSession(projectId, state.loopName, state.sessionId)?.content ?? null
  }

  function getPlanText(loopName: string, sessionId: string): string | null {
    return plansRepo.getForLoopOrSession(projectId, loopName, sessionId)?.content ?? null
  }

  function getCoderDecisions(loopName?: string): string | null {
    if (!loopName) return null
    if (loopAttemptsRepo) return loopAttemptsRepo.list(projectId, loopName, undefined, 1)[0]?.coderDecisions ?? null
    return coderDecisionsByLoop.get(loopName) ?? null
  }

  function buildAuditPrompt(state: LoopState): string {
    return _buildAuditPrompt(_promptCtx, state)
  }

  function listActive(): LoopState[] {
    const rows = loopsRepo.listByStatus(projectId, ['running'])
    return rows.map((row) => {
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return hydratePlanFromPlans(loopRowToState(row, large))
    })
  }

  function listRecent(): LoopState[] {
    const rows = loopsRepo.listByStatus(projectId, ['completed', 'cancelled', 'errored', 'stalled'])
    return rows.map((row) => {
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return hydratePlanFromPlans(loopRowToState(row, large))
    })
  }

  function findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] } {
    const result = loopsRepo.findPartial(projectId, name)
    const mapResult = (row: LoopRow | null): LoopState | null => {
      if (!row) return null
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return hydratePlanFromPlans(loopRowToState(row, large))
    }
    return {
      match: mapResult(result.match),
      candidates: result.candidates.map((row) => {
        const large = loopsRepo.getLarge(projectId, row.loopName)
        return hydratePlanFromPlans(loopRowToState(row, large))
      }),
    }
  }

  function getStallTimeoutMs(): number {
    return loopConfig?.stallTimeoutMs ?? STALL_TIMEOUT_MS
  }

  function getMaxConsecutiveStalls(): number {
    return loopConfig?.maxConsecutiveStalls ?? MAX_CONSECUTIVE_STALLS
  }

  function getBusyStallTimeoutMs(): number {
    return loopConfig?.busyStallTimeoutMs ?? BUSY_STALL_TIMEOUT_MS
  }

  async function terminateAll(): Promise<void> {
    const active = listActive()
    const now = Date.now()
    for (const state of active) {
      loopsRepo.terminate(projectId, state.loopName, {
        status: 'cancelled',
        reason: 'shutdown',
        completedAt: now,
      })
      coderDecisionsByLoop.delete(state.loopName)
      notifyLoopChange('terminate', state.loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
    }
    coderDecisionsByLoop.clear()
    findingRecurrenceByLoop.clear()
    logger.log(`Loop: terminated ${String(active.length)} active loop(s)`)
  }

  function getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[] {
    const rows = loopName ? reviewFindingsRepo.listByLoopName(projectId, loopName) : reviewFindingsRepo.listAll(projectId)
    return severity ? rows.filter((r) => r.severity === severity) : rows
  }

  function getSectionScope(state: LoopState): SectionScope {
    return resolveSectionScope(getSectionPlans(state), state.currentSectionIndex)
  }

  function getBlockingBugFindings(state: LoopState): ReviewFindingRow[] {
    return blockingBugFindings(getOutstandingFindings(state.loopName), state, getSectionScope(state))
  }

  function hasEscalatedBugFindings(state: LoopState): boolean {
    const bugs = state.totalSections > 0
      ? getBlockingBugFindings(state)
      : getOutstandingFindings(state.loopName, 'bug')
    return hasEscalatedFindings(bugs, getFindingRecurrence(state.loopName))
  }

  function hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean {
    return getOutstandingFindings(loopName, severity).length > 0
  }

  function setCoderDecisions(name: string, decisions: string | null): void {
    if (!decisions) {
      coderDecisionsByLoop.delete(name)
    } else {
      coderDecisionsByLoop.set(name, decisions)
    }
  }

  function getAttemptHistory(name: string, scope?: string, limit?: number, beforeId?: number): LoopAttemptRow[] {
    return loopAttemptsRepo?.list(projectId, name, scope, limit, beforeId) ?? []
  }

  function getLatestAttempt(state: LoopState): LoopAttemptRow | null {
    if (!loopAttemptsRepo) return null
    return loopAttemptsRepo.latest(projectId, state.loopName, auditScope(state))
  }

  function attemptPlanHash(state: LoopState): string {
    const plan = getPlanTextForState(state)
    const sections = getSectionPlans(state).map(s => [s.sectionIndex, s.content])
    return createHash('sha256').update(JSON.stringify([auditScope(state), plan, sections])).digest('hex')
  }

  function getPromptAttemptHistory(state: LoopState, limit = 4): LoopAttemptRow[] {
    const rows = getAttemptHistory(state.loopName, auditScope(state), limit)
    const latest = rows.at(-1)
    if (latest && (latest.planHash !== attemptPlanHash(state) || latest.worktreeDir !== state.runDir ||
      (latest.sourceSessionId !== state.sessionId && latest.auditorSessionId !== state.sessionId))) {
      rows[rows.length - 1] = { ...latest, previousCommit: null, diffSummary: null, fallbackReason: 'The plan, workspace, or session has changed; perform the full audit scope.' }
    }
    return rows
  }

  async function captureAttempt(state: LoopState, completionKey: string, decisions: string | null): Promise<boolean> {
    if (!loopAttemptsRepo) {
      setCoderDecisions(state.loopName, decisions)
      return true
    }
    const source = getRunState(state.loopName, state.sectionRunKey)
    if (!source || source.sessionId !== state.sessionId) return false
    const scope = auditScope(state)
    const previous = loopAttemptsRepo.latest(projectId, state.loopName, scope)
    if (previous?.completionKey === completionKey) return true
    const planHash = attemptPlanHash(state)
    const ref = `refs/forge/audits/${randomUUID()}`
    let snapshotCommit: string | null = null
    let snapshotRef: string | null = null
    let previousCommit: string | null = null
    let diffSummary: string | null = null
    let fallbackReason: string | null = 'First audit in this scope; review the full scope.'
    try {
      const snapshot = await captureAuditSnapshot(state.runDir, ref, logger)
      snapshotCommit = snapshot.commit
      snapshotRef = snapshot.ref
      if (previous?.outcome && previous.snapshotCommit && previous.planHash === planHash && previous.worktreeDir === state.runDir) {
        diffSummary = await compareAuditSnapshots(state.runDir, previous.snapshotCommit, snapshotCommit, logger)
        previousCommit = previous.snapshotCommit
        fallbackReason = null
      } else if (previous) {
        fallbackReason = 'The previous attempt was not audited, its checkpoint is unavailable, or the plan/workspace changed; review the full scope.'
      }
    } catch (err) {
      fallbackReason = `Checkpoint unavailable: ${err instanceof Error ? err.message : String(err)}. Review the full scope.`
      logger.log(`Loop: ${fallbackReason}`)
    }
    let recorded: LoopAttemptRow | null = null
    try {
      const fresh = getRunState(state.loopName, state.sectionRunKey)
      if (!fresh || fresh.sessionId !== source.sessionId || fresh.phase !== source.phase ||
        fresh.runDir !== source.runDir || attemptPlanHash({ ...fresh, phase: state.phase }) !== planHash) return false
      recorded = loopAttemptsRepo.record({
        projectId, loopName: state.loopName, scope, sourceSessionId: state.sessionId, completionKey,
        iteration: state.iteration, worktreeDir: state.runDir, planHash, coderDecisions: decisions,
        snapshotCommit, snapshotRef, previousCommit, diffSummary, fallbackReason,
        findingsBefore: attemptFindings(state),
      })
      return recorded !== null
    } finally {
      if (snapshotRef && recorded?.snapshotRef !== snapshotRef) {
        await deleteAuditSnapshot(state.runDir, snapshotRef, logger).catch(err => logger.error('Loop: orphan checkpoint cleanup failed', err))
      }
    }
  }

  function attemptFindings(state: LoopState): ReviewFindingRow[] {
    const findings = getOutstandingFindings(state.loopName)
    if (!auditScope(state).startsWith('section:')) return findings
    const sectionScope = getSectionScope(state)
    return findings.filter(f => isFindingInSectionScope(f, sectionScope))
  }

  function finishAttempt(state: LoopState, outcome: 'clean' | 'dirty'): void {
    if (!loopAttemptsRepo || state.phase !== 'auditing') return
    const scope = auditScope(state)
    const active = getRunState(state.loopName, state.sectionRunKey)
    if (!active || active.sessionId !== state.sessionId || active.phase !== state.phase || auditScope(active) !== scope) return
    const latest = loopAttemptsRepo.latest(projectId, state.loopName, scope)
    if (!latest || latest.auditorSessionId !== state.sessionId) {
      loopAttemptsRepo.record({
        projectId, loopName: state.loopName, scope, sourceSessionId: state.sessionId,
        completionKey: `recovered-audit:${state.sessionId}`, iteration: state.iteration,
        worktreeDir: state.runDir, planHash: attemptPlanHash(state), coderDecisions: null,
        snapshotCommit: null, snapshotRef: null, previousCommit: null, diffSummary: null,
        fallbackReason: 'Audit resumed without a matching code handoff; the next audit must use the full scope.', findingsBefore: [],
      })
      loopAttemptsRepo.bindAudit(projectId, state.loopName, scope, state.sessionId, state.sessionId)
    }
    loopAttemptsRepo.finishAudit(projectId, state.loopName, scope, state.sessionId, outcome, attemptFindings(state))
  }

  function bumpFindingRecurrence(name: string, findings: ReviewFindingRow[]): void {
    if (loopAttemptsRepo) return
    const prev = findingRecurrenceByLoop.get(name) ?? new Map()
    const keys = findings.map(f => findingRecurrenceKey(f))
    findingRecurrenceByLoop.set(name, bumpRecurrence(prev, keys))
  }

  function resetSectionRecurrence(name: string, sectionIndex: number): void {
    if (loopAttemptsRepo) return
    const prev = findingRecurrenceByLoop.get(name)
    if (!prev) return
    const prefix = `${sectionIndex}:`
    const next = new Map<string, number>()
    for (const [key, count] of prev) {
      if (!key.startsWith(prefix)) {
        next.set(key, count)
      }
    }
    findingRecurrenceByLoop.set(name, next)
  }

  function incrementError(ref: LoopLaneRef): number {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    const result = loopsRepo.incrementError(projectId, name, runKey)
    notifyLoopChange('error', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
    return result
  }

  function resetError(ref: LoopLaneRef): void {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    loopsRepo.resetError(projectId, name, runKey)
    notifyLoopChange('error', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function advanceAuditorFallbackIndex(ref: LoopLaneRef, fromIndex: number, toIndex: number): number | null {
    const { loopName: name, runKey } = laneRef(ref)
    const result = loopsRepo.advanceAuditorFallbackIndex(projectId, name, fromIndex, toIndex, runKey)
    if (result !== null) {
      const state = getAnyState(name)
      notifyLoopChange('auditor-fallback', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
    }
    return result
  }

  function resetAuditorFallbackIndex(ref: LoopLaneRef): boolean {
    const { loopName: name, runKey } = laneRef(ref)
    const changed = loopsRepo.resetAuditorFallbackIndex(projectId, name, runKey)
    if (changed) {
      const state = getAnyState(name)
      notifyLoopChange('auditor-fallback', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
    }
    return changed
  }

  function setPhase(ref: LoopLaneRef, phase: LoopState['phase']): void {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    loopsRepo.updatePhase(projectId, name, phase, runKey)
    notifyLoopChange('phase', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setPhaseAndResetError(ref: LoopLaneRef, phase: LoopState['phase']): void {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    loopsRepo.setPhaseAndResetError(projectId, name, phase, runKey)
    notifyLoopChange('phase', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setModelFailed(ref: LoopLaneRef, failed: boolean): void {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    loopsRepo.setModelFailed(projectId, name, failed, runKey)
    notifyLoopChange('model-failed', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setLastAuditResult(name: string, text: string): void {
    if (text === '') return
    const state = getAnyState(name)
    loopsRepo.setLastAuditResult(projectId, name, text)
    notifyLoopChange('audit-result', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function clearLastAuditResult(name: string): void {
    const state = getAnyState(name)
    loopsRepo.clearLastAuditResult(projectId, name)
    notifyLoopChange('audit-result', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setPostActionReport(name: string, text: string): void {
    if (text === '') return
    const state = getAnyState(name)
    loopsRepo.setPostActionReport(projectId, name, text)
    notifyLoopChange('post-action-report', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void {
    const state = getAnyState(name)
    loopsRepo.terminate(projectId, name, opts)
    coderDecisionsByLoop.delete(name)
    findingRecurrenceByLoop.delete(name)
    notifyLoopChange('terminate', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setSandboxContainer(name: string, containerName: string | null): void {
    const state = getAnyState(name)
    loopsRepo.setSandboxContainer(projectId, name, containerName)
    notifyLoopChange('sandbox', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setStandbySessionId(ref: LoopLaneRef, sessionId: string | null): void {
    const { loopName: name, runKey } = laneRef(ref)
    const state = getAnyState(name)
    loopsRepo.setStandbySessionId(projectId, name, sessionId, runKey)
    notifyLoopChange('session', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function clearWorkspaceId(name: string): void {
    const state = getAnyState(name)
    loopsRepo.clearWorkspaceId(projectId, name)
    notifyLoopChange('workspace', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setWorkspaceId(name: string, workspaceId: string): void {
    const state = getAnyState(name)
    loopsRepo.setWorkspaceId(projectId, name, workspaceId)
    notifyLoopChange('workspace', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function getSectionPlan(state: LoopState, index: number): SectionPlanRow | null {
    if (!sectionPlansRepo) return null
    return sectionPlansRepo.get(projectId, state.loopName, index)
  }

  function getSectionPlans(state: LoopState): SectionPlanRow[] {
    if (!sectionPlansRepo) return []
    return sectionPlansRepo.list(projectId, state.loopName)
  }

  function recordSectionCodeGraph(state: LoopState, index: number, text: string): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.setCodeGraph(projectId, state.loopName, index, text)
  }

  function setSectionCheckpointCommit(loopName: string, index: number, sha: string): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.setCheckpointCommit(projectId, loopName, index, sha)
  }

  /**
   * The `## Code graph` pointer rendered into this section's coder prompts. The
   * snapshot wrote the report inside the sandbox before the row was stored; the
   * host never writes it into the agent-writable worktree. A non-sandboxed loop
   * or a disabled `codeGraph.enabled` setting drops the pointer entirely.
   */
  function getSectionCodeGraphBlock(state: LoopState): string {
    if (!state.sandbox || !codeGraphEnabled) return ''
    const index = state.currentSectionIndex
    if (!getSectionPlan(state, index)?.codeGraph) return ''
    return buildCodeGraphPromptBlock(sectionCodeGraphReportPath(index), 'section start')
  }

  function recordAttemptCodeGraph(state: LoopState, attempt: LoopAttemptRow, text: string): void {
    if (!loopAttemptsRepo) return
    loopAttemptsRepo.setCodeGraph(projectId, state.loopName, attempt.id, text)
  }

  /**
   * The `## Code graph` pointer rendered into this scope's audit and coder
   * prompts, for the report snapshot B wrote inside the sandbox. A non-sandboxed
   * loop or a disabled `codeGraph.enabled` setting drops the pointer entirely.
   */
  function getAttemptCodeGraphBlock(state: LoopState): string {
    if (!state.sandbox || !codeGraphEnabled) return ''
    const attempt = getLatestAttempt(state)
    if (!attempt?.codeGraph) return ''
    return buildCodeGraphPromptBlock(attemptCodeGraphReportPath(attempt), 'audit checkpoint')
  }

  function getNextReadySectionPlan(state: LoopState): SectionPlanRow | null {
    return selectNextSection(getSectionPlans(state))
  }

  function sectionFilesOf(row: SectionPlanRow): string[] {
    return extractSectionFiles(row.content)
  }

  function isLastOpenSection(state: LoopState): boolean {
    if (state.totalSections <= 0) return false
    const sections = getSectionPlans(state)
    if (sections.length === 0) return state.currentSectionIndex >= state.totalSections - 1
    const completed = sections.filter(s => s.status === 'completed').length
    if (completed < state.totalSections - 1) return false
    return isLastOpenSectionIndex(sections, state.currentSectionIndex)
  }

  function getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[] {
    if (!sectionPlansRepo) return []
    const completed = sectionPlansRepo.listCompleted(projectId, state.loopName)
    return completed.map(s => ({
      index: s.sectionIndex,
      title: s.title,
      summaryDone: s.summaryDone,
      summaryDeviations: s.summaryDeviations,
      summaryFollowUps: s.summaryFollowUps,
    }))
  }

  function buildPlanInitialPrompt(planText: string): string {
    return _buildPlanInitialPrompt(planText)
  }

  function buildSectionInitialPrompt(state: LoopState): string {
    return _buildSectionInitialPrompt(_promptCtx, state)
  }

  function buildSectionAuditPrompt(state: LoopState): string {
    return _buildSectionAuditPrompt(_promptCtx, state)
  }

  function buildSectionContinuationPrompt(state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string {
    return _buildSectionContinuationPrompt(_promptCtx, state, notice, outstandingBugs)
  }

  function buildPostActionPrompt(state: LoopState, opts: PostActionPromptOptions): string {
    return _buildPostActionPrompt(_promptCtx, state, opts)
  }

  function completeSection(loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.setStatus(projectId, loopName, index, 'completed')
    sectionPlansRepo.setSummary(projectId, loopName, index, {
      done: summary.done ?? undefined,
      deviations: summary.deviations ?? undefined,
      followUps: summary.followUps ?? undefined,
    })
    sectionPlansRepo.setCompletedAt(projectId, loopName, index, Date.now())
  }

  function incrementSectionAttempts(loopName: string, index: number): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.incrementAttempts(projectId, loopName, index)
  }

  function resetSectionForRewind(loopName: string, index: number): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.resetForRewind(projectId, loopName, index)
  }

  function setCurrentSectionIndex(ref: LoopLaneRef, index: number): void {
    // Defensive clamp against suffix-deletion races: if the active section run's
    // index was persisted from a snapshot where `total_sections = N` but the
    // loop row has since been amended to `total_sections < index`, clamp the
    // index so the invariant `current section index < total_sections` always
    // holds.  The index lives on the loop's active section run, not on a
    // separate column of the loops row.
    const loopName = laneRef(ref).loopName
    const row = loopsRepo.get(projectId, loopName)
    if (row && row.totalSections > 0 && index >= row.totalSections) {
      index = row.totalSections - 1
    }
    loopsRepo.setCurrentSectionIndex(projectId, loopName, index)
  }

  function startSection(loopName: string, index: number): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.setStatus(projectId, loopName, index, 'in_progress')
    sectionPlansRepo.setStartedAt(projectId, loopName, index, Date.now())
  }

  function bulkInsertSections(loopName: string, sections: PlanSection[]): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
  }

  /** Defensive clamp for `totalSections` when reduced by a suffix deletion.

   * When `setTotalSections` lowers the total, the active section run's index
   * may be in the deleted region.  Clamp it back to `total - 1` to preserve the
   * invariant that the current index never exceeds the highest valid section
   * index.  The index lives on the loop's active section run, not on a
   * separate column of the loops row.  */
  function setTotalSections(loopName: string, total: number): void {
    loopsRepo.setTotalSections(projectId, loopName, total)
    if (total > 0) {
      const row = loopsRepo.get(projectId, loopName)
      if (row && row.currentSectionIndex >= total) {
        loopsRepo.setCurrentSectionIndex(projectId, loopName, total - 1)
      }
    }
  }

  function recordPendingHandoff(input: LoopHandoffWriteInput): { record: LoopHandoffRecord; replaced: boolean } {
    return loopsRepo.upsertPendingHandoff({ projectId, ...input })
  }

  function getPendingHandoff(loopName: string, sectionRunKey: string): LoopHandoffRecord | null {
    return loopsRepo.getPendingHandoff(projectId, loopName, sectionRunKey)
  }

  function applyPendingHandoff<R extends LoopHandoffRole>(
    loopName: string,
    sectionRunKey: string,
    sessionId: string,
    role: R,
  ): LoopHandoffRecordFor<R> | null {
    return loopsRepo.applyPendingHandoff(projectId, loopName, sectionRunKey, sessionId, role)
  }

  function discardPendingHandoff(loopName: string, sectionRunKey?: string): void {
    loopsRepo.discardPendingHandoff(projectId, loopName, sectionRunKey)
  }

  function listHandoffs(loopName: string, limit?: number): LoopHandoffRecord[] {
    return loopsRepo.listHandoffs(projectId, loopName, limit)
  }

  function recordTransition(name: string, entry: {
    eventType: string
    transitionKind: string
    fromPhase: string
    toPhase: string | null
    status?: string | null
    reason?: string | null
    iteration: number
    sectionIndex?: number | null
  }): void {
    if (!loopTransitionsRepo) return
    try {
      loopTransitionsRepo.insert({
        projectId,
        loopName: name,
        eventType: entry.eventType,
        transitionKind: entry.transitionKind,
        fromPhase: entry.fromPhase,
        toPhase: entry.toPhase,
        status: entry.status ?? null,
        reason: entry.reason ?? null,
        iteration: entry.iteration,
        sectionIndex: entry.sectionIndex ?? null,
      })
    } catch (err) {
      // Persisted transition logging is best-effort: never propagate into the runtime.
      logger.error(`Loop: failed to record transition for ${name}`, err as Error)
    }
  }

  /**
   * Record the single terminal transition row for a loop. Wraps
   * `terminationStatusFor`/`terminationReasonToString` so the terminal row
   * shape (transitionKind 'terminate', toPhase null, derived status/reason)
   * has exactly one definition across the runtime and execution service.
   */
  function recordTerminalTransition(name: string, entry: {
    reason: TerminationReason
    fromPhase: string
    iteration: number
    sectionIndex: number | null
    /** Defaults to `reason.kind`. */
    eventType?: string
  }): void {
    recordTransition(name, {
      eventType: entry.eventType ?? entry.reason.kind,
      transitionKind: 'terminate',
      fromPhase: entry.fromPhase,
      toPhase: null,
      status: terminationStatusFor(entry.reason),
      reason: terminationReasonToString(entry.reason),
      iteration: entry.iteration,
      sectionIndex: entry.sectionIndex,
    })
  }

    async function adjustRemainingSections(name: string, args: {
    sections?: { title: string; content: string; id?: string; after?: string[] }[]
    currentSection?: { title: string; content: string }
    edits?: { id: string; title: string; content: string; after?: string[] }[]
    rationale: string
    auditorSessionId: string
  }): Promise<{ ok: true; totalSections: number; restartRuns: string[] } | { ok: false; error: string }> {
    if (!sectionPlansRepo) {
      return { ok: false, error: 'section plans repository is not configured' }
    }
    if (!planAmendmentsRepo) {
      return { ok: false, error: 'plan amendments repository is not configured' }
    }
    if (!args.rationale || isBlank(args.rationale)) {
      return { ok: false, error: 'rationale must not be empty' }
    }
    if (isBlank(args.auditorSessionId ?? '')) {
      return { ok: false, error: 'auditorSessionId must not be empty' }
    }
    if (args.currentSection) {
      if (isBlank(args.currentSection.title)) {
        return { ok: false, error: 'currentSection title must not be empty' }
      }
      if (isBlank(args.currentSection.content)) {
        return { ok: false, error: 'currentSection content must not be empty' }
      }
    }
    if (args.sections) {
      for (const [i, section] of args.sections.entries()) {
        if (isBlank(section.title)) {
          return { ok: false, error: `sections[${i}] title must not be empty` }
        }
        if (isBlank(section.content)) {
          return { ok: false, error: `sections[${i}] content must not be empty` }
        }
      }
    }
    const edits = args.edits ?? []
    for (const [i, edit] of edits.entries()) {
      if (isBlank(edit.title)) {
        return { ok: false, error: `edits[${i}] title must not be empty` }
      }
      if (isBlank(edit.content)) {
        return { ok: false, error: `edits[${i}] content must not be empty` }
      }
    }
    if (args.sections === undefined && args.currentSection === undefined && edits.length === 0) {
      return { ok: false, error: 'no changes specified: provide sections, currentSection and/or edits' }
    }
    // `sections` rewrites the not-started suffix from `pendingSuffixStart`:
    // omit it to leave future sections untouched, or pass an empty array to
    // remove the entire suffix. `currentSection` edits the in-progress section
    // being audited in place, preserving its status/attempts; `edits` then
    // updates any section by id, reopening completed rows and reporting running
    // lanes that must restart.

    // Serialization with the runtime's `tick()` promise chain prevents a
    // stale in-memory decision from the auditing runner from racing against
    // a concurrent section advance.  `BEGIN IMMEDIATE` still serialises the
    // writes, but runExclusive serialises the read-then-write decision so
    // the phase / index we operate on is the authoritative one at lock
    // acquisition time.
    type AdjustResult =
      | { ok: true; totalSections: number; restartRuns: string[]; hint: { projectDir: string; worktreeDir: string } }
      | { ok: false; error: string }

    function isAdjustedOk(r: AdjustResult): r is { ok: true; totalSections: number; restartRuns: string[]; hint: { projectDir: string; worktreeDir: string } } {
      return r.ok
    }

    function inner(): AdjustResult {
      let txnResult: AdjustResult
      try {
        txnResult = sectionPlansRepo!.immediateTransaction(() => {
          const callerRow = loopsRepo.getBySessionId(projectId, args.auditorSessionId)
          if (!callerRow || callerRow.loopName !== name) {
            return { ok: false as const, error: `session mismatch: session ${args.auditorSessionId} is not the current session of an active section run for loop ${name}` }
          }
          if (callerRow.status !== 'running') {
            return { ok: false as const, error: `loop ${name} is not active` }
          }
          if (callerRow.totalSections === 0) {
            return { ok: false as const, error: 'loop has no sectioned plan' }
          }
          if (callerRow.phase !== 'auditing') {
            return { ok: false as const, error: `adjustments are only allowed during auditing (current phase: ${callerRow.phase})` }
          }

          const currentIndex = callerRow.currentSectionIndex
          const ownSectionId = callerRow.sectionId
          const callerRunKey = callerRow.sectionRunKey
          const rowsBefore = sectionPlansRepo!.list(projectId, name)
          const fromIndex = pendingSuffixStart(rowsBefore, currentIndex)

          if (args.currentSection) {
            const currentRow = rowsBefore.find((r) => r.sectionIndex === currentIndex) ?? null
            if (!currentRow) {
              return { ok: false as const, error: `current section ${currentIndex} does not exist` }
            }
            if (currentRow.status !== 'in_progress') {
              return { ok: false as const, error: `cannot edit section ${currentIndex}: current section may only be edited while in_progress (status: ${currentRow.status})` }
            }
          }

          const replacementSections = args.sections?.map((section) => ({
            ...section,
            title: stripLeadingStructuralOrdinal(section.title) || section.title,
          }))
          const newTotal = replacementSections !== undefined ? fromIndex + replacementSections.length : callerRow.totalSections
          if (replacementSections !== undefined) {
            if (newTotal > MAX_TOTAL_SECTIONS) {
              return { ok: false as const, error: `resulting total sections (${newTotal}) would exceed cap ${MAX_TOTAL_SECTIONS}` }
            }
            if (newTotal === 0) {
              return { ok: false as const, error: 'resulting total sections would be zero' }
            }
          }

          const survivingRows = replacementSections === undefined
            ? rowsBefore
            : rowsBefore.filter((r) => r.sectionIndex < fromIndex)

          let replacementNodes: SectionGraphNode[] = []
          let chainedSections: { title: string; content: string; id: string; after: string[] }[] = []
          if (replacementSections !== undefined) {
            const existingNodes: SectionGraphNode[] = survivingRows
              .map((r) => ({ index: r.sectionIndex, id: r.sectionId, after: r.dependsOn }))
            const lastExisting = existingNodes.at(-1)
            let previousId = lastExisting?.id ?? generatedSectionId(currentIndex)
            let previousExists = lastExisting !== undefined
            const usedIds = new Set(existingNodes.map((node) => node.id))
            for (const section of replacementSections) {
              if (section.id !== undefined) usedIds.add(section.id)
            }
            replacementNodes = replacementSections.map((section, i) => {
              let id: string
              if (section.id !== undefined) {
                id = section.id
              } else {
                let candidateIndex = fromIndex + i
                while (usedIds.has(generatedSectionId(candidateIndex))) candidateIndex += 1
                id = generatedSectionId(candidateIndex)
                usedIds.add(id)
              }
              const after = section.after ?? (previousExists ? [previousId] : [])
              previousId = id
              previousExists = true
              return { index: fromIndex + i, id, after }
            })
            chainedSections = replacementSections.map((section, i) => ({
              ...section,
              id: replacementNodes[i].id,
              after: replacementNodes[i].after,
            }))
          }

          const finalNodes: { index: number; id: string; after: string[]; status: SectionPlanRow['status'] }[] = [
            ...survivingRows.map((r) => ({ index: r.sectionIndex, id: r.sectionId, after: r.dependsOn, status: r.status })),
            ...replacementNodes.map((node) => ({ ...node, status: 'pending' as const })),
          ]
          const finalById = new Map(finalNodes.map((node) => [node.id, node]))
          const seenEditIds = new Set<string>()
          for (const edit of edits) {
            if (seenEditIds.has(edit.id)) {
              return { ok: false as const, error: `edits contains duplicate id "${edit.id}"` }
            }
            seenEditIds.add(edit.id)
            if (!finalById.has(edit.id)) {
              return { ok: false as const, error: `edits references unknown section id "${edit.id}"` }
            }
          }
          const normalizedEdits = edits.map((edit) => ({
            ...edit,
            title: stripLeadingStructuralOrdinal(edit.title) || edit.title,
          }))
          for (const edit of normalizedEdits) {
            const target = finalById.get(edit.id)!
            const isOwnSection = target.index === currentIndex || target.id === ownSectionId
            if (isOwnSection && target.status !== 'in_progress') {
              return { ok: false as const, error: `cannot edit section ${target.index}: current section may only be edited while in_progress (status: ${target.status})` }
            }
          }

          if (replacementSections !== undefined || normalizedEdits.some((edit) => edit.after !== undefined)) {
            const editedEdges = new Map(normalizedEdits.filter((edit) => edit.after !== undefined).map((edit) => [edit.id, edit.after!]))
            const graphNodes: SectionGraphNode[] = finalNodes.map((node) => ({
              index: node.index,
              id: node.id,
              after: editedEdges.get(node.id) ?? node.after,
            }))
            const graphErrors = validateSectionGraph(graphNodes)
            if (graphErrors.length > 0) {
              return { ok: false as const, error: 'invalid section graph: ' + graphErrors.join('; ') }
            }
          }

          const changedIndices = [
            ...(args.currentSection ? [currentIndex] : []),
            ...(replacementSections !== undefined ? [fromIndex] : []),
            ...normalizedEdits.map((edit) => finalById.get(edit.id)!.index),
          ]
          const snapshotFrom = Math.min(...changedIndices)
          const beforeRows = rowsBefore
            .filter((r) => r.sectionIndex >= snapshotFrom)
            .map((r) => ({ index: r.sectionIndex, title: r.title, content: r.content }))
          const sectionsBefore = JSON.stringify(beforeRows)

          if (replacementSections !== undefined) {
            const replaceResult = sectionPlansRepo!.replacePendingSections({
              projectId,
              loopName: name,
              fromIndex,
              sections: chainedSections,
            })
            if (!replaceResult.ok) {
              return replaceResult
            }
          }

          if (args.currentSection) {
            sectionPlansRepo!.updateSection(projectId, name, currentIndex, {
              title: stripLeadingStructuralOrdinal(args.currentSection.title) || args.currentSection.title,
              content: args.currentSection.content,
            })
          }

          const restartRuns = new Set<string>()
          for (const edit of normalizedEdits) {
            const target = finalById.get(edit.id)!
            const isOwnSection = target.index === currentIndex || target.id === ownSectionId
            sectionPlansRepo!.updateSection(projectId, name, target.index, {
              title: edit.title,
              content: edit.content,
              after: edit.after,
            })
            if (target.status === 'completed') {
              sectionPlansRepo!.reopen(projectId, name, target.index)
            } else if (target.status === 'in_progress' && !isOwnSection) {
              for (const runKey of loopsRepo.listActiveRunKeys(projectId, name)) {
                if (runKey === callerRunKey) continue
                const runRow = loopsRepo.getForRun(projectId, name, runKey)
                if (runRow?.sectionId === edit.id) {
                  restartRuns.add(runKey)
                  break
                }
              }
            }
          }

          if (replacementSections !== undefined) {
            loopsRepo.setTotalSections(projectId, name, newTotal)
          }

          const afterRows = sectionPlansRepo!.list(projectId, name)
            .filter((r) => r.sectionIndex >= snapshotFrom)
            .map((r) => ({ index: r.sectionIndex, title: r.title, content: r.content }))
          const sectionsAfter = JSON.stringify(afterRows)

          planAmendmentsRepo!.insert({
            projectId,
            loopName: name,
            source: 'auditor',
            rationale: args.rationale,
            appliedAtSection: currentIndex,
            sectionsBefore,
            sectionsAfter,
          })

          return {
            ok: true as const,
            totalSections: newTotal,
            restartRuns: [...restartRuns],
            hint: { projectDir: callerRow.projectDir, worktreeDir: callerRow.worktreeDir },
          }
        })
      } catch (err) {
        logger.error(`Loop: failed to apply section adjustment for ${name}`, err as Error)
        return { ok: false, error: (err as Error).message ?? 'section adjustment failed' }
      }

      if (!isAdjustedOk(txnResult)) {
        return { ok: false, error: txnResult.error }
      }

      try {
        notifyLoopChange('sections-adjusted', name, {
          projectDir: txnResult.hint.projectDir,
          worktreeDir: txnResult.hint.worktreeDir,
        })
      } catch (notifyErr) {
        logger.error(`Loop: sections-adjusted notification failed for ${name}`, notifyErr as Error)
      }
      return { ok: true, totalSections: txnResult.totalSections, restartRuns: txnResult.restartRuns, hint: txnResult.hint }
    }

    // Strip the `hint` before returning to callers — it's only used for the notification inside inner().
    function stripHint(r: AdjustResult): { ok: true; totalSections: number; restartRuns: string[] } | { ok: false; error: string } {
      if (isAdjustedOk(r)) return { ok: r.ok, totalSections: r.totalSections, restartRuns: r.restartRuns }
      return r
    }

    if (runExclusive) {
      return runExclusive(name, async () => stripHint(inner()))
    }
    return stripHint(inner())
  }

  return {
    getActiveState,
    getRunState,
    listActiveRunStates,
    getRunStateForSession,
    getAnyState,
    setState,
    restoreState,
    deleteState,
    registerLoopSession,
    resolveLoopName,
    resolveActiveLoopForSession,
    findActiveByWorktreeDir,
    setStatus,
    buildContinuationPrompt,
    buildCoderFollowUpPrompt,
    buildAuditFollowUpPrompt,
    buildAuditPrompt,
    listActive,
    listRecent,
    findMatchByName,
    getStallTimeoutMs,
    getMaxConsecutiveStalls,
    getBusyStallTimeoutMs,
    terminateAll,
    hasOutstandingFindings,
    getOutstandingFindings,
    getBlockingBugFindings,
    getSectionScope,
    hasEscalatedBugFindings,
    setCoderDecisions,
    captureAttempt,
    finishAttempt,
    getAttemptHistory,
    bumpFindingRecurrence,
    resetSectionRecurrence,
    getPlanText,
    incrementError,
    resetError,
    advanceAuditorFallbackIndex,
    resetAuditorFallbackIndex,
    setPhase,
    setPhaseAndResetError,
    setModelFailed,
    setLastAuditResult,
    clearLastAuditResult,
    setPostActionReport,
    setSandboxContainer,
    setStandbySessionId,
    terminate,
    clearWorkspaceId,
    setWorkspaceId,
    replaceSession,
    activateSectionRun,
    finishRun,
    setIteration,
    getSectionPlan,
    getSectionPlans,
    recordSectionCodeGraph,
    setSectionCheckpointCommit,
    recordAttemptCodeGraph,
    getLatestAttempt,
    getNextReadySectionPlan,
    sectionFilesOf,
    getCompletedSectionDigest,

    buildPlanInitialPrompt,
    buildSectionInitialPrompt,
    buildSectionAuditPrompt,
    buildSectionContinuationPrompt,
    buildPostActionPrompt,
    completeSection,
    incrementSectionAttempts,
    resetSectionForRewind,
    setCurrentSectionIndex,
    isLastOpenSection,
    startSection,
    bulkInsertSections,
    setTotalSections,
    recordTransition,
    recordTerminalTransition,
    recordPendingHandoff,
    getPendingHandoff,
    applyPendingHandoff,
    discardPendingHandoff,
    listHandoffs,
    adjustRemainingSections,
  }
}
