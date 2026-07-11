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
├── version.ts               # VERSION constant generated from package.json
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
- Provides plan viewer, execution dialog, loop details, model and variant selection

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
| `session.ts` | Session lifecycle (message, compacting) |
| `loop.ts` | LoopEventHandler adapter (events → Loop runtime) |
| `host-side-effects.ts` | Termination side-effects (teardown, toast, log) |
| `watchdog.ts` | Stall detection and recovery |
| `plan-approval.ts` | Plan approval dedup/event gating + tool execute before/after hooks |
| `plan-capture.ts` | Plan capture from streaming assistant messages |
| `forge-session-attach.ts` | Auto-attach loops on `session.created` and `chat.message` events |
| `loop-permission.ts` | Patches subagent permission rulesets on `session.created` for active-loop sessions |
| `sandbox-tools.ts` | Sandbox tool before/after redirection hooks |

### Public API (barrel exports from `hooks/index.ts`)

```typescript
createSessionHooks(): SessionHooks          // Session lifecycle hooks (session.ts)
createLoopEventHandler(): LoopEventHandler  // Loop event handling adapter (loop.ts)
createToolExecuteBeforeHook()              // Pre-tool execution hook (plan-approval.ts)
createToolExecuteAfterHook()               // Post-tool execution hook (plan-approval.ts)
createPlanApprovalEventHook()              // Plan approval event hook (plan-approval.ts)
```

Additional hooks available via direct imports (not re-exported by the barrel):
- `createSandboxToolBeforeHook()` / `createSandboxToolAfterHook()` — sandbox tool redirection (`sandbox-tools.ts`)
- `createForgeSessionAttachHook()` / `createForgeSessionMessageAttachHook()` — auto-attach loops on session events (`forge-session-attach.ts`)
- `createLoopPermissionRejectHook()` — patch subagent permissions on `session.created` (`loop-permission.ts`)
- `createPlanCaptureEventHook()` — plan marker extraction from streaming parts and on `message.updated` for completed assistant messages (`plan-capture.ts`)

Source: [src/hooks/index.ts](../src/hooks/index.ts)

---

## `loop/` — Core Loop State Machine

The heart of Forge. Implements autonomous iterative development with phases: `coding → auditing → final_auditing → post_action`.

### Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API barrel (all re-exports) |
| `runtime.ts` | `createLoop()` factory, `Loop` interface |
| `service.ts` | DB-backed `LoopService` (`createLoopService`) |
| `state.ts` | Discriminated union `LoopState` (4 phases: `coding`, `auditing`, `final_auditing`, `post_action`), row↔state converters |
| `transitions.ts` | Pure `nextTransition()` table — no side effects; includes `'post-action-complete'` event and `handlePostActionEvent` |
| `termination.ts` | `TerminationReason` union, `terminationStatusFor()` |
| `prompts.ts` | Prompt builders for each loop phase, including `buildPostActionPrompt()` |
| `post-action-config.ts` | `ResolvedPostActionConfig` interface and `resolvePostActionConfig()` resolver |
| `section-summary.ts` | Parse audit output markers |
| `idle-gate.ts` | Session busy detection and timeout tracking |
| `in-flight-guard.ts` | Single-flight guard for concurrent loop start attempts |
| `restartability.ts` | `getRestartability()` — decides whether a non-completed loop can restart, blocked, or requires force |
| `token-usage.ts` | Extract and normalize per-message usage from session output |
| `name-uniqueness.ts` | Reserve a unique loop identity before any side effects |
| `session-output.ts` | Fetch session output for loop display |

### Key Types

```typescript
type Phase = 'coding' | 'auditing' | 'final_auditing' | 'post_action'

type LoopState =
  | CodingState
  | AuditingState
  | FinalAuditingState
  | PostActionState

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
loopRowToState(row, largeFields?): LoopState
loopStateToRow(state, projectId): LoopRow
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
buildPostActionPrompt(state, opts): string

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
| `deterministic-decomposer.ts` | Slice a plan into milestones (`section_plans` rows) deterministically — called once at loop start by `execution.ts`, not a runtime loop phase |
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
| `SectionPlansRepo` | `section_plans` | `SectionPlanRow` — one row per **milestone** (decomposed plan section). See [Loop System](loop-system.md#milestones-aka-sections). |
| `LoopSessionUsageRepo` | `loop_session_usage` | `LoopSessionUsageRow`, `LoopUsageAggregate` |
| `TuiPrefsRepo` | `tui_preferences` | N/A |

### Migrations

Sequential numbered `.sql` files (100–131) tracked in a `migrations` table.

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
| `execute-plan` | `loop.ts` | Execute a plan using an iterative development loop, or `mode: new-session` for a fresh standalone session. Args: `title` required; `plan`, `loopName`, `hostSessionId`, `mode` optional. |
| `execute-goal` | `loop.ts` | Execute a non-empty goal in a dedicated session inside a managed worktree. Args: `goal` required; `title`, `loopName`, `maxIterations`, `hostSessionId` optional. |
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
  loopSessionUsageRepo: LoopSessionUsageRepo
  workspaceStatusRegistry: WorkspaceStatusRegistry
  pendingTeardowns: PendingTeardownRegistry
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
| Plan | `plan-execution.ts`, `plan-capture.ts`, `plan-archive.ts` | Plan parsing and archiving |
| Sections | `section-capture.ts`, `section-summary.ts` | Section extraction/summary parsing |
| Loop | `loop-helpers.ts`, `loop-format.ts`, `loop-session.ts` | Loop model/format/session helpers |
| Sessions | `audit-session.ts`, `session-titles.ts` | Session naming |
| TUI | `tui-client.ts`, `tui-plan-store.ts`, `tui-loop-store.ts`, `tui-execution-preferences.ts`, `tui-execution-context-cache.ts`, `tui-models.ts` | TUI RPC, storage, preferences, models |
| Remote | `remote-config.ts`, `tui-remote-launch.ts` | Remote server config resolution and remote loop launch (see also `createRemoteForgeClient` in `client/sdk-adapter.ts`) |
| Workspace | `worktree-cleanup.ts`, `workspace-listing.ts`, `workspace-status-registry.ts` | Worktree/workspace lifecycle |
| Misc | `partial-match.ts`, `model-fallback.ts`, `busy-guard.ts`, `sandbox-ready.ts`, `format.ts` | Various helpers |

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
createDockerService(logger, opts?) // Docker (opts.execUser = host UID:GID for `docker exec --user`)
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
- Rows are mapped to domain objects via `loopRowToState()` etc.

### State Machine Pattern

The loop follows a strict phase-based state machine:
- States: `coding`, `auditing`, `final_auditing`, `post_action`
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
