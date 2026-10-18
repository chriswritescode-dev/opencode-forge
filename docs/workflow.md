# Planning and Execution Workflow

Plan with a smart model, execute with a fast model. The architect agent researches the codebase and designs an implementation plan; the code agent implements it.

See also: [Agents and Slash Commands](agents-and-commands.md), [Tools](tools.md), [Loop System](loop-system.md), [TUI](tui.md).

## How Plans Work

The architect is read-only and authors the plan into SQL storage for the current session with file-like plan tools: `plan-read` reads it, `plan-write` creates or replaces it, and `plan-edit` performs exact replacements, insertions, and deletions. Multi-phase plans are built incrementally with `plan-edit` rather than emitted or rewritten in one large call. Every write or edit returns a structure report with line and character counts, the detected `Loop Name:`, decomposed phases, and actionable warnings. A warning-free plan has an Objective, canonical loop name, correctly placed phase markers, every required phase subsection, trailing Decisions/Conventions/Key Context blocks, no section-cap overflow, and no detected host-absolute paths.

The stored plan is the source of truth for execution: `execute-plan`, the approval hook, and the TUI dialog all read it, and a marker-free assistant message can never replay an older chat plan over a newer tool-authored one. Programmatic access is via the `plan-read` tool.

## Execution

The execution dialog is available from the TUI.

After the architect presents a summary, the user chooses an execution mode from the execution dialog:

- **New session** — Creates a new Code session and sends the plan as the initial prompt.
- **Execute here** — The code agent takes over the current session immediately with the plan.
- **Loop** — Forge launches an iterative coding/auditing loop directly (no extra architect turn), creating an isolated git worktree and provisioning msb when enabled. An enabled sandbox that cannot start fails the launch rather than silently running on the host.

| Mode | When to choose it |
|------|-------------------|
| `New session` | Default for normal implementation |
| `Execute here` | When preserving current context matters |
| `Loop` | Safer autonomous iteration |

The dialog also lets you pick the execution model, auditor model, and their optional **variants** (provider-specific reasoning or thinking-effort levels such as `low`, `high`, `max`) at launch time. Selections are persisted with the loop and pre-filled on later launches. Variant defaults can be set via `config.executionVariant` / `config.auditorVariant` in the plugin config. In-session changes in the dialog override all other sources and persist for the OpenCode instance lifetime only (not across restarts).

For New session and Execute here, execution is immediate — there are no additional LLM calls between approval and execution. The system intercepts the user's approval answer, reads the cached plan, and dispatches it programmatically to the code agent. The architect never processes the approval response. For Loop mode the path depends on the surface: the TUI execution dialog dispatches the loop directly, while the question-based plan approval instructs the architect to launch it with the `execute-plan` tool.

For a multi-chunk goal, the `/goal <objective>` command runs as the architect: it resolves the work strictly read-only (GitHub issues via `gh`, a tracker's MCP tools, or a plain task breakdown), orders the tasks one-per-chunk, saves the goal with `goal-write`, and plans only chunk 1. Launching that plan as a loop from the same session — through the TUI dialog, the approval `Loop` path, or `execute-plan` — attaches it as chunk 1 and snapshots its models, sandbox settings, iteration cap, and project directory. As each chunk's loop settles, `architect-auto` plans the next task against the previous chunk's branch and the orchestrator launches it on a stacked branch, until every task is done, the planner declares the goal complete, or the goal pauses for an explicit `goal-status restart`. See [Loop System → Goals](loop-system.md#goals).

## Troubleshooting

- **No plan found** — Ensure the architect called `plan-write` in the current session and completed the stored plan.
- **TUI shows no plan** — Plans are session-scoped on the server; switch to the session where the architect produced the plan.
- **Need logs** — Set `logging.enabled` to `true`, and optionally `logging.debug` for verbose output.
