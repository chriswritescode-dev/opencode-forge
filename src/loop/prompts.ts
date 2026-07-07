import type { LoopState } from './state'
import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../utils/section-summary'
import { CODER_DECISIONS_INSTRUCTION } from '../utils/coder-decisions'
import { findingRecurrenceKey, RECURRENCE_ESCALATION_THRESHOLD } from './finding-recurrence'

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
  formatReviewFindings(loopName?: string): string
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getCompletedSectionDigest(state: LoopState): SectionDigestEntry[]
  getCoderDecisions(loopName?: string): string | null
  getFindingRecurrence(loopName?: string): Map<string, number>
}

/**
 * Sandbox context note injected into the system prompt of every session belonging to an
 * active sandbox loop — including subagent sessions spawned via the Task tool — by
 * `createSandboxMessageHook`. Centralizing it here (rather than appending to each loop/audit
 * prompt body) ensures subagents, which never see the loop prompt text, still receive the
 * container context. Single source of truth.
 */
export const SANDBOX_CONTEXT_NOTE = [
  '[Sandbox] This loop runs inside a container: bash tool commands execute in the loop container, not on the host. OS-specific commands or tools may differ from the host system.',
  'Focus on what the code does, not whether local tooling matches — this saves time and avoids false positives.',
].join('\n')

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
  return `\n\n---\n##  Recurring blocking findings\nThese findings have recurred across multiple audits without resolution. For EACH: either fix it definitively, OR if it is intentional/correct, document the reasoning and the exact passing verification method in your coder-decisions block so the auditor can verify and clear it.\n\n${lines.join('\n')}`
}

function buildRecurringFindingsAuditorBlock(ctx: PromptContext, state: LoopState): string {
  const escalated = getEscalatedFindings(ctx, state)
  if (escalated.length === 0) return ''
  const lines = escalated.map(e => `- \`${e.file}:${e.line}\` (${e.count}×)`)
  return `##  Recurring findings — re-evaluate\nThese findings have recurred across audits. For each, re-check the coder decisions block above and reproduce the coder's verification method. If the coder's documented decision/verification resolves it, DELETE it with review-delete. Only keep it if it is genuinely, verifiably still broken (state the precise scenario).\n\n${lines.join('\n')}`
}

function buildCoderDecisionsAuditorBlock(coderDecisions: string | null, includeSeparator = true): string {
  if (!coderDecisions) return ''
  const separator = includeSeparator ? '\n\n---\n' : ''
  return `${separator}## Coder decisions & verification notes (this iteration)\nThe coding agent recorded the following. Use it to evaluate correctness. If a finding is explained by a documented decision, or you can reproduce the coder's passing verification method (e.g., required env vars), DELETE that finding with review-delete instead of re-reporting it.\n\n${coderDecisions}`
}

export function buildContinuationPrompt(ctx: PromptContext, state: LoopState, auditFindings?: string, outstandingBugs?: ReviewFindingRow[]): string {
  if (state.totalSections > 0) {
    return buildSectionContinuationPrompt(ctx, state, auditFindings || '', outstandingBugs)
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

  const outstandingFindings = ctx.getOutstandingFindings(state.loopName)
  if (outstandingFindings.length > 0) {
    const findingKeys = outstandingFindings.map((f) => `- \`${f.file}:${f.line}\``).join('\n')
    prompt += `\n\n---\n Outstanding Review Findings (${String(outstandingFindings.length)})\n\nThese review findings are blocking loop completion. Fix these issues so they pass the next audit review.\n\n${findingKeys}`
  }

  prompt += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)

  return prompt + CODER_DECISIONS_INSTRUCTION
}

export function buildAuditPrompt(ctx: PromptContext, state: LoopState): string {
  if (state.totalSections > 0) {
    if (state.phase === 'final_auditing') {
      return buildFinalAuditPrompt(ctx, state)
    }
    return buildSectionAuditPrompt(ctx, state)
  }

  const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const reviewFindings = ctx.formatReviewFindings(state.loopName)
  const coderDecisions = ctx.getCoderDecisions(state.loopName)

  const parts: string[] = [
    `Post-iteration ${String(state.iteration)} code review${branchInfo}.`,
    '',
    'Implementation plan:',
    planText,
    '',
    'Existing review findings:',
    reviewFindings,
  ]

  if (coderDecisions) {
    parts.push('', '---', buildCoderDecisionsAuditorBlock(coderDecisions, false))
  }

  parts.push(
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
  })
}

