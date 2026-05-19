# Modules Reference

A source-backed reference for every module in the `src/` directory. Each section lists its purpose, key files, public exports, and relationships.

See also: [Architecture](architecture.md), [Loop System](loop-system.md), [API Reference](api/README.md).

## Source Tree Overview

```
src/
├── index.ts                 # Server plugin entry point (createForgePlugin)
├── tui.tsx                  # TUI plugin entry point
├── config.ts                # Agent/command configuration handler
├── setup.ts                 # Config loading, skill installation
├── types.ts                 # Core type definitions (PluginConfig, etc.)
├── version.ts               # VERSION constant ('0.4.0')
│
├── agents/                  # AI agent definitions
├── hooks/                   # Plugin event/lifecycle hooks
├── loop/                    # Core loop state machine & runtime
├── services/                # Business logic services
├── sandbox/                 # Docker sandbox management
├── storage/                 # SQLite persistence layer
├── tools/                   # Plugin tools callable by AI agents
├── tui/                     # TUI-specific components
├── utils/                   # Shared utility modules (~25 files)
└── workspace/               # Git worktree / workspace management
```

---

## Entry Points

### `src/index.ts` — Server Plugin Entry

The main server plugin factory function that initializes all services and returns the `Hooks` object.

**Public API** (`src/index.ts`):

| Export | Type | Description |
|--------|------|-------------|
| `createForgePlugin(config)` | Function | Factory returning an OpenCode `Plugin` |
| `createParentSessionLookup(options)` | Function | Resolves parent sessions across worktrees |
| `createSessionDirectoryLookup(options)` | Function | Resolves session directory across worktrees |
| `PluginConfig` | Interface | Complete plugin configuration |
| `CompactionConfig` | Interface | Session compaction settings |
| `VERSION` | Constant | Plugin version string |

Source: [src/index.ts](../src/index.ts)

### `src/tui.tsx` — TUI Plugin Entry

The TUI plugin providing sidebar widget and dialog system. Communicates with the server plugin via RPC over the opencode bus.

- Exports `{ id: 'oc-forge', tui }`
- Registers commands: `forge.plan.view`, `forge.plan.load`
- Provides plan viewer, execution dialog, loop details, model selection

Source: [src/tui.tsx](../src/tui.tsx)

---

## `agents/` — AI Agent Definitions

Defines roles and system prompts for each AI agent used in the forge pipeline.

### Files

| File | Purpose |
|------|---------|
| `index.ts` | `buildAgents()` factory, barrel exports |
| `types.ts` | `AgentRole`, `AgentDefinition`, `AgentConfig` types |
| `code.ts` | Code execution agent |
| `architect.ts` | Read-only planning/design agent |
| `auditor.ts` | Code review agent + auditor-loop variant |

### Public API

```typescript
buildAgents(): Record<AgentRole, AgentDefinition>

type AgentRole = 'code' | 'architect' | 'auditor' | 'auditor-loop'
```

Source: [src/agents/index.ts](../src/agents/index.ts)

---

## `hooks/` — Plugin Event Hooks

Translates OpenCode host events into loop actions and manages lifecycle side-effects.

### Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports |
| `session.ts` | Session lifecycle (message, compacting, messages transform) |
| `loop.ts` | LoopEventHandler adapter (events → Loop runtime) |
| `host-side-effects.ts` | Termination side-effects (teardown, toast, log) |
| `watchdog.ts` | Stall detection and recovery |
| `plan-approval.ts` | Plan approval dedup/event gating |
| `plan-capture.ts` | Plan capture from streaming assistant messages |
| `section-capture.ts` | Section extraction from streaming messages |
| `forge-session-attach.ts` | Auto-attach loops to new sessions |
| `sandbox-tools.ts` | Sandbox tool before/after hooks |

### Public API (barrel exports from `hooks/index.ts`)

```typescript
createSessionHooks(): SessionHooks          // Session lifecycle hooks
createLoopEventHandler(): LoopEventHandler  // Loop event handling adapter
createToolExecuteBeforeHook()              // Pre-tool execution hook
createToolExecuteAfterHook()               // Post-tool execution hook
createPlanApprovalEventHook()             // Plan approval event hook
```

Additional hooks available via direct imports:
- `createSandboxToolBeforeHook()` / `createSandboxToolAfterHook()` — sandbox tool redirection
- `createForgeSessionAttachHook()` — auto-attach loops on session creation
- `createPlanCaptureEventHook()` — plan marker extraction from streaming messages

Source: [src/hooks/index.ts](../src/hooks/index.ts)

---

## `loop/` — Core Loop State Machine

