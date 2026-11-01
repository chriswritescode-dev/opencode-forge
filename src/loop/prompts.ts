import type { LoopState } from './state'
import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { LoopAttemptRow } from '../storage/repos/loop-attempts-repo'
import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopHandoffRole } from './handoff'
import { findingRecurrenceKey, isRecurrenceEscalated } from './finding-recurrence'
import { formatFindingDetails } from '../utils/review-format'
import { blockingBugFindings } from './section-scope'
import { LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME } from '../constants/loop'

export interface SectionDigestEntry {
  index: number
  title: string
  summaryDone: string | null
  summaryDeviations: string | null
  summaryFollowUps: string | null
}

export interface PromptContext {
  getPlanTextForState(state: LoopState): string | null
  getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getSectionPlans(state: LoopState): SectionPlanRow[]
  getCompletedSectionDigest(state: LoopState): SectionDigestEntry[]
  getCoderDecisions(loopName?: string): string | null
  getFindingRecurrence(loopName?: string): Map<string, number>
  getAttemptHistory?(state: LoopState, limit?: number): LoopAttemptRow[]
  getBlockingBugFindings(state: LoopState): ReviewFindingRow[]
  /** Rendered `## Code graph` pointer for the current section, or `''` when no snapshot was stored. */
  getSectionCodeGraphBlock?(state: LoopState): string
  /** Rendered `## Code graph` pointer for the latest audit attempt, or `''` when no report was stored. */
  getAttemptCodeGraphBlock?(state: LoopState): string
}

/**
 * The only coder handoff instruction. Every coder prompt ends with it so the
 * attempt hands its decisions and verification evidence to the auditor through
 * `loop-handoff` instead of free-text prose.
 */
const CODER_HANDOFF_INSTRUCTION: string = `\n\n---
## Required: coder handoff
When this attempt is done, call \`${LOOP_HANDOFF_TOOL_NAME}\` with \`changes\` (each change and why), \`deviations\` (plan item, what you did instead, why), \`verification\` (each check: exact command, worktree-relative \`cwd\`, pass/fail/not-run, whether code changed afterwards), and optional \`notes\`, then end your turn.`

/**
 * The only auditor handoff instruction. Section audits require the summary
 * payload when the section is clean; the non-sectioned plan audit never passes
 * one because summaries apply only to sectioned loops.
 */
function auditorHandoffInstruction(includeSummary: boolean): string {
  const summaryRule = includeSummary
    ? ' When no blocking bug findings remain for this section, pass `summary` { done: [...], deviations: [...], followUps: [...] }; never pass `summary` while blocking bugs remain.'
    : ''
  return `\n\n---
## Required: auditor handoff
When the audit is done, call \`${LOOP_HANDOFF_TOOL_NAME}\`.${summaryRule} Use \`notes\` only for context the findings do not carry. Then end your turn.`
}

export const AUDITOR_HANDOFF_INSTRUCTION: string = auditorHandoffInstruction(true)

/** Short follow-up sent when a phase session ended its turn without its handoff tool. */
export function buildHandoffNudgePrompt(role: LoopHandoffRole): string {
  const tool = role === 'post_action' ? LOOP_COMPLETE_TOOL_NAME : LOOP_HANDOFF_TOOL_NAME
  return `You ended your turn without calling \`${tool}\`. Finish the work, then call it.`
}

function formatSectionsSummary(digest: SectionDigestEntry[]): string {
  return digest.map(s => {
    let parts = `## Section ${s.index + 1}: ${s.title}`
    if (s.summaryDone) parts += `\n### Done\n${s.summaryDone}`
    if (s.summaryDeviations) parts += `\n### Deviations\n${s.summaryDeviations}`
    if (s.summaryFollowUps) parts += `\n### Follow-ups\n${s.summaryFollowUps}`
    return parts
  }).join('\n\n')
}