export function buildSectionInitialPromptText(input: {
  currentSectionIndex: number
  totalSections: number
  iteration: number
  maxIterations: number
  sectionContent: string
  completedSectionDigest?: SectionDigestEntry[]
}): string {
  const idx = input.currentSectionIndex
  const digest = input.completedSectionDigest ?? []
  let header = `[Loop section ${idx + 1}/${input.totalSections} -- iteration ${input.iteration}/${input.maxIterations}]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section plan\n${input.sectionContent}`

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

  header += `\n\n---\nAudit instructions:\n- Use review-read to see findings for this section.\n- Delete resolved findings.\n- Write severity: bug findings for unmet acceptance criteria or failed verification (defaults to current section_index).\n- When the section is clear, end your response with:\n${SECTION_SUMMARY_START_MARKER}\n### Done\n- bullets describing what was implemented\n### Deviations\n- bullets describing places implementation differs from this section plan, with reasons (or "none")\n### Follow-ups\n- bullets noting items deferred to later sections (or "none")\n${SECTION_SUMMARY_END_MARKER}`

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    header += `\n\n${recurringBlock}`
  }

  return header
}

export function buildSectionContinuationPrompt(ctx: PromptContext, state: LoopState, auditText: string, outstandingBugs?: ReviewFindingRow[]): string {
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
  header += `\n\n---\n## Auditor feedback from previous attempt\n${auditText}`

  const outstandingFindings = (outstandingBugs ?? ctx.getOutstandingFindings(state.loopName, 'bug'))
    .filter(f => f.sectionIndex === idx)
  if (outstandingFindings.length > 0) {
    const findingKeys = outstandingFindings.map(f => `- \`${f.file}:${f.line}\``).join('\n')
    header += `\n\n---\n## Outstanding findings\n${findingKeys}`
  }

  header += buildRecurringFindingsCoderBlock(ctx, state, outstandingBugs)

  return header + CODER_DECISIONS_INSTRUCTION
}

export function buildFinalAuditFixPrompt(ctx: PromptContext, state: LoopState, auditText: string, outstandingBugs?: ReviewFindingRow[]): string {
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const digest = ctx.getCompletedSectionDigest(state)

  let header = `[Final-audit fix -- iteration ${state.iteration}/${state.maxIterations}]`
  header += `\n\n## Master Plan\n${planText}`

  if (digest.length > 0) {
    header += `\n\n### Completed Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n---\n## Final auditor feedback\n${auditText}`

  const outstandingFindings = outstandingBugs ?? ctx.getOutstandingFindings(state.loopName, 'bug')
  if (outstandingFindings.length > 0) {
    const findingKeys = outstandingFindings.map(f => `- \`${f.file}:${f.line}\``).join('\n')
    header += `\n\n---\n## Outstanding findings (${outstandingFindings.length})\n${findingKeys}`
  }

  header += `\n\n---\nInstructions:\n- The full plan has already been implemented. The final integration audit reported the bugs above.\n- Fix the reported bugs. Scope your changes to what the findings require.\n- Once you are done, the final audit will be re-run automatically against the entire codebase.`

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

  let header = `[Final integration audit]`
  header += `\n\n## Master Plan\n${planText}`

  if (digest.length > 0) {
    header += `\n\n### Completed Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += buildCoderDecisionsAuditorBlock(ctx.getCoderDecisions(state.loopName))

  header += `\n\n---\nFinal audit instructions:\n- Verify the master plan's top-level Verification commands and acceptance criteria.\n- Use the per-section ### Deviations entries to interpret discrepancies. If a discrepancy is explained by a deviation, accept it unless it materially breaks the master plan's top-level Verification.\n- Write findings with sectionIndex pointing to the section you believe contains the bug. Use crossSection: true only when the bug spans multiple sections.\n- The loop terminates automatically when there are no outstanding bug-severity findings. Do not write findings unless they describe real, blocking issues.`

  const recurringBlock = buildRecurringFindingsAuditorBlock(ctx, state)
  if (recurringBlock) {
    header += `\n\n${recurringBlock}`
  }

  return header
}
