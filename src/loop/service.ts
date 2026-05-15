import type { Logger, LoopConfig } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopsRepo, LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopState } from './state'
import {
  buildContinuationPrompt as _buildContinuationPrompt,
  buildAuditPrompt as _buildAuditPrompt,
  buildDecomposerInitialPrompt as _buildDecomposerInitialPrompt,
  buildSectionInitialPrompt as _buildSectionInitialPrompt,
  buildSectionAuditPrompt as _buildSectionAuditPrompt,
  buildSectionContinuationPrompt as _buildSectionContinuationPrompt,
  buildFinalAuditPrompt as _buildFinalAuditPrompt,
  type PromptContext,
} from './prompts'
import { parseSectionSummary as _parseSectionSummary } from './section-summary'
import { generateUniqueName } from './name-uniqueness'

export const MAX_RETRIES = 3
const STALL_TIMEOUT_MS = 60_000
const MAX_CONSECUTIVE_STALLS = 5

export type LoopChangeReason =
  | 'insert' | 'delete' | 'terminate'
  | 'rotate' | 'phase' | 'iteration'
  | 'status' | 'session'
  | 'sandbox' | 'workspace' | 'audit-result'
  | 'model-failed' | 'error' | 'reconcile'

export type LoopChangeNotifier = (reason: LoopChangeReason, loopName: string, hint?: { projectDir?: string; worktreeDir?: string }) => void

export interface LoopService {
  getActiveState(name: string): LoopState | null
  getAnyState(name: string): LoopState | null
  setState(name: string, state: LoopState): void
  deleteState(name: string): void
  registerLoopSession(sessionId: string, loopName: string): void
  resolveLoopName(sessionId: string): string | null
  buildContinuationPrompt(state: LoopState, auditFindings?: string): string
  buildAuditPrompt(state: LoopState): string
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  getStallTimeoutMs(): number
  getMaxConsecutiveStalls(): number
  terminateAll(): Promise<void>
  reconcileStale(opts?: { isSandboxLive?: (loopName: string) => Promise<boolean> }): Promise<{ cancelled: number; preserved: string[]; restartCandidates: LoopState[] }>
  reconcileFinalize(loopName: string, action: 'cancel' | 'restored'): void
  hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean
  getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  generateUniqueLoopName(baseName: string): string
  getPlanText(loopName: string, sessionId: string): string | null
  incrementError(name: string): number
  resetError(name: string): void
  setPhase(name: string, phase: LoopState['phase']): void
  setPhaseAndResetError(name: string, phase: LoopState['phase']): void
  setModelFailed(name: string, failed: boolean): void
  setLastAuditResult(name: string, text: string): void
  clearLastAuditResult(name: string): void
  setSandboxContainer(name: string, containerName: string | null): void
  setStatus(name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'): void
  clearWorkspaceId(name: string): void
  setWorkspaceId(name: string, workspaceId: string): void
  terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void
  replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getNextIncompleteSectionPlan(state: LoopState): SectionPlanRow | null
  getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[]
  parseSectionSummary(text: string): { done: string | null; deviations: string | null; followUps: string | null } | null

  buildDecomposerInitialPrompt(state: LoopState): string
  buildSectionInitialPrompt(state: LoopState): string
  buildSectionAuditPrompt(state: LoopState): string
  buildSectionContinuationPrompt(state: LoopState, auditText: string): string
  buildFinalAuditPrompt(state: LoopState): string
  completeSection(loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }): void
  incrementSectionAttempts(loopName: string, index: number): void
  resetSectionForRewind(loopName: string, index: number): void
  setCurrentSectionIndex(loopName: string, index: number): void
  setFinalAuditDone(loopName: string, done: boolean): void
  startSection(loopName: string, index: number): void
  setDecompositionStatus(loopName: string, status: LoopState['decompositionStatus']): void
  setDecompositionSessionId(loopName: string, sessionId: string | null): void
  bulkInsertSections(loopName: string, sections: { index: number; title: string; content: string }[]): void
  setTotalSections(loopName: string, total: number): void
}

