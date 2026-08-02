# Repository Guide

## Toolchain and checks

- Install with `pnpm install --frozen-lockfile`; `pnpm-lock.yaml` is canonical. Bun is still required because build, setup, and dashboard scripts run through it—do not substitute `bun install`.
- Full source verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Focus a Node test with `pnpm test --project node test/path.test.ts`; add `-t "test name"` for one case.
- Run dashboard DOM tests with `pnpm test --project dom test/dashboard/app-dom.test.ts`. The `dom` project is the only happy-dom/browser-conditions suite; all other tests use the `node` project and a `bun:sqlite` shim.
- `pnpm typecheck` covers `src/`, not tests or scripts. ESLint also ignores tests and generated dashboard files, so run the relevant Vitest project after changing them.

## Runtime boundaries

- This is one package with three published entrypoints: server plugin `src/index.ts`, TUI plugin `src/tui.tsx`, and installer CLI `src/install/cli.ts`.
- `src/index.ts` is the server composition root. Core boundaries are `src/loop/` (runtime/state machine), `src/storage/` (database and repositories), `src/tools/` (OpenCode tools), and `src/agents/` (agent definitions).
- `pnpm dashboard` runs the standalone read-only dashboard through `scripts/dashboard.ts`; it is not a package export.

## Generated and bundled files

- `pnpm build` rewrites `src/version.ts`, `src/dashboard/marked-source.ts`, and `src/dashboard/app-bundle.ts`. Edit `package.json`, `src/dashboard/marked.min.js`, or `src/dashboard/app/` respectively, never the generated files.
- After changing `src/dashboard/app/`, run `pnpm build` before tests; `test/dashboard/app-bundle.test.ts` rejects a stale source hash.
- The build does not clean `dist/`; remove stale output when deleting or renaming source modules before validating package contents.
- Bundled prompts live in `src/prompts/`; bundled skills live in `skills/`. They sync on every plugin load, preserving user edits and never deleting files. The standalone installer handles conflicts and orphan pruning.
- Keep the section-summary markers in `src/prompts/agents/auditor-loop-addendum.md` synchronized with the constants in `src/utils/section-summary.ts`.
- `MAX_TOTAL_SECTIONS` in `src/constants/loop.ts` is the single section cap; the decomposer, section bootstrap, plan structure summary, TUI inline plan preview and `plan-adjust` all read it, and the architect system reminder in `src/index.ts` interpolates it. `src/prompts/agents/architect.md` and `src/prompts/agents/architect-auto.md` are prose and repeat the number literally — update both when the cap changes.
- `PLAN_AUTHORING_TOOL_NAMES` in `src/constants/loop.ts` is the single list of plan-authoring tools; the `code`, `auditor`, and `feature-splitter` tool-exclude lists and both permission rulesets derive their deny entries from it — `code` imports it directly, while `auditor` and `feature-splitter` pick it up transitively through `SHARED_STRUCTURAL_DENY_PERMISSIONS`. No agent may re-list these names by hand.
- `FORGE_MANAGED_PERMISSIONS` in `src/constants/loop.ts` is the single list of permissions `loop.permissions` config may not name (the blanket allow, `external_directory`, and every structural deny); both permission rulesets derive their structural denies from the same three name lists (`SHARED_STRUCTURAL_DENY_PERMISSIONS`, `LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS`, `AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS`), and the supported ways to build ruleset options from `PluginConfig` are `resolveLoopPermissionOptions` (local config), `resolveRemoteLoopPermissionOptions` (remote launch, rules without host-specific directories), and the workspace-aware `resolveLoopPermissionOptionsForWorkspace` in `src/utils/loop-permission-options.ts` (merges portable `extra.permissionRules`). `FORGE_REQUIRED_PERMISSIONS` is the single list of loop-protocol and core tools a loop cannot function without (`review-read`, `plan-read`, `section-read`, `plan-adjust`, `bash`, `read`); `parseLoopPermissionRules` rejects every deny naming `FORGE_MANAGED_PERMISSIONS` but only *blanket* (pattern `*`) denies naming `FORGE_REQUIRED_PERMISSIONS`, so a scoped deny such as `bash`/`git push *` still works. The two sets are asserted disjoint.
- `LoopService.resolveActiveLoopForSession` is the only correct "is this session inside a running loop" check. `resolveLoopName` matches terminated loops too, so using it as an activity guard blocks a session forever after its loop ends.
- `resolveForgeDbPath` in `src/utils/opencode-paths.ts` is the only place `<dataDir>/forge.db` is built; every entry point must route through it so a configured `dataDir` is honoured uniformly.
- `buildAuditorModelChain`/`resolveLoopAuditorChoice` in `src/utils/loop-helpers.ts` are the only auditor model/variant resolution point (the chain index lives in `loops.auditor_fallback_index`), and `handleAuditorProviderLimit` in `src/loop/runtime.ts` is the only place that decides whether an auditor provider limit falls back or terminates. Every detection path routes through it, including the watchdog's `retry` status poll, which must call it via `withStateLock` because the handler assumes the caller already holds the per-loop lock. The index only moves forward through `advanceAuditorFallbackIndex`; it resets to `0` on a successful audit (both auditor phases) and on loop restart, so a transient limit never permanently drops `auditorVariant`.

