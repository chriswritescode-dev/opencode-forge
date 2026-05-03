export const FALLOW_RULES = `## Code intelligence via fallow

Use the \`fallow\` skill for structural code intelligence. Load it with the Skill tool when you need dead-code, duplicate, dependency, complexity, boundary, or blast-radius analysis.

Quick rules before the skill is loaded:
- Prefer \`pnpm exec fallow ...\` for CLI calls.
- Always pass \`--format json --quiet --explain\`, redirect stderr with \`2>/dev/null\`, and append \`|| true\` because exit code 1 means issues were found.
- Never run \`fallow watch\`.
- Use Read directly for known target files/symbols, fallow for structural questions, Task/explore for open-ended research, Glob for filename pattern matching, and Grep for content search.
`
