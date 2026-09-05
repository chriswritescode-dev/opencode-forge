import type { LoopState } from './state'
import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { LoopAttemptRow } from '../storage/repos/loop-attempts-repo'
import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../utils/section-summary'
import { CODER_DECISIONS_INSTRUCTION } from '../utils/coder-decisions'
import { findingRecurrenceKey, RECURRENCE_ESCALATION_THRESHOLD } from './finding-recurrence'
import { formatFindingDetails } from '../utils/review-format'

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
}

/**
 * The one and only section-summary block template shown to the loop auditor.
 * The loop runner parses this block mechanically (parseSectionSummary), so the
 * template must never be hand-written elsewhere — prompt markdown files refer
 * to it, they do not restate it.
 */
const SECTION_SUMMARY_TEMPLATE = `${SECTION_SUMMARY_START_MARKER}\n### Done\n- bullets describing what was implemented\n### Deviations\n- bullets describing places implementation differs from this section plan, with reasons (or "none")\n### Follow-ups\n- bullets noting items deferred to later sections (or "none")\n${SECTION_SUMMARY_END_MARKER}`

/**
 * One-shot follow-up sent to the audit session when it reported no blocking
 * findings for the section but omitted (or malformed) the section-summary
 * block. Without the block the section counts as dirty and a full coder
 * iteration is wasted on nothing.
 */