## Sandbox single sources

- `src/sandbox/sbx.ts` is the only module that invokes the `sbx` CLI; every sandbox path must route through its `SandboxRuntime` facade rather than spawning `sbx` directly.
- `src/sandbox/process.ts` is the only child-process spawner in `src/sandbox/`; all sandbox shell execution goes through `runCommand`.
- `describeSbxUnavailable` in `src/sandbox/sbx.ts` is the only source of sbx-unavailable remediation text.
- `container/Dockerfile` must derive from `docker.io/docker/sandbox-templates:shell-docker` and must not declare `ENTRYPOINT`, `CMD`, or `WORKDIR`.
- `SHIM_ENV_CONTAINER` must stay `FORGE_SANDBOX_CONTAINER` because it is coupled to the public `{{FORGE_SANDBOX_CONTAINER}}` placeholder.

## Dashboard and storage gotchas

- The dashboard browser app uses `solid-js/html`, not JSX. Do not use `<${Show}>` or `<${For}>`; use reactive thunks/memos and `.map()`. Every template needs a real root element, reactive regions must be functions such as `${() => ...}`, and the root component returns one wrapper element. `test/dashboard/app-dom.test.ts` enforces these constraints.
- Storage migrations are registered explicitly, in execution order, in the lowercase `migrations` array in `src/storage/migrations/index.ts`; they are not discovered from filenames. Inline migrations are valid, so not every migration needs a SQL file.
- `resolveDashboardConfig` in `src/dashboard/config.ts` is the only place the dashboard bind host/port is resolved, and `DEFAULT_DASHBOARD_PORT`/`DEFAULT_DASHBOARD_HOST` are the only copies of the *bind* defaults. The literal `localhost` in `buildDashboardUrls` is deliberately separate: it is the loopback display URL and must not follow the configured bind host. Every launch surface (`scripts/dashboard.ts`, the TUI `forge.dashboard` command) must pass its overrides plus the loaded `PluginConfig` into `startDashboardServer` rather than resolving them itself, and must render `DashboardServerHandle.warnings` so an unusable value is never dropped silently on one surface only. The dashboard has no auth; `DASHBOARD_EXPOSED_WARNING` is the single warning string.

## Diagnostics

- Logging is disabled by default. When enabled, logs default to `$XDG_DATA_HOME/opencode/forge/logs/forge.log` (falling back to `~/.local/share/opencode/forge/logs/forge.log`); `logging.file` in `forge-config.jsonc` overrides it.
