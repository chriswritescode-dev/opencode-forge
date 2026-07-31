# Agents and Slash Commands

Forge installs agent definitions and slash commands through the server plugin config hook.

See also: [Tools](tools.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Agents

| Agent | Mode | Description |
|---|---|---|
| `code` | `all` | Primary implementation agent. |
| `architect` | `primary` | Read-only planning agent. Authors and validates the stored plan with `plan-write`/`plan-edit` before approval. |
| `auditor` | `subagent` | Read-only code review agent for convention-aware reviews. |
| `auditor-loop` | `primary`, hidden | Internal auditor used by loop audit sessions. |
| `architect-auto` | `primary`, hidden | Autonomous grouped-execution planner; only warning-free stored plans launch. |
| `feature-splitter` | `primary`, hidden | Splits broad work into implementation-coherent feature briefs. |

Source: [`src/agents/index.ts`](../src/agents/index.ts), [`src/agents/architect.ts`](../src/agents/architect.ts), [`src/agents/auditor.ts`](../src/agents/auditor.ts).

## Architect restrictions

The architect agents cannot use `apply_patch`, `edit`, `write`, `multiedit`, `patch`, or `task`. They retain direct read/search tools, Bash for read-only inspection and project checks, and `plan-read`, `plan-write`, and `plan-edit`; only the interactive architect can call `question` and `execute-plan`. The autonomous architect cannot invoke execution, loop, or group tools directly.

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
- `execute-plan`
- `execute-goal`
- `loop-cancel`
- `loop-status`

Source: [`AUDITOR_TOOL_EXCLUDES`](../src/agents/auditor.ts).

## Slash Commands

| Command | Description | Agent | Subtask |
|---|---|---|---|
| `/review` | Run a code review. | `auditor` | yes |
| `/review-plan` | Review a completed implementation against its original plan. | `auditor` | yes |
| `/execute-plan` | Start an iterative development loop in a worktree (or launch the plan in a fresh standalone session with `mode: new-session`). | `code` | no |
| `/execute-goal` | Execute a goal in rotating dedicated code and auditor sessions inside an isolated worktree. | `code` | no |
| `/loop-status` | Check status of all active loops. | `code` | no |
| `/loop-cancel` | Cancel the active loop. | `code` | no |

Source: [`buildPluginCommands()`](../src/config.ts).
