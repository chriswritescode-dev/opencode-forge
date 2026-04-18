import type { Logger, LoopConfig } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopsRepo, LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'

export const MAX_RETRIES = 3
export const STALL_TIMEOUT_MS = 60_000
export const MAX_CONSECUTIVE_STALLS = 5
export const RECENT_MESSAGES_COUNT = 5

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
  phase: 'coding' | 'auditing'
  audit: boolean
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
}

export interface LoopService {
  getActiveState(name: string): LoopState | null
  getAnyState(name: string): LoopState | null
  setState(name: string, state: LoopState): void
  deleteState(name: string): void
  registerLoopSession(sessionId: string, loopName: string): void
  resolveLoopName(sessionId: string): string | null
  unregisterLoopSession(sessionId: string): void
  buildContinuationPrompt(state: LoopState, auditFindings?: string): string
  buildAuditPrompt(state: LoopState): string
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  getStallTimeoutMs(): number
  terminateAll(): void
  reconcileStale(): number
  hasOutstandingFindings(branch?: string, severity?: 'bug' | 'warning'): boolean
  getOutstandingFindings(branch?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  generateUniqueLoopName(baseName: string): string
  getPlanText(loopName: string, sessionId: string): string | null
  incrementError(name: string): number
  resetError(name: string): void
  incrementAudit(name: string): number
  setPhase(name: string, phase: 'coding' | 'auditing'): void
  setPhaseAndResetError(name: string, phase: 'coding' | 'auditing'): void
  setModelFailed(name: string, failed: boolean): void
  setLastAuditResult(name: string, text: string | null): void
  setSandboxContainer(name: string, containerName: string | null): void
  setStatus(name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'): void
  applyRotation(name: string, opts: { sessionId: string; iteration: number; phase?: 'coding' | 'auditing'; auditCount?: number; lastAuditResult?: string | null; resetError?: boolean }): void
  terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void
}

export function createLoopService(
  loopsRepo: LoopsRepo,
  plansRepo: PlansRepo,
  reviewFindingsRepo: ReviewFindingsRepo,
  projectId: string,
  logger: Logger,
  loopConfig?: LoopConfig,
): LoopService {
  function rowToState(row: LoopRow, large: LoopLargeFields | null): LoopState {
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
      audit: row.audit,
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
    }
  }

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
      audit: state.audit,
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
    }
  }

  function getAnyState(name: string): LoopState | null {
    const row = loopsRepo.get(projectId, name)
    if (!row) return null
    const large = loopsRepo.getLarge(projectId, name)
    return rowToState(row, large)
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
  }

  function deleteState(name: string): void {
    loopsRepo.delete(projectId, name)
  }

  function setStatus(name: string, status: LoopRow['status']): void {
    loopsRepo.setStatus(projectId, name, status)
  }

  function registerLoopSession(sessionId: string, loopName: string): void {
    loopsRepo.setCurrentSessionId(projectId, loopName, sessionId)
  }

  function resolveLoopName(sessionId: string): string | null {
    return loopsRepo.getBySessionId(projectId, sessionId)?.loopName ?? null
  }

  function unregisterLoopSession(_sessionId: string): void {
    // No-op: the only caller is rotateSession, which immediately calls registerLoopSession
    // The old session has no row pointing to it — nothing to unregister
  }

  function buildContinuationPrompt(state: LoopState, auditFindings?: string): string {
    let systemLine = `Loop iteration ${String(state.iteration)}`

    if (state.maxIterations > 0) {
      systemLine += ` / ${String(state.maxIterations)}`
    } else {
      systemLine += ` | No max iterations set - loop runs until auditor all-clear or cancelled`
    }

    let prompt = `[${systemLine}]\n\n${state.prompt ?? ''}`

    if (auditFindings) {
      prompt += `\n\n---\nThe code auditor reviewed your changes. You MUST address all bugs and convention violations below — do not dismiss findings as unrelated to the task. Fix them directly without creating a plan or asking for approval.\n\n${auditFindings}`
    }

    const outstandingFindings = getOutstandingFindings(state.worktreeBranch)
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

  function formatReviewFindings(branch?: string): string {
    const findings = getOutstandingFindings(branch)
    if (findings.length === 0) {
      return 'No existing review findings.'
    }

    return findings.map((finding) => {
      return [
        `- ${finding.file}:${finding.line}`,
        `  - Severity: ${finding.severity}`,
        `  - Description: ${finding.description}`,
        `  - Scenario: ${finding.scenario}`,
      ].join('\n')
    }).join('\n\n')
  }

  function buildAuditPrompt(state: LoopState): string {
    const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
    const planText = getPlanTextForState(state) ?? 'Plan not found in plan store.'
    const reviewFindings = formatReviewFindings(state.worktreeBranch)

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
      return rowToState(row, large)
    })
  }

  function listRecent(): LoopState[] {
    const rows = loopsRepo.listByStatus(projectId, ['completed', 'cancelled', 'errored', 'stalled'])
    return rows.map((row) => {
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return rowToState(row, large)
    })
  }

  function findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] } {
    const result = loopsRepo.findPartial(projectId, name)
    const mapResult = (row: LoopRow | null): LoopState | null => {
      if (!row) return null
      const large = loopsRepo.getLarge(projectId, row.loopName)
      return rowToState(row, large)
    }
    return {
      match: mapResult(result.match),
      candidates: result.candidates.map((row) => {
        const large = loopsRepo.getLarge(projectId, row.loopName)
        return rowToState(row, large)
      }),
    }
  }

  function getStallTimeoutMs(): number {
    return loopConfig?.stallTimeoutMs ?? STALL_TIMEOUT_MS
  }

  function terminateAll(): void {
    const active = listActive()
    const now = Date.now()
    for (const state of active) {
      loopsRepo.terminate(projectId, state.loopName, {
        status: 'cancelled',
        reason: 'shutdown',
        completedAt: now,
      })
    }
    logger.log(`Loop: terminated ${String(active.length)} active loop(s)`)
  }

  function reconcileStale(): number {
    const active = listActive()
    const now = Date.now()
    for (const state of active) {
      loopsRepo.terminate(projectId, state.loopName, {
        status: 'cancelled',
        reason: 'shutdown',
        completedAt: now,
      })
      logger.log(`Reconciled stale active loop: ${state.loopName} (was at iteration ${String(state.iteration)})`)
    }
    return active.length
  }

  function getOutstandingFindings(branch?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[] {
    const rows = branch ? reviewFindingsRepo.listByBranch(projectId, branch) : reviewFindingsRepo.listAll(projectId)
    return severity ? rows.filter((r) => r.severity === severity) : rows
  }

  function hasOutstandingFindings(branch?: string, severity?: 'bug' | 'warning'): boolean {
    return getOutstandingFindings(branch, severity).length > 0
  }

  function generateUniqueLoopName(baseName: string): string {
    const existing = listRecent()
    const active = listActive()
    const allNames = [...existing, ...active].map((s) => s.loopName)
    
    return generateUniqueName(baseName, allNames)
  }

  function incrementError(name: string): number {
    return loopsRepo.incrementError(projectId, name)
  }

  function resetError(name: string): void {
    loopsRepo.resetError(projectId, name)
  }

  function incrementAudit(name: string): number {
    return loopsRepo.incrementAudit(projectId, name)
  }

  function setPhase(name: string, phase: 'coding' | 'auditing'): void {
    loopsRepo.updatePhase(projectId, name, phase)
  }

  function setPhaseAndResetError(name: string, phase: 'coding' | 'auditing'): void {
    loopsRepo.setPhaseAndResetError(projectId, name, phase)
  }

  function setModelFailed(name: string, failed: boolean): void {
    loopsRepo.setModelFailed(projectId, name, failed)
  }

  function setLastAuditResult(name: string, text: string | null): void {
    loopsRepo.setLastAuditResult(projectId, name, text)
  }

  function applyRotation(name: string, opts: { sessionId: string; iteration: number; phase?: 'coding' | 'auditing'; auditCount?: number; lastAuditResult?: string | null; resetError?: boolean }): void {
    loopsRepo.applyRotation(projectId, name, opts)
  }

  function terminate(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void {
    loopsRepo.terminate(projectId, name, opts)
  }

  function setSandboxContainer(name: string, containerName: string | null): void {
    loopsRepo.setSandboxContainer(projectId, name, containerName)
  }

  return {
    getActiveState,
    getAnyState,
    setState,
    deleteState,
    registerLoopSession,
    resolveLoopName,
    unregisterLoopSession,
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
    incrementAudit,
    setPhase,
    setPhaseAndResetError,
    setModelFailed,
    setLastAuditResult,
    setSandboxContainer,
    applyRotation,
    terminate,
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