function getEscalatedFindings(ctx: PromptContext, state: LoopState, outstandingBugs?: ReviewFindingRow[]): { file: string; line: number; count: number }[] {
  const loopName = state.loopName
  const bugFindings = outstandingBugs ?? ctx.getOutstandingFindings(loopName, 'bug')
  const recurrence = ctx.getFindingRecurrence(loopName)
  const escalated: { file: string; line: number; count: number }[] = []
  for (const f of bugFindings) {
    const key = findingRecurrenceKey(f)
    const count = recurrence.get(key) ?? 0
    if (isRecurrenceEscalated(count)) {
      escalated.push({ file: f.file, line: f.line, count })
    }
  }
  return escalated
}

function buildRecurringFindingsCoderBlock(ctx: PromptContext, state: LoopState, outstandingBugs?: ReviewFindingRow[]): string {
  const escalated = getEscalatedFindings(ctx, state, outstandingBugs)
  if (escalated.length === 0) return ''
  const lines = escalated.map(e => `- \`${e.file}:${e.line}\` (recurred ${e.count}×)`)
  return `\n\n---\n##  Recurring blocking findings\nThese findings have recurred across multiple audits without resolution, so the previous patches did not hold. For EACH: revisit the causal hypothesis behind the earlier fix, produce a specific reproducer or counterexample that demonstrates the failure, and then either fix it definitively or, if it is intentional/correct, document the reasoning and the exact passing verification method in your ${LOOP_HANDOFF_TOOL_NAME} report so the auditor can verify and clear it. Do not repeat the previous patch without a changed hypothesis.\n\n${lines.join('\n')}`
}

function buildRecurringFindingsAuditorBlock(ctx: PromptContext, state: LoopState): string {
  const escalated = getEscalatedFindings(ctx, state)
  if (escalated.length === 0) return ''
  const lines = escalated.map(e => `- \`${e.file}:${e.line}\` (${e.count}×)`)
  return `##  Recurring findings — re-evaluate\nThese findings have recurred across audits. Re-evaluate each one under the Recurring Findings policy in your loop addendum:\n\n${lines.join('\n')}`
}

/**
 * The coding agent's only channel for finding remediation detail. The auditor
 * persists the detailed solution, acceptance criterion, and narrow verification
 * inside each finding's `description`, so the full finding text is inlined here
 * instead of being restated in auditor prose and injected verbatim.
 */
function buildOutstandingFindingsCoderBlock(findings: ReviewFindingRow[]): string {
  if (findings.length === 0) return ''
  return `\n\n---\n## Outstanding review findings (${String(findings.length)})\nThese block loop completion. Each description carries the detailed solution, acceptance criterion, and narrow verification — address every one so it passes the next audit.\n\nRemediation policy (applies to every finding below):\n- Read every finding before changing anything. Identify shared root causes across findings and fix in dependency order, addressing related findings through one owner instead of independent per-file patches. Coupled fixes are serialized under one implementation owner; independent fixes may be delegated to code subagents under the existing concurrency policy. Ordering or grouping findings is not permission to truncate, suppress, or silently defer any of them.\n- For a behavioral bug, first produce a focused failing test or reproducer through the affected public interface, then apply the smallest complete fix and show the regression check passing against the reported failure. For races, replays, or ordering bugs, exercise the ordering, competing operations, or repeated delivery explicitly instead of relying on a large suite to expose them.\n- When a failing test is inappropriate for the finding, verify with concrete source or contract evidence plus the finding's own narrow verification instead of a speculative rewrite.\n- Run targeted verification after each root-cause fix. Run all applicable repository/plan full checks once after the fix batch reaches its final state, rerunning any check a later change invalidated; never run the full suite separately for every finding unless a required check demands it.\n- Record each fix's outcome and regression check in the ${LOOP_HANDOFF_TOOL_NAME} report at the end of this attempt. Never delete findings — they stay open until the auditor clears them.\n\n${formatFindingDetails(findings)}`
}

/**
 * Short runtime status note (e.g. the auditor session could not run), not
 * auditor output. Findings carry auditor output.
 */
function buildLoopNoticeBlock(notice?: string): string {
  if (!notice) return ''
  return `\n\n---\n## Loop notice\n${notice}`
}

