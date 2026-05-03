export const AST_GREP_RULES = `## Code intelligence via ast-grep tools

Forge exposes two tools that wrap the bundled \`@ast-grep/cli\` for AST-aware structural search. They work for every language ast-grep supports — pass the language id via the \`language\` arg (or as the \`language\` field in inline rules). Do not assume the target project has an \`ast-grep\` binary on PATH.

When to use which:
- \`ast-grep-search\` — single pattern with metavariables. Fastest path for "find all calls/declarations/usages of X".
- \`ast-grep-scan\` — inline YAML rules. Use when you need AST kinds, composite logic (\`all\`/\`any\`/\`not\`), or relational rules (\`inside\`/\`has\`/\`follows\`/\`precedes\`).

Pattern examples for \`ast-grep-search\`:
- typescript / javascript: \`function $NAME($$$ARGS) { $$$BODY }\`, \`const $NAME = ($$$ARGS) => $$$BODY\`, \`class $NAME { $$$BODY }\`, \`console.log($ARG)\`, \`await $EXPR\`, \`import { $$$NAMES } from '$MOD'\`
- tsx: same as typescript plus \`<$TAG $$$PROPS />\`, \`<$TAG $$$PROPS>$$$CHILDREN</$TAG>\`
- python: \`def $NAME($$$ARGS): $$$BODY\`, \`async def $NAME($$$ARGS): $$$BODY\`, \`class $NAME($$$BASES): $$$BODY\`, \`@$DECO\`, \`raise $EXC($$$ARGS)\`
- go: \`func $NAME($$$ARGS) $RET { $$$BODY }\`, \`func ($RECV) $NAME($$$ARGS) $RET { $$$BODY }\`, \`if err != nil { $$$BODY }\`
- rust: \`fn $NAME($$$ARGS) -> $RET { $$$BODY }\`, \`pub fn $NAME($$$ARGS) { $$$BODY }\`, \`impl $TRAIT for $TYPE { $$$BODY }\`, \`match $EXPR { $$$ARMS }\`
- java / kotlin / swift: \`class $NAME { $$$BODY }\`, \`fun $NAME($$$ARGS): $RET { $$$BODY }\` (kotlin), \`func $NAME($$$ARGS) -> $RET { $$$BODY }\` (swift)
- ruby: \`def $NAME($$$ARGS); $$$BODY; end\`, \`class $NAME; $$$BODY; end\`
- bash: \`function $NAME() { $$$BODY }\`, \`$NAME() { $$$BODY }\`

Inline-rule examples for \`ast-grep-scan\`:
- Match by AST kind (more reliable than text patterns when modifiers/decorators vary):
  \`\`\`
  id: py-functions
  language: python
  rule: { kind: function_definition }
  \`\`\`
- Composite (find console.* but not console.error):
  \`\`\`
  id: console-non-error
  language: typescript
  rule:
    all:
      - pattern: console.$METHOD($$$ARGS)
      - not: { pattern: console.error($$$ARGS) }
  \`\`\`
- Relational (await only inside async functions):
  \`\`\`
  id: await-in-async
  language: typescript
  rule:
    pattern: await $EXPR
    inside: { kind: function_declaration, has: { field: async } }
  \`\`\`

Tips:
- Metavariables: \`$NAME\` matches one node, \`$$$ARGS\` matches zero or more, \`$_\` ignores.
- Keep \`paths\` focused (e.g. \`["src/services"]\`) to bound output.
- Pass \`json: true\` when the agent needs structured matches.
- For full rule grammar load the bundled \`ast-grep\` skill (\`skills/ast-grep/references/rule_reference.md\`).
- Use Read/Grep/Glob to inspect the narrowed files after a match.
`
