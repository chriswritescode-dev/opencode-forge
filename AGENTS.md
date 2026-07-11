# Repository Guide

## Toolchain and checks

- Install with `pnpm install --frozen-lockfile`; `pnpm-lock.yaml` is canonical. Bun is still required because build, setup, and dashboard scripts run through it—do not substitute `bun install`.
- Full source verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Focus a Node test with `pnpm test -- --project node test/path.test.ts`; add `-t "test name"` for one case.
- Run dashboard DOM tests with `pnpm test -- --project dom test/dashboard/app-dom.test.ts`. The `dom` project is the only happy-dom/browser-conditions suite; all other tests use the `node` project and a `bun:sqlite` shim.
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

## Dashboard and storage gotchas

- The dashboard browser app uses `solid-js/html`, not JSX. Do not use `<${Show}>` or `<${For}>`; use reactive thunks/memos and `.map()`. Every template needs a real root element, reactive regions must be functions such as `${() => ...}`, and the root component returns one wrapper element. `test/dashboard/app-dom.test.ts` enforces these constraints.
- Storage migrations are registered explicitly, in execution order, in the lowercase `migrations` array in `src/storage/migrations/index.ts`; they are not discovered from filenames. Inline migrations are valid, so not every migration needs a SQL file.

## Diagnostics

- Logging is disabled by default. When enabled, logs default to `$XDG_DATA_HOME/opencode/forge/logs/forge.log` (falling back to `~/.local/share/opencode/forge/logs/forge.log`); `logging.file` in `forge-config.jsonc` overrides it.