function buildCoderDecisionsAuditorBlock(coderDecisions: string | null, includeSeparator = true): string {
  if (!coderDecisions) return ''
  const separator = includeSeparator ? '\n\n---\n' : ''
  return `${separator}## Coder decisions & verification notes (this iteration)\nThe coding agent recorded the following as context and evidence — never an automatic waiver. Judge it under your base Verification policy: clear a finding only when current code plus evidence covering its specific scenario and acceptance criterion proves it resolved. A documented decision alone, or a different test passing, is not proof.\n\n${coderDecisions}`
}

export const ATTEMPT_HISTORY_LIMIT = 4
const ATTEMPT_NOTE_EXCERPT_CHARS = 320
const SNAPSHOT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function isValidSnapshotSha(value: string): boolean {
  return SNAPSHOT_SHA_PATTERN.test(value)
}

function boundedExcerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}…`
}

function buildDeltaAuditGuidance(latest: LoopAttemptRow): string[] {
  const deltaEligible =
    latest.outcome === null &&
    latest.snapshotCommit !== null &&
    latest.previousCommit !== null &&
    !latest.fallbackReason &&
    isValidSnapshotSha(latest.snapshotCommit) &&
    isValidSnapshotSha(latest.previousCommit)

  const lines = ['', '### Delta audit ordering (delta-first, not delta-only)']
  if (deltaEligible) {
    const summaryLines = latest.diffSummary && latest.diffSummary.trim().length > 0
      ? ['- Recorded delta summary (informational):', ...latest.diffSummary.trim().split('\n').map(l => `  ${l}`)]
      : []
    lines.push(
      `The pending attempt ${String(latest.attemptNumber)} recorded a snapshot delta. Start from the delta, then widen:`,
      `- Run exactly: \`git diff --no-ext-diff --no-textconv ${latest.previousCommit} ${latest.snapshotCommit} --\``,
      ...summaryLines,
      '- Delta-first is ordering, not narrowing: verify ALL outstanding findings via review-read, the affected callers/contracts, and the acceptance criteria in scope.',
      '- Rerun any verification the delta invalidated, plus the explicit plan checks for this scope.',
      '- Expand beyond the delta when changed shared behavior affects callers or contracts outside the span.',
      '- Do not repeat unchanged inspection or unaffected verification merely because this is a new audit turn. Carry forward previous evidence only where the delta and plan have not invalidated it.',
      '- This delta is only the last known previously audited span; if either ref is unavailable or the worktree has drifted past the snapshot commit, fall back to the full established scope for this phase.',
    )
  } else {
    lines.push(
      `- No usable snapshot delta on the latest attempt${latest.fallbackReason ? ` (${latest.fallbackReason})` : ''}: audit the full established scope for this phase.`,
    )
  }
  return lines
}

export function buildAttemptHistoryBlock(ctx: PromptContext, state: LoopState, role: 'coder' | 'auditor'): string {
  const history = [...(ctx.getAttemptHistory?.(state, ATTEMPT_HISTORY_LIMIT) ?? [])].sort((a, b) => b.id - a.id)
  if (history.length === 0) return ''

  const latest = history[0]
  const previous = history.slice(1)

  const lines: string[] = [
    '',
    '---',
    `## Audit attempt history (scope: ${latest.scope})`,
    'These records describe past attempts, not current tasks. Historical findings were already routed through the finding channel and do not reopen work — decide what to do from the current outstanding findings only. Attempt history does not guarantee correctness.',
  ]

  for (const attempt of history) {
    const outcome = attempt.outcome ?? 'pending audit'
    const afterKeys = (attempt.findingsAfter ?? []).map(findingRecurrenceKey)
    let line = `- Attempt ${String(attempt.attemptNumber)} (scope ${attempt.scope}, iteration ${String(attempt.iteration)}) — outcome: ${outcome}`
    if (afterKeys.length > 0) line += `; findings after: ${boundedExcerpt(afterKeys.join(', '), 1000)}`
    lines.push(line)
  }

  if (role === 'coder' && latest.coderDecisions && latest.coderDecisions.trim().length > 0) {
    const notes = latest.coderDecisions.trim()
    lines.push('', `### Coder decisions from latest attempt ${String(latest.attemptNumber)}`, notes.length > 6000 ? `${notes.slice(0, 6000)}\n[Truncated; retrieve the full attempt with review-read.]` : notes)
  }

  const excerptLines: string[] = []
  for (const attempt of previous) {
    if (!attempt.coderDecisions || attempt.coderDecisions.trim().length === 0) continue
    excerptLines.push(`- Attempt ${String(attempt.attemptNumber)}: ${boundedExcerpt(attempt.coderDecisions, ATTEMPT_NOTE_EXCERPT_CHARS)}`)
  }
  if (excerptLines.length > 0) {
    lines.push('', '### Prior attempted coder decisions (bounded excerpts)', ...excerptLines)
  }

  if (role === 'auditor') {
    lines.push(...buildDeltaAuditGuidance(latest))
  }

  lines.push('', `For full notes and historical findings use review-read with {attempts: true}. For older records use {attempts: true, beforeId: ${history[history.length - 1].id}, limit: 20}.`)

  return lines.join('\n')
}

