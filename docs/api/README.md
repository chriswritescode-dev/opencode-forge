**opencode-forge**

***

<p align="center">
  <img src="_media/logo.webp" alt="OpenCode Forge logo" />
</p>

<h1 align="center">OpenCode Forge</h1>

<p align="center">
  <strong>Loops, plans, sandboxing, and code review for <a href="https://opencode.ai">OpenCode</a> AI agents</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-forge"><img src="https://img.shields.io/npm/v/opencode-forge" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/opencode-forge"><img src="https://img.shields.io/npm/dm/opencode-forge" alt="npm downloads" /></a>
  <a href="https://github.com/chriswritescode-dev/opencode-forge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/chriswritescode-dev/opencode-forge" alt="License" /></a>
</p>

## Quick Start

```bash
pnpm add opencode-forge
```

Add to your `opencode.json` to enable Forge’s server-side hooks, tools, and agents:

```json
{
  "plugin": ["opencode-forge@latest"]
}
```

**For TUI features:** Also add to your `tui.json` to enable the sidebar and execution dialog:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-forge@latest"]
}
```

As of OpenCode 1.17.8, `OPENCODE_EXPERIMENTAL_WORKSPACES=true` is required for the plugin's loop functionality to work. Set it in the environment that launches `opencode`:

```bash
export OPENCODE_EXPERIMENTAL_WORKSPACES=true
```

Without this, Forge cannot create loop worktrees, so the worktree-bound execution modes (`mode: loop` of `execute-plan` / `/execute-plan`, plus `execute-goal`) will fail. The audited `mode: new-session` path does not require a workspace — it runs in the project directory with no worktree. See [Common Issues](#common-issues) and [Workspace Integration](#workspace-integration) for details.

## What Forge Adds

Forge ships two user-facing surfaces:

- **Server plugin** — enabled through OpenCode plugin config in `opencode.json`. The package declares the `server` oc-plugin surface and exports `./server` for the server entrypoint.
- **TUI plugin** — enabled separately in `tui.json`. The package declares the `tui` oc-plugin surface and exports `./tui` for the terminal UI entrypoint.

The server plugin provides the core hooks, tools, agents, plan storage, loop orchestration, review persistence, and sandbox support. The TUI plugin layers on the sidebar and execution dialog.

## Detailed Documentation

- [Agents and slash commands](_media/agents-and-commands.md)
- [Tools reference](_media/tools.md)
- [Configuration reference](_media/configuration.md)
- [Sandbox](_media/sandbox.md)
- [Architecture](_media/architecture.md)
- [Loop system](_media/loop-system.md)

## Dashboard

Forge includes a read-only observability Dashboard — a standalone Bun HTTP server (`src/dashboard/`) that serves a SolidJS single-page app at `GET /` and JSON state at `GET /api/data`. Launch it from the TUI command palette (`Open dashboard`) or via `pnpm dashboard`. The dashboard **never mutates** loop, workspace, or storage state.

### Views

The dashboard shows a **Loops view** by default — groups loops by project with filterable project/loop lists, loop detail (plan, sections, findings, usage, audit results, completion summary), and live polled state (5 s interval). Supports `#<projectId>/<loopName>` deep linking.

### API Endpoints

All endpoints are read-only (non-GET requests return 404):

| Endpoint | Description |
|----------|-------------|
| `GET /` | HTML page (inlined SolidJS app) |
| `GET /api/data` | JSON snapshot of Forge loop/project state |

## Screenshots

Execution flow dialog with mode and model selection:

![Execution Flow](_media/execution.webp)

## Features

