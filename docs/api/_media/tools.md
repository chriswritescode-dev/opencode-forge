# Tools Reference

Forge exposes server-side tools for plan storage, review findings, loop management, group orchestration, section navigation, and sandbox shell execution.

See also: [Agents and Slash Commands](agents-and-commands.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Tool List

| Tool | Purpose | Source |
|---|---|---|
| `plan-read` | Read the current session or loop plan, or list/search recent project plans. | [`src/tools/plan-kv.ts`](../src/tools/plan-kv.ts) |
| `section-read` | Read a section plan and status for the active loop session. | [`src/tools/section-read.ts`](../src/tools/section-read.ts) |
| `plan-adjust` | Revise the section under audit and/or replace the remaining (not yet started) sections of the active loop plan; auditor-only, logged as a plan amendment. | [`src/tools/plan-adjust.ts`](../src/tools/plan-adjust.ts) |
| `review-write` | Store a review finding. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `review-read` | Read review findings. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `review-delete` | Delete a review finding. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `execute-plan` | Start an iterative development loop in an isolated git worktree, or (with `mode: new-session`) launch the plan in a fresh standalone session. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `execute-goal` | Start a managed goal loop in a dedicated code session inside an isolated Forge worktree. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-cancel` | Cancel an active loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-status` | List loops, inspect one loop, or restart a restartable loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `launch-group` | Launch a group of features (from a PRD or a pre-split list), each planned and run as its own loop, scheduled with a concurrency cap. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `group-status` | List groups, inspect one group's per-feature stages, or restart a non-completed group. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `group-cancel` | Cancel a group, optionally cancelling its running loops. | [`src/tools/group.ts`](../src/tools/group.ts) |

## Plan Tools

### `plan-read`

Arguments:

| Argument | Description |
|---|---|
| `offset` | Line number to start from, 1-indexed. |
| `limit` | Maximum number of lines to return. |
| `pattern` | Regex pattern to search plan content. |
| `loop_name` | Optional loop name to read a loop-scoped plan directly. |
| `session_id` | Explicit session ID to read from. |
| `recent` | List or search recent project-scoped plans. |

## Section Tools

### `section-read`

Arguments:

| Argument | Description |
|---|---|
| `section_index` | Optional 0-based section index. If omitted, returns the lowest-index incomplete section. |

### `plan-adjust`

Only callable by the current auditor session of a sectioned plan loop during the `auditing` phase (rejected in goal loops and during the final audit). Can revise the section currently under audit (`currentSection`, edited in place with its progress preserved) and/or replace the pending section suffix from the current section + 1 onward (`sections`). Already-completed sections, the plan objective, and verification are immutable. The resulting total may not exceed 24 sections. Every adjustment is recorded in the `plan_amendments` table with before/after snapshots.

Arguments:

| Argument | Description |
|---|---|
| `sections` | Optional replacement list of `{ title, content }` for the not-yet-started sections after the current one. Omit to leave future sections unchanged; an empty list removes the entire pending suffix. |
| `currentSection` | Optional `{ title, content }` revision of the section currently under audit, edited in place. If the revision means the existing work no longer satisfies the section, also write bug findings so it is re-coded. |
| `rationale` | Why the plan needs adjustment. |

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

> Group, loop, and plan tools are denied inside loop and audit sessions so an in-flight loop cannot recursively spawn more work.

## Group Tools

Group tools orchestrate parallel feature extraction: a PRD or other broad work source is split into implementation-coherent features by the `feature-splitter` agent, each feature is planned by the `architect-auto` agent, and each plan runs as its own loop. The launch command and splitter prefer small independently reviewable plans, grouping source items only when they have non-trivial implementation coupling such as shared contracts, migrations, state machines, refactors, or unavoidable sequencing. A scheduler advances features while respecting a per-group concurrency cap. Group tools are agent-invoked only (no slash commands) and are denied inside loop/audit sessions.

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

Sandbox loops use opencode's native `bash` tool; Forge routes the underlying shell into the loop container via a generated shell shim and the `shell.env` hook. See [Sandbox](sandbox.md#shell-routing).