/**
 * The first coder prompt of a non-sectioned loop: the raw plan followed by the
 * coder handoff instruction. Idempotent, so a stored prompt that already ends
 * with the instruction is never sent with it twice.
 */
export function buildPlanInitialPrompt(planText: string): string {
  if (planText.endsWith(CODER_HANDOFF_INSTRUCTION)) return planText
  return planText + CODER_HANDOFF_INSTRUCTION
}

export function buildContinuationPrompt(ctx: PromptContext, state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string {
  if (state.totalSections > 0) {
    return buildSectionContinuationPrompt(ctx, state, notice, outstandingBugs)
  }

  let prompt = `[${iterationSystemLine(state)}]`

  prompt += buildLoopNoticeBlock(notice)
  prompt += buildAttemptHistoryBlock(ctx, state, 'coder')
  prompt += buildOutstandingFindingsCoderBlock(ctx.getOutstandingFindings(state.loopName))
  prompt += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)
  prompt += ctx.getAttemptCodeGraphBlock?.(state) ?? ''

  return prompt + CODER_HANDOFF_INSTRUCTION
}

/**
 * The audit review scope shared by every audit prompt: the loop's own commits
 * since the exact base commit its worktree branched from, or the legacy
 * merge-base wording for rows persisted before base commits were recorded.
 */
function auditChangeScope(state: Pick<LoopState, 'baseCommit'>): string {
  if (state.baseCommit) {
    return `every commit since base commit \`${state.baseCommit}\` (\`git diff ${state.baseCommit}\` covers committed, staged and unstaged tracked changes) plus untracked files`
  }
  return "every `section <N>:` checkpoint commit since this branch's merge-base with its base branch, plus all uncommitted and untracked changes"
}

export function buildAuditPrompt(ctx: PromptContext, state: LoopState): string {
  if (state.totalSections > 0) {
    return buildSectionAuditPrompt(ctx, state)
  }

  const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const coderDecisions = ctx.getCoderDecisions(state.loopName)

  const parts: string[] = [
    `Post-iteration ${String(state.iteration)} code review${branchInfo}.`,
    '',
    'Implementation plan:',
    planText,
    '',
    'Use review-read to load the existing findings for this loop. Use review-read {attempts: true, beforeId: <id>, limit: <n>} to page older attempt history.',
  ]

  if (state.baseCommit) {
    parts.splice(1, 0, '', `Review scope: ${auditChangeScope(state)}.`)
  }

  if (coderDecisions) {
    parts.push('', '---', buildCoderDecisionsAuditorBlock(coderDecisions, false))
  }

  parts.push(buildAttemptHistoryBlock(ctx, state, 'auditor'))

  parts.push(
    '',
    'Review the code changes against the plan phases and verify per-phase acceptance criteria are met.',
    'Review the code changes in this worktree. Focus on bugs, logic errors, missing error handling, and convention violations.',
    'If you find bugs in related code that affect the correctness of this task, report them — even if the buggy code was not directly modified.',
    'For each existing finding, verify whether it has been resolved. Delete resolved findings with review-delete and keep any unresolved finding that still applies.',
    '',
    'Plan completeness check:',
    '- For every plan phase, verify it is fully implemented and its acceptance criteria are met.',
    '- If any phase is unimplemented, partially implemented, or its acceptance criteria are not met, you MUST write a `severity: "bug"` finding describing exactly which phase and what is missing. Use `file` = the phase\'s target file when possible, otherwise use a stable pseudo-path such as `PLAN:phase-<N>`. Use `line` = 1 when no specific line applies.',
    '- When a previously reported "phase incomplete" finding is now resolved, delete it with review-delete.',
    '- Outstanding `bug` findings block loop termination. The loop cannot complete while any `bug` finding remains.',
    '',
    'This is an automated loop — do not direct the agent to "create a plan" or "present for approval." Just report findings directly.',
  )

  const attemptCodeGraphBlock = ctx.getAttemptCodeGraphBlock?.(state) ?? ''
  if (attemptCodeGraphBlock) {
    parts.push(attemptCodeGraphBlock)
  }

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    parts.push('', recurringBlock)
  }

  return parts.join('\n') + auditorHandoffInstruction(false)
}

