# Tools Reference

Forge exposes server-side tools for plan storage, review findings, loop management, group orchestration, section navigation, and sandbox shell execution.

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
| `execute-goal` | Start a managed goal loop in a dedicated code session inside an isolated Forge worktree. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-cancel` | Cancel an active loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-status` | List loops, inspect one loop, or restart a restartable loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-migrate` | Move a loop to a configured remote opencode server, preserving its progress. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `launch-group` | Launch a group of features (from a PRD or a pre-split list), each planned and run as its own loop, scheduled with a concurrency cap. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `group-status` | List groups, inspect one group's per-feature stages, or restart a non-completed group. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `group-cancel` | Cancel a group, optionally cancelling its running loops. | [`src/tools/group.ts`](../src/tools/group.ts) |

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

Creates or overwrites the plan stored for the current session, matching the regular Write interaction with the plan as the implicit target. The stored plan is the plan of record read by `plan-read`, the approval hook, `execute-plan`, and the TUI plan dialog. Use `plan-edit` for incremental additions and revisions. Available to architect and architect-auto sessions; denied in code, auditor, auditor-loop, and feature-splitter sessions, and inside loop/audit sessions.

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

Only callable by the current auditor session of a sectioned plan loop during the `auditing` phase (rejected in goal loops and during the final audit). Revises the executable section instructions only: the section currently under audit (`currentSection`, edited in place with its progress preserved) and/or the pending section suffix from the current section + 1 onward (`sections`). `sections` is destructive — it replaces the entire pending suffix, so any omitted milestone is deleted; confirm the retained list with `section-read` `pending_suffix: true` before calling. The stored master plan row is unchanged, so the master objective and top-level Verification remain authoritative; the amended current/pending sections form the effective plan that supersedes the original per-section instructions. The tool performs no semantic validation of the adjusted instructions; auditor policy forbids weakening acceptance criteria merely to obtain a clean audit. Already-completed sections cannot be changed. The resulting total may not exceed 24 sections. Every adjustment is recorded in the `plan_amendments` table with before/after snapshots and a required rationale.

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
| `status` | Finding status; defaults to `open`. |
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
| `hostSessionId` | Optional host session ID for post-completion redirect. |
| `mode` | Execution mode. `loop` (default) runs the iterative loop in an isolated git worktree. `new-session` launches the plan in a fresh standalone session running the code agent (no worktree, no loop, not tracked by `loop-status`/`loop-cancel`). |

### `execute-goal`

Starts a managed **goal loop** from free-text goal input, with no plan, decomposition, approval flow, final audit, or post-action. Forge creates a dedicated code session inside an isolated worktree and sends the goal as its initial prompt. When that coding pass goes idle, Forge replaces it with a fresh auditor session; a dirty audit then creates a fresh code session for remediation. The invoking session remains the host redirect target and is not warped into the worktree.

Arguments:

| Argument | Description |
|---|---|
| `goal` | Required. Non-empty free text describing the goal; the first line is used to derive a title/loop name when omitted. |
| `title` | Optional short title for the loop (derived from the goal when omitted). |
| `loopName` | Optional loop name, slugified and uniquified. |
| `maxIterations` | Optional maximum loop iterations. Defaults to the plugin config `loop.defaultMaxIterations`; `0` means unlimited (run until auditor all-clear or cancellation). |
| `hostSessionId` | Optional host session ID for post-completion redirect; defaults to the invoking (`execute-goal`) session. |

Worktree/session behavior, auditor/finding completion rule, iteration cap, and differences from `execute-plan` and `launch-group` are documented in [Loop System → Goal Loops](loop-system.md#goal-loops).

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

### `loop-migrate`

Moves a loop to a configured remote opencode server (see [Configuration → Remotes](configuration.md#remotes)). The local loop is terminated with the terminal reason `migrated: <remote>`, which makes it permanently non-restartable locally; the loop then continues on the remote from the pushed loop branch tip.

What is carried over:

- The loop's phase, section pointers (`currentSectionIndex`/`totalSections`/`finalAuditDone`), section plan rows, section summaries, and review findings travel as a resume snapshot in the remote workspace's `forgeLoop` extra.
- The loop's original plan text is forwarded, so restartability display and legacy non-sectioned resume keep working on the remote.
- The execution/auditor models and variants are forwarded unchanged.
- The remote loop name is reserved (the local name is kept when available), and the remote session's permission rules come from the configured `loop.permissions` without host-specific external directories.

Failure semantics: every pre-freeze failure (unknown remote, no matching project, unreachable server) leaves the local loop untouched. A failure after the freeze — snapshot, branch-tip resolve, push, or remote launch — relabels the local loop as plain `cancelled` and rolls back the sync-ref push (best effort), so the loop stays restartable locally with `loop-status restart=true`. Only the success path leaves the loop non-restartable as `migrated`.

Arguments:

| Argument | Description |
|---|---|
| `name` | Required loop name (or branch) to migrate. |
| `remote` | Required configured `remotes[].name` to migrate to. |

> Group, loop, and plan tools are denied inside loop and audit sessions so an in-flight loop cannot recursively spawn more work.

## Group Tools

Group tools orchestrate parallel feature extraction: a PRD or other broad work source is split into implementation-coherent features by the `feature-splitter` agent, each feature is planned by the `architect-auto` agent, and each warning-free plan runs as its own loop. Structurally incomplete stored plans fail after planning, and queued plans are revalidated immediately before launch. The autonomous architect cannot invoke execution, loop, or group tools directly. The launch command and splitter prefer small independently reviewable plans, grouping source items only when they have non-trivial implementation coupling such as shared contracts, migrations, state machines, refactors, or unavoidable sequencing. A scheduler advances features while respecting a per-group concurrency cap. Group tools are agent-invoked only (no slash commands) and are denied inside loop/audit sessions.

### `launch-group`

Requires exactly one of `prd` or `features`.

| Argument | Description |
|---|---|
| `title` | Required short title for the group. |
| `prd` | PRD or other broad documentation text to split into features. Mutually exclusive with `features`. |
| `features` | Pre-split or overlap-grouped features (`{ title, description }[]`). Mutually exclusive with `prd`. |
| `maxConcurrentLoops` | Maximum number of concurrent loops for this group. When omitted, defaults to the global `groupLaunch.maxConcurrentLoops` config value. |
| `loopNamePrefix` | Reserved for future use. |

### `group-status`

| Argument | Description |
|---|---|
| `groupId` | Optional group ID for detailed per-feature status. When omitted, lists all groups. |
| `restart` | Restart a non-completed, non-running group by `groupId` (resumes interrupted/errored groups). |

### `group-cancel`

| Argument | Description |
|---|---|
| `groupId` | Required group ID to cancel. |
| `cancelRunningLoops` | Also cancel running loops for non-terminal features. |

## Sandbox Shell

Sandbox loops use opencode's native `bash` tool; Forge routes the underlying shell into the loop sandbox via a generated shell shim and the `shell.env` hook. See [Sandbox](sandbox.md#shell-routing).
