<h1 align="center">OpenCode Forge</h1>

<p align="center">
  <strong>Loops, plans, sandboxing, and graph tooling for <a href="https://opencode.ai">OpenCode</a> AI agents</strong>
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

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-forge"]
}
```

## Features

- **Graph Indexing** - Code structure graph with file watching, auto-scanning, and symbol tracking
- **Iterative Development Loops** - Autonomous coding/auditing loop with optional worktree isolation, session rotation, stall detection, and review finding persistence
- **Session Plan Storage** - Session-scoped plan storage with 7-day TTL for managing implementation plans
- **Review Finding Persistence** - Store and retrieve audit findings across session rotations
- **Bundled Agents** - Ships with Code, Architect, Auditor and Librarian agents preconfigured for graph-aware workflows
- **CLI Tools** - Loop status, cancel, restart, graph status, graph scan, and upgrade commands via `opencode-forge`
- **Docker Sandbox** - Run loops inside isolated Docker containers with bind-mounted project directory, automatic container lifecycle, and selective tool routing (bash, glob, grep)

## Agents

The plugin bundles four agents that integrate with the graph system:

| Agent | Mode | Description |
|-------|------|-------------|
| **code** | primary | Primary coding agent with graph awareness. Checks the code graph before unfamiliar code, stores architectural decisions and conventions as it works. |
| **architect** | primary | Read-only planning agent. Researches the codebase, designs implementation plans, then hands off to code via `plan-execute`. |
| **auditor** | subagent | Read-only code auditor with access to project graph for convention-aware reviews. Invoked via Task tool to review diffs, commits, branches, or PRs against stored conventions and decisions. |

The auditor agent is a read-only subagent (`temperature: 0.0`) that can read the graph but cannot write, edit, or delete graph entries or execute plans. It is invoked by other agents via the Task tool to review code changes against stored project conventions and decisions.

The architect agent operates in read-only mode (`temperature: 0.0`, all edits denied) with message-level enforcement via the `experimental.chat.messages.transform` hook. Plans are built incrementally in the KV store during the planning session. After approval, execution is dispatched programmatically — no additional LLM calls are needed. The user can view and edit the cached plan from the sidebar or command palette before or during execution. 


## Tools

### Plan Tools

Session-scoped plan storage with 7-day TTL for managing implementation plans.

| Tool | Description |
|------|-------------|
| `plan-write` | Store the entire plan content. Auto-resolves key to `plan:{sessionID}`. |
| `plan-edit` | Edit the plan by finding `old_string` and replacing with `new_string`. |
| `plan-read` | Retrieve the plan. Supports pagination with offset/limit and pattern search. |
| `plan-execute` | Create a new Code session and send an approved plan as the first prompt |

### Review Tools

Review finding storage for persisting audit results across session rotations.

| Tool | Description |
|------|-------------|
| `review-write` | Store a review finding with file, line, severity, and description. Auto-injects branch field. |
| `review-read` | Retrieve review findings. Filter by file path or search by regex pattern. |
| `review-delete` | Delete a review finding by file and line. |

### Loop Tools

Iterative development loops with automatic auditing. Defaults to current directory execution; set `worktree: true` for isolated git worktree.

| Tool | Description |
|------|-------------|
| `loop` | Execute a plan using an iterative development loop. Default runs in current directory. Set `worktree` to true for isolated git worktree. |
| `loop-cancel` | Cancel an active loop by worktree name |
| `loop-status` | List all active loops or get detailed status by worktree name. Supports `restart` to resume inactive loops. |

### Graph Tools

Code structure graph with file watching and symbol tracking.

| Tool | Description |
|------|-------------|
| `graph-status` | Check graph indexing status or trigger re-scan. Actions: `status`, `scan` |
| `graph-query` | Query file-level graph information. Actions: `top_files`, `file_deps`, `file_dependents`, `cochanges`, `blast_radius`, `packages`, `file_symbols` |
| `graph-symbols` | Query symbol-level graph information. Actions: `find`, `search`, `signature`, `callers`, `callees` |
| `graph-analyze` | Analyze code quality. Actions: `unused_exports`, `duplication`, `near_duplicates` |

### Graph Tool Details

#### graph-status
Check graph indexing status or trigger re-scan.

```typescript
graph-status { action: "status" | "scan" }
```

**Actions:**
- `status` - Show current graph statistics (files, symbols, edges, calls)
- `scan` - Trigger a full codebase scan to build/update the graph

#### graph-query
Query file-level graph information.

```typescript
graph-query { 
  action: "top_files" | "file_deps" | "file_dependents" | "cochanges" | "blast_radius" | "packages" | "file_symbols",
  file?: string,
  limit?: number 
}
```

**Actions:**
- `top_files` - Get most important files by PageRank
- `file_deps` - Get dependencies of a file
- `file_dependents` - Get files that depend on a given file
- `cochanges` - Get files that change together with a given file
- `blast_radius` - Calculate blast radius for a file
- `packages` - List external packages used
- `file_symbols` - Get symbols defined in a file

#### graph-symbols
Query symbol-level graph information.

```typescript
graph-symbols { 
  action: "find" | "search" | "signature" | "callers" | "callees",
  name?: string,
  file?: string,
  kind?: string,
  limit?: number 
}
```

**Actions:**
- `find` - Find symbols by name
- `search` - Full-text search symbols
- `signature` - Get symbol signature
- `callers` - Find all callers of a symbol
- `callees` - Find all callees of a symbol

#### graph-analyze
Analyze code quality issues.

```typescript
graph-analyze { 
  action: "unused_exports" | "duplication" | "near_duplicates",
  file?: string,
  limit?: number,
  threshold?: number 
}
```

**Actions:**
- `unused_exports` - Find exported symbols that are never imported
- `duplication` - Find duplicate code structures
- `near_duplicates` - Find near-duplicate code patterns (configurable threshold)

## Slash Commands

| Command | Description | Agent |
|---------|-------------|-------|
| `/review` | Run a code review on current changes | auditor (subtask) |
| `/loop` | Start an iterative development loop in a worktree | code |
| `/loop-status` | Check status of all active loops | code |
| `/loop-cancel` | Cancel the active loop | code |

## CLI

Manage loops and graph operations using the `opencode-forge` CLI. The CLI auto-detects the project ID from git.

```bash
opencode-forge <command> [options]
```

**Global options** (apply to all commands):

| Flag | Description |
|------|-------------|
| `--project, -p <name>` | Project name or SHA (auto-detected from git) |
| `--dir, -d <path>` | Git repo path for project detection |
| `--help, -h` | Show help |

### Commands

#### upgrade

Check for plugin updates and install the latest version.

```bash
opencode-forge upgrade
```

#### status

Show loop status for the current project.

```bash
opencode-forge loop status
opencode-forge loop status --project my-project
```

| Flag | Description |
|------|-------------|
| `--project, -p <name>` | Project name or SHA (auto-detected from git) |

#### cancel

Cancel a loop by worktree name.

```bash
opencode-forge loop cancel my-worktree-name
opencode-forge loop cancel --project my-project my-worktree-name
```

| Flag | Description |
|------|-------------|
| `--project, -p <name>` | Project name or SHA (auto-detected from git) |

#### restart

Restart a loop by worktree name.

```bash
opencode-forge loop restart my-worktree-name
opencode-forge loop restart --project my-project my-worktree-name
```

| Flag | Description |
|------|-------------|
| `--project, -p <name>` | Project name or SHA (auto-detected from git) |
| `--force` | Force restart an active loop without confirmation |
| `--server <url>` | OpenCode server URL (default: http://localhost:5551) |

#### graph

Check graph status, trigger a scan, list cache entries, or remove entries.

```bash
opencode-forge graph status
opencode-forge graph scan
opencode-forge graph list
opencode-forge graph remove <key>
```

| Flag | Description |
|------|-------------|
| `--project, -p <name>` | Project name or SHA (auto-detected from git) |
| `--dir, -d <path>` | Project directory for graph scanning |
| `--target, -t <id>` | Target for removal (project ID or hash directory) |
| `--yes, -y` | Skip confirmation prompt for removal |

## Configuration

On first run, the plugin automatically copies the bundled config to your config directory:
- Path: `~/.config/opencode/forge-config.jsonc`
- Falls back to: `$XDG_CONFIG_HOME/opencode/forge-config.jsonc`

**Note:** Configuration is stored at `~/.config/opencode/forge-config.jsonc`.

The plugin supports JSONC format, allowing comments with `//` and `/* */`.