export function buildSectionInitialPrompt(ctx: PromptContext, state: LoopState): string {
  const idx = state.currentSectionIndex
  const total = state.totalSections
  const section = ctx.getSectionPlan(state, idx)
  if (!section) return ''

  return buildSectionInitialPromptText({
    currentSectionIndex: idx,
    totalSections: total,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    sectionContent: section.content,
    completedSectionDigest: ctx.getCompletedSectionDigest(state),
    codeGraphBlock: ctx.getSectionCodeGraphBlock?.(state) ?? '',
    attemptHistoryBlock: buildAttemptHistoryBlock(ctx, state, 'coder'),
  })
}

export function buildSectionInitialPromptText(input: {
  currentSectionIndex: number
  totalSections: number
  iteration: number
  maxIterations: number
  sectionContent: string
  completedSectionDigest?: SectionDigestEntry[]
  codeGraphBlock?: string
  attemptHistoryBlock?: string
}): string {
  const idx = input.currentSectionIndex
  const digest = input.completedSectionDigest ?? []
  let header = `[Loop section ${idx + 1}/${input.totalSections} -- iteration ${input.iteration}/${input.maxIterations}]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section plan\n${input.sectionContent}`

  if (input.codeGraphBlock) {
    header += input.codeGraphBlock
  }

  if (input.attemptHistoryBlock) {
    header += input.attemptHistoryBlock
  }

  return header + CODER_HANDOFF_INSTRUCTION
}

