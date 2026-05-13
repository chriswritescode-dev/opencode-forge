# OpenCode Forge Architecture

This document provides a high-level overview of the opencode-forge plugin architecture.

## Plugin Architecture

OpenCode Forge is a dual-plugin: it exports both a server plugin (`src/index.ts`) and a TUI plugin (`src/tui.tsx`).

### Server Plugin (`src/index.ts`)

The server plugin is the core of the plugin. It:

1. Initializes services (KV, Loop, Sandbox)
2. Registers tools for OpenCode to use
3. Registers hooks for session management and event handling
4. Manages the lifecycle of loops and sandbox containers

Key exports:
- `createForgePlugin(config: PluginConfig): Plugin` - Factory function
- `PluginConfig` - Configuration type
- `VERSION` - Plugin version

### Multi-client / multi-project

Each `opencode attach --dir <worktree>` invokes `createForgePlugin` once for that project, even when clients share the same `opencode serve` process.

- The API listener is process-shared and reference-counted (`src/api/server.ts`): one `Bun.serve` instance per host/port is reused by all attached projects.
- Active projects are tracked in a process-level registry (`src/api/project-registry.ts`), and API dispatch resolves the request to the correct project `ToolContext` by `:projectId`.
- Storage remains project-keyed (SQLite rows include `projectId`), so no schema changes are required for multi-project isolation.
- Sandbox orphan cleanup is registry-aware: preserve loop names are unioned across all registered projects before container cleanup.

### TUI Plugin (`src/tui.tsx`)

The TUI plugin provides a sidebar widget that displays:

- Active and recent loops
- Plan viewer with inline editing
- Loop details dialog with session statistics
- Command palette integration

The TUI plugin reads loop state from the KV store and renders it reactively.

## Loop System

The loop system provides autonomous iterative development with automatic auditing.

### Components

- **Loop Runtime** (`src/loop/runtime.ts`) - Factory for creating Loop instances with phase handlers
- **Loop Service** (`src/loop/service.ts`) - State management for loops (DB-backed)
- **Transition Table** (`src/loop/transitions.ts`) - Pure state machine for loop phases
- **Termination** (`src/loop/termination.ts`) - Termination reason mapping and status checks
- **Prompts** (`src/loop/prompts.ts`) - Prompt builders for each loop phase
- **Idle Gate** (`src/loop/idle-gate.ts`) - Session busy detection and timeout tracking
- **LoopEventHandler** (`src/hooks/loop.ts`) - Event handling, session rotation, watchdog integration

### Module Layout

```
src/loop/
├── index.ts          # Public API barrel (all re-exports)
├── runtime.ts        # createLoop() factory, Loop interface (~2100 lines)
├── service.ts        # DB-backed LoopService (createLoopService, rowToLoopState)
├── state.ts          # Discriminated union LoopState (4 phases), converters
├── transitions.ts    # Pure nextTransition() table
├── termination.ts    # TerminationReason union, terminationStatusFor()
├── prompts.ts        # build*Prompt() builders
├── section-summary.ts # parseSectionSummary() for audit output
├── idle-gate.ts      # sessionsAwaitingBusy map, timeout tracking
├── name-uniqueness.ts # generateUniqueName() for unique loop names
├── orphan-sweep.ts   # sweepOrphanWorkspaces()
└── session-output.ts # fetchSessionOutput(), LoopSessionOutput type
```

All external consumers import through the barrel `src/loop/index.ts`.

### Loop Lifecycle

1. User initiates a loop via the `loop` tool or slash command
2. A `LoopState` is created and persisted to KV store
3. Coding phase: Code agent works on the task
4. Audit phase (if enabled): Auditor agent reviews changes
5. Session rotation: Fresh session created with continuation prompt
6. Repeat until max iterations reached, error threshold exceeded, review findings block, or loop cancelled

See [loop-system.md](loop-system.md) for detailed documentation.

## Sandbox System

Sandbox is optional. When Docker is available and `sandbox.mode = 'docker'` is configured, a sandbox container is provisioned automatically; otherwise loops run in worktree-only mode.

### Components

- **DockerService** (`sandbox/docker.ts`) - Docker API client
- **SandboxManager** (`sandbox/manager.ts`) - Container lifecycle management
- **SandboxContext** (`sandbox/context.ts`) - Tool call redirection
- **SandboxTools** (`hooks/sandbox-tools.ts`) - Hooks for sandbox integration

### How It Works

1. When a sandbox loop starts, a Docker container is created
2. The worktree directory is bind-mounted at `/workspace` inside the container
3. Tool hooks redirect `bash`, `glob`, and `grep` calls into the container
4. File operations (`read`, `write`, `edit`) operate on the host directly
5. On loop completion, the container is stopped and removed

### Tool Redirection

The sandbox uses OpenCode's tool hook system to intercept and redirect tool calls:
- `tool.execute.before` hook prepends commands with `docker exec`
- `tool.execute.after` hook captures output and returns it to the host

## Hook System

OpenCode Forge integrates with OpenCode through several hook points.

### Session Hooks

- `chat.message` - Inject memory into context, handle session events
- `experimental.session.compacting` - Custom compaction behavior
- `experimental.chat.messages.transform` - Architect read-only enforcement

### Tool Hooks

- `tool.execute.before` - Sandbox tool redirection, logging
- `tool.execute.after` - Sandbox cleanup

### Permission Hooks

- `permission.ask` - Auto-allow/deny based on patterns (e.g., deny `git push`)

### Event Hooks

- `event` - Handle server lifecycle events (server.instance.disposed)

## Storage Architecture

### KV Store

The KV store (`services/kv.ts`) provides key-value persistence with TTL support:

- Key format: `projectId:key`
- Supports TTL for automatic expiration
- Used for loop state, plans, review findings

### Configuration

Plugin configuration is stored at `~/.config/opencode/forge-config.jsonc` (JSONC format). On first run, a bundled default config is copied if none exists.

## Service Initialization Order

1. Logger - Always first
2. Database - Initialize storage
3. KV Service - Enable state persistence
4. Loop Service - Restore previous loops
5. Sandbox Manager - If enabled
6. Tools and Hooks - Final registration

## Cleanup

On plugin shutdown (`server.instance.disposed` event):

1. Stop all active sandbox containers
2. Terminate all active loops
3. Clear retry timeouts
4. Close database connections