You can edit this file to customize settings. The file is created only if it doesn't already exist.

```jsonc
{
  // Data directory for plugin storage (graph.db, KV store, logs)
  // When empty, resolves to ~/.local/share/opencode/forge (or XDG_DATA_HOME equivalent)
  "dataDir": "",

  // Logging configuration
  "logging": {
    "enabled": false,                // Enable file logging
    "debug": false,                 // Enable debug-level output
    "file": ""                      // Log file path (defaults to ~/.local/share/opencode/forge/logs/forge.log)
  },

  // Session compaction settings
  "compaction": {
    "customPrompt": true,           // Use custom compaction prompt for continuity
    "maxContextTokens": 0           // Max tokens for context (0 = unlimited)
  },

  // Messages transform hook for graph injection and read-only enforcement
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
    "defaultAudit": true,          // Run auditor after each coding iteration
    "model": "",                   // Model override for loop sessions
    "minAudits": 1,                // Minimum audit iterations before completion
    "stallTimeoutMs": 60000        // Stall detection timeout (60s)
  },

  // Docker sandbox configuration for isolated loop execution
  "sandbox": {
    "mode": "off",                 // Sandbox mode: "off" or "docker"
    "image": "oc-forge-sandbox:latest"  // Docker image for sandbox containers
  },

  // Graph indexing configuration
  "graph": {
    "enabled": true,               // Enable graph indexing
    "autoScan": true,              // Auto-scan on startup
    "watch": true,                 // Watch for file changes
    "debounceMs": 100,             // Debounce delay for file watches
    "maxFiles": 1000               // Maximum files to index
  },

  // TUI sidebar widget configuration
  "tui": {
    "sidebar": true,               // Show memory sidebar in OpenCode TUI
    "showLoops": true,             // Display loop status in sidebar
    "showVersion": true            // Show plugin version in sidebar title
  },

  // Default TTL for KV store entries in milliseconds (default: 604800000 / 7 days)
  "defaultKvTtlMs": 604800000,

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
- `dataDir` - Data directory for plugin storage (graph.db, KV store, logs). When empty, resolves to `~/.local/share/opencode/forge` (or `XDG_DATA_HOME` equivalent) (default: `""`)
- `defaultKvTtlMs` - Default TTL for KV store entries in milliseconds (default: `604800000` / 7 days)
- `executionModel` - Model override for plan execution sessions, format: `provider/model` (e.g. `anthropic/claude-hautilus-3-5-20241022`). When set, `plan-execute` uses this model for the new Code session. When empty or omitted, OpenCode's default model is used (typically the `model` field from `opencode.json`). **Recommended:** Set this to a fast, cheap model (e.g. Haiku or MiniMax) and use a smart model (e.g. Opus) for the Architect session — planning needs reasoning, execution needs speed.
- `auditorModel` - Model override for the auditor agent (`provider/model`). When set, overrides the auditor agent's default model. When not set, uses platform default (default: `""`)

#### Logging
- `logging.enabled` - Enable file logging (default: `false`)
- `logging.debug` - Enable debug-level log output (default: `false`)
- `logging.file` - Log file path. When empty, resolves to `~/.local/share/opencode/forge/logs/forge.log` (default: `""`). Logs remain in the data directory, only config has moved.

When enabled, logs are written to the specified file with timestamps. The log file has a 10MB size limit with automatic rotation.

#### Compaction
- `compaction.customPrompt` - Use a custom compaction prompt optimized for session continuity (default: `true`)
- `compaction.maxContextTokens` - Maximum tokens for context during compaction (default: `0` / unlimited)

#### Messages Transform
- `messagesTransform.enabled` - Enable the messages transform hook that handles graph injection and Architect read-only enforcement (default: `true`)
- `messagesTransform.debug` - Enable debug logging for messages transform (default: `false`)

#### Loop
- `loop.enabled` - Enable iterative development loops (default: `true`)
- `loop.defaultMaxIterations` - Default max iterations for loops, 0 = unlimited (default: `15`)
- `loop.cleanupWorktree` - Auto-remove worktree on cancel (default: `false`)
- `loop.defaultAudit` - Run auditor after each coding iteration by default (default: `true`)
- `loop.model` - Model override for loop sessions (`provider/model`), falls back to `executionModel` (default: `""`)
- `loop.stallTimeoutMs` - Watchdog stall detection timeout in milliseconds (default: `60000`)
- `loop.minAudits` - Minimum audit iterations required before completion (default: `1`)

#### Sandbox
- `sandbox.mode` - Sandbox mode: `"off"` or `"docker"` (default: `"off"`)
- `sandbox.image` - Docker image for sandbox containers (default: `"oc-forge-sandbox:latest"`)

#### Graph
- `graph.enabled` - Enable graph indexing (default: `true`)
- `graph.autoScan` - Auto-scan codebase on startup (default: `true`)
- `graph.watch` - Watch for file changes (default: `true`)
- `graph.debounceMs` - Debounce delay for file watch events (default: `100`)
- `graph.maxFiles` - Maximum files to index (default: `1000`)

#### TUI
- `tui.sidebar` - Show the forge sidebar widget in OpenCode TUI (default: `true`)
- `tui.showLoops` - Display active and recent loop status in the sidebar (default: `true`)
- `tui.showVersion` - Show plugin version number in the sidebar title (default: `true`)

#### Agents
- `agents` - Per-agent temperature overrides keyed by display name (e.g., `"code"`, `"architect"`, `"auditor"`). Temperature range: `0.0` - `2.0` (default: `undefined`)

## TUI Plugin

The plugin includes a TUI sidebar widget and dialog system for monitoring and managing loops directly in the OpenCode terminal interface.

### Sidebar

The sidebar shows all loops for the current project:

- Loop name (truncated to 25 chars with middle ellipsis) with a colored status dot
- Status text: current phase for active loops, termination reason for completed/cancelled
- Clicking a **worktree loop** opens the Loop Details dialog
- Clicking a **non-worktree loop** navigates directly to its session
- **Plan indicator** — When a plan exists for the current session, a 📋 Plan link appears. Click it to open the Plan Viewer dialog.

### Plan Viewer

When an architect session produces a plan, it is cached in the project KV store. The plan is accessible from the sidebar (📋 Plan link) or the command palette (`Memory: View plan`).

The plan viewer dialog renders the full plan as GitHub-flavored markdown with syntax highlighting:

Click `[edit]` to switch to edit mode, where you can modify the plan text directly in a textarea. Click **Save** to write changes back to the KV store, or `[view]` to return to the rendered view without saving.

### Loop Details Dialog

The Loop Details dialog shows a detailed view of a single loop:

- Name and status badge (active / completed / error / cancelled / stalled)
- Session stats: session ID, iteration count, token usage (input/output/cache), cost
- Latest output from the last assistant message (scrollable, up to 500 chars)
- **Back** — return to the loop list (when opened from the command palette)
- **Cancel loop** — abort the active loop session (visible only when loop is active)
- **Close (esc)** — dismiss the dialog

### Command Palette

The `Memory: Show loops` command is registered in the command palette when loops exist for the current project. It opens a list of all **worktree loops** (large dialog), then drills into the Loop Details dialog for the selected loop (medium dialog) with a Back button to return to the list.

### Setup

When installed via npm, the TUI plugin loads automatically when added to your TUI config. The plugin is auto-detected via the `./tui` export in `package.json`.

Add to your `~/.config/opencode/tui.json` or project-level `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-forge"
  ]
}
```

For local development, reference the built TUI file directly:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/path/to/opencode-forge/dist/tui.js"
  ]
}
```

