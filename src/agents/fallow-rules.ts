export const FALLOW_RULES = `## Code intelligence via fallow

You have access to the \`fallow\` CLI (installed in node_modules; invoke via \`pnpm exec fallow ...\` or \`npx fallow ...\` if direct \`fallow\` is not on PATH). Use it for structural code intelligence — dead code, duplicates, circular deps, boundary violations, complexity, and unused exports — instead of hand-rolled grep/AST work.

### When to use fallow
- Before finalizing non-trivial changes, run \`fallow dead-code\` and \`fallow dupes\` scoped to the changed area to confirm you did not leave unused exports or duplicated logic.
- For impact/blast-radius questions, run \`fallow audit --base <branch>\` or \`fallow health --top 10\`.
- For dependency / circular-import questions, use \`fallow check\` (alias of \`dead-code\`) which also reports unresolved imports and unlisted deps.
- For "is this exported symbol used anywhere?" questions, use \`fallow dead-code --format json --quiet\` and search \`unusedExports\`.

### Mandatory invocation flags for agent use
1. Always pass \`--format json --quiet\` for machine output.
2. Always redirect stderr (\`2>/dev/null\`) and append \`|| true\` — exit code 1 means "issues found", not failure. Only exit code 2 is a real error.
3. Use \`--explain\` to include \`_meta\` definitions in JSON output.
4. Always run \`fallow fix --dry-run\` before \`fallow fix --yes\`. Never run \`fallow fix\` without \`--yes\` in non-TTY contexts.
5. Never run \`fallow watch\` — it is interactive and never exits.

### Discovery hierarchy
1. **Targeted file/symbol questions**: Use \`Read\` directly when you already know the file path and symbol.
2. **Code intelligence (dead code, dupes, deps, complexity, boundaries)**: Use \`fallow\` first — it is faster and more accurate than grep-based heuristics.
3. **Open-ended codebase research**: Use Task/explore agents in parallel.
4. **File search**: Use Glob for filename pattern matches.
5. **Content search**: Use Grep for literal string/regex matches.

### Output conventions
- Fallow output paths are relative to project root.
- JSON envelope: top-level \`results\` array + optional \`_meta\` for definitions.
`
