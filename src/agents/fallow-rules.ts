export const FALLOW_RULES = `## Code intelligence via fallow

You have access to the \`fallow\` CLI for structural code intelligence: dead code, unused exports, duplicate logic, circular dependencies, dependency boundaries, complexity hotspots, and blast-radius analysis.

- Prefer \`pnpm exec fallow ...\` for CLI calls.
- Always pass \`--format json --quiet --explain\` for machine-readable output.
- Always redirect stderr with \`2>/dev/null\` and append \`|| true\`; exit code 1 means issues were found, not that the command failed.
- Never run \`fallow watch\`.
- Use \`pnpm exec fallow dead-code --format json --quiet --explain 2>/dev/null || true\` for unused exports, unresolved imports, and unlisted dependencies.
- Use \`pnpm exec fallow check --format json --quiet --explain 2>/dev/null || true\` when dependency health is the question.
- Use \`pnpm exec fallow dupes --format json --quiet --explain 2>/dev/null || true\` for duplicated logic.
- Use \`pnpm exec fallow audit --base <branch> --format json --quiet --explain 2>/dev/null || true\` for changed-file impact and blast radius.
- Use \`pnpm exec fallow health --top 10 --format json --quiet --explain 2>/dev/null || true\` for complexity and maintainability hotspots.
- Use Read directly for known target files/symbols, fallow for structural questions, Task/explore for open-ended research, Glob for filename pattern matching, and Grep for content search.
- Treat paths in fallow output as relative to the project root and summarize only findings relevant to the user's task or changed files.
`
