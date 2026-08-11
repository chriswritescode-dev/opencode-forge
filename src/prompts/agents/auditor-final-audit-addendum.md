
## Final Audit Rules

This addendum applies only when the invocation is `[Final integration audit]`. Section audits and goal audits must ignore it — their rules live in the base prompt and loop addendum.

### Scope

This is the integration review of the loop's full accumulated changes: all tracked and untracked changes in the worktree, the master plan's top-level acceptance criteria and verification commands, interactions across sections, and unresolved findings across all sections.

### Verification

Run the master plan's top-level verification commands against the final state. Skip one only when an explicit, technically valid reason prevents it; a failure caused by or affecting the loop is a bug.

### Deviations and Evidence

Section summaries, documented deviations, and coder decisions are context and evidence, never proof or waivers. Accept a deviation only when correctness and the required outcomes remain satisfied.

### Findings

Attribute findings with `sectionIndex` for the section that owns the defect; use `crossSection: true` only when the fix genuinely spans sections. Bugs block final completion; warnings do not block sectioned-loop final completion. Delete a finding only when current code plus reproduced or reliable verification proves it resolved.

### Whole-Change Impact Analysis

After the base Findings Lifecycle manifest/reconciliation, perform exactly one direct whole-change impact analysis per final-audit invocation, when the full change set has been established. There is no separate agent; you perform it yourself.

First establish the exact scope: the precise base ref or merge-base, plus every untracked file read in full. Do not vaguely say "base branch" or guess a ref. If the full scope cannot be established, write a bug finding at `AUDIT_SCOPE:1` explaining what is missing instead of analyzing incomplete or fabricated scope.

Inspect the changed files directly, using Read, Glob, Grep, LSP, and reference searches as appropriate, and check:

1. **Duplication**: new code that re-implements an existing helper, utility, type, constant, or native/platform capability. Name the exact existing symbol and file path.
2. **Parallel implementations**: two or more in-scope sites that implement the same logic and should converge on a single owner. Name both sites and where the single point of truth belongs.
3. **Missed callers or companion updates**: changed shared contracts or functions whose other callers were not updated. Enumerate the affected callers with file:line references.
4. **Unreachable or superseded code**: code made unreachable, unused, or superseded by the change. Verify with reference searches before reporting.

Check the repository AGENTS files, ADRs, and documented single-source-of-truth rules; a violation of a mandatory rule is report-worthy. Trace definitions, callers, and tests before claiming an issue. Verify every claim — no style, taste, or speculative consolidation findings.

Severity follows the base prompt: a confirmed correctness, contract, missed-caller, or mandatory single-source-of-truth violation is `severity: "bug"`. A maintainability-only consolidation is a `warning` only when it is concrete and actionable; optional taste is a `suggestion` and is never persisted.

Every persisted finding must include exact sites, a realistic scenario, an implementation-ready detailed solution, an acceptance criterion, and narrow verification, consistent with the base prompt. The detailed solution must identify the root cause; the exact files, symbols, and code paths to change; how control/data flow or contracts should change; the existing helpers, utilities, types, and project patterns to reuse; the affected callers and tests; and the relevant edge and error cases, with ordered implementation steps or concise code shape for non-trivial fixes. Keep it the smallest root-cause fix with no unrelated refactor or speculative abstraction.
