import type { Logger, LoopConfig } from '../types'
import type { LoopsRepo, LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
import type { LoopState } from './state'
import { loopRowToState, loopStateToRow } from './state'
import {
  buildContinuationPrompt as _buildContinuationPrompt,
  buildAuditPrompt as _buildAuditPrompt,
  buildSectionInitialPrompt as _buildSectionInitialPrompt,
  buildSectionAuditPrompt as _buildSectionAuditPrompt,
  buildSectionContinuationPrompt as _buildSectionContinuationPrompt,
  buildFinalAuditPrompt as _buildFinalAuditPrompt,
  buildFinalAuditFixPrompt as _buildFinalAuditFixPrompt,
  buildPostActionPrompt as _buildPostActionPrompt,
  type PostActionPromptOptions,
  type PromptContext,
} from './prompts'
import { parseSectionSummary as _parseSectionSummary } from './section-summary'
import { generateUniqueName } from './name-uniqueness'
import { bumpRecurrence, findingRecurrenceKey } from './finding-recurrence'

export const MAX_RETRIES = 3
const STALL_TIMEOUT_MS = 60_000
const MAX_CONSECUTIVE_STALLS = 5
/** Hard cap on the total number of sections a loop may have after amendment. */
const MAX_TOTAL_SECTIONS = 24

export type LoopChangeReason =
  | 'insert' | 'delete' | 'terminate'
  | 'rotate' | 'phase' | 'iteration'
  | 'status' | 'session'
  | 'sandbox' | 'workspace' | 'audit-result' | 'post-action-report'
  | 'model-failed' | 'error' | 'sections-adjusted'

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
  buildContinuationPrompt(state: LoopState, auditFindings?: string, outstandingBugs?: ReviewFindingRow[]): string
  buildAuditPrompt(state: LoopState): string
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  getStallTimeoutMs(): number
  getMaxConsecutiveStalls(): number
  terminateAll(): Promise<void>
  hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean
  getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  setCoderDecisions(name: string, decisions: string | null): void
  bumpFindingRecurrence(name: string, findings: ReviewFindingRow[]): void
  resetSectionRecurrence(name: string, sectionIndex: number): void
  generateUniqueLoopName(baseName: string): string
  getPlanText(loopName: string, sessionId: string): string | null
  incrementError(name: string): number
  resetError(name: string): void
  setPhase(name: string, phase: LoopState['phase']): void
  setPhaseAndResetError(name: string, phase: LoopState['phase']): void
  setModelFailed(name: string, failed: boolean): void
  setLastAuditResult(name: string, text: string): void
  clearLastAuditResult(name: string): void
  setPostActionReport(name: string, text: string): void
  setSandboxContainer(name: string, containerName: string | null): void
  setStatus(name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'): void
  clearWorkspaceId(name: string): void
  setWorkspaceId(name: string, workspaceId: string): void
  terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void
  replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null; executorSessionId?: string | null }): void
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getNextIncompleteSectionPlan(state: LoopState): SectionPlanRow | null
  getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[]
  parseSectionSummary(text: string): { done: string | null; deviations: string | null; followUps: string | null } | null

  buildSectionInitialPrompt(state: LoopState): string
  buildSectionAuditPrompt(state: LoopState): string
  buildSectionContinuationPrompt(state: LoopState, auditText: string, outstandingBugs?: ReviewFindingRow[]): string
  buildFinalAuditPrompt(state: LoopState): string
  buildFinalAuditFixPrompt(state: LoopState, auditText: string, outstandingBugs?: ReviewFindingRow[]): string
  buildPostActionPrompt(state: LoopState, opts: PostActionPromptOptions): string
  completeSection(loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }): void
  incrementSectionAttempts(loopName: string, index: number): void
  resetSectionForRewind(loopName: string, index: number): void
  setCurrentSectionIndex(loopName: string, index: number): void
  setFinalAuditDone(loopName: string, done: boolean): void
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
  adjustRemainingSections(name: string, args: {
    sections: { title: string; content: string }[]
    rationale: string
    auditorSessionId?: string
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

  function setState(name: string, state: LoopState): void {
    if (state.loopName !== name) {
      throw new Error(`setState: name parameter "${name}" does not match state.loopName "${state.loopName}"`)
    }
    const row = loopStateToRow(state, projectId)
    const large: LoopLargeFields = {
      lastAuditResult: state.lastAuditResult ?? null,
      postActionReport: state.postActionReport ?? null,
      // Goal loops persist their goal solely in loop_large_fields, never in plans.
      goal: row.kind === 'goal' ? (state.goal ?? null) : null,
    }
    const ok = loopsRepo.insert(row, large)
    if (!ok) {
      throw new Error(`setState: loop "${name}" already exists`)
    }
    if (row.kind !== 'goal' && state.prompt) {
      plansRepo.writeForLoop(projectId, name, state.prompt)
    }
    notifyLoopChange('insert', name, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
  }

  function deleteState(name: string): void {
    const state = getAnyState(name)
    loopsRepo.delete(projectId, name)
    plansRepo.deleteForLoop(projectId, name)
    coderDecisionsByLoop.delete(name)
    findingRecurrenceByLoop.delete(name)
    notifyLoopChange('delete', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function restoreState(name: string, state: LoopState): void {
    if (state.loopName !== name) {
      throw new Error(`restoreState: name parameter "${name}" does not match state.loopName "${state.loopName}"`)
    }
    const row = loopStateToRow(state, projectId)
    const large: LoopLargeFields = {
      lastAuditResult: state.lastAuditResult ?? null,
      postActionReport: state.postActionReport ?? null,
      goal: row.kind === 'goal' ? (state.goal ?? null) : null,
    }
    loopsRepo.restore(row, large)
    if (row.kind !== 'goal' && state.prompt) {
      plansRepo.writeForLoop(projectId, name, state.prompt)
    }
    notifyLoopChange('rotate', name, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
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

  function replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null; executorSessionId?: string | null }): void {
    const state = getAnyState(name)
    loopsRepo.replaceSession(projectId, name, {
      sessionId: opts.newSessionId,
      phase: opts.phase,
      iteration: opts.iteration,
      resetError: opts.resetError,
      auditCount: opts.auditCount,
      lastAuditResult: opts.lastAuditResult,
      executorSessionId: opts.executorSessionId,
    })
    notifyLoopChange('rotate', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  function getFindingRecurrence(loopName?: string): Map<string, number> {
    if (!loopName) return new Map()
    return findingRecurrenceByLoop.get(loopName) ?? new Map()
  }

  const _promptCtx: PromptContext = { getPlanTextForState, getOutstandingFindings, formatReviewFindings, getSectionPlan, getCompletedSectionDigest, getCoderDecisions, getFindingRecurrence }

  function buildContinuationPrompt(state: LoopState, auditFindings?: string, outstandingBugs?: ReviewFindingRow[]): string {
    return _buildContinuationPrompt(_promptCtx, state, auditFindings, outstandingBugs)
  }

  function getPlanTextForState(state: LoopState): string | null {
    return plansRepo.getForLoopOrSession(projectId, state.loopName, state.sessionId)?.content ?? null
  }

  function getPlanText(loopName: string, sessionId: string): string | null {
    return plansRepo.getForLoopOrSession(projectId, loopName, sessionId)?.content ?? null
  }

  function getCoderDecisions(loopName?: string): string | null {
    if (!loopName) return null
    return coderDecisionsByLoop.get(loopName) ?? null
  }

  function formatReviewFindings(loopName?: string): string {
    const findings = getOutstandingFindings(loopName)
    if (findings.length === 0) {
      return 'No existing review findings.'
    }

    return findings.map((finding) => {
      return [
        `- ${finding.file}:${finding.line}`,
        `  - Severity: ${finding.severity}`,
        `  - Description: ${finding.description}`,
        `  - Scenario: ${finding.scenario || 'N/A'}`,
      ].join('\n')
    }).join('\n\n')
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

  function hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean {
    return getOutstandingFindings(loopName, severity).length > 0
  }

  function generateUniqueLoopName(baseName: string): string {
    const existing = listRecent()
    const active = listActive()
    const allNames = [...existing, ...active].map((s) => s.loopName)
    
    return generateUniqueName(baseName, allNames)
  }

  function setCoderDecisions(name: string, decisions: string | null): void {
    if (!decisions) {
      coderDecisionsByLoop.delete(name)
    } else {
      coderDecisionsByLoop.set(name, decisions)
    }
  }

  function bumpFindingRecurrence(name: string, findings: ReviewFindingRow[]): void {
    const prev = findingRecurrenceByLoop.get(name) ?? new Map()
    const keys = findings.map(f => findingRecurrenceKey(f))
    findingRecurrenceByLoop.set(name, bumpRecurrence(prev, keys))
  }

  function resetSectionRecurrence(name: string, sectionIndex: number): void {
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

  function getNextIncompleteSectionPlan(state: LoopState): SectionPlanRow | null {
    if (!sectionPlansRepo) return null
    return sectionPlansRepo.getNextIncomplete(projectId, state.loopName)
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

  function parseSectionSummary(text: string): { done: string | null; deviations: string | null; followUps: string | null } | null {
    return _parseSectionSummary(text)
  }

  function buildSectionInitialPrompt(state: LoopState): string {
    return _buildSectionInitialPrompt(_promptCtx, state)
  }

  function buildSectionAuditPrompt(state: LoopState): string {
    return _buildSectionAuditPrompt(_promptCtx, state)
  }

  function buildSectionContinuationPrompt(state: LoopState, auditText: string, outstandingBugs?: ReviewFindingRow[]): string {
    return _buildSectionContinuationPrompt(_promptCtx, state, auditText, outstandingBugs)
  }

  function buildFinalAuditPrompt(state: LoopState): string {
    return _buildFinalAuditPrompt(_promptCtx, state)
  }

  function buildFinalAuditFixPrompt(state: LoopState, auditText: string, outstandingBugs?: ReviewFindingRow[]): string {
    return _buildFinalAuditFixPrompt(_promptCtx, state, auditText, outstandingBugs)
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

  function setFinalAuditDone(loopName: string, done: boolean): void {
    loopsRepo.setFinalAuditDone(projectId, loopName, done)
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

    async function adjustRemainingSections(name: string, args: {
    sections: { title: string; content: string }[]
    rationale: string
    auditorSessionId?: string
  }): Promise<{ ok: true; totalSections: number } | { ok: false; error: string }> {
    if (!sectionPlansRepo) {
      return { ok: false, error: 'section plans repository is not configured' }
    }
    if (!planAmendmentsRepo) {
      return { ok: false, error: 'plan amendments repository is not configured' }
    }
    if (!args.rationale || args.rationale.trim().length === 0) {
      return { ok: false, error: 'rationale must not be empty' }
    }
    // Empty `sections` is permitted: it removes the entire pending suffix
    // (Phase 8 auditors may delete remaining work, not just replace it).

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
          if (row.kind === 'goal') {
            return { ok: false as const, error: 'goal loops do not support section amendment' }
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
          if (args.auditorSessionId && row.currentSessionId !== args.auditorSessionId) {
            return { ok: false as const, error: `session mismatch: only the current auditor session may adjust the plan` }
          }

          const fromIndex = row.currentSectionIndex + 1
          const newTotal = fromIndex + args.sections.length
          if (newTotal > MAX_TOTAL_SECTIONS) {
            return { ok: false as const, error: `resulting total sections (${newTotal}) would exceed cap ${MAX_TOTAL_SECTIONS}` }
          }
          if (newTotal === 0) {
            return { ok: false as const, error: 'resulting total sections would be zero' }
          }

          const beforeRows = sectionPlansRepo!.list(projectId, name)
            .filter((r) => r.sectionIndex >= fromIndex)
            .map((r) => ({ index: r.sectionIndex, title: r.title, content: r.content }))
          const sectionsBefore = JSON.stringify(beforeRows)

          const replaceResult = sectionPlansRepo!.replacePendingSections({
            projectId,
            loopName: name,
            fromIndex,
            sections: args.sections,
          })
          if (!replaceResult.ok) {
            return replaceResult
          }

          loopsRepo.setTotalSections(projectId, name, newTotal)

          const afterRows = sectionPlansRepo!.list(projectId, name)
            .filter((r) => r.sectionIndex >= fromIndex)
            .map((r) => ({ index: r.sectionIndex, title: r.title, content: r.content }))
          const sectionsAfter = JSON.stringify(afterRows)

          planAmendmentsRepo!.insert({
            projectId,
            loopName: name,
            source: 'auditor',
            rationale: args.rationale,
            appliedAtSection: row.currentSectionIndex,
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
    setStatus,
    buildContinuationPrompt,
    buildAuditPrompt,
    listActive,
    listRecent,
    findMatchByName,
    getStallTimeoutMs,
    getMaxConsecutiveStalls,
    terminateAll,
    hasOutstandingFindings,
    getOutstandingFindings,
    setCoderDecisions,
    bumpFindingRecurrence,
    resetSectionRecurrence,
    generateUniqueLoopName,
    getPlanText,
    incrementError,
    resetError,
    setPhase,
    setPhaseAndResetError,
    setModelFailed,
    setLastAuditResult,
    clearLastAuditResult,
    setPostActionReport,
    setSandboxContainer,
    terminate,
    clearWorkspaceId,
    setWorkspaceId,
    replaceSession,
    getSectionPlan,
    getNextIncompleteSectionPlan,
    getCompletedSectionDigest,
    parseSectionSummary,

    buildSectionInitialPrompt,
    buildSectionAuditPrompt,
    buildSectionContinuationPrompt,
    buildFinalAuditPrompt,
    buildFinalAuditFixPrompt,
    buildPostActionPrompt,
    completeSection,
    incrementSectionAttempts,
    resetSectionForRewind,
    setCurrentSectionIndex,
    setFinalAuditDone,
    startSection,
    bulkInsertSections,
    setTotalSections,
    recordTransition,
    adjustRemainingSections,
  }
}