- **Plans** — architect produces marked plans that are auto-captured to SQL storage
- **Execution** — approved-plan launch paths in worktree (`mode: loop`) or project-directory (`mode: 'new-session'`) loops, plus direct `/execute-goal` loops in dedicated worktree sessions; plan loops can also target a configured remote opencode server (see [Configuration](_media/configuration.md#remotes))
- **Loops** — iterative coding/auditing with isolated git worktree and optional Docker sandbox for plan and `/execute-goal` loops; the audited `New session` mode (`mode: 'new-session'`) runs as a goal-style loop in the project directory with no worktree and no sandbox
- **Review Findings** — persistent, loop-scoped review findings across loop sessions
- **TUI** — sidebar and execution dialog
- **Sandbox** — Optional Docker worktree loop isolation with bind-mounted project files

## Agents

The plugin bundles three user-facing agents plus a hidden `auditor-loop` variant used by loop audit sessions. See [Agents and slash commands](_media/agents-and-commands.md) for the full reference.

| Agent | Mode | Description |
|-------|------|-------------|
| **code** | all | Primary coding agent. |
| **architect** | primary | Read-only planning agent. Researches the codebase, designs implementation plans, and caches them for user approval before execution. |
| **auditor** | subagent | Read-only code auditor for convention-aware reviews. Invoked via Task tool to review diffs, commits, branches, or PRs against stored conventions and decisions. |
| **auditor-loop** | primary, hidden | Internal audit agent used for loop-runner audit sessions. |

The auditor agent is a read-only subagent that cannot edit source files or execute plans. It is invoked by other agents via the Task tool to review code changes against stored project conventions and decisions.

**Tool restrictions:** The auditor cannot use file-editing tools, planning tools, or loop-management tools. See [Auditor restrictions](_media/agents-and-commands.md#auditor-restrictions).

The architect agent operates as a read-only planner with message-level reinforcement via the `experimental.chat.messages.transform` hook. Final plans are rendered once in the assistant response between `<!-- forge-plan:start -->` and `<!-- forge-plan:end -->` markers, then auto-captured into SQL before execution approval. After user approval via the question tool, execution is dispatched programmatically. **Co-located deployments** (TUI and `opencode serve` in the same process) need no additional LLM calls between approval and dispatch — the system intercepts the approval answer, reads the cached plan, and dispatches it directly; the architect never processes the approval response. **Split-process deployments** (TUI attached to a separate `opencode serve` process) add one LLM turn for `New session` as the panel prompts the host session's agent to invoke `execute-plan` with `mode='new-session'` over the bus before execution starts (panel-only dispatch — the architect is out of the path); `Execute here` and `Loop` follow their own dispatch described in [Planning and Execution Workflow](#planning-and-execution-workflow). The user can view and edit the cached plan from the sidebar or command palette before or during execution.

## Tools

See [Tools reference](_media/tools.md) for full arguments, section-scoping behavior, restart options, and sandbox shell details.

Forge provides these tool groups:

- **Plan tools** — `plan-read`, `section-read`
- **Review tools** — `review-write`, `review-read`, `review-delete`
- **Loop tools** — `execute-plan`, `execute-goal`, `loop-cancel`, `loop-status`
- **Sandbox shell** — `sh` when a sandbox manager is available

Most loops run in an isolated git worktree; Docker sandbox is used automatically when available. The audited `New session` execution mode (`mode: new-session`) is the exception: it runs as a goal-style loop in the project directory with no worktree or sandbox.

| Tool | Description |
|------|-------------|
| `execute-plan` | Execute a plan using an iterative development loop in an isolated git worktree, or `mode: new-session` to run it as an audited goal-style loop in the project directory (no worktree, no sandbox; tracked by `loop-status`/`loop-cancel`; falls back to a standalone session when loops are disabled or the project has no commit). Args: `title` required; `plan`, `loopName`, `hostSessionId`, `mode`, `executionModel`, `auditorModel`, `executionVariant`, `auditorVariant` optional. |
| `execute-goal` | Execute a free-text goal in rotating dedicated code and auditor sessions inside an isolated git worktree. Args: `goal` required; `title`, `loopName`, `maxIterations`, `hostSessionId` optional. |
| `loop-cancel` | Cancel an active loop by loop name |
| `loop-status` | List active/recent loops or get detailed status by loop name, including cumulative token usage when available. Supports `restart=true` to restart any non-completed loop (`running`, `cancelled`, `errored`, `stalled`). Completed loops are history-only and cannot be restarted. |

`execute-plan` reads the current session's captured plan when `plan` is omitted. Direct tool arguments can override the code and auditor model and variants (`executionModel`, `auditorModel`, `executionVariant`, `auditorVariant`); they default to plugin config values when omitted. `maxIterations` and sandbox behavior are not configurable per-invocation: `maxIterations` is sourced from `loop.defaultMaxIterations` and `sandbox.mode` governs sandbox use. The TUI execution dialog exposes only model/variant selection, so panel-driven `New session` launches inherit the configured iteration limit rather than a dialog-controlled one.

## Slash Commands

| Command | Description | Agent |
|---------|-------------|-------|
| `/review` | Run a code review on current changes | auditor (subtask) |
| `/review-plan` | Review a completed implementation against its original plan | auditor (subtask) |
| `/execute-plan` | Start an iterative development loop in a worktree (or run the plan as an audited goal-style loop in the project directory with `mode: new-session`) | code |
| `/execute-goal` | Execute a free-text goal in dedicated worktree sessions until an audit leaves no findings | code |
| `/loop-status` | Check status of all active loops | code |
| `/loop-cancel` | Cancel the active loop | code |

## Configuration

On first run, the plugin automatically copies the bundled config to your config directory:
- If `XDG_CONFIG_HOME` is set: `$XDG_CONFIG_HOME/opencode/forge-config.jsonc`
- Otherwise: `~/.config/opencode/forge-config.jsonc`

**Note:** Configuration is stored at `~/.config/opencode/forge-config.jsonc` unless `XDG_CONFIG_HOME` is set.

The plugin supports JSONC format, allowing comments with `//` and `/* */`.

You can edit this file to customize settings. The file is created only if it doesn't already exist.

See [Configuration reference](_media/configuration.md) for all supported options, including loop post-actions, external read directories, TUI keybinds, dashboard, and sandbox resource defaults.

### Where Forge stores data

- Config: `~/.config/opencode/forge-config.jsonc` or `$XDG_CONFIG_HOME/opencode/forge-config.jsonc`
- Data dir: `~/.local/share/opencode/forge` or `$XDG_DATA_HOME/opencode/forge`
- Logs: `~/.local/share/opencode/forge/logs/forge.log`
- Log rotation: 10MB
- Prompts: `~/.config/opencode/forge/prompts` or `$XDG_CONFIG_HOME/opencode/forge/prompts`

### Customizing prompts

Agent and command prompts are bundled as editable markdown under `src/prompts/` and installed to `~/.config/opencode/forge/prompts/` on first run. Edit any file there to customize an agent (`agents/*.md`) or slash command (`commands/*.md`); your edits take precedence over the bundled defaults and are preserved across upgrades. Bundled prompt fixes are re-applied automatically only to files you have not edited (tracked by content hash in `~/.config/opencode/forge/manifests/`); delete a file to restore the bundled version on next start.

> The manifest files are managed automatically. Do not hand-edit a manifest hash to match a file you changed — doing so makes the startup sync treat your edit as a pristine bundled file and overwrite it on the next upgrade. Just edit the prompt; leave the manifest alone.

### Reinstalling or repairing bundled assets

The startup sync is intentionally silent and non-destructive: it installs new prompts/skills, refreshes files you have not touched, preserves your edits, and never deletes anything. For deliberate (re)installation, conflict resolution, and cleanup, run the interactive installer:

```bash
bunx opencode-forge        # or: npx opencode-forge
```

It walks through every bundled prompt and skill. New files are installed silently; when an installed file differs from the bundle you are prompted to **overwrite**, **keep** your version, or view a **diff**. Orphaned files left over from older layouts are offered for removal.

Flags for non-interactive use:

| Flag | Behavior |
| --- | --- |
| `-f`, `--force` | Overwrite all conflicting files and delete all orphans |
| `-k`, `--keep` | Keep all local versions; never delete anything |
| `-y`, `--yes` | Keep edited files, prune orphans (no prompts) |
| `-n`, `--dry-run` | Show what would change without writing anything |
| `--no-prune` | Only report orphaned files; never delete them |

From a checkout, the same tool is available as `pnpm setup` (runs `bun src/install/cli.ts`).

Enable `logging.enabled` to write logs to disk. To use the default log path, omit `logging.file` or set it to `null` (an empty string is not treated as a default). Set `logging.debug` for more verbose output.

## TUI Plugin

The plugin includes a TUI sidebar widget and an execution dialog for launching plans directly in the OpenCode terminal interface.

### Sidebar

The sidebar shows Forge's connection status and version. Captured plans live on the server in the `plansRepo` SQL store; the TUI no longer keeps a local archive or in-TUI editor.

### Execution Dialog

Open the dialog from the command palette as `Execute plan` (default keybind `<leader>f`). The plan is sourced from the most recent architect message in the current session — the marked `<!-- forge-plan:start --> ... <!-- forge-plan:end -->` block is parsed out of the assistant's reply. If no marked plan exists in the session, the dialog will not open and you'll see a toast asking the architect to produce one first.

The dialog provides full control over execution parameters:

#### Execution Mode Selection

Choose from three execution modes:

1. **New session** — Creates a fresh Code session in the project directory and runs the plan as an audited goal-style loop (auditor validates each pass until the audit is clear)
2. **Execute here** — Takes over the current session immediately with the plan
3. **Loop** — Prompts the architect to launch an iterative coding/auditing loop via the `execute-plan` tool in an isolated git worktree (Docker sandbox used automatically when available)

#### Model Selection

Two model selectors are available:

**Execution Model:**
- Opens a full model selection dialog with all available providers
- Shows recently used models for quick access (derived from your OpenCode sessions, recent Forge loops, OpenCode favorites, and the global default)
- Displays model capabilities (reasoning, tools support) in descriptions
- Defaults to `config.executionModel`, falling back to the most recent Forge loop's selection (priority: in-session override → `config.executionModel` → last-used workspace)

**Auditor Model:**
- Same model selection interface
- Defaults to `config.auditorModel` → `config.executionModel` (inherit), falling back to the most recent Forge loop's auditor (or execution) selection (priority: in-session override → `config.auditorModel` → `config.executionModel` → last-used workspace auditor → last-used workspace execution → platform default)

#### Persistence

Persistence is per-mode. **Loop** executions stamp the chosen execution + auditor model (and variants) into `workspace.create.extra.forgeLoop`; those workspace rows live on the OpenCode server, so the dialog derives durable last-used defaults and recents from `workspace.list()` even when the TUI runs on a different host than the server. **New session** and **Execute here** are not workspace-backed: their model choices are remembered only as in-session overrides in TUI-local memory (instance lifetime, not across OpenCode restarts) plus the shared server-derived recents list, so launching them in a fresh OpenCode instance falls back to config defaults rather than the previous session's pick.

The dialog tracks loop-mode, `New session`, and `Execute here` modes for recents — derived from the OpenCode session list — and last-used defaults — derived exclusively from loop-mode workspace metadata. In split-process deployments (TUI attached to a separate `opencode serve` process), executing `New session` first prompts the host session's agent which dispatches `plan.execute.newSession` over the bus, adding one extra LLM turn before execution starts; the panel then awaits authoritative confirmation from the per-launch nonce-keyed `loop_new_session_outcomes` row written after the launch commits (this single outcome table covers both audited goal-loop and one-shot fallback outcomes), rather than reporting success off the queued prompt alone. Successful executions in loop mode update workspace-level preferences so subsequent launches reuse the same selections; `New session` and `Execute here` selections do not persist across restarts.

### Setup

When installed from the package, the TUI plugin loads automatically when added to your TUI config. The plugin is auto-detected via the `./tui` export in `package.json`.

Add to your `~/.config/opencode/tui.json` or project-level `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-forge"
  ]
}
```

### Model Selection Dialog

The TUI provides a comprehensive model selection dialog when executing plans. The dialog features:

#### Model Organization

Models are displayed in priority order:

1. **Recent** — Last 10 models, derived from the OpenCode session list, recent Forge loops, OpenCode favorites, and the global default
2. **Connected providers** — Models from currently connected providers
3. **Configured providers** — Models from providers defined in your OpenCode config
4. **All models** — Remaining models sorted alphabetically by provider and model name

Each model shows:
- Model name and provider
- Capabilities (reasoning, tools support)
- Full identifier (e.g., `anthropic/claude-sonnet-4-20250514`)

#### Quick Access

- **"Use default"** option at the top to use config defaults
- Recently used models are loaded into the project-scoped execution-context cache once when the TUI connects to the OpenCode server, and updated in-memory as you launch loops (e.g. via `recordRecent`). The cache is reused on subsequent dialog opens for instant display; recents are not re-fetched from the server every time the dialog opens, but the next cache refresh re-derives them authoritatively from server-side data.

### Configuration

TUI options are configured in `~/.config/opencode/forge-config.jsonc` under the `tui` key:

```jsonc
{
  "tui": {
    "sidebar": true,
    "showVersion": true
  }
}
```

Set `sidebar` to `false` to completely disable the widget.

For local development, reference the built TUI file directly:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/path/to/opencode-forge/dist/tui.js"
  ]
}
```

## Planning and Execution Workflow

Plan with a smart model, execute with a fast model. The architect agent researches the codebase and designs an implementation plan; the code agent implements it.

### How Plans Work

The architect is read-only and must output exactly one final plan between `<!-- forge-plan:start -->` and `<!-- forge-plan:end -->` markers. Forge auto-captures that marked plan into SQL storage for the current session.

The captured plan is the source of truth for execution. The architect's own message in the chat history is the human-readable view; programmatic access is via the `plan-read` tool.

### Execution

After the architect presents a summary, the user chooses an execution mode from the execution dialog:

- **New session** — Creates a new Code session in the project directory and runs the plan as an audited goal-style loop (auditor validates each pass until the audit is clear).
- **Execute here** — The code agent takes over the current session immediately with the plan.
- **Loop** — The architect is prompted to launch an iterative coding/auditing loop via the `execute-plan` tool, which creates an isolated git worktree and provisions a Docker sandbox when available.

| Mode | When to choose it |
|------|-------------------|
| `New session` | Default for normal implementation; tracked as an audited loop in the project directory |
| `Execute here` | When preserving current context matters |
| `Loop` | Safer autonomous iteration in an isolated worktree |

The dialog also lets you pick the execution model, auditor model, and their optional **variants** (provider-specific reasoning or thinking-effort levels such as `low`, `high`, `max`) at launch time. Loop-mode selections are remembered as workspace-level preferences and pre-filled on later launches; New session and Execute here selections are remembered only as in-session overrides (instance lifetime). Variant defaults can be set via `config.executionVariant` / `config.auditorVariant` in the plugin config. In-session changes in the dialog override all other sources and persist for the OpenCode instance lifetime only (not across restarts).

For New session and Execute here, the first coding pass is immediate in co-located deployments — there are no additional LLM calls between approval and execution. The system intercepts the user's approval answer, reads the cached plan, and dispatches it programmatically to the code agent. The architect never processes the approval response. In split-process deployments (TUI running against a separate `opencode serve` process), `New session` adds one LLM turn as the panel prompts the host session's agent to invoke `plan.execute.newSession` (panel-only host dispatch — the architect is not in the loop for `New session`), and the panel awaits authoritative confirmation via the per-launch nonce-keyed outcome row before reporting success. In New session mode, that code session is the executor of an audited goal-style loop running in the project directory (`worktree:false`) under the configured `loop.defaultMaxIterations` cap, so a fresh auditor session rotates in once it goes idle, and the cycle repeats until the audit is clear. For Loop mode, the architect is instead instructed to launch the loop via the `execute-plan` tool.

### Model Selection Priority

Model and variant selection follows this priority order:

**For execution model:**
1. In-session dialog override (instance lifetime)
2. `config.executionModel`
3. Last-used (per-project workspace)
4. Platform default

**For auditor model:**
1. In-session override
2. `config.auditorModel`
3. `config.executionModel` (inherit)
4. Last-used workspace
5. Platform default

**For execution variant:**
1. In-session override
2. `config.executionVariant`
3. Last-used workspace

**For auditor variant:**
1. In-session override
2. `config.auditorVariant`
3. Last-used workspace
   *(independent — does not inherit the execution variant)*

### Troubleshooting

- **No plan found** — Ensure the architect output included the `<!-- forge-plan:start -->` / `<!-- forge-plan:end -->` markers; the capture hook only stores plans wrapped in those markers.
- **TUI shows no plan** — Plans are session-scoped on the server; switch to the session where the architect produced the plan.
- **Need logs** — Set `logging.enabled` to `true`, and optionally `logging.debug` for verbose output.

## Loop

Forge runs two loop kinds that share the same runtime/watchdog/review-store but differ in how input enters and how they terminate:

- **Plan loops** (`mode: loop`, `launch-group`) — a decomposed, section-driven implementation loop in an isolated git worktree (sandbox optional). This is the loop kind with the five persisted phases below.
- **Goal loops** (`execute-goal`, `execute-plan` `mode: 'new-session'`) — share the same runtime but differ by entry path. `/execute-goal` takes a free-text goal and runs in an isolated worktree; `execute-plan` `mode: 'new-session'` runs a structured plan as a goal-style loop directly in the project directory with no worktree and no sandbox. The structured plan is approved upstream only when launched via the architect's plan-approval flow or the TUI panel — a direct `execute-plan` tool call supplies the plan inline (or references a stored plan) with no approval check. Neither decomposes the input: Goal loops have **no plan decomposition, no sections, no final audit phase, and no post-completion action** — see [Goal Loops](_media/loop-system.md#goal-loops).

### Plan-loop lifecycle

The plan loop is an iterative development system with five persisted phases (`coding`, `auditing`, `final_auditing`, `final_audit_fix`, `post_action`), ending with an optional post-completion action:

1. **Coding phase** — A Code session works on the task
2. **Auditing phase** — The Auditor agent reviews changes against project conventions and stored review findings
3. **Session rotation** — A fresh session is created for the next iteration
4. **Repeat** — Audit findings feed back into the next coding iteration
5. **Post-completion action** — After a clean final audit, if configured, a `post_action` phase runs a skill/prompt inside the worktree before teardown (best-effort, not re-audited)

### Session Rotation

Each iteration runs in a **fresh session** to keep context small and prioritize speed. After each phase completes, the current session is destroyed and a new one is created. The original task prompt and any audit findings are re-injected into the new session as a continuation prompt, so no context is lost while keeping the window clean.

### Review Finding Persistence

Audit findings survive session rotation via the **review store**. The auditor stores each bug and warning using `review-write` with file, line, severity, and description. At the start of each audit:

- Existing findings are retrieved via `review-read`
- Resolved findings are deleted via `review-delete`
- Unresolved findings are carried forward into the review

### Usage Tracking

Loop sessions rotate between code and auditor work, so Forge persists per-session usage rows in `loop_session_usage` and merges them for `loop-status`. Detailed status includes cumulative cost, input/output/reasoning/cache token totals, per-model breakdowns, and live active-session output when available.

### Worktree Isolation

Worktree loops run in an isolated git worktree. The audited `New session` mode (`mode: new-session`) is the exception: it runs as a goal-style loop directly in the project directory with no worktree and no sandbox. Sandbox is optional for worktree loops: when Docker is available and `sandbox.mode = 'docker'` is configured, a sandbox container is provisioned automatically; otherwise the loop runs in worktree-only mode. Changes are auto-committed and the worktree is removed on completion (branch preserved for later merge).

### Auditor Integration

After each coding iteration, the auditor agent reviews changes against project conventions and stored review findings. Findings are persisted via `review-write` scoped to the current loop. Completion rules depend on the loop kind:

- **Plan loops** (`mode: loop`, `launch-group`): outstanding `severity: 'bug'` findings block completion. The loop terminates only when the auditor has run at least once and zero bug-severity findings remain; warnings may persist without blocking.
- **Goal loops** (`execute-goal`, `execute-plan` `mode: 'new-session'`): a completed auditor pass must leave **zero outstanding review findings of any severity** — both bugs and warnings block completion. See [Goal Loops](_media/loop-system.md#goal-loops).

### Stall Detection

A watchdog monitors loop activity. If no progress is detected within `stallTimeoutMs` (default: 60s), the current phase is re-triggered. After `maxConsecutiveStalls` consecutive stalls (default: 5), the loop terminates with reason `stall_timeout`. Use `loop-status` with `restart` to resume from the persisted section; restart resets the iteration budget (it starts a fresh iteration 1) rather than preserving the stalled iteration.

### Model Configuration

Loops use the following priority order for model selection:

1. **In-session dialog override** — Changed in the execution dialog (instance lifetime)
2. `config.executionModel` — Global execution model fallback
3. Last-used workspace — Previously selected model for the project
4. Platform default — OpenCode's default model

The auditor model follows a similar chain: in-session override → `config.auditorModel` → `config.executionModel` (inherit) → last-used workspace → platform default. Variants follow their own priority (see [Model Selection Priority](#model-selection-priority)).

When launching from the TUI dialog, your selection is remembered and pre-filled on subsequent launches. The dialog also allows selecting a separate model for the auditor phase.

On model errors during execution, automatic fallback to the default model kicks in.

### Safety

- `git push` is denied inside active loop sessions
- Tools like `question` and `execute-plan` are blocked to prevent recursive loops and keep execution autonomous

### Management

- **Slash commands**: `/execute-plan` to start, `/loop-cancel` to cancel
- **Tools**: `execute-plan` to start with parameters, `loop-status` for checking progress (with restart capability), `loop-cancel` to cancel

### Loop termination

The loop terminates when any of these conditions is met:

- **Max iterations** — The global `maxIterations` cap is exceeded (0 = unlimited).
- **Stall timeout** — After `maxConsecutiveStalls` consecutive stalls (default: 5). Use `loop-status` with `restart` to resume from the persisted section; restart resets the iteration budget (it starts a fresh iteration 1) rather than preserving the stalled iteration.
- **Clean audit (goal loops)** — For `execute-goal` and `execute-plan` `mode: 'new-session'`, a completed auditor pass that leaves **zero outstanding review findings of any severity** terminates the loop immediately. Goal loops have no final audit phase and no post-completion action.
- **Final audit completion (plan loops)** — For `mode: loop` / `launch-group`, when no bug-severity review findings remain after the final audit phase. If `loop.postAction.enabled` is `true`, the loop enters the `post_action` phase before final termination.
- **Post-action completion (plan loops)** — After a clean final audit and a successful post-completion action phase (if configured).
- **Consecutive errors** — 3 consecutive errors in either phase.

Worktree loops run in an isolated git worktree. Sandbox is optional for worktree loops: when Docker is available and `sandbox.mode = 'docker'` is configured, a sandbox container is provisioned automatically; otherwise the loop runs in worktree-only mode.

## Workspace Integration

Forge worktree loops register as **OpenCode workspaces**, letting you switch between them (and your main project) from the same TUI session without restarting or re-opening anything.

### Requirements

Workspace integration requires the **experimental workspace runtime** enabled in OpenCode. See [Quick Start](#quick-start) for the environment variable setup. No forge config option enables or disables this — the toggle is purely on the OpenCode side and must be present before OpenCode starts.

> The `OPENCODE_EXPERIMENTAL_WORKSPACES` flag is not currently documented on opencode.ai. The authoritative source is `packages/core/src/flag/flag.ts` and `packages/opencode/src/effect/runtime-flags.ts` in the OpenCode repo.

### When workspace integration is active

- **Env var set, OpenCode ≥ 1.17.8** → Forge can create the worktree workspace, bind loop sessions to it, and show the loop as a switchable workspace in the TUI.
- **Env var unset or older OpenCode** → `experimental.workspace.create` is unavailable or no-ops, Forge cannot create the loop worktree, and the worktree-bound modes (`mode: loop` of `execute-plan` / `/execute-plan`, plus `execute-goal`) fail before iteration starts. The audited `mode: new-session` path is unaffected — it runs in the project directory without a workspace.

### What it does

When a worktree loop starts with `OPENCODE_EXPERIMENTAL_WORKSPACES=true`, forge:

1. Calls `experimental.workspace.create` with `type: "forge"`, `branch: null`, and `extra: { loopName, projectDirectory, workspaceCreatedAt }` to register the workspace through the `forge` adapter
2. The adapter's `create` hook creates the git worktree (reusing an orphaned branch when possible) and, when configured, provisions the Docker sandbox container
3. Creates a new Code session pointed at the worktree directory
4. Calls `experimental.workspace.warp` to bind the session to that workspace
5. Persists the workspace ID on the loop record (`loops.workspace_id`) so the TUI can route clicks on a loop into the correct workspace

The adapter's `remove` hook commits in-flight changes (when teardown context allows), stops the sandbox container if any, and removes the worktree directory unless the loop is restartable. Branches are preserved for later restart or merge.

### Failure behavior

If initial workspace creation fails at startup — env var unset, OpenCode version too old, network error, API mismatch — the loop aborts before creating the first loop session. If a workspace disappears after a loop is already running, Forge attempts to re-provision or detach it and continue where possible.

### From the TUI

- Loops are launched via the execution dialog (select Loop mode)
- On hosts with workspace support, active loops appear as switchable workspaces alongside your main project

## Common Issues

### `execute-plan` / `/execute-plan` fails to start

**Most common cause:** `OPENCODE_EXPERIMENTAL_WORKSPACES=true` was not set in the environment that launched OpenCode. See [Quick Start](#quick-start) for setup.

Symptoms include:

- `execute-plan` or `/execute-plan` returns an internal error before the first coding session starts
- Forge logs contain `createBuiltinWorktreeWorkspace: workspace.create threw`, `workspace.create returned no workspace id`, or `handleStartLoop: failed to create builtin worktree workspace`
- No loop worktree appears in the TUI workspace switcher

The flag must be set before OpenCode starts — setting it inside an already-running session is too late. If OpenCode is launched by a desktop app, service manager, shell alias, terminal profile, or wrapper script, set the variable there and fully restart OpenCode.

### Workspace prerequisites

Worktree loops require a git repository with at least one commit. OpenCode scopes its instance to project `global` when started in a directory without a root commit, and worktree loop sessions created against a `global` project are invisible to the TUI. If you see a "No git commit in this project" error, create an initial commit and restart OpenCode.

## Docker Sandbox

Run loop iterations inside an isolated Docker container. Sandbox is optional: when Docker is available and configured, Forge provisions a loop container automatically; otherwise loops run in worktree-only mode.

See [Sandbox](_media/sandbox.md) for setup, Docker-in-Docker behavior, host networking, environment passthrough, custom bind mounts, large-output handling, and resource defaults.

### Prerequisites

- Docker running on your machine
- OpenCode >= 1.15.5 — sandbox shell routing relies on the session-aware `shell.env` plugin hook. Enforced via `engines.opencode`, so older versions refuse to load the plugin rather than silently running sandbox commands on the host. (Loops additionally require OpenCode >= 1.17.8 for workspace integration, see [Requirements](#requirements).)

### Setup

**1. Build the sandbox image:**

```bash
docker build -t oc-forge-sandbox:latest container/
```

The image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, and jq.

The `container/Dockerfile` ships with the plugin package. If the image is missing when OpenCode starts, Forge shows a warning toast with a "Build sandbox image" command in the palette. You can also trigger the build from the command palette at any time by searching for `Build sandbox image`, which opens a confirmation dialog and runs `docker build` automatically.

Restart OpenCode after changing sandbox configuration.

## Development

```bash
pnpm build      # Compile TypeScript to dist/
pnpm test       # Run tests
pnpm typecheck  # Type check without emitting
```

## Loop Flow

The diagram below shows the overall flow of the Forge loop system — from plan capture through iterative coding/auditing phases with section advancement and session rotation.

![Loop Flow](_media/loop-flow.webp)

## License

MIT