export function buildSectionAuditPrompt(ctx: PromptContext, state: LoopState): string {
  const idx = state.currentSectionIndex
  const total = state.totalSections
  const section = ctx.getSectionPlan(state, idx)
  if (!section) return ''

  const digest = ctx.getCompletedSectionDigest(state)
  let header = `[Loop section audit ${idx + 1}/${total}]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section under audit\n${section.content}`

  header += buildCoderDecisionsAuditorBlock(ctx.getCoderDecisions(state.loopName))
  header += buildAttemptHistoryBlock(ctx, state, 'auditor')
  header += ctx.getAttemptCodeGraphBlock?.(state) ?? ''

  const hasNextSection = idx + 1 < total
  const proactiveCheck = hasNextSection
    ? `call \`section-read\` with \`section_index: ${idx + 1}\` and verify its plan against the current worktree`
    : 'this is the last section, so skip the proactive next-section check'

  header += `\n\n---\nAudit instructions:\n- Review scope: this section's work is all uncommitted changes plus any commits made after the most recent \`section <N>:\` checkpoint commit (\`git log --oneline\`; the first section has no checkpoint yet). Earlier sections are already committed and audited — read them as context only.\n- This full scope is the acceptance scope on every section audit. On repeat audits, use the delta-first ordering from the attempt history to prioritize what to verify first within that scope; the delta orders the review, it does not replace the full scope.\n- Use review-read to see findings for this section. Use review-read {attempts: true, beforeId: <id>, limit: <n>} to page older attempt history.\n- Delete resolved findings.\n- Write severity: bug findings for unmet acceptance criteria or failed verification (defaults to current section_index).\n- This section is clean only when this section, every earlier section, and the cross-section findings are free of outstanding bugs. \`review-read\` returns exactly that scope: verify each finding, delete the resolved ones, and keep the unresolved ones open. Findings attributed to a later, not-yet-started section do not block this audit.\n- When the section is clear: run the proactive next-section check from your Adaptive plan adjustment rules — ${proactiveCheck}.\n- \`plan-adjust\` (section audits only) amends the executable section instructions: revise the section under audit with \`currentSection\` and/or replace the pending suffix with \`sections\`. The stored master plan row is unchanged, so its objective and top-level Verification stay authoritative — confirm both with \`plan-read\` before adjusting. Section instructions and acceptance criteria may be revised, but auditor policy forbids weakening them merely to obtain a clean audit; the tool does not enforce this semantically. If a \`currentSection\` revision requires code, write severity: bug findings in this same audit. Before passing \`sections\`, call \`section-read\` with \`pending_suffix: true\` — \`sections\` replaces the entire pending suffix and omissions delete milestones, so include every later milestone you intend to retain. A rationale is required. Prefer the existing plan when it remains viable.`

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    header += `\n\n${recurringBlock}`
  }

  return header + AUDITOR_HANDOFF_INSTRUCTION
}

