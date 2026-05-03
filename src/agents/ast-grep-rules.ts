export const AST_GREP_RULES = `## Code intelligence via ast-grep

You have access to native ast-grep tools (\`ast-grep-search\`, \`ast-grep-inspect\`, \`ast-grep-rewrite-preview\`) for AST-aware search, inspection, and rewrite previews. These tools are powered by \`@ast-grep/napi\` and official \`@ast-grep/lang-*\` parser packages for all bundled ast-grep languages.

When to reach for them:
- Need syntax-aware search? Use \`ast-grep-search\` with a pattern such as \`console.log($A)\` or a NapiConfig-style rule.
- Need to learn AST shape before writing a precise query? Use \`ast-grep-inspect\` on one source/file and request parent, ancestor, or child summaries only when needed.
- Need a safe codemod preview? Use \`ast-grep-rewrite-preview\`; it returns edits and transformed output but never writes files.
- For many files, prefer \`ast-grep-search\` with \`paths\`; it uses ast-grep's parallel file search internally.
- Keep outputs bounded with \`maxResults\` or \`maxEdits\`, and use Read/Grep when large tool output is spilled to disk.
`
