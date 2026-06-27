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

Without this, Forge cannot create loop worktrees and `loop` / `/loop` will fail. See [Common Issues](#common-issues) and [Workspace Integration](#workspace-integration) for details.

## What Forge Adds

Forge ships two user-facing surfaces:

- **Server plugin** — enabled through OpenCode plugin config in `opencode.json`. The package declares the `server` oc-plugin surface and exports `./server` for the server entrypoint.
- **TUI plugin** — enabled separately in `tui.json`. The package declares the `tui` oc-plugin surface and exports `./tui` for the terminal UI entrypoint.

The server plugin provides the core hooks, tools, agents, plan storage, loop orchestration, review persistence, and sandbox support. The TUI plugin layers on the sidebar and execution dialog.

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
- **Execution** — `New session`, `Execute here`, and `Loop` launch paths for approved plans
- **Loops** — iterative coding/auditing with isolated git worktree and optional Docker sandbox
- **Review Findings** — persistent, loop-scoped review findings across loop sessions
- **TUI** — sidebar and execution dialog
- **Sandbox** — Optional Docker worktree loop isolation with bind-mounted project files

## Agents

The plugin bundles three user-facing agents plus a hidden `auditor-loop` variant used by loop audit sessions:

| Agent | Mode | Description |
|-------|------|-------------|
| **code** | all | Primary coding agent. |
| **architect** | primary | Read-only planning agent. Researches the codebase, designs implementation plans, and caches them for user approval before execution. |
| **auditor** | subagent | Read-only code auditor for convention-aware reviews. Invoked via Task tool to review diffs, commits, branches, or PRs against stored conventions and decisions. |
| **auditor-loop** | primary, hidden | Internal audit agent used for loop-runner audit sessions. |

The auditor agent is a read-only subagent that cannot edit source files or execute plans. It is invoked by other agents via the Task tool to review code changes against stored project conventions and decisions.

**Tool restrictions:** The auditor cannot use file-editing tools, planning tools, or loop-management tools. See [Auditor restrictions](../agents-and-commands.md#auditor-restrictions).

The architect agent operates as a read-only planner with message-level reinforcement via the `experimental.chat.messages.transform` hook. Final plans are rendered once in the assistant response between `<!-- forge-plan:start -->` and `<!-- forge-plan:end -->` markers, then auto-captured into SQL before execution approval. After user approval via the question tool, execution is dispatched programmatically — no additional LLM calls are needed. The user can view and edit the cached plan from the sidebar or command palette before or during execution. 

## Tools

See [Tools reference](../tools.md) for full arguments, section-scoping behavior, restart options, and sandbox shell details.

### Plan Tools

Session-scoped plan storage backed by SQL for managing implementation plans. Loop-associated plans are pruned with expired completed loops.

| Tool | Description |
|------|-------------|
| `plan-read` | Retrieve the plan. Supports pagination with offset/limit and pattern search. |
| `section-read` | Read a section plan and its status for the active loop session. Supports reading by index or defaulting to the lowest-index incomplete section. |

### Review Tools

Review finding storage for persisting audit results across session rotations.

| Tool | Description |
|------|-------------|
| `review-write` | Store a review finding with file, line, severity, and description. Findings are scoped to the current loop. |
| `review-read` | Retrieve review findings. Filter by file path or search by regex pattern. |
| `review-delete` | Delete a review finding by file and line. |

### Loop Tools

Iterative development loops with automatic auditing. Loops always run in an isolated git worktree; Docker sandbox is used automatically when available.

| Tool | Description |
|------|-------------|
| `loop` | Execute a plan using an iterative development loop in an isolated git worktree. Args: `title` required; `plan`, `loopName`, and `hostSessionId` optional. |
| `loop-cancel` | Cancel an active loop by worktree name |
| `loop-status` | List active/recent loops or get detailed status by worktree name, including cumulative token usage when available. Supports `restart=true` to restart any non-completed loop (`running`, `cancelled`, `errored`, `stalled`). Completed loops are history-only and cannot be restarted. |

`loop` reads the current session's captured plan when `plan` is omitted. `maxIterations`, execution model, auditor model, and sandbox behavior come from configuration or the TUI execution dialog, not direct `loop` tool arguments.

## Slash Commands

| Command | Description | Agent |
|---------|-------------|-------|
| `/review` | Run a code review on current changes | auditor (subtask) |
| `/review-plan` | Review a completed implementation against its original plan | auditor (subtask) |
| `/loop` | Start an iterative development loop in a worktree | code |
| `/loop-status` | Check status of all active loops | code |
| `/loop-cancel` | Cancel the active loop | code |

## Configuration

On first run, the plugin automatically copies the bundled config to your config directory:
- If `XDG_CONFIG_HOME` is set: `$XDG_CONFIG_HOME/opencode/forge-config.jsonc`
- Otherwise: `~/.config/opencode/forge-config.jsonc`

**Note:** Configuration is stored at `~/.config/opencode/forge-config.jsonc` unless `XDG_CONFIG_HOME` is set.

The plugin supports JSONC format, allowing comments with `//` and `/* */`.

You can edit this file to customize settings. The file is created only if it doesn't already exist.

See [Configuration reference](../configuration.md) for all supported options, including loop post-actions, external read directories, TUI keybinds, dashboard, and sandbox resource defaults.

### Where Forge stores data

- Config: `~/.config/opencode/forge-config.jsonc` or `$XDG_CONFIG_HOME/opencode/forge-config.jsonc`
- Data dir: `~/.local/share/opencode/forge` or `$XDG_DATA_HOME/opencode/forge`
- Logs: `~/.local/share/opencode/forge/logs/forge.log`
- Log rotation: 10MB
- Prompts: `~/.config/opencode/forge/prompts` or `$XDG_CONFIG_HOME/opencode/forge/prompts`

### Customizing prompts

Agent and command prompts are bundled as editable markdown under `src/prompts/` and installed to `~/.config/opencode/forge/prompts/` on first run. Edit any file there to customize an agent (`agents/*.md`) or slash command (`commands/*.md`); your edits take precedence over the bundled defaults and are preserved across upgrades. Bundled prompt fixes are re-applied automatically only to files you have not edited (tracked by content hash); delete a file to restore the bundled version on next start.

Enable `logging.enabled` to write logs to disk. To use the default log path, omit `logging.file` or set it to `null` (an empty string is not treated as a default). Set `logging.debug` for more verbose output.

```jsonc
{
  // Data directory for plugin storage (SQL stores, logs)
  // When empty, resolves to ~/.local/share/opencode/forge (or XDG_DATA_HOME equivalent)
  "dataDir": "",

  // Logging configuration
  "logging": {
    "enabled": false,                // Enable file logging
    "debug": false,                 // Enable debug-level output
    "file": ""                      // Log file path (omit or set to null for default path)
  },

  // Session compaction settings
  "compaction": {
    "customPrompt": true,           // Use custom compaction prompt for continuity
    "maxContextTokens": 0           // Max tokens for context (0 = unlimited)
  },

  // Messages transform hook for read-only enforcement
  "messagesTransform": {
    "enabled": true,               // Enable transform hook
    "debug": false                 // Enable debug logging
  },

  // Model override for plan execution sessions (format: "provider/model")
  "executionModel": "",

  // Model override for the auditor agent (format: "provider/model")
  "auditorModel": "",

  // Iterative development loop settings
  "loop": {
    "enabled": true,               // Enable iterative loops
    "defaultMaxIterations": 15,    // Max iterations (0 = unlimited)
    "cleanupWorktree": false,      // Auto-remove worktree on cancel
    "stallTimeoutMs": 60000,       // Stall detection timeout (60s)
    "maxConsecutiveStalls": 5,     // Consecutive stalls before termination (0 = disabled)
    "worktreeLogging": {           // Worktree loop completion logging
      "enabled": false,            // Enable completion logging
      "directory": ""              // Log directory (defaults to platform data dir)
    }
  },

  // Sandbox configuration (optional; provisioned automatically when available)
  // Set "enabled": false to force worktree-only mode even when Docker is available.
  "sandbox": {
    "enabled": true,
    "mode": "docker",
    "image": "oc-forge-sandbox:latest"
  },

  // TUI sidebar widget configuration
  "tui": {
    "sidebar": true,               // Show Forge sidebar in OpenCode TUI
    "showVersion": true            // Show plugin version in sidebar title
  },

  // TTL in ms for completed/cancelled loops before cleanup. Default: 604800000 (7 days)
  "completedLoopTtlMs": 604800000,

  // Per-agent overrides (temperature range: 0.0 - 2.0)
  // Keys are agent display names (e.g., "code", "architect", "auditor")
  // "agents": {
  //   "architect": { "temperature": 0.0 },
  //   "auditor": { "temperature": 0.0 },
  //   "code": { "temperature": 0.7 }
  // }
}
```

### Options

#### Top-level
- `dataDir` - Data directory for plugin storage (SQL stores, logs). When empty, resolves to `~/.local/share/opencode/forge` (or `XDG_DATA_HOME` equivalent) (default: `""`)
- `completedLoopTtlMs` - TTL for completed/cancelled/errored/stalled loops before sweep (default: `604800000` / 7 days).
- `executionModel` - Model override for plan execution sessions, format: `provider/model` (e.g. `anthropic/claude-sonnet-4-20250514`). When set, plan execution (via the architect's approval flow or the TUI Execute panel) uses this model for the new Code session. When empty or omitted, OpenCode's default model is used (typically the `model` field from `opencode.json`). **Recommended:** Set this to a fast, cheap model (e.g. Haiku or MiniMax) and use a smart model (e.g. Opus) for the Architect session — planning needs reasoning, execution needs speed. This value is used as a fallback when no per-launch selection is made.
- `auditorModel` - Model override for the auditor agent (`provider/model`). When set, overrides the auditor agent's default model. When not set, uses platform default (default: `""`). This value is used as a fallback when no per-launch selection is made.
- `agents` - Per-agent temperature overrides keyed by display name (e.g., `"code"`, `"architect"`, `"auditor"`). Temperature range: `0.0` - `2.0` (default: `undefined`)

#### Logging
- `logging.enabled` - Enable file logging (default: `false`)
- `logging.debug` - Enable debug-level log output (default: `false`)
- `logging.file` - Log file path. Omitted or `null` falls back to `~/.local/share/opencode/forge/logs/forge.log` (default: `""`). Setting to an empty string `""` passes the empty string through and logging will fail silently. Logs remain in the data directory, only config has moved.

When enabled, logs are written to the specified file with timestamps. The log file has a 10MB size limit with automatic rotation.

#### Compaction
- `compaction.customPrompt` - Use a custom compaction prompt optimized for session continuity (default: `true`)
- `compaction.maxContextTokens` - Maximum tokens for context during compaction (default: `0` / unlimited)

#### Messages Transform
- `messagesTransform.enabled` - Enable the messages transform hook for Architect read-only enforcement (default: `true`)
- `messagesTransform.debug` - Enable debug logging for messages transform (default: `false`)

#### Loop
- `loop.enabled` - Enable iterative development loops (default: `true`)
- `loop.defaultMaxIterations` - Default max iterations for loops, 0 = unlimited (default: `15`)
- `loop.cleanupWorktree` - Auto-remove worktree on cancel (default: `false`)
- `loop.stallTimeoutMs` - Watchdog stall detection timeout in milliseconds (default: `60000`)
- `loop.maxConsecutiveStalls` - Number of consecutive stalls before the loop terminates with reason `stall_timeout`. Set to `0` to disable stall-based termination (default: `5`).
- `loop.worktreeLogging.enabled` - Enable worktree loop completion logging (default: `false`)
- `loop.worktreeLogging.directory` - Directory for completion logs, defaults to platform data dir (default: `""`)

#### Sandbox
- `sandbox.enabled` - Enable sandboxed execution. When `false`, loops run in worktree-only mode even if Docker is available (default: `true`)
- `sandbox.mode` - Sandbox mode: `"docker"` (optional; Docker sandbox is provisioned automatically when available)
- `sandbox.image` - Docker image for sandbox containers (default: `"oc-forge-sandbox:latest"`)
- `sandbox.resources` - Container resource limits mapped directly to `docker run` flags:
  - `memory` - Memory limit, e.g., `'8g'`. Maps to `--memory`.
  - `memorySwap` - Optional memory+swap limit, e.g., `'12g'`. Maps to `--memory-swap`; no default is applied.
  - `cpus` - Number of CPUs, e.g., `'4'`, `'2.5'`. Maps to `--cpus`.
  - `shmSize` - Shared memory size, e.g., `'1g'`. Maps to `--shm-size`.

#### TUI
- `tui.sidebar` - Show the forge sidebar widget in OpenCode TUI (default: `true`)
- `tui.showVersion` - Show plugin version number in the sidebar title (default: `true`)
- `tui.keybinds.executePlan` - Open the execution dialog for the current session's plan. Default: `<leader>f` ("Forge"). Avoid `<leader>e` — that conflicts with opencode's built-in `editor_open` and your binding will be shadowed.

#### Dashboard


## TUI Plugin

The plugin includes a TUI sidebar widget and an execution dialog for launching plans directly in the OpenCode terminal interface.

### Sidebar

The sidebar shows Forge's connection status and version. Captured plans live on the server in the `plansRepo` SQL store; the TUI no longer keeps a local archive or in-TUI editor.

### Execution Dialog

Open the dialog from the command palette as `Execute plan` (default keybind `<leader>f`). The plan is sourced from the most recent architect message in the current session — the marked `<!-- forge-plan:start --> ... <!-- forge-plan:end -->` block is parsed out of the assistant's reply. If no marked plan exists in the session, the dialog will not open and you'll see a toast asking the architect to produce one first.

The dialog provides full control over execution parameters:

#### Execution Mode Selection

Choose from three execution modes:

1. **New session** — Creates a fresh Code session and sends the plan as the initial prompt
2. **Execute here** — Takes over the current session immediately with the plan
3. **Loop** — Prompts the architect to launch an iterative coding/auditing loop via the `loop` tool in an isolated git worktree (Docker sandbox used automatically when available)

#### Model Selection

Two model selectors are available:

**Execution Model:**
- Opens a full model selection dialog with all available providers
- Shows recently used models for quick access (derived from your OpenCode sessions, recent Forge loops, OpenCode favorites, and the global default)
- Displays model capabilities (reasoning, tools support) in descriptions
- Defaults to the most recent Forge loop's selection, falling back to `config.executionModel`

**Auditor Model:**
- Same model selection interface
- Defaults to the most recent Forge loop's auditor selection, falling back to `config.auditorModel` → `config.executionModel`

#### Persistence

Selections live on the **OpenCode server**, not in a TUI-local cache. Every loop execution stamps the chosen execution + auditor model (and variants) into `workspace.create.extra.forgeLoop`, and the next time the dialog opens it derives defaults and recents from `workspace.list()` plus the session list. This means the picker is correct even when the TUI runs on a different host than the OpenCode server.

The dialog tracks only loop-mode executions for recents / last-used defaults; `New session` and `Execute here` modes do not create a workspace, so they do not contribute to recents.

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
- Recently used models are derived from server-side data each time the dialog opens, so they reflect the latest state across all hosts the user has used.

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

- **New session** — Creates a new Code session and sends the plan as the initial prompt.
- **Execute here** — The code agent takes over the current session immediately with the plan.
- **Loop** — The architect is prompted to launch an iterative coding/auditing loop via the `loop` tool, which creates an isolated git worktree and provisions a Docker sandbox when available.

| Mode | When to choose it |
|------|-------------------|
| `New session` | Default for normal implementation |
| `Execute here` | When preserving current context matters |
| `Loop` | Safer autonomous iteration |

The dialog also lets you pick the execution model and auditor model at launch time. Those selections are remembered per project and pre-filled on later launches. Optional **variant selectors** accompany each model selector, letting you choose provider-specific reasoning or thinking-effort levels (e.g., `low`, `high`, `max`) when the model exposes them. Variant selections are also persisted per project.

For New session and Execute here, execution is immediate — there are no additional LLM calls between approval and execution. The system intercepts the user's approval answer, reads the cached plan, and dispatches it programmatically to the code agent. The architect never processes the approval response. For Loop mode, the architect is instead instructed to launch the loop via the `loop` tool.

### Model Selection Priority

Model selection follows this priority order:

**For execution model:**
1. Dialog selection (last-used, persisted per-project)
2. `config.executionModel`
3. Platform default

**For auditor model:**
1. Dialog selection (last-used, persisted per-project)
2. `config.auditorModel`
3. `config.executionModel`
4. Platform default

### Troubleshooting

- **No plan found** — Ensure the architect output included the `<!-- forge-plan:start -->` / `<!-- forge-plan:end -->` markers; the capture hook only stores plans wrapped in those markers.
- **TUI shows no plan** — Plans are session-scoped on the server; switch to the session where the architect produced the plan.
- **Need logs** — Set `logging.enabled` to `true`, and optionally `logging.debug` for verbose output.

## Loop

The loop is an iterative development system with four phases, ending with an optional post-completion action:

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

Loops always run in an isolated git worktree. Sandbox is optional: when Docker is available and `sandbox.mode = 'docker'` is configured, a sandbox container is provisioned automatically; otherwise the loop runs in worktree-only mode. Changes are auto-committed and the worktree is removed on completion (branch preserved for later merge).

### Auditor Integration

After each coding iteration, the auditor agent reviews changes against project conventions and stored review findings. Findings are persisted via `review-write` scoped to the current loop. Outstanding `severity: 'bug'` findings block completion — the loop terminates only when the auditor has run at least once and zero bug-severity findings remain.

### Stall Detection

A watchdog monitors loop activity. If no progress is detected within `stallTimeoutMs` (default: 60s), the current phase is re-triggered. After `maxConsecutiveStalls` consecutive stalls (default: 5), the loop terminates with reason `stall_timeout`. Use `loop-status` with `restart` to resume from the persisted section/iteration.

### Model Configuration

Loops use the following priority order for model selection:

1. **Dialog selection** — Model chosen in the execution dialog (persisted per-project)
2. `executionModel` — Global execution model fallback
3. Platform default — OpenCode's default model

The auditor model follows a similar chain: dialog selection → `auditorModel` → `executionModel` → platform default.

When launching from the TUI dialog, your selection is remembered and pre-filled on subsequent launches. The dialog also allows selecting a separate model for the auditor phase.

On model errors during execution, automatic fallback to the default model kicks in.

### Safety

- `git push` is denied inside active loop sessions
- Tools like `question` and `loop` are blocked to prevent recursive loops and keep execution autonomous

### Management

- **Slash commands**: `/loop` to start, `/loop-cancel` to cancel
- **Tools**: `loop` to start with parameters, `loop-status` for checking progress (with restart capability), `loop-cancel` to cancel

### Loop termination

The loop terminates when any of these conditions is met:

- **Max iterations** — The global `maxIterations` cap is exceeded (0 = unlimited).
- **Stall timeout** — After `maxConsecutiveStalls` consecutive stalls (default: 5). Use `loop-status` with `restart` to resume from the persisted section and iteration.
- **Final audit completion** — When no bug-severity review findings remain after the final audit phase. If `loop.postAction.enabled` is `true`, the loop enters the `post_action` phase before final termination.
- **Post-action completion** — After a clean final audit and a successful post-completion action phase (if configured).
- **Consecutive errors** — 3 consecutive errors in either phase.

Loops always run in an isolated git worktree. Sandbox is optional: when Docker is available and `sandbox.mode = 'docker'` is configured, a sandbox container is provisioned automatically; otherwise the loop runs in worktree-only mode.

## Workspace Integration

Forge worktree loops register as **OpenCode workspaces**, letting you switch between them (and your main project) from the same TUI session without restarting or re-opening anything.

### Requirements

Workspace integration requires the **experimental workspace runtime** enabled in OpenCode. See [Quick Start](#quick-start) for the environment variable setup. No forge config option enables or disables this — the toggle is purely on the OpenCode side and must be present before OpenCode starts.

> The `OPENCODE_EXPERIMENTAL_WORKSPACES` flag is not currently documented on opencode.ai. The authoritative source is `packages/core/src/flag/flag.ts` and `packages/opencode/src/effect/runtime-flags.ts` in the OpenCode repo.

### When workspace integration is active

- **Env var set, OpenCode ≥ 1.17.8** → Forge can create the worktree workspace, bind loop sessions to it, and show the loop as a switchable workspace in the TUI.
- **Env var unset or older OpenCode** → `experimental.workspace.create` is unavailable or no-ops, Forge cannot create the loop worktree, and `loop` / `/loop` fails before iteration starts.

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

### `loop` / `/loop` fails to start

**Most common cause:** `OPENCODE_EXPERIMENTAL_WORKSPACES=true` was not set in the environment that launched OpenCode. See [Quick Start](#quick-start) for setup.

Symptoms include:

- `loop` or `/loop` returns an internal error before the first coding session starts
- Forge logs contain `createBuiltinWorktreeWorkspace: workspace.create threw`, `workspace.create returned no workspace id`, or `handleStartLoop: failed to create builtin worktree workspace`
- No loop worktree appears in the TUI workspace switcher

The flag must be set before OpenCode starts — setting it inside an already-running session is too late. If OpenCode is launched by a desktop app, service manager, shell alias, terminal profile, or wrapper script, set the variable there and fully restart OpenCode.

## Docker Sandbox

See [Sandbox](../sandbox.md) for setup, Docker-in-Docker behavior, host networking, environment passthrough, custom bind mounts, large-output handling, and resource defaults.

Run loop iterations inside an isolated Docker container. Three tools (`bash`, `glob`, `grep`) execute inside the container via `docker exec`, while `read`/`write`/`edit` operate on the host filesystem. The worktree directory is bind-mounted at `/workspace` for instant file sharing, and the source project directory is mounted read-only at `/project` for convenient host-side access.

### Prerequisites

- Docker running on your machine

### Setup

**1. Build the sandbox image:**

```bash
docker build -t oc-forge-sandbox:latest container/
```

The image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, and jq.

The `container/Dockerfile` ships with the plugin package. If the image is missing when OpenCode starts, Forge shows a warning toast with a "Build sandbox image" command in the palette. You can also trigger the build from the command palette at any time by searching for `Build sandbox image`, which opens a confirmation dialog and runs `docker build` automatically.

**2. Configure the sandbox** (`~/.config/opencode/forge-config.jsonc`):

```jsonc
{
  "sandbox": {
    "mode": "docker",
    "image": "oc-forge-sandbox:latest"
  }
}
```

**3. Restart OpenCode.**

### Usage

Start a sandbox loop by selecting "Loop" in the execution dialog (the architect launches it via the `loop` tool) or by invoking the `loop` tool directly:

```
loop
```

Sandbox is optional. When Docker is available and configured, a sandbox container is provisioned automatically; otherwise the loop runs in worktree-only mode. The loop:
1. Creates a git worktree
2. Starts a Docker container with the worktree directory bind-mounted at `/workspace`
3. Redirects `bash`, `glob`, and `grep` tool calls into the container
4. Cleans up the container on loop completion or cancellation

### How It Works

- **Bind mount** -- the worktree directory is mounted directly into the container at `/workspace`. No sync daemon, no file copying. Changes are visible instantly on both sides.
- **Tool redirection** -- `bash`, `glob`, and `grep` route through `docker exec` when a session belongs to a sandbox loop. The `read`/`write`/`edit` tools operate on the host filesystem directly (compatible with host LSP).
- **Git in the container** -- the image includes `git` for tooling and install workflows (e.g. fetching dependencies). Loop-managed git operations (commit, push, branch management) are handled by the loop system on the host.
- **Host LSP** -- since files are shared via the bind mount, OpenCode's LSP servers on the host read the same files and provide diagnostics after writes and edits.
- **Container lifecycle** -- one container per loop, automatically started and stopped. Container name format: `forge-<worktreeName>`.

### Reaching Host Services

The sandbox container can reach services running on the host via `host.docker.internal:<port>`. This is enabled by default and useful for connecting to local databases, API servers, or other development services. Disable it by setting `network.hostGateway` to `false`.

**Environment passthrough** allows select host environment variables into the container. Specify variable names in `network.env`:

```jsonc
{
  "sandbox": {
    "network": {
      "env": ["DATABASE_URL", "API_KEY"]
    }
  }
}
```

Values are written to a temporary `--env-file` on container start; they are not persisted to disk.

The source project is mounted read-only at `/project`, so project env files remain available there for commands that explicitly read them.

**Security note:** environment passthrough exposes host secrets to the container. Only sandbox-trusted variables should be passed through. Each feature is independently controlled:

- `network.hostGateway: false` — disables `host.docker.internal` gateway access
- `network.env: []` — disables environment variable passthrough

Removing the `network` key does **not** disable all host-network features; the `hostGateway` default remains active.

### Read-Only Project Mount

By default, the source project directory (not the worktree) is mounted read-only at `/project` inside the container. This gives you access to the original project files — useful for reference, config templates, or node_modules — without the risk of accidental edits to the source.

- **Mount path:** configurable via `projectMountPath` (default: `"/project"`)
- **Disable:** set `mountProjectReadonly` to `false`
- **Searchable:** the mounted project is accessible to `glob` and `grep` (project-scoped) and readable via `sh`
- **Not editable:** `write`/`edit` still target the host filesystem; changes to the project mount are not written back

The worktree at `/workspace` remains writable for all sandbox operations.

### Custom Bind Mounts

Mount additional host directories into the sandbox via `sandbox.mounts`. Each entry requires absolute `host` and `container` paths; `readonly` defaults to `true` (read-only). Set `"readonly": false` to grant read-write access:

```jsonc
"mounts": [
  { "host": "/abs/host/reference", "container": "/reference" },
  { "host": "/abs/host/cache", "container": "/cache", "readonly": false }
]
```

- **Validation:** entries are skipped (with a log message) when the host path does not exist, the container path is not absolute, or the container path collides with a reserved mount (`/workspace`, the `/project` mount, detected git metadata, or an earlier custom mount).
- **Read-only by default:** mounts are mounted read-only unless you set `"readonly": false`, mirroring the read-only `/project` mount and keeping the worktree-isolation guarantee intact.

**Security note:** read-write custom mounts (`"readonly": false`) expose arbitrary host directories to the container with the same trust boundary as environment passthrough. Only grant write access to directories you trust the sandbox to modify.

### Docker-in-Docker

Every sandbox container runs **Docker-in-Docker** by default: a nested, isolated Docker daemon boots inside the container so loops can build and run containers (e.g. end-to-end tests, `docker compose` suites) without touching the host's Docker daemon. Each loop gets its own daemon and image/container storage, so concurrent loops cannot see each other's containers or images, and everything is torn down with the sandbox.

Because a nested daemon requires root, the container itself is launched `--privileged --init` and the daemon runs as root. The privileges are confined to the Docker host's VM/daemon, not the host OS directly. The agent's own shell commands, however, run as your **host UID:GID** (`docker exec --user`), so files written to the bind-mounted worktree are owned by you, not `root` — on both Docker Desktop and native Linux hosts. To let that non-root user reach the nested daemon, `dockerd` is started with its socket group set to your host GID (`--group`), so no socket permission relaxation is needed.

The sandbox image bundles the Docker engine, buildx, and the Compose plugin. Inside a loop, the standard `docker` and `docker compose` commands work against the nested daemon, and bind mounts that reference `/workspace` resolve correctly (the daemon shares the container's filesystem).

### Large Command Output

When a `sh` command produces output exceeding the tool's limit, the overflow is written to `<worktree>/.forge/tmp/` (inside the worktree, not the container). These spill files can be read with the `read` tool or searched with `grep`. The `.forge/` directory is automatically added to `git exclude` after worktree creation so spill files are never committed.

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `sandbox.enabled` | `true` | Enable sandboxed execution. Set to `false` to force worktree-only mode even when Docker is available. |
| `sandbox.mode` | `"docker"` | Sandbox mode (optional; Docker used when available) |
| `sandbox.image` | `"oc-forge-sandbox:latest"` | Docker image to use for sandbox containers |
| `sandbox.resources.memory` | `"8g"` | Memory limit for the container. Maps to `--memory`. |
| `sandbox.resources.memorySwap` | unset | Optional memory+swap limit. Maps to `--memory-swap`. |
| `sandbox.resources.cpus` | `"4"` | CPU count. Maps to `--cpus`. |
| `sandbox.resources.shmSize` | `"1g"` | Shared memory size. Maps to `--shm-size`. |
| `sandbox.mountProjectReadonly` | `true` | Mount the source project directory read-only at `projectMountPath`. |
| `sandbox.projectMountPath` | `"/project"` | Container path for the read-only project mount. |
| `sandbox.mounts` | `[]` | Additional host directories to bind-mount into the container (see [Custom Bind Mounts](#custom-bind-mounts)). |
| `sandbox.network.hostGateway` | `true` | Enable `host.docker.internal` gateway for reaching host services. |
| `sandbox.network.env` | `[]` | Host environment variable names to pass through via temp `--env-file`. |

### Customizing the Image

The `container/Dockerfile` is included in the plugin package. To add project-specific tools (e.g., Go, Rust, additional language servers), edit the Dockerfile and rebuild:

```bash
docker build -t oc-forge-sandbox:latest container/
```

You can also rebuild from the command palette using `Build sandbox image`. This picks up any local changes to the bundled Dockerfile automatically.

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
