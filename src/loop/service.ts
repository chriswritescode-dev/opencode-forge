import type { Logger, LoopConfig } from '../types'
import type { LoopsRepo, LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
import type { LoopState } from './state'
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
import { canonicalizePath } from '../sandbox/path'
import { blockingBugFindings, isFindingInSectionScope } from './section-scope'
import { buildCodeGraphPromptBlock, codeGraphReportPath, ensureCodeGraphReportFile } from './code-graph'
import type { LoopHandoffRecord, LoopHandoffRecordFor, LoopHandoffRole, LoopHandoffWriteInput } from './handoff'

export const MAX_RETRIES = 3
const STALL_TIMEOUT_MS = 60_000
const MAX_CONSECUTIVE_STALLS = 5
const BUSY_STALL_TIMEOUT_MS = 900_000

function isBlank(value: string): boolean {
  return value.trim().length === 0
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
  getAnyState(name: string): LoopState | null
  setState(name: string, state: LoopState): void
  /** In-place row restore via UPDATE (preserves child rows such as loop_transitions/section_plans that would be cascade-deleted by deleteState + setState). Falls back to INSERT if the row was concurrently deleted. */
  restoreState(name: string, state: LoopState): void
  deleteState(name: string): void
  registerLoopSession(sessionId: string, loopName: string): void
  resolveLoopName(sessionId: string): string | null
  /**
   * The loop this session is currently driving, or null. `resolveLoopName`
   * matches terminated loops too, so every "is this session inside a running
   * loop" check must go through here instead of testing loop-row existence.
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
   * findings attributed to the current or an earlier section. Findings from a
   * later, not-yet-started section do not block. Every bug blocks a
   * non-sectioned loop.
   */
  getBlockingBugFindings(state: LoopState): ReviewFindingRow[]
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
  incrementError(name: string): number
  resetError(name: string): void
  /** Compare-and-swap advance of the auditor fallback index; returns the new index on success or null when the loop is absent/non-running/index mismatch. */
  advanceAuditorFallbackIndex(name: string, fromIndex: number, toIndex: number): number | null
  /** Reset the auditor fallback index to 0 after a successful audit; returns true when a running row was actually changed. */
  resetAuditorFallbackIndex(name: string): boolean
  setPhase(name: string, phase: LoopState['phase']): void
  setPhaseAndResetError(name: string, phase: LoopState['phase']): void
  setModelFailed(name: string, failed: boolean): void
  setLastAuditResult(name: string, text: string): void
  clearLastAuditResult(name: string): void
  setPostActionReport(name: string, text: string): void
  setSandboxContainer(name: string, containerName: string | null): void
  /**
   * Record (or clear, with null) the other role's session kept for reuse on the
   * next same-section phase switch.
   */
  setStandbySessionId(name: string, sessionId: string | null): void
  setStatus(name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'): void
  clearWorkspaceId(name: string): void
  setWorkspaceId(name: string, workspaceId: string): void
  terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void
  replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getSectionPlans(state: LoopState): SectionPlanRow[]
  /** Persist a section's code-graph report and write it into the loop worktree. */
  recordSectionCodeGraph(state: LoopState, index: number, text: string): void
  /** Persist an audit attempt's code-graph report and write it into the loop worktree. */
  recordAttemptCodeGraph(state: LoopState, attempt: LoopAttemptRow, text: string): void
  /** The newest attempt row for the state's current audit scope, or null when attempts are not stored. */
  getLatestAttempt(state: LoopState): LoopAttemptRow | null
  getNextIncompleteSectionPlan(state: LoopState): SectionPlanRow | null
  getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[]

  buildPlanInitialPrompt(planText: string): string
  buildSectionInitialPrompt(state: LoopState): string
  buildSectionAuditPrompt(state: LoopState): string
  buildSectionContinuationPrompt(state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string
  buildPostActionPrompt(state: LoopState, opts: PostActionPromptOptions): string
  completeSection(loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }): void
  incrementSectionAttempts(loopName: string, index: number): void
  resetSectionForRewind(loopName: string, index: number): void
  setCurrentSectionIndex(loopName: string, index: number): void
  /**
   * Whether `state` is the loop's last open section: every other section plan
   * row is already completed. Covers both the final index and the rewind case
   * where all later sections finished before the current one.
   */
  isLastOpenSection(state: LoopState): boolean
  startSection(loopName: string, index: number): void
  bulkInsertSections(loopName: string, sections: { index: number; title: string; content: string }[]): void
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
  getPendingHandoff(loopName: string): LoopHandoffRecord | null
  /** Applies the session's pending handoff only when its role matches; any other pending row is left untouched. */
  applyPendingHandoff<R extends LoopHandoffRole>(loopName: string, sessionId: string, role: R): LoopHandoffRecordFor<R> | null
  discardPendingHandoff(loopName: string): void
  listHandoffs(loopName: string, limit?: number): LoopHandoffRecord[]
  adjustRemainingSections(name: string, args: {
    sections?: { title: string; content: string }[]
    currentSection?: { title: string; content: string }
    rationale: string
    auditorSessionId: string
  }): Promise<{ ok: true; totalSections: number } | { ok: false; error: string }>
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

  function registerLoopSession(sessionId: string, loopName: string): void {
    const state = getAnyState(loopName)
    loopsRepo.setCurrentSessionId(projectId, loopName, sessionId)
    notifyLoopChange('session', loopName, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function resolveLoopName(sessionId: string): string | null {
    return loopsRepo.getBySessionId(projectId, sessionId)?.loopName ?? null
  }

  function resolveActiveLoopForSession(sessionId: string): LoopState | null {
    const loopName = resolveLoopName(sessionId)
    const state = loopName ? getActiveState(loopName) : null
    return state?.sessionId === sessionId ? state : null
  }

  function findActiveByWorktreeDir(directory: string, options?: { worktreeOnly?: boolean }): LoopState | null {
    const canonical = canonicalizePath(directory)
    for (const state of listActive()) {
      if (!state.worktreeDir) continue
      if (options?.worktreeOnly && !state.worktree) continue
      if (canonicalizePath(state.worktreeDir) === canonical) return state
    }
    return null
  }

  function replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void {
    const state = getAnyState(name)
    const replace = () => loopsRepo.replaceSession(projectId, name, {
      sessionId: opts.newSessionId,
      phase: opts.phase,
      iteration: opts.iteration,
      resetError: opts.resetError,
      auditCount: opts.auditCount,
      lastAuditResult: opts.lastAuditResult,
    })
    if (state && loopAttemptsRepo && opts.phase === 'auditing') {
      loopAttemptsRepo.bindAudit(projectId, name, auditScope({ ...state, phase: opts.phase }), state.sessionId, opts.newSessionId, replace)
    } else replace()
    notifyLoopChange('rotate', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
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

  const _promptCtx: PromptContext = { getPlanTextForState, getOutstandingFindings, getSectionPlan, getSectionPlans, getCompletedSectionDigest, getCoderDecisions, getFindingRecurrence, getAttemptHistory: getPromptAttemptHistory, getBlockingBugFindings, getSectionCodeGraphBlock, getAttemptCodeGraphBlock }

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

  function getBlockingBugFindings(state: LoopState): ReviewFindingRow[] {
    return blockingBugFindings(getOutstandingFindings(state.loopName), state)
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
    if (latest && (latest.planHash !== attemptPlanHash(state) || latest.worktreeDir !== state.worktreeDir ||
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
    const source = getActiveState(state.loopName)
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
      const snapshot = await captureAuditSnapshot(state.worktreeDir, ref, logger)
      snapshotCommit = snapshot.commit
      snapshotRef = snapshot.ref
      if (previous?.outcome && previous.snapshotCommit && previous.planHash === planHash && previous.worktreeDir === state.worktreeDir) {
        diffSummary = await compareAuditSnapshots(state.worktreeDir, previous.snapshotCommit, snapshotCommit, logger)
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
      const fresh = getActiveState(state.loopName)
      if (!fresh || fresh.sessionId !== source.sessionId || fresh.phase !== source.phase ||
        fresh.worktreeDir !== source.worktreeDir || attemptPlanHash({ ...fresh, phase: state.phase }) !== planHash) return false
      recorded = loopAttemptsRepo.record({
        projectId, loopName: state.loopName, scope, sourceSessionId: state.sessionId, completionKey,
        iteration: state.iteration, worktreeDir: state.worktreeDir, planHash, coderDecisions: decisions,
        snapshotCommit, snapshotRef, previousCommit, diffSummary, fallbackReason,
        findingsBefore: attemptFindings(state),
      })
      return recorded !== null
    } finally {
      if (snapshotRef && recorded?.snapshotRef !== snapshotRef) {
        await deleteAuditSnapshot(state.worktreeDir, snapshotRef, logger).catch(err => logger.error('Loop: orphan checkpoint cleanup failed', err))
      }
    }
  }

  function attemptFindings(state: LoopState): ReviewFindingRow[] {
    const findings = getOutstandingFindings(state.loopName)
    return auditScope(state).startsWith('section:') ? findings.filter(f => isFindingInSectionScope(f, state.currentSectionIndex)) : findings
  }

  function finishAttempt(state: LoopState, outcome: 'clean' | 'dirty'): void {
    if (!loopAttemptsRepo || state.phase !== 'auditing') return
    const scope = auditScope(state)
    const active = getActiveState(state.loopName)
    if (!active || active.sessionId !== state.sessionId || active.phase !== state.phase || auditScope(active) !== scope) return
    const latest = loopAttemptsRepo.latest(projectId, state.loopName, scope)
    if (!latest || latest.auditorSessionId !== state.sessionId) {
      loopAttemptsRepo.record({
        projectId, loopName: state.loopName, scope, sourceSessionId: state.sessionId,
        completionKey: `recovered-audit:${state.sessionId}`, iteration: state.iteration,
        worktreeDir: state.worktreeDir, planHash: attemptPlanHash(state), coderDecisions: null,
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

  function incrementError(name: string): number {
    const state = getAnyState(name)
    const result = loopsRepo.incrementError(projectId, name)
    notifyLoopChange('error', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
    return result
  }

  function resetError(name: string): void {
    const state = getAnyState(name)
    loopsRepo.resetError(projectId, name)
    notifyLoopChange('error', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function advanceAuditorFallbackIndex(name: string, fromIndex: number, toIndex: number): number | null {
    const result = loopsRepo.advanceAuditorFallbackIndex(projectId, name, fromIndex, toIndex)
    if (result !== null) {
      const state = getAnyState(name)
      notifyLoopChange('auditor-fallback', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
    }
    return result
  }

  function resetAuditorFallbackIndex(name: string): boolean {
    const changed = loopsRepo.resetAuditorFallbackIndex(projectId, name)
    if (changed) {
      const state = getAnyState(name)
      notifyLoopChange('auditor-fallback', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
    }
    return changed
  }

  function setPhase(name: string, phase: LoopState['phase']): void {
    const state = getAnyState(name)
    loopsRepo.updatePhase(projectId, name, phase)
    notifyLoopChange('phase', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setPhaseAndResetError(name: string, phase: LoopState['phase']): void {
    const state = getAnyState(name)
    loopsRepo.setPhaseAndResetError(projectId, name, phase)
    notifyLoopChange('phase', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function setModelFailed(name: string, failed: boolean): void {
    const state = getAnyState(name)
    loopsRepo.setModelFailed(projectId, name, failed)
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

  function setStandbySessionId(name: string, sessionId: string | null): void {
    const state = getAnyState(name)
    loopsRepo.setStandbySessionId(projectId, name, sessionId)
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

  function sectionReportPath(index: number): string {
    return codeGraphReportPath(`section-${index + 1}`)
  }

  function attemptReportPath(attempt: LoopAttemptRow): string {
    return codeGraphReportPath(`audit-${attempt.scope}-attempt-${attempt.attemptNumber}`)
  }

  function writeCodeGraphReport(state: LoopState, relPath: string, text: string): boolean {
    if (ensureCodeGraphReportFile(state.worktreeDir, relPath, text)) return true
    logger.error(`[code-graph] cannot write report ${relPath} for ${state.loopName}`)
    return false
  }

  function recordSectionCodeGraph(state: LoopState, index: number, text: string): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.setCodeGraph(projectId, state.loopName, index, text)
    writeCodeGraphReport(state, sectionReportPath(index), text)
  }

  /**
   * The `## Code graph` pointer rendered into this section's coder prompts.
   * Restarts and reused worktrees rewrite the report from the stored row text so
   * the pointer never outlives its file. A non-sandboxed loop or a disabled
   * `codeGraph.enabled` setting drops the pointer entirely.
   */
  function getSectionCodeGraphBlock(state: LoopState): string {
    if (!state.sandbox || !codeGraphEnabled) return ''
    const index = state.currentSectionIndex
    const text = getSectionPlan(state, index)?.codeGraph ?? null
    if (!text) return ''
    const reportPath = sectionReportPath(index)
    if (!writeCodeGraphReport(state, reportPath, text)) return ''
    return buildCodeGraphPromptBlock(reportPath, 'section start')
  }

  function recordAttemptCodeGraph(state: LoopState, attempt: LoopAttemptRow, text: string): void {
    if (!loopAttemptsRepo) return
    loopAttemptsRepo.setCodeGraph(projectId, state.loopName, attempt.id, text)
    writeCodeGraphReport(state, attemptReportPath(attempt), text)
  }

  /**
   * The `## Code graph` pointer rendered into this scope's audit and coder
   * prompts. Restarts and reused worktrees rewrite the report from the stored
   * attempt row so the pointer never outlives its file. A non-sandboxed loop or
   * a disabled `codeGraph.enabled` setting drops the pointer entirely.
   */
  function getAttemptCodeGraphBlock(state: LoopState): string {
    if (!state.sandbox || !codeGraphEnabled) return ''
    const attempt = getLatestAttempt(state)
    if (!attempt?.codeGraph) return ''
    const reportPath = attemptReportPath(attempt)
    if (!writeCodeGraphReport(state, reportPath, attempt.codeGraph)) return ''
    return buildCodeGraphPromptBlock(reportPath, 'audit checkpoint')
  }

  function getNextIncompleteSectionPlan(state: LoopState): SectionPlanRow | null {
    if (!sectionPlansRepo) return null
    return sectionPlansRepo.getNextIncomplete(projectId, state.loopName)
  }

  function isLastOpenSection(state: LoopState): boolean {
    if (state.totalSections <= 0) return false
    const sections = getSectionPlans(state)
    if (sections.length === 0) return state.currentSectionIndex >= state.totalSections - 1
    const completed = sections.filter(s => s.status === 'completed').length
    if (completed < state.totalSections - 1) return false
    return sections.every(s => s.sectionIndex === state.currentSectionIndex || s.status === 'completed')
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

  function setCurrentSectionIndex(loopName: string, index: number): void {
    // Defensive clamp against suffix-deletion races: if `current_section_index`
    // was persisted from a snapshot where `total_sections = N` but the loop row
    // has since been amended to `total_sections < index`, clamp the index so
    // the invariant `current_section_index < total_sections` always holds.
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

  function bulkInsertSections(loopName: string, sections: { index: number; title: string; content: string }[]): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
  }

  /** Defensive clamp for `totalSections` when reduced by a suffix deletion.

   * When `setTotalSections` lowers the total, any already-persisted
   * `current_section_index` may be in the deleted region.  Clamp it
   * back to `total - 1` to preserve the invariant that the current index
   * never exceeds the highest valid section index.  */
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

  function getPendingHandoff(loopName: string): LoopHandoffRecord | null {
    return loopsRepo.getPendingHandoff(projectId, loopName)
  }

  function applyPendingHandoff<R extends LoopHandoffRole>(
    loopName: string,
    sessionId: string,
    role: R,
  ): LoopHandoffRecordFor<R> | null {
    return loopsRepo.applyPendingHandoff(projectId, loopName, sessionId, role)
  }

  function discardPendingHandoff(loopName: string): void {
    loopsRepo.discardPendingHandoff(projectId, loopName)
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
    sections?: { title: string; content: string }[]
    currentSection?: { title: string; content: string }
    rationale: string
    auditorSessionId: string
  }): Promise<{ ok: true; totalSections: number } | { ok: false; error: string }> {
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
    if (args.sections === undefined && args.currentSection === undefined) {
      return { ok: false, error: 'no changes specified: provide sections and/or currentSection' }
    }
    // `sections` scopes the pending suffix (from current index + 1): omit it to
    // leave future sections untouched, or pass an empty array to remove the
    // entire suffix. `currentSection` edits the in-progress section being
    // audited in place, preserving its status/attempts. Completed sections
    // (index < current) are never touched — the repo only replaces pending rows.

    // Serialization with the runtime's `tick()` promise chain prevents a
    // stale in-memory decision from the auditing runner from racing against
    // a concurrent section advance.  `BEGIN IMMEDIATE` still serialises the
    // writes, but runExclusive serialises the read-then-write decision so
    // the phase / index we operate on is the authoritative one at lock
    // acquisition time.
    type AdjustResult =
      | { ok: true; totalSections: number; hint: { projectDir: string; worktreeDir: string } }
      | { ok: false; error: string }

    function isAdjustedOk(r: AdjustResult): r is { ok: true; totalSections: number; hint: { projectDir: string; worktreeDir: string } } {
      return r.ok
    }

    function inner(): AdjustResult {
      let txnResult: AdjustResult
      try {
        txnResult = sectionPlansRepo!.immediateTransaction(() => {
          const row = loopsRepo.get(projectId, name)
          if (!row) {
            return { ok: false as const, error: `loop ${name} does not exist` }
          }
          if (row.status !== 'running') {
            return { ok: false as const, error: `loop ${name} is not active` }
          }
          if (row.totalSections === 0) {
            return { ok: false as const, error: 'loop has no sectioned plan' }
          }
          if (row.phase !== 'auditing') {
            return { ok: false as const, error: `adjustments are only allowed during auditing (current phase: ${row.phase})` }
          }
          // Defensive session authorization: ensures the caller holds the
          // loop's current session, preventing a stale auditor session from
          // modifying the plan after session rotation.
          if (row.currentSessionId !== args.auditorSessionId) {
            return { ok: false as const, error: `session mismatch: only the current auditor session may adjust the plan for loop ${name}` }
          }

          const currentIndex = row.currentSectionIndex
          const fromIndex = currentIndex + 1

          if (args.currentSection) {
            const currentRow = sectionPlansRepo!.get(projectId, name, currentIndex)
            if (!currentRow) {
              return { ok: false as const, error: `current section ${currentIndex} does not exist` }
            }
            if (currentRow.status !== 'in_progress') {
              return { ok: false as const, error: `cannot edit section ${currentIndex}: current section may only be edited while in_progress (status: ${currentRow.status})` }
            }
          }

          const replacementSections = args.sections
          const newTotal = replacementSections !== undefined ? fromIndex + replacementSections.length : row.totalSections
          if (replacementSections !== undefined) {
            if (newTotal > MAX_TOTAL_SECTIONS) {
              return { ok: false as const, error: `resulting total sections (${newTotal}) would exceed cap ${MAX_TOTAL_SECTIONS}` }
            }
            if (newTotal === 0) {
              return { ok: false as const, error: 'resulting total sections would be zero' }
            }
          }

          // Snapshot from the earliest changed index: the current section when
          // it is being edited, otherwise the pending suffix start.
          const snapshotFrom = args.currentSection ? currentIndex : fromIndex
          const beforeRows = sectionPlansRepo!.list(projectId, name)
            .filter((r) => r.sectionIndex >= snapshotFrom)
            .map((r) => ({ index: r.sectionIndex, title: r.title, content: r.content }))
          const sectionsBefore = JSON.stringify(beforeRows)

          if (replacementSections !== undefined) {
            const replaceResult = sectionPlansRepo!.replacePendingSections({
              projectId,
              loopName: name,
              fromIndex,
              sections: replacementSections,
            })
            if (!replaceResult.ok) {
              return replaceResult
            }
            loopsRepo.setTotalSections(projectId, name, newTotal)
          }

          if (args.currentSection) {
            sectionPlansRepo!.updateContent(projectId, name, [{
              index: currentIndex,
              title: args.currentSection.title,
              content: args.currentSection.content,
            }])
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
            hint: { projectDir: row.projectDir, worktreeDir: row.worktreeDir },
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
      return { ok: true, totalSections: txnResult.totalSections, hint: txnResult.hint }
    }

    // Strip the `hint` before returning to callers — it's only used for the notification inside inner().
    function stripHint(r: AdjustResult): { ok: true; totalSections: number } | { ok: false; error: string } {
      if (isAdjustedOk(r)) return { ok: r.ok, totalSections: r.totalSections }
      return r
    }

    if (runExclusive) {
      return runExclusive(name, async () => stripHint(inner()))
    }
    return stripHint(inner())
  }

  return {
    getActiveState,
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
    getSectionPlan,
    getSectionPlans,
    recordSectionCodeGraph,
    recordAttemptCodeGraph,
    getLatestAttempt,
    getNextIncompleteSectionPlan,
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
