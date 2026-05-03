# fallow

Use this skill when you need structural code intelligence: dead code, unused exports, duplicate logic, circular dependencies, dependency boundaries, complexity hotspots, or blast-radius analysis.

## CLI rules

- Prefer `pnpm exec fallow ...`.
- Always pass `--format json --quiet --explain` for machine-readable output.
- Always redirect stderr with `2>/dev/null` and append `|| true`; exit code 1 means issues were found, not that the command failed.
- Never run `fallow watch`.
- Use fallow for analysis only. Make needed edits through the normal editing tools when your role allows file changes.

## Command selection

- `pnpm exec fallow dead-code --format json --quiet --explain 2>/dev/null || true` — unused exports, unresolved imports, unlisted dependencies.
- `pnpm exec fallow check --format json --quiet --explain 2>/dev/null || true` — alias for dead-code; use when dependency health is the question.
- `pnpm exec fallow dupes --format json --quiet --explain 2>/dev/null || true` — duplicated logic.
- `pnpm exec fallow audit --base <branch> --format json --quiet --explain 2>/dev/null || true` — changed-file impact and blast radius.
- `pnpm exec fallow health --top 10 --format json --quiet --explain 2>/dev/null || true` — complexity and maintainability hotspots.

## Discovery hierarchy

1. Read known target files/symbols directly.
2. Use fallow for structural questions.
3. Use Task/explore agents for broad codebase research.
4. Use Glob for filename search.
5. Use Grep for content search.

## Reporting

- Treat paths in fallow output as relative to the project root.
- Expect a JSON envelope with `results` and optional `_meta` definitions.
- Summarize only findings relevant to the user's task or changed files.