export function buildSectionSummaryRepromptText(): string {
  return `Your previous audit response did not include a parseable section-summary block, and no blocking bug findings are recorded for this section.\n\n- If the section is clear: reply with ONLY the section-summary block below, reproducing the marker comments exactly.\n${SECTION_SUMMARY_TEMPLATE}\n- If the section is NOT clear: persist each blocking issue with review-write (severity: bug) and do not include the summary block.`
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

function buildEffectiveSectionPlanBlock(ctx: PromptContext, state: LoopState): string {
  const rows = ctx.getSectionPlans(state)
  if (rows.length === 0) return ''
  const body = rows.map(r => `### Section ${r.sectionIndex + 1} (index ${r.sectionIndex}): ${r.title}\n${r.content}`).join('\n\n')
  return `\n\n## Effective section plan\nThese live section rows supersede the master plan's original per-section instructions; the master objective and top-level Verification remain authoritative. Titles are display labels — the content under each heading is the executable requirement.\n\n${body}`
}

function getEscalatedFindings(ctx: PromptContext, state: LoopState, outstandingBugs?: ReviewFindingRow[]): { file: string; line: number; count: number }[] {
  const loopName = state.loopName
  const bugFindings = outstandingBugs ?? ctx.getOutstandingFindings(loopName, 'bug')
  const recurrence = ctx.getFindingRecurrence(loopName)
  const escalated: { file: string; line: number; count: number }[] = []
  for (const f of bugFindings) {
    const key = findingRecurrenceKey(f)
    const count = recurrence.get(key) ?? 0
    if (count >= RECURRENCE_ESCALATION_THRESHOLD) {
      escalated.push({ file: f.file, line: f.line, count })
    }
  }
  return escalated
}

function buildRecurringFindingsCoderBlock(ctx: PromptContext, state: LoopState, outstandingBugs?: ReviewFindingRow[]): string {
  const escalated = getEscalatedFindings(ctx, state, outstandingBugs)
  if (escalated.length === 0) return ''
  const lines = escalated.map(e => `- \`${e.file}:${e.line}\` (recurred ${e.count}×)`)
  return `\n\n---\n##  Recurring blocking findings\nThese findings have recurred across multiple audits without resolution, so the previous patches did not hold. For EACH: revisit the causal hypothesis behind the earlier fix, produce a specific reproducer or counterexample that demonstrates the failure, and then either fix it definitively or, if it is intentional/correct, document the reasoning and the exact passing verification method in your coder-decisions block so the auditor can verify and clear it. Do not repeat the previous patch without a changed hypothesis.\n\n${lines.join('\n')}`
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
  return `\n\n---\n## Outstanding review findings (${String(findings.length)})\nThese block loop completion. Each description carries the detailed solution, acceptance criterion, and narrow verification — address every one so it passes the next audit.\n\nRemediation policy (applies to every finding below):\n- Read every finding before changing anything. Identify shared root causes across findings and fix in dependency order, addressing related findings through one owner instead of independent per-file patches. Coupled fixes are serialized under one implementation owner; independent fixes may be delegated to code subagents under the existing concurrency policy. Ordering or grouping findings is not permission to truncate, suppress, or silently defer any of them.\n- For a behavioral bug, first produce a focused failing test or reproducer through the affected public interface, then apply the smallest complete fix and show the regression check passing against the reported failure. For races, replays, or ordering bugs, exercise the ordering, competing operations, or repeated delivery explicitly instead of relying on a large suite to expose them.\n- When a failing test is inappropriate for the finding, verify with concrete source or contract evidence plus the finding's own narrow verification instead of a speculative rewrite.\n- Run targeted verification after each root-cause fix. Run all applicable repository/plan full checks once after the fix batch reaches its final state, rerunning any check a later change invalidated; never run the full suite separately for every finding unless a required check demands it.\n- Record each fix's outcome and regression check in the coder-decisions block at the end of this prompt. Never delete findings — they stay open until the auditor clears them.\n\n${formatFindingDetails(findings)}`
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
      '- Do not repeat unchanged inspection or unaffected verification merely because this is a fresh session. Carry forward previous evidence only where the delta and plan have not invalidated it.',
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
 * Goal-loop executor prompt used for both the initial/recovery coding pass and
 * continuation after an audit. Goal loops have no plan, sections, or
 * approval/planning flow — the agent implements and verifies the goal directly.
 * The exact goal text is always restated so every iteration remains anchored to
 * what was requested.
 */
function buildGoalCodingPrompt(ctx: PromptContext, state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string {
  const goal = state.goal ?? '(goal text missing)'

  let systemLine = `Goal loop iteration ${String(state.iteration)}`
  if (state.maxIterations > 0) {
    systemLine += ` / ${String(state.maxIterations)}`
  } else {
    systemLine += ` | No max iterations set - loop runs until auditor all-clear or cancelled`
  }

  let prompt = `[${systemLine}]\n\n## Goal\n${goal}`

  prompt += '\n\n---\nInstructions:\n- Implement the goal above directly in this worktree. Do not create a plan, decompose the goal into sections, or ask for approval — just do the work.\n- Write or update tests for the changes and run the project\'s verification (lint/typecheck/tests) before finishing.\n- Keep changes scoped to what the goal requires; reuse existing helpers and patterns rather than introducing speculative abstractions.'

  prompt += buildLoopNoticeBlock(notice)
  prompt += buildAttemptHistoryBlock(ctx, state, 'coder')
  prompt += buildOutstandingFindingsCoderBlock(ctx.getOutstandingFindings(state.loopName))
  prompt += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)

  return prompt + CODER_DECISIONS_INSTRUCTION
}

/**
 * Goal-loop audit prompt. The auditor must verify BOTH that the goal is fully
 * achieved AND that the code is correct/conventional. An unmet goal is reported
 * as a `severity: "bug"` finding on the stable `GOAL` pseudo-path (line 1) so it
 * blocks termination the same way code defects do. The loop runtime blocks
 * completion while ANY outstanding finding (bug or warning) remains, so the
 * auditor must delete resolved findings and may leave none outstanding to
 * authorize termination.
 */
function buildGoalAuditPrompt(ctx: PromptContext, state: LoopState): string {
  const goal = state.goal ?? '(goal text missing)'
  const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
  const coderDecisions = ctx.getCoderDecisions(state.loopName)

  const parts: string[] = [
    `Post-iteration ${String(state.iteration)} goal review${branchInfo}.`,
    '',
    'Goal:',
    goal,
    '',
    'Use review-read to load the existing findings for this loop. Use review-read {attempts: true, beforeId: <id>, limit: <n>} to page older attempt history.',
  ]

  if (coderDecisions) {
    parts.push('', '---', buildCoderDecisionsAuditorBlock(coderDecisions, false))
  }

  parts.push(buildAttemptHistoryBlock(ctx, state, 'auditor'))

  parts.push(
    '',
    'Review the code changes in this worktree against the goal above. Verify BOTH:',
    '1. Goal completion: every part of the goal is implemented and working.',
    '2. Code correctness: bugs, logic errors, missing error handling, and convention violations.',
    'If you find bugs in related code that affect the correctness of this task, report them — even if the buggy code was not directly modified.',
    '',
    'Goal completeness check:',
    '- For every part of the goal, verify it is implemented and working.',
    '- If any part is unimplemented, partially implemented, or not working, you MUST write a `severity: "bug"` finding describing exactly which part of the goal is missing and what is required. Use `file` = the relevant source file when possible, otherwise use the stable pseudo-path `GOAL` with `line` = 1.',
    '- When a previously reported goal-incomplete finding is now resolved, delete it with review-delete.',
    '',
    'For each existing finding, verify whether it has been resolved. Delete resolved findings with review-delete and keep any unresolved finding that still applies.',
    'Outstanding findings block loop termination — the loop cannot complete while any finding (bug or warning) remains. Zero remaining findings authorizes termination.',
    '',
    'This is an automated loop — do not direct the agent to "create a plan" or "present for approval." Just report findings directly.',
  )

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    parts.push('', recurringBlock)
  }

  return parts.join('\n')
}

export function buildContinuationPrompt(ctx: PromptContext, state: LoopState, notice?: string, outstandingBugs?: ReviewFindingRow[]): string {
  if (state.kind === 'goal') {
    return buildGoalCodingPrompt(ctx, state, notice, outstandingBugs)
  }
  if (state.totalSections > 0) {
    return buildSectionContinuationPrompt(ctx, state, notice, outstandingBugs)
  }

  let systemLine = `Loop iteration ${String(state.iteration)}`
  if (state.maxIterations > 0) {
    systemLine += ` / ${String(state.maxIterations)}`
  } else {
    systemLine += ` | No max iterations set - loop runs until auditor all-clear or cancelled`
  }

  let prompt = `[${systemLine}]`

  prompt += buildLoopNoticeBlock(notice)
  prompt += buildAttemptHistoryBlock(ctx, state, 'coder')
  prompt += buildOutstandingFindingsCoderBlock(ctx.getOutstandingFindings(state.loopName))
  prompt += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)

  return prompt + CODER_DECISIONS_INSTRUCTION
}

