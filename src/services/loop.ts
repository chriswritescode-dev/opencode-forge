import type { KvService, KvEntry } from './kv'
import type { Logger, LoopConfig } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { findPartialMatch } from '../utils/partial-match'

export function migrateRalphKeys(kvService: KvService, projectId: string, logger: Logger): void {
  const oldEntries = kvService.listByPrefix(projectId, 'ralph:')
  if (oldEntries.length === 0) return
  
  logger.log(`Migrating ${String(oldEntries.length)} ralph: KV entries to loop: prefix`)
  for (const entry of oldEntries) {
    const newKey = entry.key.replace(/^ralph:/, 'loop:')
    const data = (typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data) as Record<string, unknown>
    if ('inPlace' in data) {
      data.worktree = !(data.inPlace as boolean)
      delete data.inPlace
    }
    kvService.set(projectId, newKey, data)
    kvService.delete(projectId, entry.key)
  }
  
  const oldSessions = kvService.listByPrefix(projectId, 'ralph-session:')
  for (const entry of oldSessions) {
    const newKey = entry.key.replace(/^ralph-session:/, 'loop-session:')
    kvService.set(projectId, newKey, entry.data)
    kvService.delete(projectId, entry.key)
  }
  
  if (oldSessions.length > 0) {
    logger.log(`Migrated ${String(oldSessions.length)} ralph-session: KV entries to loop-session: prefix`)
  }
}

export const MAX_RETRIES = 3
export const STALL_TIMEOUT_MS = 60_000
export const MAX_CONSECUTIVE_STALLS = 5
export const DEFAULT_MIN_AUDITS = 1
export const RECENT_MESSAGES_COUNT = 5
export const DEFAULT_COMPLETION_SIGNAL = 'ALL_PHASES_COMPLETE'

export function buildCompletionSignalInstructions(signal: string): string {
  return `\n\n---\n\n**IMPORTANT - Completion Signal:** When you have completed ALL phases of this plan successfully, you MUST output the following phrase exactly: ${signal}\n\nBefore outputting the completion signal, you MUST:\n1. Verify each phase's acceptance criteria are met\n2. Run all verification commands listed in the plan and confirm they pass\n3. If tests were required, confirm they exist AND pass\n\nDo NOT output this phrase until every phase is truly complete and all verification steps pass. The loop will continue until this signal is detected.`
}

export { LOOP_PERMISSION_RULESET } from '../constants/loop'

/**
 * Represents the runtime state of an autonomous loop.
 */
export interface LoopState {
  active: boolean
  sessionId: string
  loopName: string
  worktreeDir: string
  projectDir: string
  worktreeBranch?: string
  iteration: number
  maxIterations: number
  completionSignal: string | null
  startedAt: string
  prompt?: string
  phase: 'coding' | 'auditing'
  audit?: boolean
  lastAuditResult?: string
  errorCount: number
  auditCount: number
  terminationReason?: string
  completedAt?: string
  worktree?: boolean
  modelFailed?: boolean
  sandbox?: boolean
  sandboxContainerName?: string
}