export function rowToLoopState(row: LoopRow, large: LoopLargeFields | null): LoopState {
  return {
    active: row.status === 'running',
    sessionId: row.currentSessionId,
    loopName: row.loopName,
    worktreeDir: row.worktreeDir,
    projectDir: row.projectDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    startedAt: new Date(row.startedAt).toISOString(),
    phase: row.phase,
    lastAuditResult: large?.lastAuditResult ?? undefined,
    errorCount: row.errorCount,
    auditCount: row.auditCount,
    terminationReason: row.terminationReason ?? undefined,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    worktree: row.worktree,
    modelFailed: row.modelFailed,
    sandbox: row.sandbox,
    sandboxContainer: row.sandboxContainer ?? undefined,
    completionSummary: row.completionSummary ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    hostSessionId: row.hostSessionId ?? undefined,
    decompositionStatus: row.decompositionStatus,
    decompositionMode: row.decompositionMode,
    decompositionSessionId: row.decompositionSessionId,
    currentSectionIndex: row.currentSectionIndex,
    totalSections: row.totalSections,
    finalAuditDone: row.finalAuditDone === 1,
  }
}

export function createLoopService(
  loopsRepo: LoopsRepo,
  plansRepo: PlansRepo,
  reviewFindingsRepo: ReviewFindingsRepo,
  projectId: string,
  logger: Logger,
  loopConfig?: LoopConfig,
  notify?: LoopChangeNotifier,
  _v2Client?: OpencodeClient,
  sectionPlansRepo?: SectionPlansRepo,
): LoopService {
  const notifyLoopChange: LoopChangeNotifier = notify ?? (() => {})

  function stateToRow(state: LoopState): LoopRow {
    return {
      projectId,
      loopName: state.loopName,
      status: state.active ? 'running' : 'completed',
      currentSessionId: state.sessionId,
      worktree: state.worktree ?? false,
      worktreeDir: state.worktreeDir,
      worktreeBranch: state.worktreeBranch ?? null,
      projectDir: state.projectDir ?? state.worktreeDir,
      maxIterations: state.maxIterations,
      iteration: state.iteration,
      auditCount: state.auditCount,
      errorCount: state.errorCount,
      phase: state.phase,
      executionModel: state.executionModel ?? null,
      auditorModel: state.auditorModel ?? null,
      modelFailed: state.modelFailed ?? false,
      sandbox: state.sandbox ?? false,
      sandboxContainer: state.sandboxContainer ?? null,
      startedAt: new Date(state.startedAt).getTime(),
      completedAt: state.completedAt ? new Date(state.completedAt).getTime() : null,
      terminationReason: state.terminationReason ?? null,
      completionSummary: state.completionSummary ?? null,
      workspaceId: state.workspaceId ?? null,
      hostSessionId: state.hostSessionId ?? null,
      decompositionStatus: state.decompositionStatus,
      decompositionMode: state.decompositionMode,
      decompositionSessionId: state.decompositionSessionId,
      currentSectionIndex: state.currentSectionIndex,
      totalSections: state.totalSections,
      finalAuditDone: state.finalAuditDone ? 1 : 0,
    }
  }

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
    const state = rowToLoopState(row, large)
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
    const row = stateToRow(state)
    const large: LoopLargeFields = {
      lastAuditResult: state.lastAuditResult ?? null,
    }
    const ok = loopsRepo.insert(row, large)
    if (!ok) {
      throw new Error(`setState: loop "${name}" already exists`)
    }
    if (state.prompt) {
      plansRepo.writeForLoop(projectId, name, state.prompt)
    }
    notifyLoopChange('insert', name, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
  }

  function deleteState(name: string): void {
    const state = getAnyState(name)
    loopsRepo.delete(projectId, name)
    plansRepo.deleteForLoop(projectId, name)
    notifyLoopChange('delete', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
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

  function replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void {
    const state = getAnyState(name)
    loopsRepo.replaceSession(projectId, name, {
      sessionId: opts.newSessionId,
      phase: opts.phase,
      iteration: opts.iteration,
      resetError: opts.resetError,
      auditCount: opts.auditCount,
      lastAuditResult: opts.lastAuditResult,
    })
    notifyLoopChange('rotate', name, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
  }

  const _promptCtx: PromptContext = { getPlanTextForState, getOutstandingFindings, formatReviewFindings, getSectionPlan, getCompletedSectionDigest }

  function buildContinuationPrompt(state: LoopState, auditFindings?: string): string {
    return _buildContinuationPrompt(_promptCtx, state, auditFindings)
  }

  function getPlanTextForState(state: LoopState): string | null {
    return plansRepo.getForLoopOrSession(projectId, state.loopName, state.sessionId)?.content ?? null
  }

  function getPlanText(loopName: string, sessionId: string): string | null {
    return plansRepo.getForLoopOrSession(projectId, loopName, sessionId)?.content ?? null
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
      return hydratePlanFromPlans(rowToLoopState(row, large))
    })
  }

  function listRecent(): LoopState[] {
    const rows = loopsRepo.listByStatus(projectId, ['completed', 'cancelled', 'errored', 'stalled'])
    return rows.map((row) => {
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return hydratePlanFromPlans(rowToLoopState(row, large))
    })
  }

  function findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] } {
    const result = loopsRepo.findPartial(projectId, name)
    const mapResult = (row: LoopRow | null): LoopState | null => {
      if (!row) return null
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return hydratePlanFromPlans(rowToLoopState(row, large))
    }
    return {
      match: mapResult(result.match),
      candidates: result.candidates.map((row) => {
        const large = loopsRepo.getLarge(projectId, row.loopName)
        return hydratePlanFromPlans(rowToLoopState(row, large))
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
      notifyLoopChange('terminate', state.loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
    }
    logger.log(`Loop: terminated ${String(active.length)} active loop(s)`)
  }

  async function reconcileStale(opts?: { isSandboxLive?: (loopName: string) => Promise<boolean> }): Promise<{ cancelled: number; preserved: string[]; restartCandidates: LoopState[] }> {
    const active = listActive()
    const now = Date.now()
    const preserved: string[] = []
    const restartCandidates: LoopState[] = []
    let cancelled = 0

    // Back-compatible path: no opts means cancel everything (old behavior)
    if (!opts?.isSandboxLive) {
      for (const state of active) {
        loopsRepo.terminate(projectId, state.loopName, {
          status: 'cancelled',
          reason: 'shutdown',
          completedAt: now,
        })
        notifyLoopChange('reconcile', state.loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
        logger.log(`Reconciled stale active loop: ${state.loopName} (was at iteration ${String(state.iteration)})`)
      }
      return { cancelled: active.length, preserved: [], restartCandidates: [] }
    }

    // Selective path: preserve loops with live sandbox containers; flag dead-sandbox loops
    // with intact worktrees as restart candidates (caller decides whether to actually restart).
    for (const state of active) {
      const eligibleForPreserve =
        !!state.sandbox &&
        !!state.worktree &&
        !!state.worktreeDir &&
        !!state.sandboxContainer &&
        !!state.loopName

      const live = eligibleForPreserve ? await opts.isSandboxLive(state.loopName) : false

      if (live) {
        preserved.push(state.loopName)
        logger.log(`Loop: preserved active sandbox loop across plugin restart: ${state.loopName} (iteration ${String(state.iteration)})`)
        continue
      }

      const eligibleForRestart =
        !!state.sandbox &&
        !!state.worktree &&
        !!state.worktreeDir &&
        !!state.loopName

      if (eligibleForRestart) {
        restartCandidates.push(state)
        logger.log(`Loop: queued for auto-restart attempt: ${state.loopName} (iteration ${String(state.iteration)}, phase=${state.phase})`)
        continue
      }

      loopsRepo.terminate(projectId, state.loopName, {
        status: 'cancelled',
        reason: 'shutdown',
        completedAt: now,
      })
      notifyLoopChange('reconcile', state.loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
      logger.log(`Reconciled stale active loop: ${state.loopName} (was at iteration ${String(state.iteration)})`)
      cancelled++
    }

    return { cancelled, preserved, restartCandidates }
  }

  function reconcileFinalize(loopName: string, action: 'cancel' | 'restored'): void {
    const state = getAnyState(loopName)
    if (action === 'cancel') {
      loopsRepo.terminate(projectId, loopName, {
        status: 'cancelled',
        reason: 'shutdown',
        completedAt: Date.now(),
      })
      notifyLoopChange('reconcile', loopName, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
      logger.log(`Loop: auto-restart unavailable, cancelled stale loop: ${loopName}`)
    } else {
      notifyLoopChange('reconcile', loopName, state ? { projectDir: state.projectDir, worktreeDir: state.worktreeDir } : undefined)
      logger.log(`Loop: auto-restored stale loop across plugin restart: ${loopName}`)
    }
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

  function terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void {
    const state = getAnyState(name)
    loopsRepo.terminate(projectId, name, opts)
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

  function buildDecomposerInitialPrompt(state: LoopState): string {
    return _buildDecomposerInitialPrompt(_promptCtx, state)
  }

  function buildSectionInitialPrompt(state: LoopState): string {
    return _buildSectionInitialPrompt(_promptCtx, state)
  }

  function buildSectionAuditPrompt(state: LoopState): string {
    return _buildSectionAuditPrompt(_promptCtx, state)
  }

  function buildSectionContinuationPrompt(state: LoopState, auditText: string): string {
    return _buildSectionContinuationPrompt(_promptCtx, state, auditText)
  }

  function buildFinalAuditPrompt(state: LoopState): string {
    return _buildFinalAuditPrompt(_promptCtx, state)
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

  function setDecompositionStatus(loopName: string, status: LoopState['decompositionStatus']): void {
    loopsRepo.setDecompositionStatus(projectId, loopName, status)
  }

  function setDecompositionSessionId(loopName: string, sessionId: string | null): void {
    loopsRepo.setDecompositionSessionId(projectId, loopName, sessionId)
  }

  function bulkInsertSections(loopName: string, sections: { index: number; title: string; content: string }[]): void {
    if (!sectionPlansRepo) return
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
  }

  function setTotalSections(loopName: string, total: number): void {
    loopsRepo.setTotalSections(projectId, loopName, total)
  }

  return {
    getActiveState,
    getAnyState,
    setState,
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
    reconcileStale,
    reconcileFinalize,
    hasOutstandingFindings,
    getOutstandingFindings,
    generateUniqueLoopName,
    getPlanText,
    incrementError,
    resetError,
    setPhase,
    setPhaseAndResetError,
    setModelFailed,
    setLastAuditResult,
    clearLastAuditResult,
    setSandboxContainer,
    terminate,
    clearWorkspaceId,
    setWorkspaceId,
    replaceSession,
    getSectionPlan,
    getNextIncompleteSectionPlan,
    getCompletedSectionDigest,
    parseSectionSummary,

    buildDecomposerInitialPrompt,
    buildSectionInitialPrompt,
    buildSectionAuditPrompt,
    buildSectionContinuationPrompt,
    buildFinalAuditPrompt,
    completeSection,
    incrementSectionAttempts,
    resetSectionForRewind,
    setCurrentSectionIndex,
    setFinalAuditDone,
    startSection,
    setDecompositionStatus,
    setDecompositionSessionId,
    bulkInsertSections,
    setTotalSections,
  }
}

// Re-export generateUniqueName for backward compatibility
export { generateUniqueName } from './name-uniqueness'
