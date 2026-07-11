# Tools Reference

Forge exposes server-side tools for plan storage, review findings, loop management, group orchestration, section navigation, and sandbox shell execution.

See also: [Agents and Slash Commands](agents-and-commands.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Tool List

| Tool | Purpose | Source |
|---|---|---|
| `plan-read` | Read the current session or loop plan, or list/search recent project plans. | [`src/tools/plan-kv.ts`](../src/tools/plan-kv.ts) |
| `section-read` | Read a section plan and status for the active loop session. | [`src/tools/section-read.ts`](../src/tools/section-read.ts) |
| `review-write` | Store a review finding. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `review-read` | Read review findings. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `review-delete` | Delete a review finding. | [`src/tools/review.ts`](../src/tools/review.ts) |
| `execute-plan` | Start an iterative development loop in an isolated git worktree, or (with `mode: new-session`) launch the plan in a fresh standalone session. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `execute-goal` | Start a managed goal loop in the current session, warped into an isolated Forge worktree with fresh auditors on idle. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-cancel` | Cancel an active loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-status` | List loops, inspect one loop, or restart a restartable loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `launch-group` | Launch a group of features (from a PRD or a pre-split list), each planned and run as its own loop, scheduled with a concurrency cap. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `group-status` | List groups, inspect one group's per-feature stages, or restart a non-completed group. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `group-cancel` | Cancel a group, optionally cancelling its running loops. | [`src/tools/group.ts`](../src/tools/group.ts) |
| `sh` | Sandbox shell tool added when a sandbox manager is available. | [`src/tools/bash/index.ts`](../src/tools/bash/index.ts) |

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

Starts a managed goal loop in the invoking session. The session is warped into an isolated Forge worktree; no executor session is created. Each executor idle transition creates a fresh auditor, and dirty findings return to the same executor until an audit leaves no open findings.

| Argument | Description |
|---|---|
| `goal` | Required non-empty free-text goal. |
| `title` | Optional title, derived from the goal when omitted. |
| `loopName` | Optional loop name, slugified and uniquified. |
| `maxIterations` | Optional iteration cap; `0` means unlimited. |
| `hostSessionId` | Optional host session ID for post-completion redirect. |

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

## Sandbox Shell Tool

### `sh`

The `sh` tool is only added when a sandbox manager is available. It runs shell commands inside the sandbox container associated with the active loop session. Outside an active sandbox loop, the tool is not useful and the global default permission denies `sh` unless Forge explicitly grants sandbox context.

For broader sandbox behavior, see [Sandbox](sandbox.md).