export function buildSectionContinuationPrompt(ctx: PromptContext, state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string {
  const idx = state.currentSectionIndex
  const total = state.totalSections
  const iter = state.iteration
  const maxIter = state.maxIterations
  const section = ctx.getSectionPlan(state, idx)
  if (!section) return ''

  const digest = ctx.getCompletedSectionDigest(state)
  let header = `[Loop section ${idx + 1}/${total} -- iteration ${iter}/${maxIter} (continuation)]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section plan\n${section.content}`

  header += ctx.getSectionCodeGraphBlock?.(state) ?? ''
  header += buildLoopNoticeBlock(notice)
  header += buildAttemptHistoryBlock(ctx, state, 'coder')
  const blockingBugs = outstandingBugs ? blockingBugFindings(outstandingBugs, state) : ctx.getBlockingBugFindings(state)
  header += buildOutstandingFindingsCoderBlock(blockingBugs)
  header += buildRecurringFindingsCoderBlock(ctx, state, blockingBugs)
  header += ctx.getAttemptCodeGraphBlock?.(state) ?? ''

  return header + CODER_HANDOFF_INSTRUCTION
}

/** The `[Loop iteration i/max]` system line shared by non-sectioned coder prompts. */
function iterationSystemLine(state: Pick<LoopState, 'iteration' | 'maxIterations'>): string {
  if (state.maxIterations > 0) return `Loop iteration ${String(state.iteration)} / ${String(state.maxIterations)}`
  return `Loop iteration ${String(state.iteration)} | No max iterations set - loop runs until auditor all-clear or cancelled`
}

/**
 * Follow-up sent to a reused coder session on a same-section retry. The session
 * already holds the section plan, the plan text and the earlier attempt history,
 * so this carries only the loop notice, the findings that are still open and the
 * decisions instruction, keeping the retry cheap.
 */
export function buildCoderFollowUpPrompt(ctx: PromptContext, state: LoopState, outstandingBugs?: ReviewFindingRow[], notice?: string): string {
  const header = state.totalSections > 0
    ? `[Loop section ${String(state.currentSectionIndex + 1)}/${String(state.totalSections)} -- iteration ${String(state.iteration)}/${String(state.maxIterations)} (follow-up)]`
    : `[${iterationSystemLine(state)} (follow-up)]`

  const findings = state.totalSections > 0
    ? (outstandingBugs ? blockingBugFindings(outstandingBugs, state) : ctx.getBlockingBugFindings(state))
    : ctx.getOutstandingFindings(state.loopName)

  const intro = findings.length > 0
    ? 'The audit of your previous changes left the findings below open. Your earlier context still applies; re-read any file you change.'
    : 'The audit of your previous changes left no open findings. Your earlier context still applies; re-read any file you change.'

  let prompt = `${header}${buildLoopNoticeBlock(notice)}\n\n${intro}`
  prompt += buildOutstandingFindingsCoderBlock(findings)
  prompt += buildRecurringFindingsCoderBlock(ctx, state, state.totalSections > 0 ? findings : outstandingBugs)
  prompt += ctx.getAttemptCodeGraphBlock?.(state) ?? ''

  return prompt + CODER_HANDOFF_INSTRUCTION
}

/**
 * Follow-up sent to a reused audit session for the next same-section attempt.
 * The session keeps its earlier reads and command results; this restates the
 * coder's decisions, the latest attempt's delta guidance and the verification
 * steps for the findings that are still open.
 */
export function buildAuditFollowUpPrompt(ctx: PromptContext, state: LoopState): string {
  const header = state.totalSections > 0
    ? `[Loop section audit ${String(state.currentSectionIndex + 1)}/${String(state.totalSections)} (follow-up)]`
    : `[Loop audit iteration ${String(state.iteration)}${state.maxIterations > 0 ? ` / ${String(state.maxIterations)}` : ''} (follow-up)]`

  let prompt = `${header}\n\nThe coder has finished the next attempt for this scope. Your earlier file reads and command results may be stale.`

  prompt += buildCoderDecisionsAuditorBlock(ctx.getCoderDecisions(state.loopName))
  prompt += buildAttemptHistoryBlock(ctx, state, 'auditor')
  prompt += ctx.getAttemptCodeGraphBlock?.(state) ?? ''

  prompt += `\n\n---\nAudit instructions:\n- Re-read the files that changed since your last turn (\`git status\` and \`git diff\` show what the coder touched).\n- Use review-read to load the findings in scope, verify every outstanding one against the current code, delete the resolved ones with review-delete, and keep the unresolved ones open.\n- Write severity: bug findings for unmet acceptance criteria or failed verification.\n- Verify with concrete source or contract evidence and the finding's own narrow verification rather than re-running unrelated work.`

  return prompt + (state.totalSections > 0 ? AUDITOR_HANDOFF_INSTRUCTION : auditorHandoffInstruction(false))
}

export interface PostActionPromptOptions {
  skill?: string
  prompt?: string
}

export function buildPostActionPrompt(ctx: PromptContext, state: LoopState, opts: PostActionPromptOptions): string {
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const branch = state.worktreeBranch ?? '(unknown)'

  const parts: string[] = [
    '[Post-implementation action]',
    '',
    '## Master Plan',
    planText,
    '',
    'This is an isolated worktree. The plan\'s implementation is complete (changes may be uncommitted in the working tree)',
    `on branch \`${branch}\`. Review the full worktree state including uncommitted changes (` + '`git status` + `git diff`' + ').',
  ]

  if (opts.skill) {
    parts.push(
      '',
      `Load the \`${opts.skill}\` skill with the Skill tool and execute its full workflow against this worktree's changes. No user is available: if the skill has an unattended or non-interactive mode, use it and follow it completely, including the fixes and validation it prescribes.`,
    )
  }

  if (opts.prompt) {
    parts.push('', opts.prompt)
  }

  parts.push(
    '',
    'This runs unattended — do NOT use the question tool. Auto-defer any finding that would require clarification and report it.',
    ...(opts.skill ? [] : ['Apply only safe, scoped fixes; then run the project\'s tests/lint/typecheck.']),
    '',
    POST_ACTION_HANDOFF_RULE,
  )

  return parts.join('\n')
}

const POST_ACTION_HANDOFF_RULE = `Do not end your turn while any step is still pending (subagents still running, results not yet merged, records not yet saved). When every step is finished and persisted, call \`${LOOP_COMPLETE_TOOL_NAME}\` with \`outcome\`, one \`steps\` entry per workflow step (name, status done/skipped/failed, and optional detail), \`followUps\`, and optional \`notes\`, then end your turn. The worktree is removed afterwards.`