export interface LoopService {
  /**
   * Gets the active state for a loop by name.
   * @param name - The loop name.
   * @returns The loop state if active, null otherwise.
   */
  getActiveState(name: string): LoopState | null
  /**
   * Gets any state (active or completed) for a loop by name.
   * @param name - The loop name.
   * @returns The loop state if found, null otherwise.
   */
  getAnyState(name: string): LoopState | null
  /**
   * Updates the state for a loop.
   * @param name - The loop name.
   * @param state - The new state to persist.
   */
  setState(name: string, state: LoopState): void
  /**
   * Deletes the state for a loop.
   * @param name - The loop name.
   */
  deleteState(name: string): void
  /**
   * Registers a session as belonging to a loop.
   * @param sessionId - The OpenCode session ID.
   * @param loopName - The loop name to associate.
   */
  registerLoopSession(sessionId: string, loopName: string): void
  /**
   * Resolves the loop name for a session.
   * @param sessionId - The OpenCode session ID.
   * @returns The loop name if found, null otherwise.
   */
  resolveLoopName(sessionId: string): string | null
  /**
   * Unregisters a session from its loop.
   * @param sessionId - The OpenCode session ID.
   */
  unregisterLoopSession(sessionId: string): void
  /**
   * Checks if text contains the completion signal.
   * @param text - The text to check.
   * @param promise - The completion signal phrase.
   * @returns True if the signal is present.
   */
  checkCompletionSignal(text: string, promise: string): boolean
  /**
   * Builds the prompt for continuing a loop iteration.
   * @param state - The current loop state.
   * @param auditFindings - Optional audit findings to include.
   * @returns The continuation prompt string.
   */
  buildContinuationPrompt(state: LoopState, auditFindings?: string): string
  /**
   * Builds the prompt for the auditor agent.
   * @param state - The current loop state.
   * @returns The audit prompt string.
   */
  buildAuditPrompt(state: LoopState): string
  /**
   * Lists all currently active loops.
   * @returns Array of active loop states.
   */
  listActive(): LoopState[]
  /**
   * Lists recently completed loops.
   * @returns Array of completed loop states.
   */
  listRecent(): LoopState[]
  /**
   * Finds a loop by exact or partial name match.
   * @param name - The loop name to search for.
   * @returns The matching loop state or null.
   */
  findByLoopName(name: string): LoopState | null
  /**
   * Finds candidate loops matching a partial name.
   * @param name - The partial name to search for.
   * @returns Array of matching loop states.
   */
  findCandidatesByPartialName(name: string): LoopState[]
  /**
   * Gets the configured stall timeout in milliseconds.
   * @returns Stall timeout value.
   */
  getStallTimeoutMs(): number
  /**
   * Gets the minimum number of audits required.
   * @returns Minimum audit count.
   */
  getMinAudits(): number
  /**
   * Terminates all active loops.
   */
  terminateAll(): void
  /**
   * Reconciles loops that were active but are now stale.
   * @returns Number of loops reconciled.
   */
  reconcileStale(): number
  /**
   * Checks if there are outstanding review findings.
   * @param branch - Optional branch to filter by.
   * @returns True if findings exist.
   */
  hasOutstandingFindings(branch?: string): boolean
  /**
   * Gets all outstanding review findings.
   * @param branch - Optional branch to filter by.
   * @returns Array of KV entries with findings.
   */
  getOutstandingFindings(branch?: string): KvEntry[]
  /**
   * Generates a unique loop name based on a base name.
   * @param baseName - The desired base name.
   * @returns A unique loop name.
   */
  generateUniqueLoopName(baseName: string): string
}

/**
 * Creates a loop service instance for managing autonomous dev loops.
 * 
 * @param kvService - KV service for persistence.
 * @param projectId - The current project ID.
 * @param logger - Logger instance.
 * @param loopConfig - Optional loop configuration.
 * @returns A LoopService instance.
 */
