# Agents and Slash Commands

Forge installs agent definitions and slash commands through the server plugin config hook.

See also: [Tools](tools.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Agents

| Agent | Mode | Description |
|---|---|---|
| `code` | `all` | Primary implementation agent. |
| `architect` | `primary` | Read-only planning agent. Researches the goal, settles the implementation route with grouped `question` rounds, then authors and validates the stored plan with `plan-write`/`plan-edit` before approval. |
| `auditor` | `subagent` | Read-only code review agent for convention-aware reviews. |
| `auditor-loop` | `primary`, hidden | Internal auditor used by loop audit sessions. |
| `architect-auto` | `primary`, hidden | Non-interactive planning agent that authors a stored plan from a single prompt, without `question` or execution tools, following route decisions recorded in its brief. Used by the goal orchestrator to plan each subsequent goal chunk. |

Source: [`src/agents/index.ts`](../src/agents/index.ts), [`src/agents/architect.ts`](../src/agents/architect.ts), [`src/agents/auditor.ts`](../src/agents/auditor.ts).

## Architect restrictions

The architect agents cannot use `edit`, `write`, `patch`, or `subagent`. They retain direct read/search tools, `shell` for read-only inspection and project checks, and `plan-read`, `plan-write`, and `plan-edit`; only the interactive architect can call `question`, `execute-plan`, and `goal-write`. The autonomous architect cannot invoke execution, loop, or goal tools directly.

## Auditor restrictions

The auditor agents are read-only. They cannot use file-modifying tools or loop-management tools.

Excluded tools:

- `edit`
- `write`
- `plan-write`
- `plan-edit`
- `goal-write`
- `execute-plan`
- `question`
- `loop-cancel`
- `loop-status`
- `goal-cancel`
- `goal-status`
- `loop-complete`

The `auditor` subagent also excludes `loop-handoff`. Only `auditor-loop`, the primary agent of a loop audit session, may record the auditor handoff.

Source: [`AUDITOR_TOOL_EXCLUDES` and `AUDITOR_SUBAGENT_TOOL_EXCLUDES`](../src/agents/auditor.ts).

## Slash Commands

| Command | Description | Agent | Subtask |
|---|---|---|---|
| `/review` | Run a code review. | `auditor` | yes |
| `/review-plan` | Review a completed implementation against its original plan. | `auditor` | yes |
| `/execute-plan` | Start an iterative development loop in a worktree (or launch the plan in a fresh standalone session with `mode: new-session`). | `code` | no |
| `/goal` | Plan a multi-chunk goal: resolve its tasks, save the ordered goal, and plan chunk 1 for launch as a loop. | `architect` | no |
| `/loop-status` | Check status of all active loops. | `code` | no |
| `/loop-cancel` | Cancel the active loop. | `code` | no |

`/review` and `/review-plan` are declared as subtask commands but run inline in the invoking session, because a plugin command cannot create a child session. Every Forge command switches the session to the command's agent for that one turn and, once the turn finishes, switches it back to the previous agent unless you selected a different agent in the meantime.

Source: [`buildPluginCommands()`](../src/config.ts).
