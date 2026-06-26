# Tools Reference

Forge exposes server-side tools for plan storage, review findings, loop management, section navigation, and sandbox shell execution.

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
| `loop-cancel` | Cancel an active loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
| `loop-status` | List loops, inspect one loop, or restart a restartable loop. | [`src/tools/loop.ts`](../src/tools/loop.ts) |
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

## Sandbox Shell Tool

### `sh`

The `sh` tool is only added when a sandbox manager is available. It runs shell commands inside the sandbox container associated with the active loop session. Outside an active sandbox loop, the tool is not useful and the global default permission denies `sh` unless Forge explicitly grants sandbox context.

For broader sandbox behavior, see [Sandbox](sandbox.md).
