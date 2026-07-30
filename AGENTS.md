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
- Keep the four required headings in `src/prompts/agents/goal.md` synchronized with `GOAL_BRIEF_REQUIRED_HEADINGS` in `src/utils/goal-brief.ts`.
- Goal launches from the TUI must set `initialPromptOwner: 'server'` so `attachLoopToSession` builds the prompt from `buildGoalCodingPrompt`. `buildTuiLoopInitialPrompt` is plan-only because it decomposes and sends section 1; it must not be reused for goal loops.
- `MAX_TOTAL_SECTIONS` in `src/constants/loop.ts` is the single section cap; the decomposer, section bootstrap, plan structure summary, TUI inline plan preview and `plan-adjust` all read it, and the architect system reminder in `src/index.ts` interpolates it. `src/prompts/agents/architect.md` is prose and repeats the number literally — update it when the cap changes.
- `PLAN_AUTHORING_TOOL_NAMES` in `src/constants/loop.ts` is the single list of plan-authoring tools; the `code`, `auditor`, and `feature-splitter` tool-exclude lists derive their deny entries from it. `GOAL_AUTHORING_TOOL_NAMES` is the single list of goal-authoring tools (`goal-write` only). `SPEC_AUTHORING_TOOL_NAMES` (the plan list plus the goal list) is what `code`, `auditor`, and `feature-splitter` spread into their tool-exclude lists AND what both permission rulesets (`buildLoopPermissionRuleset`, `buildAuditSessionPermissionRuleset`) derive their deny entries from, so `goal-write` is denied in any running or audit session. The `architect` and `architect-auto` agents append `GOAL_AUTHORING_TOOL_NAMES` only (they keep `plan-write`/`plan-edit`). The `goal` agent spreads only `PLAN_AUTHORING_TOOL_NAMES` and is the **only** agent that may call `goal-write`. `assertWritableSession` in `src/tools/session-write-guard.ts` is the single shared guard both `plan-authoring.ts` and `goal-authoring.ts` call to reject writes from an active loop session.
- `LoopService.resolveActiveLoopForSession` is the only correct "is this session inside a running loop" check. `resolveLoopName` matches terminated loops too, so using it as an activity guard blocks a session forever after its loop ends.
- `resolveForgeDbPath` in `src/utils/opencode-paths.ts` is the only place `<dataDir>/forge.db` is built; every entry point must route through it so a configured `dataDir` is honoured uniformly.
- `resolveLoopLaunchPolicy` in `src/utils/loop-helpers.ts` is the single resolution point for the loop launch policy (`loop.enabled` and `loop.defaultMaxIterations`). The `execute-plan`/`execute-goal` handlers in `src/services/execution.ts`, the TUI launch path in `src/utils/tui-client.ts`, the remote launch path in `src/utils/tui-remote-launch.ts`, and the attach hook fallback in `src/hooks/forge-session-attach.ts` all read it. The TUI/remote launch path stamps the resolved `maxIterations` onto the `forgeLoop` envelope (`ForgeLoopExtra.maxIterations`) so the attach hook honours the launcher's promise first and only falls back to the server-side policy when the stamp is absent. Local TUI launches set `awaitAttachAck` so `launchTuiLoop` polls the shared forge database for the running loop row before reporting success; remote launches cannot observe the remote database and remain fire-and-forget. `connectForgeProject` is the only TUI entry point that receives `pluginConfig`/`awaitAttachAck` (population from `src/tui.tsx`).

## Dashboard and storage gotchas

- The dashboard browser app uses `solid-js/html`, not JSX. Do not use `<${Show}>` or `<${For}>`; use reactive thunks/memos and `.map()`. Every template needs a real root element, reactive regions must be functions such as `${() => ...}`, and the root component returns one wrapper element. `test/dashboard/app-dom.test.ts` enforces these constraints.
- Storage migrations are registered explicitly, in execution order, in the lowercase `migrations` array in `src/storage/migrations/index.ts`; they are not discovered from filenames. Inline migrations are valid, so not every migration needs a SQL file.
- `goal_briefs` is the pre-launch authoring store for goal briefs; `loop_large_fields.goal` remains the launched loop's copy. Goal loops still never write `plans` rows (`src/loop/service.ts:183-194`).
- `fetchStoredSessionLaunchSpec` in `src/utils/tui-loop-store.ts` is the only place the dialog resolves a launchable artifact; it reads both stores (plans and goal briefs) in one DB open and the newest wins with plans breaking ties.
- `resolveDashboardConfig` in `src/dashboard/config.ts` is the only place the dashboard bind host/port is resolved, and `DEFAULT_DASHBOARD_PORT`/`DEFAULT_DASHBOARD_HOST` are the only copies of the *bind* defaults. The literal `localhost` in `buildDashboardUrls` is deliberately separate: it is the loopback display URL and must not follow the configured bind host. Every launch surface (`scripts/dashboard.ts`, the TUI `forge.dashboard` command) must pass its overrides plus the loaded `PluginConfig` into `startDashboardServer` rather than resolving them itself, and must render `DashboardServerHandle.warnings` so an unusable value is never dropped silently on one surface only. The dashboard has no auth; `DASHBOARD_EXPOSED_WARNING` is the single warning string.

## Diagnostics

- Logging is disabled by default. When enabled, logs default to `$XDG_DATA_HOME/opencode/forge/logs/forge.log` (falling back to `~/.local/share/opencode/forge/logs/forge.log`); `logging.file` in `forge-config.jsonc` overrides it.
