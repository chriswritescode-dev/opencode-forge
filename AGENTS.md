# Repository Guide

## Toolchain and checks

- Install with `pnpm install --frozen-lockfile`; `pnpm-lock.yaml` is canonical. Bun is still required because build, setup, and dashboard scripts run through it—do not substitute `bun install`.
- Full verification: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`. Build must precede tests because `test/dashboard/app-bundle.test.ts` rejects a stale source hash.
- Focus a Node test with `pnpm test --project node test/path.test.ts`; add `-t "test name"` for one case. Run dashboard DOM tests with `pnpm test --project dom test/dashboard/app-dom.test.ts`. The `dom` project is the only happy-dom suite; all other tests use the `node` project and a `bun:sqlite` shim.
- `pnpm typecheck` covers `src/`, not tests or scripts. ESLint also ignores tests and generated dashboard files.

## Package surfaces

- Server plugin `src/index.ts` — published as root (`.`) and `./server` alias. TUI plugin `src/tui.tsx`. Installer CLI `src/install/cli.ts` (bin). Standalone dashboard via `pnpm dashboard` (`scripts/dashboard.ts`); not a package export.
- `src/index.ts` is the server composition root. Core boundaries: `src/loop/` (runtime/state machine), `src/storage/` (database and repositories), `src/tools/` (OpenCode tools), `src/agents/` (agent definitions).

## Generated and bundled files

- `pnpm build` rewrites `src/version.ts`, `src/dashboard/marked-source.ts`, and `src/dashboard/app-bundle.ts`. Edit `package.json`, `src/dashboard/marked.min.js`, or `src/dashboard/app/` respectively, never the generated files.
- The build does not clean `dist/`; remove stale output when deleting or renaming source modules.
- Bundled prompts (`src/prompts/`) and skills (`skills/`) sync on every plugin load, preserving user edits. The standalone installer handles conflicts and orphan pruning.
- Keep section-summary markers in `src/prompts/agents/auditor-loop-addendum.md` synchronized with constants in `src/utils/section-summary.ts`.

## Loop runtime

- `MAX_TOTAL_SECTIONS` in `src/constants/loop.ts` is the single section cap. Update both `architect.md` and `architect-auto.md` prose when it changes.
- `PLAN_AUTHORING_TOOL_NAMES` and `FORGE_MANAGED_PERMISSIONS`/`FORGE_REQUIRED_PERMISSIONS` in `src/constants/loop.ts` are the single sources for tool-exclude lists, permission rulesets, and the audit ruleset. Do not re-list tool names by hand.
- Watchdog has exactly two progress signals (`recordActivity`, `recordSessionContent`); `busy` is not one of them. Content signal is fed from `loop.tick` first branch, must stay O(1). Busy ceiling (`busyStallTimeoutMs`) is measured from the newest of both across loop and subagent sessions.
- Multiple plugin instances share one process. Ownership gate: `ownsLoopWorktree` in `src/loop/runtime.ts` compares `directory` to `worktreeDir` via `canonicalizePath`. `startWatchdog` and `session.error` handler gate on it — fail-safe, never a hang. Do not extend the gate to the idle handler.
- `LoopService.resolveActiveLoopForSession` is the only correct "is this session inside a running loop" check. `resolveLoopName` matches terminated loops too.

## Sandbox

- `src/sandbox/msb.ts` is the sole TypeScript runtime/lifecycle facade and `msb` CLI argument owner; route runtime operations through its `SandboxRuntime` facade. The one required exception is the generated shell shim (`src/sandbox/shell-shim.ts`), which invokes `msb exec` directly when an agent shell command must run inside a sandbox. `src/sandbox/process.ts` is the only child-process spawner; all TypeScript shell execution goes through `runCommand`.
- `getSandboxState` is the only liveness primitive; four states: `running`, `stopped` (reusable, never create/evict), `unknown` (query failed), `missing` (may create or evict). `Stopped`/`Crashed` map to the reusable `stopped` state because `msb exec` starts them in place. `registerActiveSandbox` is the only place a usable sandbox is recorded.
- `container/Dockerfile` must derive from a plain OCI base and keep the final `USER agent`; `ENTRYPOINT`/`CMD` are ignored because msb runs `agentd` as PID 1.

## Dashboard, storage, and paths

- Dashboard uses `solid-js/html`, not JSX. No `<${Show}>` or `<${For}>`; use reactive thunks/memos and `.map()`. Root component returns one wrapper element. `test/dashboard/app-dom.test.ts` enforces these constraints.
- `src/dashboard/render.ts` owns the stylesheet; `test/dashboard/render.test.ts` enforces CSS token usage, sticky stack `--z-subnav` < `--z-app-bar` < `--z-popover`, app-bar height variables at relevant breakpoints, and matching loop-table `data-col` attributes.
- Storage migrations are registered explicitly, in execution order, in the lowercase `migrations` array in `src/storage/migrations/index.ts`; they are not discovered from filenames.
- `resolveDashboardConfig` in `src/dashboard/config.ts` is the only dashboard bind host/port resolver. Every launch surface must pass overrides into `startDashboardServer` and render warnings. Dashboard has no auth; `DASHBOARD_EXPOSED_WARNING` is the single warning.
- `resolveForgeDbPath` in `src/utils/opencode-paths.ts` is the only place `<dataDir>/forge.db` is built.
