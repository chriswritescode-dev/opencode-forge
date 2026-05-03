import { tool } from '@opencode-ai/plugin'
import { resolve, isAbsolute } from 'path'
import { readFile } from 'fs/promises'
import { createRequire } from 'module'
import type { ToolContext } from './types'
import type * as AstGrep from '@ast-grep/napi'
import type { NapiConfig, SgNode, SgRoot, FindConfig, DynamicLangRegistrations } from '@ast-grep/napi'
import type { NapiLang } from '@ast-grep/napi/types/lang'

const z = tool.schema
const require = createRequire(import.meta.url)

type AstGrepModule = typeof AstGrep

export type AstGrepLoader = () => Promise<AstGrepModule>

export const AST_GREP_DEFAULT_TOOL_NAMES = [
  'ast-grep-search',
  'ast-grep-inspect',
  'ast-grep-rewrite-preview',
] as const

export type AstGrepToolName = typeof AST_GREP_DEFAULT_TOOL_NAMES[number]

export const AST_GREP_LANGUAGES = [
  'Bash',
  'C',
  'Cpp',
  'CSharp',
  'Css',
  'Dart',
  'Elixir',
  'Go',
  'Html',
  'Java',
  'JavaScript',
  'Json',
  'Kotlin',
  'Php',
  'Python',
  'Ruby',
  'Rust',
  'Scala',
  'Swift',
  'Toml',
  'Tsx',
  'TypeScript',
  'Yaml',
] as const

export type AstGrepLanguage = typeof AST_GREP_LANGUAGES[number]

export interface CreateAstGrepToolsOptions {
  loader?: AstGrepLoader
}

const defaultLoader: AstGrepLoader = async () => {
  return await import('@ast-grep/napi')
}

type LanguageRegistration = DynamicLangRegistrations[string]

const AST_GREP_LANGUAGE_PACKAGES: Record<AstGrepLanguage, string> = {
  Bash: '@ast-grep/lang-bash',
  C: '@ast-grep/lang-c',
  Cpp: '@ast-grep/lang-cpp',
  CSharp: '@ast-grep/lang-csharp',
  Css: '@ast-grep/lang-css',
  Dart: '@ast-grep/lang-dart',
  Elixir: '@ast-grep/lang-elixir',
  Go: '@ast-grep/lang-go',
  Html: '@ast-grep/lang-html',
  Java: '@ast-grep/lang-java',
  JavaScript: '@ast-grep/lang-javascript',
  Json: '@ast-grep/lang-json',
  Kotlin: '@ast-grep/lang-kotlin',
  Php: '@ast-grep/lang-php',
  Python: '@ast-grep/lang-python',
  Ruby: '@ast-grep/lang-ruby',
  Rust: '@ast-grep/lang-rust',
  Scala: '@ast-grep/lang-scala',
  Swift: '@ast-grep/lang-swift',
  Toml: '@ast-grep/lang-toml',
  Tsx: '@ast-grep/lang-tsx',
  TypeScript: '@ast-grep/lang-typescript',
  Yaml: '@ast-grep/lang-yaml',
}

let languagesRegistered = false