TUI options are configured in `~/.config/opencode/forge-config.jsonc` under the `tui` key:

```jsonc
{
  "tui": {
    "sidebar": true,
    "showLoops": true,
    "showVersion": true
  }
}
```

Set `sidebar` to `false` to completely disable the widget.

## architect → code Workflow

Plan with a smart model, execute with a fast model. The architect agent researches the codebase and designs an implementation plan; the code agent implements it.

### How Plans Work

During planning, the architect writes the plan incrementally to the project KV store — building sections, appending content, and making targeted line-based edits. The plan is cached under a session-scoped key, not generated as a single LLM response.

The user can view the cached plan at any time from the **sidebar** (📋 Plan link) or the **command palette** (`Memory: View plan`). The plan viewer renders full GitHub-flavored markdown and supports inline editing — the user can modify the plan directly before approving.

### Execution

After the architect presents a summary, the user approves via one of four execution modes:

- **New session** — Creates a new Code session and sends the plan as the initial prompt. The architect session is aborted and the TUI navigates to the new session.
- **Execute here** — The architect session is aborted and the code agent takes over the same session immediately with the plan.
- **Loop (worktree)** — Creates an isolated git worktree and launches an iterative coding/auditing loop. When `config.sandbox.mode` is `"docker"`, the loop automatically uses Docker sandbox.
- **Loop (in-place)** — Runs an iterative coding/auditing loop in the current directory without worktree isolation.