export function buildAuditPrompt(ctx: PromptContext, state: LoopState): string {
  if (state.kind === 'goal') {
    return buildGoalAuditPrompt(ctx, state)
  }
  if (state.totalSections > 0) {
    if (state.phase === 'final_auditing') {
      return buildFinalAuditPrompt(ctx, state)
    }
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

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    parts.push('', recurringBlock)
  }

  return parts.join('\n')
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
  attemptHistoryBlock?: string
}): string {
  const idx = input.currentSectionIndex
  const digest = input.completedSectionDigest ?? []
  let header = `[Loop section ${idx + 1}/${input.totalSections} -- iteration ${input.iteration}/${input.maxIterations}]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section plan\n${input.sectionContent}`

  if (input.attemptHistoryBlock) {
    header += input.attemptHistoryBlock
  }

  return header + CODER_DECISIONS_INSTRUCTION
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

  const hasNextSection = idx + 1 < total
  const proactiveCheck = hasNextSection
    ? `call \`section-read\` with \`section_index: ${idx + 1}\` and verify its plan against the current worktree`
    : 'this is the last section, so skip the proactive next-section check'

  header += `\n\n---\nAudit instructions:\n- Review scope: this section's work is all uncommitted changes plus any commits made after the most recent \`section <N>:\` checkpoint commit (\`git log --oneline\`; the first section has no checkpoint yet). Earlier sections are already committed and audited — read them as context only.\n- This full scope is the acceptance scope on every section audit. On repeat audits, use the delta-first ordering from the attempt history to prioritize what to verify first within that scope; the delta orders the review, it does not replace the full scope.\n- Use review-read to see findings for this section. Use review-read {attempts: true, beforeId: <id>, limit: <n>} to page older attempt history.\n- Delete resolved findings.\n- Write severity: bug findings for unmet acceptance criteria or failed verification (defaults to current section_index).\n- When the section is clear: run the proactive next-section check from your Adaptive plan adjustment rules — ${proactiveCheck} — then end your response with the block below — when clean it may be your entire response:\n${SECTION_SUMMARY_TEMPLATE}\n- \`plan-adjust\` (section audits only; unavailable in the final audit) amends the executable section instructions: revise the section under audit with \`currentSection\` and/or replace the pending suffix with \`sections\`. The stored master plan row is unchanged, so its objective and top-level Verification stay authoritative — confirm both with \`plan-read\` before adjusting. Section instructions and acceptance criteria may be revised, but auditor policy forbids weakening them merely to obtain a clean audit; the tool does not enforce this semantically. If a \`currentSection\` revision requires code, write severity: bug findings in this same audit. Before passing \`sections\`, call \`section-read\` with \`pending_suffix: true\` — \`sections\` replaces the entire pending suffix and omissions delete milestones, so include every later milestone you intend to retain. A rationale is required. Prefer the existing plan when it remains viable.`

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    header += `\n\n${recurringBlock}`
  }

  return header
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

  header += buildLoopNoticeBlock(notice)
  header += buildAttemptHistoryBlock(ctx, state, 'coder')
  header += buildOutstandingFindingsCoderBlock(
    (outstandingBugs ?? ctx.getOutstandingFindings(state.loopName, 'bug')).filter(f => f.sectionIndex === idx),
  )
  header += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)

  return header + CODER_DECISIONS_INSTRUCTION
}

