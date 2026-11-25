# Agents and Slash Commands

Forge installs agent definitions and slash commands through the server plugin config hook.

See also: [Tools](tools.md), [Configuration](configuration.md), [Loop System](loop-system.md).

## Agents

| Agent | Mode | Description |
|---|---|---|
| `code` | `all` | Primary implementation agent. Orchestrates `minion` subagents for implementation, reviews and fixes their output, and edits directly only when needed. |
| `code-loop` | `primary`, hidden | Coding agent used by default for loop coding and post-action sessions. It shares `code`'s coding discipline and exact tool exclusions, but its prompt has no orchestration or `minion` delegation, so fast/cheap loop models implement directly instead of spawning subagent batches. Prompt-only separation: permissions are unchanged. |
| `architect` | `primary` | Read-only planning agent. Researches the goal, settles the implementation route with grouped `question` rounds, then authors and validates the stored plan with `plan-write`/`plan-edit` before approval. |
| `auditor` | `subagent` | Read-only code review agent for convention-aware reviews. |
| `auditor-loop` | `primary`, hidden | Internal auditor used by loop audit sessions. |
| `minion` | `subagent` | Fast implementation subagent for exactly one explicitly scoped change with detailed instructions. Runs on `agents.minion.model` / `agents.minion.variant` when set, otherwise on `executionModel` / `executionVariant`, or OpenCode's default model when neither is set — never the caller's model. A user-defined `minion` agent overrides its prompt, model, and description; the tool restrictions below still apply. |

`code` and `code-loop` both load their system addendum from `~/.config/opencode/forge/prompts/agents/` (`code.md` and `code-loop.md`). The prompts sync automatically through the prompts manifest, and user edits are preserved. The separation lives entirely in the prompt: `code-loop.md` omits the `# Orchestration` section that tells `code` to delegate implementation to `minion`.

Source: [`src/agents/index.ts`](../src/agents/index.ts), [`src/agents/code.ts`](../src/agents/code.ts), [`src/agents/architect.ts`](../src/agents/architect.ts), [`src/agents/auditor.ts`](../src/agents/auditor.ts), [`src/agents/minion.ts`](../src/agents/minion.ts).

### Loop role agents

Loop sessions choose their agents independently of the interactive `code` agent:

| Setting | Default | Role |
|---|---|---|
| `loop.executionAgent` | `"code-loop"` | Loop coding turns. |
| `loop.auditorAgent` | `"auditor-loop"` | Loop audit turns. |
| `loop.postAction.agent` | `"code-loop"` | Post-completion action turn. |

Each accepts any Forge or user-defined agent name, so a custom agent can replace a role. Configure defaults in `forge-config.jsonc`; the TUI execution and restart dialogs override them per run (`Execution agent`, `Auditor agent`, and `Loop settings → Post-action agent`), and `FORGE_RPC` carries the same per-run values through `executePlan`, `loopRestart`, `loopDefaults`, `loops`, and `loopDetail`. See [Configuration → Loop](configuration.md#loop) and [Configuration → Post-Action](configuration.md#post-action).

The post-action phase also has its own optional `loop.postAction.model` and `loop.postAction.variant`. Its variant is independent and never inherited across models: it applies only with an explicitly configured post-action model, and the auditor model chain keeps the auditor's own variant.

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