Execution is immediate — there are no additional LLM calls between approval and execution. The system intercepts the user's approval answer, reads the cached plan from KV, and dispatches it programmatically to the code agent. The architect never processes the approval response.

Set `executionModel` in your config to a fast model (e.g., Haiku) and use a smart model (e.g., Opus) for the architect session.

## Loop

The loop is an iterative development system that alternates between coding and auditing phases:

1. **Coding phase** — A Code session works on the task
2. **Auditing phase** — The Auditor agent reviews changes against project conventions and stored review findings
3. **Session rotation** — A fresh session is created for the next iteration
4. **Repeat** — Audit findings feed back into the next coding iteration

### Session Rotation

Each iteration runs in a **fresh session** to keep context small and prioritize speed. After each phase completes, the current session is destroyed and a new one is created. The original task prompt and any audit findings are re-injected into the new session as a continuation prompt, so no context is lost while keeping the window clean.

### Review Finding Persistence

Audit findings survive session rotation via the **review store**. The auditor stores each bug and warning using `review-write` with file, line, severity, and description. At the start of each audit:

- Existing findings are retrieved via `review-read`
- Resolved findings are deleted via `review-delete`
- Unresolved findings are carried forward into the review

### Worktree Isolation

Loops default to current directory execution. Set `worktree: true` to run in an isolated git worktree with its own branch (e.g., `opencode/loop-<slug>`). In worktree mode, changes are auto-committed and the worktree is removed on completion (branch preserved for later merge).

