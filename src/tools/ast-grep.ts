import { tool } from '@opencode-ai/plugin'
import { execFile } from 'child_process'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
import { promisify } from 'util'
import type { ToolContext } from './types'

const z = tool.schema
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

function resolveAstGrepBinary(): string {
  const packageJsonPath = require.resolve('@ast-grep/cli/package.json')
  return resolve(dirname(packageJsonPath), process.platform === 'win32' ? 'ast-grep.cmd' : 'ast-grep')
}

function normalizePaths(paths: string[] | undefined): string[] {
  const values = paths?.filter((path) => path.trim().length > 0)
  return values?.length ? values : ['.']
}

async function runAstGrep(args: string[], cwd: string): Promise<string> {
  const binary = resolveAstGrepBinary()
  try {
    const result = await execFileAsync(binary, args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 5,
    })
    return result.stdout.trim() || result.stderr.trim() || 'No matches found.'
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number }
    const output = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n')
    if (err.code === 1 && !output) return 'No matches found.'
    return output || err.message
  }
}

const SEARCH_DESCRIPTION = `Run the bundled @ast-grep/cli for AST-aware structural search. Wraps \`ast-grep run --pattern\`. Supports every language ast-grep supports; pass the language id via the \`language\` arg.

Pattern examples by language:
- typescript / javascript: \`function $NAME($$$ARGS) { $$$BODY }\`, \`const $NAME = ($$$ARGS) => $$$BODY\`, \`class $NAME { $$$BODY }\`, \`console.log($ARG)\`, \`await $EXPR\`, \`import { $$$NAMES } from '$MOD'\`
- tsx: same as typescript plus \`<$TAG $$$PROPS />\`, \`<$TAG $$$PROPS>$$$CHILDREN</$TAG>\`
- python: \`def $NAME($$$ARGS): $$$BODY\`, \`async def $NAME($$$ARGS): $$$BODY\`, \`class $NAME($$$BASES): $$$BODY\`, \`@$DECO\`, \`raise $EXC($$$ARGS)\`
- go: \`func $NAME($$$ARGS) $RET { $$$BODY }\`, \`func ($RECV) $NAME($$$ARGS) $RET { $$$BODY }\`, \`if err != nil { $$$BODY }\`
- rust: \`fn $NAME($$$ARGS) -> $RET { $$$BODY }\`, \`pub fn $NAME($$$ARGS) { $$$BODY }\`, \`impl $TRAIT for $TYPE { $$$BODY }\`, \`match $EXPR { $$$ARMS }\`
- java / kotlin / swift: \`class $NAME { $$$BODY }\`, \`fun $NAME($$$ARGS): $RET { $$$BODY }\` (kotlin), \`func $NAME($$$ARGS) -> $RET { $$$BODY }\` (swift)
- ruby: \`def $NAME($$$ARGS); $$$BODY; end\`, \`class $NAME; $$$BODY; end\`
- bash: \`function $NAME() { $$$BODY }\`, \`$NAME() { $$$BODY }\`

Metavariables: \`$NAME\` matches one node, \`$$$ARGS\` matches zero or more. Use \`$_\` to ignore. Keep \`paths\` focused to bound output. Use \`json: true\` when the agent needs to parse matches.`

const SCAN_DESCRIPTION = `Run the bundled @ast-grep/cli scan command with inline YAML rules. Use this when a single pattern is not enough — for kind-based matching, composite rules (\`all\`/\`any\`/\`not\`), relational rules (\`inside\`/\`has\`/\`follows\`/\`precedes\`), or constraints on metavariables.

Inline rule examples:

Find all Python function definitions by AST kind (more reliable than text patterns for decorators/async/etc.):
\`\`\`yaml
id: py-functions
language: python
rule: { kind: function_definition }
\`\`\`

Find awaits inside async functions only:
\`\`\`yaml
id: await-in-async
language: typescript
rule:
  pattern: await $EXPR
  inside: { kind: function_declaration, has: { field: async } }
\`\`\`

Find console.* calls excluding console.error:
\`\`\`yaml
id: console-non-error
language: typescript
rule:
  all:
    - pattern: console.$METHOD($$$ARGS)
    - not: { pattern: console.error($$$ARGS) }
\`\`\`

Find Go functions returning error without nil-check on the call site:
\`\`\`yaml
id: unchecked-error
language: go
rule:
  pattern: $FN($$$ARGS)
  not:
    follows:
      pattern: if err != nil { $$$ }
\`\`\`

Find Rust unwrap() in non-test code:
\`\`\`yaml
id: prod-unwrap
language: rust
rule:
  pattern: $EXPR.unwrap()
  not:
    inside: { kind: function_item, has: { pattern: '#[test]' } }
\`\`\`

See the bundled \`ast-grep\` skill (\`skills/ast-grep/references/rule_reference.md\`) for the full rule grammar.`

export function createAstGrepTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  return {
    'ast-grep-search': tool({
      description: SEARCH_DESCRIPTION,
      args: {
        pattern: z.string().describe('ast-grep pattern, e.g. "console.log($ARG)" or "def $NAME($$$ARGS): $$$BODY"'),
        language: z.string().describe('Language id (typescript, tsx, javascript, python, go, rust, java, kotlin, swift, ruby, php, bash, lua, c, cpp, csharp, etc.).'),
        paths: z.array(z.string()).optional().describe('Files or directories to search, relative to the working directory. Defaults to ["."]. Keep this focused to bound output.'),
        json: z.boolean().optional().describe('Return ast-grep JSON output Useful to parse matches.'),
      },
      execute: async (args, toolCtx) => {
        const cwd = toolCtx?.directory ?? toolCtx?.worktree ?? ctx.directory
        const cliArgs = ['run', '--pattern', args.pattern, '--lang', args.language]
        if (args.json) cliArgs.push('--json=compact')
        cliArgs.push(...normalizePaths(args.paths))
        ctx.logger.log(`ast-grep-search: ${cliArgs.join(' ')}`)
        return runAstGrep(cliArgs, cwd)
      },
    }),

    'ast-grep-scan': tool({
      description: SCAN_DESCRIPTION,
      args: {
        inlineRules: z.string().describe('Inline ast-grep YAML rules passed to --inline-rules. Must include id, language, and rule fields.'),
        paths: z.array(z.string()).optional().describe('Files or directories to scan, relative to the working directory. Defaults to ["."]. Keep this focused to bound output.'),
        json: z.boolean().optional().describe('Return ast-grep JSON output.'),
      },
      execute: async (args, toolCtx) => {
        const cwd = toolCtx?.directory ?? toolCtx?.worktree ?? ctx.directory
        const cliArgs = ['scan', '--inline-rules', args.inlineRules]
        if (args.json) cliArgs.push('--json=compact')
        cliArgs.push(...normalizePaths(args.paths))
        ctx.logger.log('ast-grep-scan: scan --inline-rules <rules>')
        return runAstGrep(cliArgs, cwd)
      },
    }),
  }
}