The heart of Forge. Implements autonomous iterative development with phases: `coding → auditing → final_auditing`.

### Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API barrel (all re-exports) |
| `runtime.ts` | `createLoop()` factory, `Loop` interface (~2100 lines) |
| `service.ts` | DB-backed `LoopService` (`createLoopService`) |
| `state.ts` | Discriminated union `LoopState` (4 phases), converters |
| `transitions.ts` | Pure `nextTransition()` table |
| `termination.ts` | `TerminationReason` union, `terminationStatusFor()` |
| `prompts.ts` | Prompt builders for each loop phase |
| `section-summary.ts` | Parse audit output markers |
| `idle-gate.ts` | Session busy detection and timeout tracking |
| `name-uniqueness.ts` | Generate unique loop names |
| `session-output.ts` | Fetch session output for loop display |

### Key Types

```typescript
type Phase = 'coding' | 'auditing' | 'final_auditing'

type LoopState =
  | CodingState
  | AuditingState
  | FinalAuditingState

type TerminationReason =
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'user_aborted' }
  | { kind: 'shutdown' }
  | { kind: 'max_iterations' }
  | { kind: 'stall_timeout' }
  | { kind: 'missing_worktree_dir' }
  | { kind: 'session_creation_failed' }
  | { kind: 'audit_retry_exhausted' }
  | { kind: 'final_audit_retry_exhausted' }
  | { kind: 'coding_no_assistant' }
  | { kind: 'worktree_failed'; message: string }
  | { kind: 'error_max_retries'; message: string }
```

### Public API

```typescript
// Runtime
createLoop(deps: LoopRuntimeDeps): Loop
isWorkspaceNotFoundError(error): boolean

// State
rowToLoopState(row, largeFields?): LoopState
MAX_RETRIES: number

// Transitions
nextTransition(state, event): Transition

// Prompts
buildContinuationPrompt(state, auditFindings?): string
buildAuditPrompt(state): string
buildSectionInitialPrompt(state, sectionIndex?): string
buildSectionAuditPrompt(state, sectionIndex?): string
buildSectionContinuationPrompt(state, sectionIndex?): string
buildFinalAuditPrompt(state): string

// Termination
terminationStatusFor(reason: TerminationReason): TerminationStatus
terminationReasonToString(reason): string
parseTerminationReasonString(str): TerminationReason

// Section summary
parseSectionSummary(text): { startLine, endLine, summary }
SECTION_SUMMARY_START_MARKER: string
SECTION_SUMMARY_END_MARKER: string

// Idle gate
sessionsAwaitingBusy: Map<string, ...>
AWAITING_BUSY_TIMEOUT_MS: number
markPromptSent(sessionId, loopName): void
clearPromptPending(sessionId): void
isAwaitingBusy(sessionId): boolean
isAwaitingBusyExpired(sessionId): boolean

// Name uniqueness
generateUniqueName(existingNames[]): string

// Session output
fetchSessionOutput(v2, sessionId): LoopSessionOutput
```

All external consumers import through the barrel: `src/loop/index.ts`

Source: [src/loop/index.ts](../src/loop/index.ts)

---

## `services/` — Business Logic Services

Higher-level orchestration services coordinating between hooks, loop runtime, and storage.

### Files

| File | Purpose |
|------|---------|
| `execution.ts` | Unified command bus for plan execution (`createForgeExecutionService()`) |
| `session-loop-resolver.ts` | Resolve which loop owns a given session |
| `deterministic-decomposer.ts` | Parse plan sections without LLM (`decomposeDeterministically()`) |
| `plan-capture.ts` | Extract plan text from messages |
| `worktree-log.ts` | Log worktree completions |

### Key Interfaces

```typescript
type ForgeExecutionSurface = 'tool' | 'approval-hook' | 'api' | 'tui'

interface ForgeExecutionRequestContext {
  surface: ForgeExecutionSurface
  projectId: string
  directory: string
  sourceSessionId?: string
  requestId?: string
}

type PlanSource =
  | { kind: 'inline'; planText: string }
  | { kind: 'stored'; sessionId: string }
  | { kind: 'loop-state'; loopName: string }
```

Source: [src/services/execution.ts](../src/services/execution.ts)

---

## `sandbox/` — Docker Sandboxing

Manages Docker containers for isolated loop execution.

### Files

| File | Purpose |
|------|---------|
| `docker.ts` | `DockerService` API client (exec, build, create, remove containers) |
| `manager.ts` | `SandboxManager` lifecycle management (start/stop/getActive/isLive) |
| `reconcile.ts` | Sandbox reconciliation with loop states |
| `context.ts` | `SandboxContext`, `isSandboxEnabled()` |
| `path.ts` | Sandbox path utilities |
| `exec-fs.ts` | Filesystem operations through Docker |