### Auditor Integration

After each coding iteration, the auditor agent reviews changes against project conventions and stored review findings. Findings are persisted via `review-write` scoped to the loop's branch. Outstanding findings block completion, and a minimum audit count (`minAudits`, default: `1`) must be met before the completion promise is honored.

### Stall Detection

A watchdog monitors loop activity. If no progress is detected within `stallTimeoutMs` (default: 60s), the current phase is re-triggered. After 5 consecutive stalls, the loop terminates with reason `stall_timeout`.

### Model Configuration

Loops use `loop.model` if set, falling back to `executionModel`, then the platform default. On model errors, automatic fallback to the default model kicks in.

### Safety

- `git push` is denied inside active loop sessions
- Tools like `question`, `plan-execute`, and `loop` are blocked to prevent recursive loops and keep execution autonomous

### Management

- **Slash commands**: `/loop` to start, `/loop-cancel` to cancel
- **Tools**: `loop` to start with parameters, `loop-status` for checking progress (with restart capability), `loop-cancel` to cancel
- **CLI**: `opencode-forge loop status` and `opencode-forge loop cancel` for loop management

### Completion and Termination

The loop completes when the Code agent outputs the completion promise. It auto-terminates after `maxIterations` (if set) or after 3 consecutive errors.

By default, loops run in the current directory. Set `worktree: true` to run in an isolated git worktree instead (enables worktree creation, auto-commit, and cleanup on completion).

## Docker Sandbox

Run loop iterations inside an isolated Docker container. Three tools (`bash`, `glob`, `grep`) execute inside the container via `docker exec`, while `read`/`write`/`edit` operate on the host filesystem. Your project directory is bind-mounted at `/workspace` for instant file sharing.

### Prerequisites

- Docker running on your machine

### Setup

**1. Build the sandbox image:**

```bash
docker build -t oc-forge-sandbox:latest container/
```

The image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, and jq.

**2. Enable sandbox mode in your config** (`~/.config/opencode/forge-config.jsonc`):

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

Start a sandbox loop via the architect plan approval flow (select "Loop (worktree)") or directly with the `loop` tool:

```
loop with worktree: true
```

Sandbox is automatically enabled when `config.sandbox.mode` is set to `"docker"` and the loop uses `worktree: true`. The loop:
1. Creates a git worktree
2. Starts a Docker container with the worktree directory bind-mounted at `/workspace`
3. Redirects `bash`, `glob`, and `grep` tool calls into the container
4. Cleans up the container on loop completion or cancellation

### How It Works

- **Bind mount** -- the project directory is mounted directly into the container at `/workspace`. No sync daemon, no file copying. Changes are visible instantly on both sides.
- **Tool redirection** -- `bash`, `glob`, and `grep` route through `docker exec` when a session belongs to a sandbox loop. The `read`/`write`/`edit` tools operate on the host filesystem directly (compatible with host LSP).
- **Git blocking** -- git commands are explicitly blocked inside the container. All git operations (commit, push, branch management) are handled by the loop system on the host.
- **Host LSP** -- since files are shared via the bind mount, OpenCode's LSP servers on the host read the same files and provide diagnostics after writes and edits.
- **Container lifecycle** -- one container per loop, automatically started and stopped. Container name format: `opencode-forge-sandbox-<worktreeName>`.

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `sandbox.mode` | `"off"` | Set to `"docker"` to enable sandbox support |
| `sandbox.image` | `"oc-forge-sandbox:latest"` | Docker image to use for sandbox containers |

### Customizing the Image

The `container/Dockerfile` is included in the project. To add project-specific tools (e.g., Go, Rust, additional language servers), edit the Dockerfile and rebuild:

```bash
docker build -t oc-forge-sandbox:latest container/
```


## Development

```bash
pnpm build      # Compile TypeScript to dist/
pnpm test       # Run tests
pnpm typecheck  # Type check without emitting
```

## License

MIT