export function buildFinalAuditFixPrompt(ctx: PromptContext, state: LoopState, outstandingBugs?: ReviewFindingRow[]): string {
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const digest = ctx.getCompletedSectionDigest(state)

  let header = `[Final-audit fix -- iteration ${state.iteration}/${state.maxIterations}]`
  header += `\n\n## Master Plan\n${planText}`
  header += buildEffectiveSectionPlanBlock(ctx, state)

  if (digest.length > 0) {
    header += `\n\n### Completed Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += buildAttemptHistoryBlock(ctx, { ...state, phase: 'final_audit_fix' } as LoopState, 'coder')

  header += buildOutstandingFindingsCoderBlock(outstandingBugs ?? ctx.getOutstandingFindings(state.loopName, 'bug'))

  header += `\n\n---\nInstructions:\n- The full plan has already been implemented. The final integration audit reported the bugs above.\n- Fix the reported bugs. Scope your changes to what the findings require.\n- Once you are done, the final integration audit re-runs over the loop's full accumulated changes — every \`section <N>:\` checkpoint commit since this branch's merge-base with its base branch, plus all uncommitted and untracked changes — and the affected integration paths.`

  header += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)

  return header + CODER_DECISIONS_INSTRUCTION
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
      `Load the \`${opts.skill}\` skill with the Skill tool and execute its workflow against this worktree's changes.`,
    )
  }

  if (opts.prompt) {
    parts.push('', opts.prompt)
  }

  parts.push(
    '',
    'This runs unattended — do NOT use the question tool. Auto-defer any finding that would require clarification',
    'and report it; apply only safe, scoped fixes; then run the project\'s tests/lint/typecheck.',
  )

  return parts.join('\n')
}

export function buildFinalAuditPrompt(ctx: PromptContext, state: LoopState): string {
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const digest = ctx.getCompletedSectionDigest(state)
  const effectiveSectionPlan = buildEffectiveSectionPlanBlock(ctx, state)

  let header = `[Final integration audit]`
  header += `\n\n## Master Plan\n${planText}`
  header += effectiveSectionPlan

  if (digest.length > 0) {
    header += `\n\n### Completed Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += buildCoderDecisionsAuditorBlock(ctx.getCoderDecisions(state.loopName))
  header += buildAttemptHistoryBlock(ctx, { ...state, phase: 'final_auditing' } as LoopState, 'auditor')

  const verificationScope = effectiveSectionPlan
    ? 'Verify the master plan\'s objective and top-level Verification commands, then verify the requirements in the Effective section plan.'
    : 'Verify the master plan\'s objective and top-level Verification commands.'
  header += `\n\n---\nFinal audit instructions:\n- Review scope: the loop's full accumulated changes — every \`section <N>:\` checkpoint commit since this branch's merge-base with its base branch, plus all uncommitted and untracked changes.\n- Delta-first ordering from the attempt history may prioritize what you verify first, but the full integration scope above stays mandatory — the delta never narrows this final gate.\n- ${verificationScope}\n- Use the per-section ### Deviations entries to interpret discrepancies. If a discrepancy is explained by a deviation, accept it unless it materially breaks the master plan's top-level Verification.\n- Use review-read to load findings; {attempts: true, beforeId: <id>, limit: <n>} pages older attempt history.\n- Write findings with sectionIndex pointing to the section you believe contains the bug. Use crossSection: true only when the bug spans multiple sections.\n- The loop terminates automatically when there are no outstanding bug-severity findings. Do not write findings unless they describe real, blocking issues.`

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    header += `\n\n${recurringBlock}`
  }

  return header
}
