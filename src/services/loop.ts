import type { Logger, LoopConfig } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopsRepo, LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import { teardownWorktreeArtifacts } from '../utils/worktree-cleanup'

export type LoopChangeReason =
  | 'insert' | 'delete' | 'terminate'
  | 'rotate' | 'phase' | 'iteration'
  | 'status' | 'session'
  | 'sandbox' | 'workspace' | 'audit-result'
  | 'model-failed' | 'error' | 'reconcile'

export type LoopChangeNotifier = (reason: LoopChangeReason, loopName: string, hint?: { projectDir?: string; worktreeDir?: string }) => void

export const MAX_RETRIES = 3
const STALL_TIMEOUT_MS = 60_000
export const MAX_CONSECUTIVE_STALLS = 5
const RECENT_MESSAGES_COUNT = 5
const orphanSweepWorkspaceIds = new Set<string>()

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotFoundError' || err.message.includes('NotFoundError'))
}

/**
 * Represents the runtime state of an autonomous loop.
 */
export interface LoopState {
  active: boolean
  sessionId: string
  loopName: string
  worktreeDir: string
  projectDir?: string
  worktreeBranch?: string
  iteration: number
  maxIterations: number
  startedAt: string
  prompt?: string
  phase: 'coding' | 'auditing' | 'decomposing' | 'final_auditing'
  lastAuditResult?: string
  errorCount: number
  auditCount: number
  terminationReason?: string
  completedAt?: string
  worktree?: boolean
  modelFailed?: boolean
  sandbox?: boolean
  sandboxContainer?: string
  completionSummary?: string
  executionModel?: string
  auditorModel?: string
  workspaceId?: string
  hostSessionId?: string
  decompositionStatus: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  decompositionMode: 'agent' | 'deterministic'
  decompositionSessionId: string | null
  currentSectionIndex: number
  totalSections: number
  finalAuditDone: boolean
  finalAuditAttempts: number
}

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
  terminateAll(): Promise<void>
  reconcileStale(opts?: { isSandboxLive?: (loopName: string) => Promise<boolean> }): Promise<{ cancelled: number; preserved: string[] }>
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
  getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[]
  parseSectionSummary(text: string): { done: string | null; deviations: string | null; followUps: string | null } | null
  parseFinalAuditClear(text: string): boolean
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
  incrementFinalAuditAttempts(loopName: string): number
  startSection(loopName: string, index: number): void
  setDecompositionStatus(loopName: string, status: LoopState['decompositionStatus']): void
  setDecompositionSessionId(loopName: string, sessionId: string | null): void
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
    prompt: large?.prompt ?? undefined,
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
    finalAuditAttempts: row.finalAuditAttempts,
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
  v2Client?: OpencodeClient,
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
      finalAuditAttempts: state.finalAuditAttempts,
    }
  }

  function getAnyState(name: string): LoopState | null {
    const row = loopsRepo.get(projectId, name)
    if (!row) return null
    const large = loopsRepo.getLarge(projectId, name)
    return rowToLoopState(row, large)
  }

  function getActiveState(name: string): LoopState | null {
    const state = getAnyState(name)
    if (!state?.active) {
      return null
    }
    return state
  }

  function setState(name: string, state: LoopState): void {
    // Assert that the name parameter matches state.loopName to prevent silent data corruption
    if (state.loopName !== name) {
      throw new Error(`setState: name parameter "${name}" does not match state.loopName "${state.loopName}"`)
    }
    const row = stateToRow(state)
    const large: LoopLargeFields = {
      prompt: state.prompt ?? null,
      lastAuditResult: state.lastAuditResult ?? null,
    }
    // Use insert which errors on conflict - should never happen for setState
    const ok = loopsRepo.insert(row, large)
    if (!ok) {
      throw new Error(`setState: loop "${name}" already exists`)
    }
    notifyLoopChange('insert', name, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
  }

  function deleteState(name: string): void {
    const state = getAnyState(name)
    loopsRepo.delete(projectId, name)
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

  function buildContinuationPrompt(state: LoopState, auditFindings?: string): string {
    if (state.totalSections > 0) {
      return buildSectionContinuationPrompt(state, auditFindings || '')
    }

    let systemLine = `Loop iteration ${String(state.iteration)}`

    if (state.maxIterations > 0) {
      systemLine += ` / ${String(state.maxIterations)}`
    } else {
      systemLine += ` | No max iterations set - loop runs until auditor all-clear or cancelled`
    }

    let prompt = `[${systemLine}]`

    if (auditFindings) {
      prompt += `\n\n---\nThe code auditor reviewed your changes. You MUST address all bugs and convention violations below — do not dismiss findings as unrelated to the task. Fix them directly without creating a plan or asking for approval.\n\n${auditFindings}`
    }

    const outstandingFindings = getOutstandingFindings(state.loopName)
    if (outstandingFindings.length > 0) {
      const findingKeys = outstandingFindings.map((f) => `- \`${f.file}:${f.line}\``).join('\n')
      prompt += `\n\n---\n⚠️ Outstanding Review Findings (${String(outstandingFindings.length)})\n\nThese review findings are blocking loop completion. Fix these issues so they pass the next audit review.\n\n${findingKeys}`
    }

    return prompt
  }

  function getPlanTextForState(state: LoopState): string | null {
    const fromExecution = loopsRepo.getLarge(projectId, state.loopName)?.prompt
    if (fromExecution) return fromExecution
    return plansRepo.getForLoopOrSession(projectId, state.loopName, state.sessionId)?.content ?? null
  }

  function getPlanText(loopName: string, sessionId: string): string | null {
    const fromExecution = loopsRepo.getLarge(projectId, loopName)?.prompt
    if (fromExecution) return fromExecution
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
    if (state.totalSections > 0) {
      // Final-audit window: use the final-audit prompt for sectioned loops
      if (state.phase === 'final_auditing') {
        return buildFinalAuditPrompt(state)
      }
      // Otherwise, use section-specific audit prompt
      return buildSectionAuditPrompt(state)
    }

    const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
    const planText = getPlanTextForState(state) ?? 'Plan not found in plan store.'
    const reviewFindings = formatReviewFindings(state.loopName)

    return [
      `Post-iteration ${String(state.iteration)} code review${branchInfo}.`,
      '',
      'Implementation plan:',
      planText,
      '',
      'Existing review findings:',
      reviewFindings,
      '',
      'Review the code changes against the plan phases and verify per-phase acceptance criteria are met.',
      'Review the code changes in this worktree. Focus on bugs, logic errors, missing error handling, and convention violations.',
      'If you find bugs in related code that affect the correctness of this task, report them — even if the buggy code was not directly modified.',
      'For each existing finding above, verify whether it has been resolved. Delete resolved findings with review-delete and report any unresolved findings that still apply.',
      'If everything looks good, state "No issues found." clearly.',
      '',
      'Plan completeness check:',
      '- For every plan phase, verify it is fully implemented and its acceptance criteria are met.',
      '- If any phase is unimplemented, partially implemented, or its acceptance criteria are not met, you MUST write a `severity: "bug"` finding describing exactly which phase and what is missing. Use `file` = the phase\'s target file when possible, otherwise use a stable pseudo-path such as `PLAN:phase-<N>`. Use `line` = 1 when no specific line applies.',
      '- When a previously reported "phase incomplete" finding is now resolved, delete it with review-delete.',
      '- Outstanding `bug` findings block loop termination. The loop cannot complete while any `bug` finding remains.',
      '',
      'This is an automated loop — do not direct the agent to "create a plan" or "present for approval." Just report findings directly.',
    ].join('\n')
  }

  function listActive(): LoopState[] {
    const rows = loopsRepo.listByStatus(projectId, ['running'])
    return rows.map((row) => {
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return rowToLoopState(row, large)
    })
  }

  function listRecent(): LoopState[] {
    const rows = loopsRepo.listByStatus(projectId, ['completed', 'cancelled', 'errored', 'stalled'])
    return rows.map((row) => {
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return rowToLoopState(row, large)
    })
  }

  function findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] } {
    const result = loopsRepo.findPartial(projectId, name)
    const mapResult = (row: LoopRow | null): LoopState | null => {
      if (!row) return null
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return rowToLoopState(row, large)
    }
    return {
      match: mapResult(result.match),
      candidates: result.candidates.map((row) => {
        const large = loopsRepo.getLarge(projectId, row.loopName)
        return rowToLoopState(row, large)
      }),
    }
  }

  function getStallTimeoutMs(): number {
    return loopConfig?.stallTimeoutMs ?? STALL_TIMEOUT_MS
  }

  async function terminateAll(): Promise<void> {
    const active = listActive()
    const now = Date.now()
    for (const state of active) {
      if (state.worktree && v2Client) {
        try {
          await teardownWorktreeArtifacts({
            v2: v2Client,
            loopName: state.loopName,
            sessionId: state.sessionId,
            workspaceId: state.workspaceId,
            worktreeDir: state.worktreeDir,
            worktree: true,
            doCommit: true,
            doRemoveWorktree: true,
            reasonLabel: 'shutdown',
            worktreeBranch: state.worktreeBranch,
            iteration: state.iteration,
            logPrefix: 'Loop',
            logger,
          })
          logger.log(`Loop: teardown for ${state.loopName} sessionDeleted=true workspaceDeleted=true worktreeRemoved=true`)
        } catch (err) {
          logger.error(`Loop: teardown failed for ${state.loopName}`, err)
        }
      }
      loopsRepo.terminate(projectId, state.loopName, {
        status: 'cancelled',
        reason: 'shutdown',
        completedAt: now,
      })
      notifyLoopChange('terminate', state.loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
    }
    logger.log(`Loop: terminated ${String(active.length)} active loop(s)`)
  }

  async function reconcileStale(opts?: { isSandboxLive?: (loopName: string) => Promise<boolean> }): Promise<{ cancelled: number; preserved: string[] }> {
    const active = listActive()
    const now = Date.now()
    const preserved: string[] = []
    let cancelled = 0

    // Back-compatible path: no opts means cancel everything (old behavior)
    if (!opts?.isSandboxLive) {
      for (const state of active) {
        if (state.worktree && v2Client) {
          try {
            await teardownWorktreeArtifacts({
              v2: v2Client,
              loopName: state.loopName,
              sessionId: state.sessionId,
              workspaceId: state.workspaceId,
              worktreeDir: state.worktreeDir,
              worktree: true,
              doCommit: true,
              doRemoveWorktree: true,
              reasonLabel: 'shutdown',
              worktreeBranch: state.worktreeBranch,
              iteration: state.iteration,
              logPrefix: 'Loop',
              logger,
            })
            logger.log(`Loop: teardown for ${state.loopName} sessionDeleted=true workspaceDeleted=true worktreeRemoved=true`)
          } catch (err) {
            logger.error(`Loop: teardown failed for ${state.loopName}`, err)
          }
        }
        loopsRepo.terminate(projectId, state.loopName, {
          status: 'cancelled',
          reason: 'shutdown',
          completedAt: now,
        })
        notifyLoopChange('reconcile', state.loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
        logger.log(`Reconciled stale active loop: ${state.loopName} (was at iteration ${String(state.iteration)})`)
      }
      return { cancelled: active.length, preserved: [] }
    }

    // Selective path: preserve loops with live sandbox containers
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
        // No status change, no notify — the row stays running.
        continue
      }

      if (state.worktree && v2Client) {
        try {
          await teardownWorktreeArtifacts({
            v2: v2Client,
            loopName: state.loopName,
            sessionId: state.sessionId,
            workspaceId: state.workspaceId,
            worktreeDir: state.worktreeDir,
            worktree: true,
            doCommit: true,
            doRemoveWorktree: true,
            reasonLabel: 'shutdown',
            worktreeBranch: state.worktreeBranch,
            iteration: state.iteration,
            logPrefix: 'Loop',
            logger,
          })
          logger.log(`Loop: teardown for ${state.loopName} sessionDeleted=true workspaceDeleted=true worktreeRemoved=true`)
        } catch (err) {
          logger.error(`Loop: teardown failed for ${state.loopName}`, err)
        }
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

    return { cancelled, preserved }
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
    const markerRegex = /<!--\s*section-summary:start\s*-->\n([\s\S]*?)\n<!--\s*section-summary:end\s*-->/g
    const match = markerRegex.exec(text)
    if (!match) return null

    const body = match[1]
    const doneMatch = body.match(/### Done\s*\n([\s\S]*?)(?=### |$)/)
    const devMatch = body.match(/### Deviations\s*\n([\s\S]*?)(?=### |$)/)
    const followMatch = body.match(/### Follow-ups\s*\n([\s\S]*?)(?=### |$)/)

    return {
      done: doneMatch?.[1]?.trim() || null,
      deviations: devMatch?.[1]?.trim() || null,
      followUps: followMatch?.[1]?.trim() || null,
    }
  }

  function parseFinalAuditClear(text: string): boolean {
    return /<!--\s*final-audit:clear\s*-->/.test(text)
  }

  function buildDecomposerInitialPrompt(state: LoopState): string {
    const planText = getPlanTextForState(state) ?? 'Plan not found in plan store.'
    return `[Decomposing master plan into section plans]\n\n${planText}`
  }

  function buildSectionInitialPrompt(state: LoopState): string {
    const idx = state.currentSectionIndex
    const total = state.totalSections
    const iter = state.iteration
    const maxIter = state.maxIterations
    const section = getSectionPlan(state, idx)
    if (!section) return ''

    const digest = getCompletedSectionDigest(state)
    let header = `[Loop section ${idx + 1}/${total} -- iteration ${iter}/${maxIter}]`

    if (digest.length > 0) {
      const sectionsSummary = digest.map(s => {
        let parts = `## Section ${s.index + 1}: ${s.title}`
        if (s.summaryDone) parts += `\n### Done\n${s.summaryDone}`
        if (s.summaryDeviations) parts += `\n### Deviations\n${s.summaryDeviations}`
        if (s.summaryFollowUps) parts += `\n### Follow-ups\n${s.summaryFollowUps}`
        return parts
      }).join('\n\n')
      header += `\n\n### Prior Sections' Summaries\n${sectionsSummary}`
    }

    header += `\n\n## Section plan\n${section.content}`

    return header
  }

  function buildSectionAuditPrompt(state: LoopState): string {
    const idx = state.currentSectionIndex
    const total = state.totalSections
    const section = getSectionPlan(state, idx)
    if (!section) return ''

    const digest = getCompletedSectionDigest(state)
    let header = `[Loop section audit ${idx + 1}/${total}]`

    if (digest.length > 0) {
      const sectionsSummary = digest.map(s => {
        let parts = `## Section ${s.index + 1}: ${s.title}`
        if (s.summaryDone) parts += `\n### Done\n${s.summaryDone}`
        if (s.summaryDeviations) parts += `\n### Deviations\n${s.summaryDeviations}`
        if (s.summaryFollowUps) parts += `\n### Follow-ups\n${s.summaryFollowUps}`
        return parts
      }).join('\n\n')
      header += `\n\n### Prior Sections' Summaries\n${sectionsSummary}`
    }

    header += `\n\n## Section under audit\n${section.content}`

    header += `\n\n---\nAudit instructions:\n- Use review-read to see findings for this section.\n- Delete resolved findings.\n- Write severity: bug findings for unmet acceptance criteria or failed verification (defaults to current section_index).\n- When the section is clear, end your response with:\n<!-- section-summary:start -->\n### Done\n- bullets describing what was implemented\n### Deviations\n- bullets describing places implementation differs from this section plan, with reasons (or "none")\n### Follow-ups\n- bullets noting items deferred to later sections (or "none")\n<!-- section-summary:end -->`

    return header
  }

  function buildSectionContinuationPrompt(state: LoopState, auditText: string): string {
    const idx = state.currentSectionIndex
    const total = state.totalSections
    const iter = state.iteration
    const maxIter = state.maxIterations
    const section = getSectionPlan(state, idx)
    if (!section) return ''

    const digest = getCompletedSectionDigest(state)
    let header = `[Loop section ${idx + 1}/${total} -- iteration ${iter}/${maxIter} (continuation)]`

    if (digest.length > 0) {
      const sectionsSummary = digest.map(s => {
        let parts = `## Section ${s.index + 1}: ${s.title}`
        if (s.summaryDone) parts += `\n### Done\n${s.summaryDone}`
        if (s.summaryDeviations) parts += `\n### Deviations\n${s.summaryDeviations}`
        if (s.summaryFollowUps) parts += `\n### Follow-ups\n${s.summaryFollowUps}`
        return parts
      }).join('\n\n')
      header += `\n\n### Prior Sections' Summaries\n${sectionsSummary}`
    }

    header += `\n\n## Section plan\n${section.content}`
    header += `\n\n---\n## Auditor feedback from previous attempt\n${auditText}`

    const outstandingFindings = getOutstandingFindings(state.loopName, 'bug')
      .filter(f => f.sectionIndex === idx)
    if (outstandingFindings.length > 0) {
      const findingKeys = outstandingFindings.map(f => `- \`${f.file}:${f.line}\``).join('\n')
      header += `\n\n---\n## Outstanding findings\n${findingKeys}`
    }

    return header
  }

  function buildFinalAuditPrompt(state: LoopState): string {
    const attempts = state.finalAuditAttempts + 1
    const planText = getPlanTextForState(state) ?? 'Plan not found in plan store.'
    const digest = getCompletedSectionDigest(state)

    let header = `[Final integration audit -- pass ${attempts}/${MAX_RETRIES + 1}]`
    header += `\n\n## Master Plan\n${planText}`

    if (digest.length > 0) {
      const sectionsSummary = digest.map(s => {
        let parts = `## Section ${s.index + 1}: ${s.title}`
        if (s.summaryDone) parts += `\n### Done\n${s.summaryDone}`
        if (s.summaryDeviations) parts += `\n### Deviations\n${s.summaryDeviations}`
        if (s.summaryFollowUps) parts += `\n### Follow-ups\n${s.summaryFollowUps}`
        return parts
      }).join('\n\n')
      header += `\n\n### Completed Sections' Summaries\n${sectionsSummary}`
    }

    header += `\n\n---\nFinal audit instructions:\n- Verify the master plan's top-level Verification commands and acceptance criteria.\n- Use the per-section ### Deviations entries to interpret discrepancies. If a discrepancy is explained by a deviation, accept it unless it materially breaks the master plan's top-level Verification.\n- Write findings with sectionIndex pointing to the section you believe contains the bug. Use crossSection: true only when the bug spans multiple sections.\n- When the implementation is acceptable, end your response with:\n<!-- final-audit:clear -->`

    return header
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

  function incrementFinalAuditAttempts(loopName: string): number {
    return loopsRepo.incrementFinalAuditAttempts(projectId, loopName)
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
    terminateAll,
    reconcileStale,
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
    getCompletedSectionDigest,
    parseSectionSummary,
    parseFinalAuditClear,
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
    incrementFinalAuditAttempts,
    startSection,
    setDecompositionStatus,
    setDecompositionSessionId,
  }
}

export function generateUniqueName(baseName: string, existingNames: readonly string[]): string {
  const maxLength = 25
  const truncated = baseName.length > maxLength ? baseName.substring(0, maxLength) : baseName
  
  if (!existingNames.includes(truncated)) {
    return truncated
  }
  
  let counter = 1
  let candidate = `${truncated}-${counter}`
  
  while (existingNames.includes(candidate)) {
    counter++
    candidate = `${truncated}-${counter}`
  }
  
  return candidate
}

export interface LoopSessionOutput {
  messages: { text: string; cost: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } }[]
  totalCost: number
  totalTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  fileChanges: { additions: number; deletions: number; files: number } | null
}

export async function sweepOrphanWorkspaces(opts: {
  v2Client: OpencodeClient
  loopsRepo: LoopsRepo
  projectId: string
  logger: Logger
}): Promise<{ removed: number; errors: string[] }> {
  const { v2Client, loopsRepo, projectId, logger } = opts
  const result = { removed: 0, errors: [] as string[] }

  const workspaceApi = v2Client.experimental?.workspace
  if (!workspaceApi?.list) {
    logger.log('Sweep: experimental.workspace.list not available, skipping orphan sweep')
    return result
  }

  try {
    const listResult = await workspaceApi.list()
    const workspaces = (listResult.data ?? []) as Array<{
      id: string
      type?: string
      directory?: string
      extra?: unknown
    }>

    const forgeWorktreeWorkspaces = workspaces.filter((w) => w.type === 'forge-worktree')
    if (forgeWorktreeWorkspaces.length === 0) {
      return result
    }

    const activeRows = loopsRepo.listByStatus(projectId, ['running'])
    const activeWorkspaceIds = new Set(activeRows.map((r) => r.workspaceId).filter((id): id is string => id !== null))

    for (const workspace of forgeWorktreeWorkspaces) {
      if (activeWorkspaceIds.has(workspace.id)) {
        continue
      }
      if (orphanSweepWorkspaceIds.has(workspace.id)) {
        logger.debug(`Sweep: workspace ${workspace.id} already being swept, skipping`)
        continue
      }

      orphanSweepWorkspaceIds.add(workspace.id)
      logger.log(`Sweep: found orphan workspace ${workspace.id} (type=forge-worktree)`)

      try {
        const sessionApi = v2Client.experimental?.session
        if (sessionApi?.list) {
          try {
            const sessionResult = await sessionApi.list({ workspace: workspace.id })
            const sessions = (sessionResult.data ?? []) as Array<{ id: string }>
            for (const session of sessions) {
              try {
                await v2Client.session.delete({ sessionID: session.id, directory: workspace.directory ?? projectId })
                logger.log(`Sweep: deleted orphan session ${session.id} in workspace ${workspace.id}`)
              } catch (err) {
                if (isNotFoundError(err)) {
                  logger.debug(`Sweep: orphan session ${session.id} already deleted`)
                  continue
                }

                const msg = err instanceof Error ? err.message : String(err)
                result.errors.push(`Failed to delete session ${session.id}: ${msg}`)
                logger.error(`Sweep: failed to delete session ${session.id}`, err)
              }
            }
          } catch (err) {
            logger.error(`Sweep: failed to list sessions in workspace ${workspace.id}`, err)
          }
        }

        try {
          await workspaceApi.remove({ id: workspace.id })
          result.removed++
          logger.log(`Sweep: removed orphan workspace ${workspace.id}`)
        } catch (err) {
          if (isNotFoundError(err)) {
            logger.debug(`Sweep: orphan workspace ${workspace.id} already removed`)
            continue
          }

          const msg = err instanceof Error ? err.message : String(err)
          result.errors.push(`Failed to remove workspace ${workspace.id}: ${msg}`)
          logger.error(`Sweep: failed to remove workspace ${workspace.id}`, err)
        }
      } finally {
        orphanSweepWorkspaceIds.delete(workspace.id)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`Orphan sweep failed: ${msg}`)
    logger.error('Sweep: orphan sweep failed', err)
  }

  return result
}

export async function fetchSessionOutput(
  v2Client: OpencodeClient,
  sessionId: string,
  directory: string,
  logger?: Logger,
): Promise<LoopSessionOutput | null> {
  if (!directory || !sessionId) {
    logger?.debug('fetchSessionOutput: invalid directory or sessionId')
    return null
  }

  try {
    const messagesResult = await v2Client.session.messages({
      sessionID: sessionId,
      directory,
    })

    const messages = (messagesResult.data ?? []) as {
      info: { role: string; cost?: number; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
      parts: { type: string; text?: string }[]
    }[]

    const assistantMessages = messages.filter((m) => m.info.role === 'assistant')
    const lastThree = assistantMessages.slice(-RECENT_MESSAGES_COUNT)

    const extractedMessages = lastThree.map((msg) => {
      const text = msg.parts
        .filter((p) => p.type === 'text' && p.text !== undefined)
        .map((p) => p.text!)
        .join('\n')
      const cost = msg.info.cost ?? 0
      const tokens = msg.info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      return {
        text,
        cost,
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cacheRead: tokens.cache.read,
          cacheWrite: tokens.cache.write,
        },
      }
    })

    let totalCost = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalReasoningTokens = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0

    for (const msg of assistantMessages) {
      totalCost += msg.info.cost ?? 0
      const tokens = msg.info.tokens
      if (tokens) {
        totalInputTokens += tokens.input
        totalOutputTokens += tokens.output
        totalReasoningTokens += tokens.reasoning
        totalCacheRead += tokens.cache.read
        totalCacheWrite += tokens.cache.write
      }
    }

    const sessionResult = await v2Client.session.get({ sessionID: sessionId, directory })
    const session = sessionResult.data as { summary?: { additions: number; deletions: number; files: number } } | undefined
    const fileChanges = session?.summary
      ? {
          additions: session.summary.additions,
          deletions: session.summary.deletions,
          files: session.summary.files,
        }
      : null

    return {
      messages: extractedMessages,
      totalCost,
      totalTokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        reasoning: totalReasoningTokens,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
      },
      fileChanges,
    }
  } catch (err) {
    if (logger) {
      logger.error(`Loop: could not fetch session output for ${sessionId}`, err)
    }
    return null
  }
}
