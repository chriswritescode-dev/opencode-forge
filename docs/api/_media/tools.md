# Tools Reference

Forge exposes server-side tools for plan storage, review findings, loop management, goal orchestration, section navigation, and sandbox shell execution. The `review` / `review-plan` slash commands run inline instead of spawning a subtask. See [Limitations](../README.md#limitations).

See also: [Agents and Slash Commands](agents-and-commands.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Tool List

| Tool | Purpose | Source |
|---|---|---|
| `plan-read` | Read the current session or loop plan, or list/search recent project plans. | [`src/tools/plan-kv.ts`](../src/tools/plan-kv.ts) |
| `plan-write` | Create or overwrite the stored session plan. | [`src/tools/plan-authoring.ts`](../src/tools/plan-authoring.ts) |
| `plan-edit` | Edit the stored session plan by exact string replacement. | [`src/tools/plan-authoring.ts`](../src/tools/plan-authoring.ts) |
| `section-read` | Read a section plan and status for the active loop session, or the ordered pending section suffix. | [`src/tools/section-read.ts`](../src/tools/section-read.ts) |
| `plan-adjust` | Revise the section under audit and/or replace the pending section suffix of the active loop plan's executable section instructions; auditor-only, section-audit-only, logged as a plan amendment. | [`src/tools/plan-adjust.ts`](../src/tools/plan-adjust.ts) |
| `review-write` | Store a review finding. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `review-read` | Read review findings. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `review-delete` | Delete a review finding. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `execute-plan` | Start an iterative development loop in an isolated git worktree, or (with `mode: new-session`) launch the plan in a fresh standalone session. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-cancel` | Cancel an active loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-status` | List loops, inspect one loop, or restart a restartable loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `goal-write` | Save the ordered goal (objective and task list) for this session as a draft; the next loop launched from this session becomes chunk 1. Architect-only. | [`src/tools/goal.ts`](../src/tools/goal.ts) |
| `goal-status` | List goals, inspect one goal's chunks, or restart a paused/interrupted goal (optionally raising `maxChunks`). | [`src/tools/goal.ts`](../src/tools/goal.ts) |
| `goal-cancel` | Cancel a goal, optionally cancelling its running chunk loop. | [`src/tools/goal.ts`](../src/tools/goal.ts) |

## Plan Tools

### `plan-read`

Uses the regular Read tool's `offset` and `limit` options with the stored plan as the implicit target; reads are capped at 2000 lines by default, and when the requested window does not reach the end of the plan the output appends a notice showing the lines returned and the next `offset` to pass to read the rest. Plan-specific selectors remain available for resolving or searching stored plans.

Arguments:

| Argument | Description |
|---|---|
| `offset` | When reading a plan: line number to start from, 1-indexed. |
| `limit` | When reading a plan: maximum number of lines to return; defaults to 2000. |
| `count` | When `recent` is true: number of recent plans to list or search; defaults to 20, capped at 100. |
| `pattern` | Regex pattern to search plan content. |
| `loop_name` | Optional loop name to read a loop-scoped plan directly. |
| `session_id` | Explicit session ID to read from. |
| `recent` | List or search recent project-scoped plans. |

### `plan-write`

Creates or overwrites the plan stored for the current session, matching the regular Write interaction with the plan as the implicit target. The stored plan is the plan of record read by `plan-read`, the approval hook, `execute-plan`, and the TUI plan dialog. Use `plan-edit` for incremental additions and revisions. Available to architect and architect-auto sessions; denied in code, auditor, and auditor-loop sessions, and inside loop/audit sessions.

Denied when the session owns a running loop: a running loop's plan is amended only with `plan-adjust` during a section audit. On success the tool persists the plan through the shared session-scoped write path and returns a structure report: a `Plan stored: N lines, M chars.` line, the detected `Loop Name:` when present, the full decomposed section outline, and a `Warnings:` block when any structural requirement is unmet.

Arguments:

| Argument | Description |
|---|---|
| `content` | Stored plan markdown. Use `<!-- forge-section -->` markers before each `## Phase` heading. |

### `plan-edit`

Edits the stored session plan by exact string replacement, the same way the Edit tool edits a file. It supports small revisions, insertions, and deletions without rewriting the full plan. Use `plan-read` to inspect the current text first; do not include `plan-read`'s `N:` line-number prefixes (with trailing space) in `oldString`. Subject to the same availability and running-loop guard as `plan-write`. On success the tool rewrites the plan through the shared session-scoped write path and returns a `Replaced N occurrence(s).` line followed by a structure report that details only the section(s) the replacement touched, or just the section count when the edit lands outside any section; `plan-write` reports the full outline.

Arguments:

| Argument | Description |
|---|---|
| `oldString` | Exact text to replace, including indentation. Must match exactly once unless `replaceAll` is true. As with Edit, an empty value creates the plan only when none exists. |
| `newString` | Replacement text. Must differ from `oldString`. |
| `replaceAll` | Replace every occurrence instead of requiring a unique match. |

`plan-write` and `plan-edit` author the plan before execution; `plan-adjust` amends the executable section instructions of an already-running sectioned loop during a section audit — the stored master plan row is unchanged — and is auditor-only.

## Section Tools

### `section-read`

Reads a section plan and its status for the active loop session. Without arguments it returns the lowest-index incomplete section. Titles are display labels; the content under each section is the executable requirement.

Arguments:

| Argument | Description |
|---|---|
| `section_index` | Optional 0-based section index. If omitted, returns the lowest-index incomplete section. |
| `pending_suffix` | When `true`, returns one JSON object with `from_index` (current section index + 1) and every pending section after the current one, ordered, each with `index`, `title`, `content`, and `status`. Cannot be combined with `section_index`. |

`section-read` never mutates loop state: section statuses and summaries are unchanged by reads.

### `plan-adjust`

Only callable by the current auditor session of a sectioned plan loop during the `auditing` phase (rejected in non-sectioned loops and during the final audit). Revises the executable section instructions only: the section currently under audit (`currentSection`, edited in place with its progress preserved) and/or the pending section suffix from the current section + 1 onward (`sections`). `sections` is destructive — it replaces the entire pending suffix, so any omitted milestone is deleted; confirm the retained list with `section-read` `pending_suffix: true` before calling. The stored master plan row is unchanged, so the master objective and top-level Verification remain authoritative; the amended current/pending sections form the effective plan that supersedes the original per-section instructions. The tool performs no semantic validation of the adjusted instructions; auditor policy forbids weakening acceptance criteria merely to obtain a clean audit. Already-completed sections cannot be changed. The resulting total may not exceed 24 sections. Every adjustment is recorded in the `plan_amendments` table with before/after snapshots and a required rationale.

Arguments:

| Argument | Description |
|---|---|
| `sections` | Optional replacement list of `{ title, content }` for the not-yet-started sections after the current one. Replaces the entire pending suffix — omissions delete milestones, so include every later milestone to retain. Omit to leave future sections unchanged; an empty list removes the entire pending suffix. |
| `currentSection` | Optional `{ title, content }` revision of the section currently under audit, edited in place. If the revision requires code, write severity: bug findings in the same audit so the section is re-coded. Revisions must not weaken acceptance criteria or verification merely to obtain a clean audit. |
| `rationale` | Why the plan needs adjustment. Required for every adjustment. |

## Review Tools

Review findings are scoped to the current loop when invoked from a loop session. Sectioned loops automatically scope findings to the current section unless overridden.

### `review-write`

Arguments:

| Argument | Description |
|---|---|
| `file` | File path where the finding is located. |
| `line` | Line number of the finding. |
| `severity` | `bug` or `warning`. |
| `description` | Clear description of the issue. |
| `scenario` | Optional conditions under which the issue manifests. |
| `crossSection` | Write as a cross-section finding with `sectionIndex: null`. |
| `sectionIndex` | Explicit section index override. |

### `review-read`

Arguments:

| Argument | Description |
|---|---|
| `loopName` | Target a specific loop, including completed loops. |
| `file` | Filter by file path. |
| `pattern` | Regex search across finding descriptions and scenarios. |
| `crossSection` | Read only cross-section findings. |
| `allSections` | Read findings from all sections instead of the current section. |
| `attempts` | Return durable audit-attempt history instead of live findings. Defaults to the current section/plan/final-audit scope; explicit `loopName` or `allSections` reads all scopes. |
| `limit` | With `attempts: true`, page size from 1 to 100 (default 20). |
| `beforeId` | With `attempts: true`, read attempts older than this positive integer ID. |

Attempt history returns `{ attempts, nextBeforeId }`, including coder decisions, checkpoint references, audit outcomes, and before/after finding snapshots. Use `nextBeforeId` to page backward. Historical findings do not reopen resolved work. This mode cannot be combined with `file`, `pattern`, or `crossSection`.

### `review-delete`

Arguments:

| Argument | Description |
|---|---|
| `file` | File path of the finding to delete. |
| `line` | Line number of the finding to delete. |
| `sectionIndex` | Explicit section index override. |
| `crossSection` | Delete cross-section findings. |

## Loop Tools

### `execute-plan`

Arguments:

| Argument | Description |
|---|---|
| `title` | Required short title for the session list. |
| `plan` | Optional inline plan. If omitted, Forge reads the current session's stored plan. |
| `loopName` | Optional loop name, slugified and uniquified. |
| `mode` | Execution mode. `loop` (default) runs the iterative loop in an isolated git worktree. `new-session` launches the plan in a fresh standalone session running the code agent (no worktree, no loop, not tracked by `loop-status`/`loop-cancel`). |

### `loop-cancel`

Arguments:

| Argument | Description |
|---|---|
| `name` | Optional loop name. If omitted, cancels the only active loop. |

### `loop-status`

Arguments:

| Argument | Description |
|---|---|
| `name` | Optional loop name for detailed status. |
| `restart` | Restart a non-completed loop by name. |
| `force` | Force restart an active or stuck loop. Required for running loops. |

Completed loops are history-only and cannot be restarted. See [Loop System](loop-system.md#restartability).

> Plan authoring (`plan-write`, `plan-edit`, `goal-write`), the loop management tools (`execute-plan`, `loop-cancel`, `loop-status`), the goal tools (`goal-status`, `goal-cancel`), and `question` are denied inside loop and audit sessions so an in-flight loop cannot recursively spawn more work. `plan-read` stays available, and `plan-adjust` is callable by the auditor during a section audit.

## Goal Tools

Goal tools drive the sequential goal orchestrator: a goal is an objective run as a series of plan-loop **chunks**, one per task, each stacked on the previous chunk's branch. See [Loop System → Goals](loop-system.md#goals) for the full lifecycle. `goal-write` is architect-only; all three are denied inside loop and audit sessions.

### `goal-write`

Saves the ordered goal for the current session as a `draft`. The next loop launched from that session — through the TUI dialog, the plan-approval `Loop` path, or `execute-plan` — is attached as chunk 1 and promotes the draft to `running`. A session may hold at most one running or paused goal, and `goal-write` replaces any existing draft for the session. Available to architect sessions only (excluded from code, auditor, and architect-auto).

Arguments:

| Argument | Description |
|---|---|
| `title` | Short title for the goal; also seeds the generated goal id. |
| `objective` | The goal objective, verbatim plus any clarified scope. |
| `tasks` | Optional ordered task list; each task becomes its own chunk. Each entry takes an optional `ref` (ticket/issue identifier), a `title`, and optional `details` (a self-contained summary including acceptance criteria). |
| `maxChunks` | Optional cap on how many chunks the goal may run, 1–100. Defaults to 20. |

### `goal-status`

Lists goals when called with no arguments; pass `goalId` for a goal's detail (status, models, objective, tasks, and chunks with their stage, loop, branch, and summary). With `restart`, resumes a paused or interrupted goal.

Arguments:

| Argument | Description |
|---|---|
| `goalId` | Goal id to show in detail, or to restart when `restart` is true. |
| `restart` | Restart a paused or interrupted goal. Requires `goalId`. |
| `force` | Discard planning that is still marked in flight when restarting. |
| `maxChunks` | Raise the goal chunk limit when restarting. |

### `goal-cancel`

Cancels a goal by `goalId`, cleaning up any planning chunks.

Arguments:

| Argument | Description |
|---|---|
| `goalId` | Goal id to cancel. |
| `cancelRunningLoops` | Also cancel the goal chunk loop that is currently running. |

## Sandbox Shell

Sandbox loops use opencode's native `shell` tool; Forge routes the underlying shell into the loop sandbox via a generated shell shim and the V2 `shell.hook('create.before')`. See [Sandbox](sandbox.md#shell-routing).