### DockerService Interface

```typescript
interface DockerService {
  checkDocker(): Promise<boolean>
  imageExists(image: string): Promise<boolean>
  buildImage(image: string, dockerfile: string): Promise<void>
  createContainer(image: string, opts: ContainerOpts): Promise<string>
  removeContainer(name: string): Promise<void>
  exec(container: string, cmd: string[], opts?: ExecOpts): Promise<string>
  execPipe(container: string, cmd: string[], opts?: ExecOpts): Promise<{ stdout: string; exitCode: number }>
  isRunning(container: string): Promise<boolean>
  containerName(worktreeName: string): string
  listContainersByPrefix(prefix: string): Promise<string[]>
}
```

### SandboxManager Interface

```typescript
interface SandboxManager {
  start(loopName: string, worktreeDir: string): Promise<void>
  stop(loopName: string): Promise<void>
  getActive(): Map<string, { container: string; worktreeDir: string }>
  isActive(loopName: string): boolean
  isLive(containerName: string): Promise<boolean>
  isLiveByName(loopName: string): Promise<boolean>
  cleanupOrphans(preserveNames: Set<string>): Promise<number>
  restore(loopName: string): Promise<void>
}
```

Source: [src/sandbox/docker.ts](../src/sandbox/docker.ts), [src/sandbox/manager.ts](../src/sandbox/manager.ts)

---

## `storage/` — SQLite Persistence Layer

All data persistence via `bun:sqlite`. Organized as:

### Database

| Export | Description |
|--------|-------------|
| `initializeDatabase(dataDir, options)` | Creates SQLite DB with migrations |
| `closeDatabase()` | Closes database connections |
| `resolveDataDir()` | Platform-appropriate data directory |
| `resolveLogPath()` | Default log file path |

### Repositories

Each created via `createXxxRepo(db)` factory with project-scoped queries:

| Repository | Table(s) | Key Types |
|---|---|---|
| `LoopsRepo` | `loops`, `loop_large_fields` | `LoopRow`, `LoopLargeFields` |
| `PlansRepo` | `plans` | `PlanRow` |
| `ReviewFindingsRepo` | `review_findings` | `ReviewFindingRow` |
| `SectionPlansRepo` | `section_plans` | `SectionPlanRow` |
| `LoopSessionUsageRepo` | `loop_session_usage` | `LoopSessionUsageRow`, `LoopUsageAggregate` |
| `TuiPrefsRepo` | `tui_preferences` | N/A |

### Migrations

Sequential numbered `.sql` files (100–130) tracked in a `migrations` table.

See [storage/migrations/README.md](../src/storage/migrations/README.md) for migration details.

Source: [src/storage/index.ts](../src/storage/index.ts)

---

## `tools/` — Plugin Tools

Implements tools callable by AI agents during conversations.

### Tools Created by `createTools(ctx)`

| Tool | File | Description |
|------|------|-------------|
| `review-write` | `review.ts` | Store a code review finding (file, line, severity, description) |
| `review-read` | `review.ts` | Retrieve review findings, filter by file or regex pattern |
| `review-delete` | `review.ts` | Delete a review finding by file and line |
| `plan-read` | `plan-kv.ts` | Retrieve plans with pagination and pattern search |
| `section-read` | `section-read.ts` | Retrieve a specific section of a plan |
| `loop` | `loop.ts` | Execute a plan using iterative development loop. Args: `title` required; `plan`, `loopName`, and `hostSessionId` optional. |
| `loop-status` | `loop.ts` | List active/recent loops, show cumulative usage for detailed status, or restart loops with `restart`/`force` arguments |
| `loop-cancel` | `loop.ts` | Cancel an active loop by worktree name |

### ToolContext

All tool implementations receive a shared context:

```typescript
interface ToolContext {
  projectId: string
  directory: string
  config: PluginConfig
  logger: Logger
  db: Database
  dataDir: string
  loopHandler: LoopEventHandler
  loop: Loop
  v2: OpencodeClientV2
  cleanup: () => Promise<void>
  input: PluginInput
  sandboxManager: SandboxManager | null
  plansRepo: PlansRepo
  reviewFindingsRepo: ReviewFindingsRepo
  loopsRepo: LoopsRepo
  sectionPlansRepo: SectionPlansRepo
  workspaceStatusRegistry: WorkspaceStatusRegistry
}
```

Source: [src/tools/index.ts](../src/tools/index.ts), [src/tools/types.ts](../src/tools/types.ts)

---

## `workspace/` — Git Worktree / Workspace Management