const loadLanguageRegistration = (language: AstGrepLanguage): LanguageRegistration => {
  try {
    const registration = require(AST_GREP_LANGUAGE_PACKAGES[language]) as LanguageRegistration | { default: LanguageRegistration }
    return 'default' in registration ? registration.default : registration
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to load ast-grep language package for ${language}: ${msg}. Install ${AST_GREP_LANGUAGE_PACKAGES[language]} and ensure its native parser prebuild resolved.`,
      { cause: err },
    )
  }
}

const registerAstGrepLanguages = (astGrep: AstGrepModule): void => {
  if (languagesRegistered || typeof astGrep.registerDynamicLanguage !== 'function') return
  const registrations = Object.fromEntries(
    AST_GREP_LANGUAGES.map(language => [language, loadLanguageRegistration(language)]),
  ) as DynamicLangRegistrations
  astGrep.registerDynamicLanguage(registrations)
  languagesRegistered = true
}

const resolveRoot = (ctxRoot: string, toolCtx?: { directory?: string; worktree?: string }): string =>
  toolCtx?.directory ?? toolCtx?.worktree ?? ctxRoot

const resolveInputPath = (root: string, inputPath: string): string => {
  if (isAbsolute(inputPath)) return inputPath
  return resolve(root, inputPath)
}

const toLang = (astGrep: AstGrepModule, language: AstGrepLanguage): NapiLang => {
  return astGrep.Lang[language as keyof typeof astGrep.Lang] ?? language
}

interface MatcherArgs {
  pattern?: string
  rule?: unknown
}

const buildMatcher = (args: MatcherArgs): NapiConfig => {
  if (!args.pattern && !args.rule) {
    throw new Error('Either pattern or rule is required')
  }
  if (args.pattern && args.rule) {
    throw new Error('Use either pattern or rule, not both')
  }
  if (args.pattern) {
    return { rule: { pattern: args.pattern } }
  }
  return args.rule as NapiConfig
}

interface SummarizeNodeOpts {
  includeText?: boolean
  metaVariables?: string[]
  multiMetaVariables?: string[]
}

interface SummarizedNode {
  file: string
  kind: string
  range: { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } }
  text?: string
  matches?: Record<string, string | null>
  multipleMatches?: Record<string, string[]>
}

const summarizeNode = (node: SgNode, root: SgRoot, opts: SummarizeNodeOpts): SummarizedNode => {
  const result: SummarizedNode = {
    file: root.filename(),
    kind: node.kind() as unknown as string,
    range: node.range(),
  }

  if (opts.includeText !== false) {
    result.text = node.text()
  }

  if (opts.metaVariables && opts.metaVariables.length > 0) {
    const matches: Record<string, string | null> = {}
    for (const name of opts.metaVariables) {
      const match = node.getMatch(name)
      matches[name] = match ? match.text() : null
    }
    result.matches = matches
  }

  if (opts.multiMetaVariables && opts.multiMetaVariables.length > 0) {
    const multipleMatches: Record<string, string[]> = {}
    for (const name of opts.multiMetaVariables) {
      const matches = node.getMultipleMatches(name)
      multipleMatches[name] = matches.map(m => m.text())
    }
    result.multipleMatches = multipleMatches
  }

  return result
}

interface CountedFindInFilesResult {
  results: Array<{
    matches: SgNode[]
  }>
}

const countedFindInFiles = async (
  astGrep: AstGrepModule,
  lang: NapiLang,
  config: { paths: string[]; matcher: NapiConfig; languageGlobs?: string[] },
  callback: (matches: SgNode[]) => void,
): Promise<CountedFindInFilesResult> => {
  const results: Array<{ matches: SgNode[] }> = []
  let callbackCount = 0

  const findConfig: FindConfig = {
    paths: config.paths,
    matcher: config.matcher,
    languageGlobs: config.languageGlobs,
  }

  const matchingFileCount = await astGrep.findInFiles(
    lang,
    findConfig,
    (err, matches) => {
      if (err) throw err
      callback(matches)
      results.push({ matches })
      callbackCount++
    },
  )

  if (matchingFileCount === 0) {
    return { results: [] }
  }

  while (callbackCount < matchingFileCount) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  return { results }
}

const formatOutput = (label: string, payload: unknown): string => {
  return `${label}\n${JSON.stringify(payload, null, 2)}`
}

export function createAstGrepTools(
  ctx: ToolContext,
  opts: CreateAstGrepToolsOptions = {},
): Record<string, ReturnType<typeof tool>> {
  const cfg = ctx.config.astGrep ?? {}
  const enabled = cfg.enabled ?? true
  if (!enabled) return {}

  const loader = opts.loader ?? defaultLoader
  let cachedModule: AstGrepModule | null = null
  const loadAstGrep = async (): Promise<AstGrepModule> => {
    if (cachedModule) return cachedModule
    try {
      cachedModule = await loader()
      registerAstGrepLanguages(cachedModule)
      return cachedModule
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to load @ast-grep/napi native bindings: ${msg}. Install @ast-grep/napi and ensure the platform-specific native package resolved.`,
        { cause: err },
      )
    }
  }

  const allow = cfg.allowedTools && cfg.allowedTools.length > 0
    ? new Set(cfg.allowedTools)
    : new Set<string>(AST_GREP_DEFAULT_TOOL_NAMES)

  const tools: Record<string, ReturnType<typeof tool>> = {}

  if (allow.has('ast-grep-search')) {
    tools['ast-grep-search'] = tool({
      description: 'Search source, files, or directories using ast-grep patterns/rules. Uses `findInFiles` for paths and `parseAsync` + `findAll` for source/file input. Preview/read-only.',
      args: {
        language: z.enum(AST_GREP_LANGUAGES).describe('Built-in ast-grep language'),
        pattern: z.string().optional().describe('ast-grep pattern, e.g. console.log($A)'),
        rule: z.record(z.string(), z.unknown()).optional().describe('NapiConfig-style matcher object'),
        source: z.string().optional().describe('Inline source text to search'),
        file: z.string().optional().describe('Single file path relative to root or absolute'),
        paths: z.array(z.string()).optional().describe('Files/directories to search with findInFiles'),
        languageGlobs: z.array(z.string()).optional().describe('Extra globs for this language in findInFiles mode'),
        maxResults: z.number().int().positive().optional().describe('Maximum match records to return; default 100'),
        includeText: z.boolean().optional().describe('Include matched node text; default true'),
        metaVariables: z.array(z.string()).optional().describe('Single metavariables to extract, e.g. ["A"]'),
        multiMetaVariables: z.array(z.string()).optional().describe('Multi metavariables to extract, e.g. ["ARGS"]'),
      },
      execute: async (args, toolCtx) => {
        const astGrep = await loadAstGrep()
        const lang = toLang(astGrep, args.language)
        const matcher = buildMatcher({ pattern: args.pattern, rule: args.rule })

        const inputModes = [args.source, args.file, args.paths].filter(x => x !== undefined)
        if (inputModes.length !== 1) {
          throw new Error('Exactly one input mode is allowed: source, file, or paths')
        }

        if (args.paths && args.paths.length === 0) {
          throw new Error('paths must be non-empty when provided')
        }

        const maxResults = args.maxResults ?? 100
        const includeText = args.includeText ?? true

        let mode: 'source' | 'file' | 'paths'
        let matches: SummarizedNode[] = []
        let matchedFiles: string[] = []

        if (args.source !== undefined) {
          mode = 'source'
          const ast = await astGrep.parseAsync(lang, args.source) as SgRoot
          const nodes = ast.root().findAll(matcher)
          matches = nodes.slice(0, maxResults).map(node =>
            summarizeNode(node as SgNode, ast, {
              includeText,
              metaVariables: args.metaVariables,
              multiMetaVariables: args.multiMetaVariables,
            }),
          )
        } else if (args.file !== undefined) {
          mode = 'file'
          const root = resolveRoot(ctx.directory, toolCtx)
          const filePath = resolveInputPath(root, args.file)
          const content = await readFile(filePath, 'utf-8')
          const ast = await astGrep.parseAsync(lang, content) as SgRoot
          const nodes = ast.root().findAll(matcher)
          matches = nodes.slice(0, maxResults).map(node =>
            summarizeNode(node as SgNode, ast, {
              includeText,
              metaVariables: args.metaVariables,
              multiMetaVariables: args.multiMetaVariables,
            }),
          )
          matchedFiles = [filePath]
        } else if (args.paths !== undefined) {
          mode = 'paths'
          const root = resolveRoot(ctx.directory, toolCtx)
          const resolvedPaths = args.paths.map(p => resolveInputPath(root, p))

          const { results } = await countedFindInFiles(
            astGrep,
            lang,
            { paths: resolvedPaths, matcher, languageGlobs: args.languageGlobs },
            (nodes) => {
              const fileMatches = nodes.map(node =>
                summarizeNode(node, node.getRoot(), {
                  includeText,
                  metaVariables: args.metaVariables,
                  multiMetaVariables: args.multiMetaVariables,
                }),
              )
              matches.push(...fileMatches)
            },
          )

          matchedFiles = results.length > 0 && results[0].matches.length > 0
            ? [results[0].matches[0].getRoot().filename()]
            : []
          matches = matches.slice(0, maxResults)
        } else {
          throw new Error('Invalid input mode')
        }

        const truncated = matches.length >= maxResults

        const output = {
          language: args.language,
          mode,
          totalMatches: matches.length,
          matchedFiles,
          truncated,
          matches,
        }

        return formatOutput('ast-grep-search', output)
      },
    })
  }

  if (allow.has('ast-grep-inspect')) {
    tools['ast-grep-inspect'] = tool({
      description: 'Inspect the first ast-grep match, including node kind/range/text and optional parent/ancestor/child summaries. Use to discover AST shape before writing a precise rule. Preview/read-only.',
      args: {
        language: z.enum(AST_GREP_LANGUAGES),
        pattern: z.string().optional(),
        rule: z.record(z.string(), z.unknown()).optional(),
        source: z.string().optional(),
        file: z.string().optional(),
        includeText: z.boolean().optional(),
        includeParent: z.boolean().optional(),
        includeAncestors: z.boolean().optional(),
        includeChildren: z.boolean().optional(),
        maxChildren: z.number().int().positive().optional(),
        metaVariables: z.array(z.string()).optional(),
        multiMetaVariables: z.array(z.string()).optional(),
      },
      execute: async (args, toolCtx) => {
        const astGrep = await loadAstGrep()
        const lang = toLang(astGrep, args.language)
        const matcher = buildMatcher({ pattern: args.pattern, rule: args.rule })

        const inputModes = [args.source, args.file].filter(x => x !== undefined)
        if (inputModes.length !== 1) {
          throw new Error('Exactly one of source or file is allowed')
        }

        const maxChildren = args.maxChildren ?? 20
        const includeText = args.includeText ?? true

        let mode: 'source' | 'file'
        let content: string

        if (args.source !== undefined) {
          mode = 'source'
          content = args.source
        } else if (args.file !== undefined) {
          mode = 'file'
          const root = resolveRoot(ctx.directory, toolCtx)
          const filePath = resolveInputPath(root, args.file)
          content = await readFile(filePath, 'utf-8')
        } else {
          throw new Error('Invalid input mode')
        }

        const ast = await astGrep.parseAsync(lang, content)
        const node = ast.root().find(matcher)

        if (!node) {
          return formatOutput('ast-grep-inspect', { found: false, language: args.language, mode })
        }

        const result: Record<string, unknown> = {
          found: true,
          language: args.language,
          mode,
          node: summarizeNode(node as SgNode, ast, {
            includeText,
            metaVariables: args.metaVariables,
            multiMetaVariables: args.multiMetaVariables,
          }),
        }

        if (args.includeParent) {
          const parent = node.parent()
          if (parent) {
            result.parent = {
              kind: parent.kind() as unknown as string,
              range: parent.range(),
              ...(includeText ? { text: parent.text() } : {}),
            }
          }
        }

        if (args.includeAncestors) {
          const ancestors = node.ancestors()
          result.ancestors = ancestors.slice(0, maxChildren).map(a => ({
            kind: a.kind() as unknown as string,
            range: a.range(),
          }))
        }

        if (args.includeChildren) {
          const children = node.children()
          result.children = children.slice(0, maxChildren).map(c => ({
            kind: c.kind() as unknown as string,
            range: c.range(),
            ...(includeText ? { text: c.text() } : {}),
          }))
        }

        return formatOutput('ast-grep-inspect', result)
      },
    })
  }

  if (allow.has('ast-grep-rewrite-preview')) {
    tools['ast-grep-rewrite-preview'] = tool({
      description: 'Preview ast-grep replacements for inline source or one file. Returns edits and transformed source; never writes files. Metavariable interpolation uses `{{NAME}}` placeholders.',
      args: {
        language: z.enum(AST_GREP_LANGUAGES),
        pattern: z.string().optional(),
        rule: z.record(z.string(), z.unknown()).optional(),
        source: z.string().optional(),
        file: z.string().optional(),
        replacement: z.string().describe('Replacement template. Use {{A}} for single metavariable text.'),
        maxEdits: z.number().int().positive().optional().describe('Maximum edits to preview; default 50'),
      },
      execute: async (args, toolCtx) => {
        const astGrep = await loadAstGrep()
        const lang = toLang(astGrep, args.language)
        const matcher = buildMatcher({ pattern: args.pattern, rule: args.rule })

        const inputModes = [args.source, args.file].filter(x => x !== undefined)
        if (inputModes.length !== 1) {
          throw new Error('Exactly one of source or file is allowed')
        }

        const maxEdits = args.maxEdits ?? 50

        let mode: 'source' | 'file'
        let content: string
        let filePath: string | undefined

        if (args.source !== undefined) {
          mode = 'source'
          content = args.source
        } else if (args.file !== undefined) {
          mode = 'file'
          const root = resolveRoot(ctx.directory, toolCtx)
          filePath = resolveInputPath(root, args.file)
          content = await readFile(filePath, 'utf-8')
        } else {
          throw new Error('Invalid input mode')
        }

        const ast = await astGrep.parseAsync(lang, content)
        const nodes = ast.root().findAll(matcher).slice(0, maxEdits)

        const edits: Array<{
          range: { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } }
          startPos: number
          endPos: number
          originalText: string
          insertedText: string
        }> = []

        for (const node of nodes) {
          const originalText = node.text()
          const renderedReplacement = args.replacement.replace(/\{\{(\w+)\}\}/g, (_, name) => {
            const match = node.getMatch(name)
            return match ? match.text() : ''
          })

          const edit = node.replace(renderedReplacement)
          edits.push({
            range: node.range(),
            startPos: edit.startPos,
            endPos: edit.endPos,
            originalText,
            insertedText: edit.insertedText,
          })
        }

        if (edits.length > 1) {
          const sorted = [...edits].sort((a, b) => a.startPos - b.startPos)
          for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].startPos < sorted[i - 1].endPos) {
              throw new Error('Cannot preview overlapping ast-grep edits; narrow the pattern or lower maxEdits')
            }
          }
        }

        const output = ast.root().commitEdits(edits.map(e => ({
          startPos: e.startPos,
          endPos: e.endPos,
          insertedText: e.insertedText,
        })))

        const truncated = nodes.length >= maxEdits

        const outputPayload = {
          language: args.language,
          mode,
          ...(filePath ? { file: filePath } : {}),
          totalMatches: nodes.length,
          previewedEdits: edits.length,
          truncated,
          edits,
          output,
        }

        return formatOutput('ast-grep-rewrite-preview', outputPayload)
      },
    })
  }

  return tools
}
