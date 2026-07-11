# Agents and Slash Commands

Forge installs agent definitions and slash commands through the server plugin config hook.

See also: [Tools](tools.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Agents

| Agent | Mode | Description |
|---|---|---|
| `code` | `all` | Primary implementation agent. |
| `architect` | `primary` | Read-only planning agent. Produces marked plans for approval and execution. |
| `auditor` | `subagent` | Read-only code review agent for convention-aware reviews. |
| `auditor-loop` | `primary`, hidden | Internal auditor used by loop audit sessions. |

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
| `/execute-goal` | Execute a goal directly in the invoking session inside an isolated worktree, with fresh auditor sessions until no findings remain. | `code` | no |
| `/loop-status` | Check status of all active loops. | `code` | no |
| `/loop-cancel` | Cancel the active loop. | `code` | no |

Source: [`buildPluginCommands()`](../src/config.ts).