export function createLoopService(
  kvService: KvService,
  projectId: string,
  logger: Logger,
  loopConfig?: LoopConfig,
): LoopService {
  const stateKey = (name: string) => `loop:${name}`

  function normalizeLoopState(state: LoopState | null): LoopState | null {
    if (!state) return null
    if (!state.loopName) return null
    // Backfill projectDir from worktreeDir for older KV records
    if (!state.projectDir && state.worktreeDir) {
      state.projectDir = state.worktreeDir
    }
    return state
  }

  function getAnyState(name: string): LoopState | null {
    return normalizeLoopState(kvService.get<LoopState>(projectId, stateKey(name)))
  }

  function getActiveState(name: string): LoopState | null {
    const state = normalizeLoopState(kvService.get<LoopState>(projectId, stateKey(name)))
    if (!state?.active) {
      return null
    }
    return state
  }

  function setState(name: string, state: LoopState): void {
    const normalized = normalizeLoopState(state)
    if (!normalized) return
    kvService.set(projectId, stateKey(name), normalized)
  }

  function deleteState(name: string): void {
    kvService.delete(projectId, stateKey(name))
  }

  function registerLoopSession(sessionId: string, loopName: string): void {
    kvService.set(projectId, `loop-session:${sessionId}`, loopName)
  }

  function resolveLoopName(sessionId: string): string | null {
    return kvService.get<string>(projectId, `loop-session:${sessionId}`)
  }

  function unregisterLoopSession(sessionId: string): void {
    kvService.delete(projectId, `loop-session:${sessionId}`)
  }

  function checkCompletionSignal(text: string, completionSignal: string): boolean {
    return text.toLowerCase().includes(completionSignal.toLowerCase())
  }


  function redactCompletionSignal(text: string, promise: string): string {
    const regex = new RegExp(promise.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    return text.replace(regex, '[SIGNAL_REDACTED]')
  }

  function buildContinuationPrompt(state: LoopState, auditFindings?: string): string {
    let systemLine = `Loop iteration ${String(state.iteration)}`

    if (state.completionSignal) {
      systemLine += ` | To stop: output ${state.completionSignal} (ONLY after all verification commands pass AND all phase acceptance criteria are met)`
    } else if (state.maxIterations > 0) {
      systemLine += ` / ${String(state.maxIterations)}`
    } else {
      systemLine += ` | No completion promise set - loop runs until cancelled`
    }

    let prompt = `[${systemLine}]\n\n${state.prompt ?? ''}`

    if (auditFindings) {
      const cleanedFindings = state.completionSignal
        ? redactCompletionSignal(auditFindings, state.completionSignal)
        : auditFindings
      const completionInstruction = state.completionSignal
        ? '\n\nAfter fixing all issues, output the completion signal.'
        : ''
      prompt += `\n\n---\nThe code auditor reviewed your changes. You MUST address all bugs and convention violations below — do not dismiss findings as unrelated to the task. Fix them directly without creating a plan or asking for approval.\n\n${cleanedFindings}${completionInstruction}`
    }

    const outstandingFindings = getOutstandingFindings(state.worktreeBranch)
    if (outstandingFindings.length > 0) {
      const findingKeys = outstandingFindings.map((f) => `- \`${f.key}\``).join('\n')
      prompt += `\n\n---\n⚠️ Outstanding Review Findings (${String(outstandingFindings.length)})\n\nThese review findings are blocking loop completion. Fix these issues so they pass the next audit review.\n\n${findingKeys}`
    }

    return prompt
  }

  function getPlanText(state: LoopState): string | null {
    return kvService.get<string>(projectId, `plan:${state.loopName}`)
      ?? kvService.get<string>(projectId, `plan:${state.sessionId}`)
      ?? null
  }

  function formatReviewFindings(branch?: string): string {
    const findings = getOutstandingFindings(branch)
    if (findings.length === 0) {
      return 'No existing review findings.'
    }

    return findings.map((finding) => {
      const data = finding.data as Record<string, unknown>
      return [
        `- ${finding.key}`,
        `  - Severity: ${String(data.severity ?? 'unknown')}`,
        `  - File: ${String(data.file ?? 'unknown')}:${String(data.line ?? 'unknown')}`,
        `  - Description: ${String(data.description ?? '')}`,
        `  - Scenario: ${String(data.scenario ?? '')}`,
        `  - Status: ${String(data.status ?? 'open')}`,
      ].join('\n')
    }).join('\n\n')
  }

  function buildAuditPrompt(state: LoopState): string {
    const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
    const planText = getPlanText(state) ?? 'Plan not found in plan store.'
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
      'This is an automated loop — do not direct the agent to "create a plan" or "present for approval." Just report findings directly.',
    ].join('\n')
  }

  function listActive(): LoopState[] {
    const entries = kvService.listByPrefix(projectId, 'loop:')
    return entries
      .map((entry) => normalizeLoopState(entry.data as LoopState | null))
      .filter((data): data is LoopState =>
        data !== null && typeof data === 'object' && 'active' in data && (data as LoopState).active
      )
  }

  function listRecent(): LoopState[] {
    const entries = kvService.listByPrefix(projectId, 'loop:')
    return entries
      .map((entry) => normalizeLoopState(entry.data as LoopState | null))
      .filter((data): data is LoopState =>
        data !== null && typeof data === 'object' && 'active' in data && !(data as LoopState).active
      )
  }

  function findByLoopName(name: string): LoopState | null {
    const active = listActive()
    const recent = listRecent()
    const allStates = [...active, ...recent]

    const { match } = findPartialMatch(name, allStates, (s) => [s.loopName, s.worktreeBranch])
    return match
  }

  function findCandidatesByPartialName(name: string): LoopState[] {
    const active = listActive()
    const recent = listRecent()
    const allStates = [...active, ...recent]

    const { candidates } = findPartialMatch(name, allStates, (s) => [s.loopName, s.worktreeBranch])
    return candidates
  }

  function getStallTimeoutMs(): number {
    return loopConfig?.stallTimeoutMs ?? STALL_TIMEOUT_MS
  }

  function getMinAudits(): number {
    return loopConfig?.minAudits ?? DEFAULT_MIN_AUDITS
  }

  function terminateAll(): void {
    const active = listActive()
    for (const state of active) {
      const updated: LoopState = {
        ...state,
        active: false,
        completedAt: new Date().toISOString(),
        terminationReason: 'shutdown',
      }
      setState(state.loopName, updated)
    }
    logger.log(`Loop: terminated ${String(active.length)} active loop(s)`)
  }

  function reconcileStale(): number {
    const active = listActive()
    for (const state of active) {
      setState(state.loopName, {
        ...state,
        active: false,
        completedAt: new Date().toISOString(),
        terminationReason: 'shutdown',
      })
      logger.log(`Reconciled stale active loop: ${state.loopName} (was at iteration ${String(state.iteration)})`)
    }
    return active.length
  }

  function getOutstandingFindings(branch?: string): KvEntry[] {
    const findings = kvService.listByPrefix(projectId, 'review-finding:')
    if (!branch) return findings
    return findings.filter((f) => {
      const data = f.data as Record<string, unknown> | null
      return data?.branch === branch
    })
  }

  function hasOutstandingFindings(branch?: string): boolean {
    return getOutstandingFindings(branch).length > 0
  }

  function generateUniqueLoopName(baseName: string): string {
    const existing = listRecent()
    const active = listActive()
    const allNames = [...existing, ...active].map((s) => s.loopName)
    
    return generateUniqueName(baseName, allNames)
  }

  return {
    getActiveState,
    getAnyState,
    setState,
    deleteState,
    registerLoopSession,
    resolveLoopName,
    unregisterLoopSession,
    checkCompletionSignal,
    buildContinuationPrompt,
    buildAuditPrompt,
    listActive,
    listRecent,
    findByLoopName,
    findCandidatesByPartialName,
    getStallTimeoutMs,
    getMinAudits,
    terminateAll,
    reconcileStale,
    hasOutstandingFindings,
    getOutstandingFindings,
    generateUniqueLoopName,
  }
}

/**
 * Generates a unique worktree name by checking against existing names and appending a numeric suffix if needed.
 * This is exported for use by TUI and other modules that need to generate unique names without direct loop service access.
 * 
 * @param baseName - The base name to uniquify
 * @param existingNames - Array of existing worktree names to check against
 * @returns A unique name (either the base name or with -1, -2, etc. suffix)
 */
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

/**
 * Fetches the output and statistics for a completed loop session.
 * 
 * @param v2Client - OpenCode v2 API client.
 * @param sessionId - The session ID to fetch.
 * @param directory - The working directory.
 * @param logger - Optional logger for debugging.
 * @returns Session output including messages, costs, and file changes.
 */
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