Creates and manages git worktrees for isolated loop execution, integrated with OpenCode's experimental workspace API.

### Files

| File | Purpose |
|------|---------|
| `forge-adapter.ts` | `createForgeWorkspaceAdapter()` — implements OpenCode's workspace API |
| `forge-worktree.ts` | `bindSessionToWorkspace()`, `createBuiltinWorktreeWorkspace()` |
| `pending-teardown.ts` | Registry of pending teardown contexts for commit message building |
| `classify-stale.ts` | Decision function for stale forge workspace handling |
| `remove-with-context.ts` | Workspace removal with teardown context |
| `sweep-stale.ts` | Opportunistic same-project sweep of stale forge workspaces during loop teardown |

Source: [src/workspace/forge-adapter.ts](../src/workspace/forge-adapter.ts)

---

## `utils/` — Shared Utilities

Cross-cutting helpers (~25 files) organized by concern:

| Group | Files | Purpose |
|---|---|---|
| Logging | `logger.ts` | File logger with rotation (10MB max) |
| Caching | `lru-cache.ts` | Generic LRU cache |
| Plan | `plan-execution.ts`, `plan-capture.ts`, `plan-archive.ts`, `plan-patch.ts` | Plan parsing, archiving, patching |
| Sections | `section-capture.ts`, `section-summary.ts` | Section extraction/summary parsing |
| Loop | `loop-helpers.ts`, `loop-format.ts`, `loop-session.ts` | Loop model/format/session helpers |
| Sessions | `audit-session.ts`, `session-titles.ts`, `session-stats.ts` | Session naming/stats |
| TUI | `tui-client.ts`, `tui-plan-store.ts`, `tui-loop-store.ts`, `tui-execution-preferences.ts`, `tui-execution-context-cache.ts`, `tui-models.ts` | TUI RPC, storage, preferences, models |
| Workspace | `worktree-cleanup.ts`, `workspace-listing.ts`, `workspace-status-registry.ts` | Worktree/workspace lifecycle |
| Misc | `partial-match.ts`, `model-fallback.ts`, `git-branch.ts`, `busy-guard.ts`, `sandbox-ready.ts`, `format.ts` | Various helpers |

---

## `constants/` — Permission Rulesets

Security rules for loop and audit sessions.

```typescript
buildLoopPermissionRuleset(): PermissionRule[]      // Allow-all except review/plan/loop/external_directory
buildAuditSessionPermissionRuleset(): PermissionRule[] // Read-only, deny all mutations
```

Source: [src/constants/loop.ts](../src/constants/loop.ts)

---

## Architectural Patterns

### Factory Pattern

Every major component uses a factory function pattern with dependency injection:

```typescript
createForgePlugin(config)         // Server plugin
createLoop(deps)                  // Loop runtime
createLoopService(...)            // State management
createSandboxManager(docker, config, logger) // Sandbox
createTools(ctx)                  // Tool registry
createForgeWorkspaceAdapter(deps) // Workspace
createDockerService(logger)       // Docker
createLogger(config)              // Logging
```

Dependencies are injected via parameter objects, not global singletons.

### Barrel Exports

Three modules use barrel `index.ts` files:
- `src/hooks/index.ts`
- `src/storage/index.ts`
- `src/loop/index.ts`
- `src/agents/index.ts`
- `src/tools/index.ts`

Other modules do NOT have barrel files (utils, sandbox, services, workspace).

### Repository Pattern

All data access goes through typed repo interfaces:
- `LoopsRepo`, `PlansRepo`, `ReviewFindingsRepo`, `SectionPlansRepo`, `TuiPrefsRepo`
- Each created via `createXxxRepo(db)` with project-scoped queries.
- Rows are mapped to domain objects via `rowToLoopState()` etc.

### State Machine Pattern

The loop follows a strict phase-based state machine:
- States: `coding`, `auditing`, `final_auditing`
- Transitions managed by `nextTransition()` in `transitions.ts`
- Each phase has dedicated prompt builders and session rotation logic
- State changes are persisted to SQLite after every mutation

### Notification Pattern

A `LoopChangeNotifier` callback is threaded through all state mutation calls. It fires on insert, delete, terminate, rotate, phase, iteration, status, session, sandbox, workspace, audit-result, error, reconcile events.

### Plugin Hook Pattern

The plugin returns a standard `Hooks` object with these hook points:
- `tool` — custom tools for agents
- `config` — agent/command configuration injection
- `chat.message` — session message handling
- `event` — event dispatching
- `tool.execute.before` / `tool.execute.after` — pre/post tool execution
- `experimental.session.compacting` — context compaction
- `experimental.chat.messages.transform` — message transformation (architect read-only enforcement)
