# OpenCode Forge Architecture

This document provides a high-level overview of the opencode-forge plugin architecture.

## Plugin Architecture

OpenCode Forge is a dual-plugin: it exports both a server plugin (`src/index.ts`) and a TUI plugin (`src/tui.tsx`).

### Server Plugin (`src/index.ts`)

The server plugin is the core of the plugin. It:

1. Initializes services (KV, Loop, Graph, Sandbox)
2. Registers tools for OpenCode to use
3. Registers hooks for session management and event handling
4. Manages the lifecycle of loops, graph indexing, and sandbox containers

Key exports:
- `createForgePlugin(config: PluginConfig): Plugin` - Factory function
- `PluginConfig` - Configuration type
- `VERSION` - Plugin version

### TUI Plugin (`src/tui.tsx`)

The TUI plugin provides a sidebar widget that displays:

- Active and recent loops
- Plan viewer with inline editing
- Loop details dialog with session statistics
- Command palette integration

The TUI plugin reads loop state from the KV store and renders it reactively.

## Graph System

The graph system provides code structure indexing and querying capabilities.

### Components

- **Tree-sitter Indexer** (`graph/tree-sitter.ts`) - Parses code and extracts symbols using tree-sitter
- **Graph Worker** (`graph/worker.ts`) - Web worker for offloading indexing work
- **Graph Service** (`graph/service.ts`) - Main interface for graph operations
- **Graph Client** (`graph/client.ts`) - RPC client for communicating with the worker
- **SQLite Storage** (`graph/database.ts`) - Persists indexed data

### Flow

1. On startup with `graph.autoScan` enabled, `GraphService.ensureStartupIndex()` performs a freshness check
2. If the graph cache is missing, stale, or unhealthy, a full scan is triggered; otherwise the existing cache is reused
3. The service batches files and sends them to the worker
4. The worker uses tree-sitter to parse files and extract:
   - Symbols (functions, classes, interfaces, etc.)
   - Imports and exports
   - Call relationships between symbols
5. Results are stored in a SQLite database per project
6. The filesystem watcher monitors for changes and triggers re-indexing
7. PageRank and other derived metrics are computed after initial scan

### Query Tools

Agents access the graph through these tools:
- `graph-status` - Check indexing status or trigger scan
- `graph-query` - File-level queries (dependencies, dependents, co-changes)
- `graph-symbols` - Symbol-level queries (find, search, callers, callees)
- `graph-analyze` - Code quality analysis (unused exports, duplication)

See [graph-system.md](graph-system.md) for detailed documentation.

## Loop System

The loop system provides autonomous iterative development with automatic auditing.

### Components

- **LoopService** (`services/loop.ts`) - State management for loops
- **LoopEventHandler** (`hooks/loop.ts`) - Event handling and session rotation
- **ReviewStore** (`tools/review.ts`) - Persistent audit findings

### Loop Lifecycle

1. User initiates a loop via the `loop` tool or slash command
2. A `LoopState` is created and persisted to KV store
3. Coding phase: Code agent works on the task
4. Audit phase (if enabled): Auditor agent reviews changes
5. Session rotation: Fresh session created with continuation prompt
6. Repeat until max iterations reached, error threshold exceeded, review findings block, or loop cancelled

See [loop-system.md](loop-system.md) for detailed documentation.

### State Management

Loop state is stored in the KV store with keys:
- `loop:{name}` - Loop state object
- `loop-session:{sessionId}` - Session to loop name mapping
- `review-finding:{id}` - Audit findings scoped to branch

### Session Rotation

Each iteration runs in a fresh session to keep context small. The original task prompt and audit findings are re-injected into the new session as a continuation prompt.

## Sandbox System

The sandbox system provides isolated Docker container execution for loops.

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
- `tool.execute.after` - Sandbox cleanup, graph update triggers

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

### Graph Database

The graph database (`graph/database.ts`) uses SQLite for code graph storage:

- File records with metadata and pagerank
- Symbol records with locations and signatures
- Import/export relationships
- Call graph edges
- Co-change patterns

### Configuration

Plugin configuration is stored at `~/.config/opencode/forge-config.jsonc` (JSONC format). On first run, a bundled default config is copied if none exists.

## Service Initialization Order

1. Logger - Always first
2. Database - Initialize storage
3. KV Service - Enable state persistence
4. Loop Service - Restore previous loops
5. Sandbox Manager - If enabled
6. Graph Service - If enabled
7. Tools and Hooks - Final registration

## Cleanup

On plugin shutdown (`server.instance.disposed` event):

1. Stop all active sandbox containers
2. Terminate all active loops
3. Clear retry timeouts
4. Close graph service (stops watcher, closes database)
5. Close database connections
