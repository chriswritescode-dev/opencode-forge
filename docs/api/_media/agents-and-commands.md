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
| `minion` | `subagent` | Fast implementation subagent for exactly one explicitly scoped change with detailed instructions. Runs on `executionModel` and `executionVariant`, or OpenCode's default model when `executionModel` is unset, never the caller's model. A user-defined `minion` agent overrides its prompt, model, and description; the tool restrictions below still apply. |

Source: [`src/agents/index.ts`](../src/agents/index.ts), [`src/agents/architect.ts`](../src/agents/architect.ts), [`src/agents/auditor.ts`](../src/agents/auditor.ts), [`src/agents/minion.ts`](../src/agents/minion.ts).

## Architect restrictions

The architect agent cannot use `edit`, `write`, `patch`, or `subagent`. It retains direct read/search tools, `shell` for read-only inspection and project checks, and `plan-read`, `plan-write`, and `plan-edit`; it can also call `question` and `execute-plan`.

## Auditor restrictions

The auditor agents are read-only. They cannot use file-modifying tools or loop-management tools.

Excluded tools:

- `edit`
- `write`
- `plan-write`
- `plan-edit`
- `execute-plan`
- `question`
- `loop-cancel`
- `loop-status`
- `loop-complete`

The `auditor` subagent also excludes `loop-handoff`. Only `auditor-loop`, the primary agent of a loop audit session, may record the auditor handoff.

Source: [`AUDITOR_TOOL_EXCLUDES` and `AUDITOR_SUBAGENT_TOOL_EXCLUDES`](../src/agents/auditor.ts).

## Minion restrictions

The `minion` subagent implements exactly one scoped change and never delegates. It excludes the shared structural tools (`plan-write`, `plan-edit`, `execute-plan`, `question`, `loop-cancel`, `loop-status`), the loop-only review tools (`review-write`, `review-delete`), the loop phase tools (`loop-handoff`, `loop-complete`), and the nested-subagent tool.

Source: [`buildMinionAgent()`](../src/agents/minion.ts).

## Slash Commands

| Command | Description | Agent | Subtask |
|---|---|---|---|
| `/review` | Run a code review. | `auditor` | yes |
| `/review-plan` | Review a completed implementation against its original plan. | `auditor` | yes |
| `/execute-plan` | Start an iterative development loop in a worktree (or launch the plan in a fresh standalone session with `mode: new-session`). | `code` | no |
| `/loop-status` | Check status of all active loops. | `code` | no |
| `/loop-cancel` | Cancel the active loop. | `code` | no |

`/review` and `/review-plan` are declared as subtask commands but run inline in the invoking session, because a plugin command cannot create a child session. Every Forge command switches the session to the command's agent for that one turn and, once the turn finishes, switches it back to the previous agent unless you selected a different agent in the meantime.

Source: [`buildPluginCommands()`](../src/config.ts).
