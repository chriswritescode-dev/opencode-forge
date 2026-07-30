# Agents and Slash Commands

Forge installs agent definitions and slash commands through the server plugin config hook.

See also: [Tools](tools.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Agents

| Agent | Mode | Description |
|---|---|---|
| `code` | `all` | Primary implementation agent. |
| `architect` | `primary` | Read-only planning agent. Authors the stored plan with `plan-write`/`plan-edit` for approval and execution; marked plans in chat are still captured. |
| `auditor` | `subagent` | Read-only code review agent for convention-aware reviews. |
| `auditor-loop` | `primary`, hidden | Internal auditor used by loop audit sessions. |
| `goal` | `primary` | Read-only brief-authoring agent. Reconnoiters the codebase, clarifies scope inline, and writes the session-scoped goal brief with `goal-write` for approval and execution. |

Source: [`src/agents/index.ts`](../src/agents/index.ts), [`src/agents/auditor.ts`](../src/agents/auditor.ts).

## Auditor restrictions

The auditor agents are read-only. They cannot use file-modifying tools or loop-management tools.

Excluded tools:

- `apply_patch`
- `edit`
- `write`
- `multiedit`
- `plan`
- `plan_exit`
- `plan-write`
- `plan-edit`
- `goal-write`
- `execute-plan`
- `execute-goal`
- `loop-cancel`
- `loop-status`

Source: [`AUDITOR_TOOL_EXCLUDES`](../src/agents/auditor.ts).

## Goal agent restrictions

The `goal` agent is a read-only brief author. It can reconnoiter with read tools and ask the user clarifying questions, but cannot edit source files, run loops, or author plans. Its only write tool is `goal-write`.

Excluded tools: every filesystem-mutating tool, every plan/loop/group management tool, and every plan-authoring tool (`plan-write`, `plan-edit`, `plan-adjust`). The `goal` agent is the only agent allowed to call `goal-write`.

Source: [`src/agents/goal.ts`](../src/agents/goal.ts), [`src/constants/loop.ts`](../src/constants/loop.ts).

## Slash Commands

| Command | Description | Agent | Subtask |
|---|---|---|---|
| `/review` | Run a code review. | `auditor` | yes |
| `/review-plan` | Review a completed implementation against its original plan. | `auditor` | yes |
| `/execute-plan` | Start an iterative development loop in a worktree (or launch the plan in a fresh standalone session with `mode: new-session`). | `code` | no |
| `/execute-goal` | Execute a goal in rotating dedicated code and auditor sessions inside an isolated worktree. | `code` | no |
| `/goal` | Reconnoiter and author a goal brief (`goal-write`), then launch a goal loop via the Forge execution dialog. | `goal` | no |
| `/loop-status` | Check status of all active loops. | `code` | no |
| `/loop-cancel` | Cancel the active loop. | `code` | no |

Source: [`buildPluginCommands()`](../src/config.ts).
