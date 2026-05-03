import { test, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAstGrepTools, AST_GREP_DEFAULT_TOOL_NAMES, AST_GREP_LANGUAGES } from '../src/tools/ast-grep'
import type { ToolContext } from '../src/tools/types'

const mockToolContext: ToolContext = {
  projectId: 'test',
  directory: '/tmp/test',
  config: {},
  logger: { log: () => {}, error: () => {}, debug: () => {} },
  db: {} as any,
  dataDir: '/tmp',
  loopService: {} as any,
  loopHandler: {} as any,
  v2: {} as any,
  cleanup: async () => {},
  input: {} as any,
  sandboxManager: null,
  plansRepo: {} as any,
  reviewFindingsRepo: {} as any,
  loopsRepo: {} as any,
}

type FakeNode = {
  kind: () => string
  range: () => { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } }
  text: () => string
  getMatch: (name: string) => FakeNode | null
  getMultipleMatches: (name: string) => FakeNode[]
  replace: (text: string) => { startPos: number; endPos: number; insertedText: string }
  commitEdits: (edits: Array<{ startPos: number; endPos: number; insertedText: string }>) => string
  parent: () => FakeNode | null
  ancestors: () => FakeNode[]
  children: () => FakeNode[]
  getRoot: () => { filename: () => string }
  findAll: (matcher: any) => FakeNode[]
  find: (matcher: any) => FakeNode | null
}

const createFakeNode = (overrides?: Partial<FakeNode>): FakeNode => ({
  kind: () => 'expression_statement',
  range: () => ({ start: { line: 0, column: 0, index: 0 }, end: { line: 0, column: 10, index: 10 } }),
  text: () => 'test code',
  getMatch: () => null,
  getMultipleMatches: () => [],
  replace: (text) => ({ startPos: 0, endPos: 10, insertedText: text }),
  commitEdits: () => 'output',
  parent: () => null,
  ancestors: () => [],
  children: () => [],
  getRoot: () => ({ filename: () => 'test.ts' }),
  findAll: () => [],
  find: () => null,
  ...overrides,
})

const createFakeRoot = (node: FakeNode) => ({
  root: () => node as any,
  filename: () => 'test.ts',
})

test('registers all three tools by default', () => {
  const tools = createAstGrepTools(mockToolContext)
  const sortedKeys = Object.keys(tools).sort()
  expect(sortedKeys).toEqual([...AST_GREP_DEFAULT_TOOL_NAMES].sort())
})

test('returns no tools when astGrep.enabled === false', () => {
  const ctx = { ...mockToolContext, config: { astGrep: { enabled: false } } }
  const tools = createAstGrepTools(ctx)
  expect(Object.keys(tools)).toHaveLength(0)
})

test('honors astGrep.allowedTools', () => {
  const ctx = {
    ...mockToolContext,
    config: { astGrep: { allowedTools: ['ast-grep-search'] } },
  }
  const tools = createAstGrepTools(ctx)
  expect(Object.keys(tools)).toEqual(['ast-grep-search'])
})

test('supports all bundled ast-grep language packages', () => {
  expect(AST_GREP_LANGUAGES).toEqual([
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
  ])
})

test('ast-grep-search source mode calls parseAsync and findAll', async () => {
  let parseAsyncCalled = false
  let findAllCalled = false
  let forwardedLang: any = null

  const fakeNode = createFakeNode({
    findAll: function () {
      findAllCalled = true
      return [createFakeNode()]
    },
  })
  const fakeRoot = {
    root: () => fakeNode,
    filename: () => 'test.ts',
  }

  const fakeModule = {
    Lang: { TypeScript: 'TypeScript' as any },
    parseAsync: async (lang: any, source: string) => {
      parseAsyncCalled = true
      forwardedLang = lang
      return fakeRoot
    },
  } as any

  const tools = createAstGrepTools(mockToolContext, { loader: () => Promise.resolve(fakeModule) })
  const searchTool = tools['ast-grep-search']

  const result = await searchTool.execute(
    {
      language: 'TypeScript',
      pattern: 'console.log($A)',
      source: 'console.log("hello")',
    },
    mockToolContext,
  )

  expect(parseAsyncCalled).toBe(true)
  expect(findAllCalled).toBe(true)
  expect(result).toContain('ast-grep-search')
  expect(result).toContain('totalMatches')
})

test('ast-grep-search file mode reads file and resolves relative paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ast-grep-tools-'))
  await writeFile(join(dir, 'test.ts'), 'const value = 1')
  const fakeModule = {
    Lang: { TypeScript: 'TypeScript' as any },
    parseAsync: async () => createFakeRoot(createFakeNode({
      findAll: () => [createFakeNode()],
    })),
  } as any

  const ctx = { ...mockToolContext, directory: dir }
  const tools = createAstGrepTools(ctx, { loader: () => Promise.resolve(fakeModule) })
  const searchTool = tools['ast-grep-search']

  await expect(
    searchTool.execute(
      {
        language: 'TypeScript',
        pattern: 'test',
        file: 'test.ts',
      },
      ctx,
    ),
  ).resolves.toContain('ast-grep-search')
})

test('ast-grep-inspect returns found: false when no match', async () => {
  const fakeModule = {
    Lang: { TypeScript: 'TypeScript' as any },
    parseAsync: async () => createFakeRoot(createFakeNode({
      find: () => null,
    })),
  } as any

  const tools = createAstGrepTools(mockToolContext, { loader: () => Promise.resolve(fakeModule) })
  const inspectTool = tools['ast-grep-inspect']

  const result = await inspectTool.execute(
    {
      language: 'TypeScript',
      pattern: 'nonexistent',
      source: 'console.log("hello")',
    },
    mockToolContext,
  )

  expect(result).toContain('"found": false')
})

test('ast-grep-inspect includes parent/children only when requested', async () => {
  const fakeNode = createFakeNode({
    parent: () => createFakeNode({ kind: () => 'parent_kind' }),
    children: () => [createFakeNode({ kind: () => 'child_kind' })],
  })

  const fakeModule = {
    Lang: { TypeScript: 'TypeScript' as any },
    parseAsync: async () => createFakeRoot(createFakeNode({
      find: () => fakeNode,
    })),
  } as any

  const tools = createAstGrepTools(mockToolContext, { loader: () => Promise.resolve(fakeModule) })
  const inspectTool = tools['ast-grep-inspect']

  const result = await inspectTool.execute(
    {
      language: 'TypeScript',
      pattern: 'test',
      source: 'console.log("hello")',
      includeParent: true,
      includeChildren: true,
    },
    mockToolContext,
  )

  expect(result).toContain('"found": true')
  expect(result).toContain('parent')
  expect(result).toContain('children')
})

test('ast-grep-rewrite-preview produces edits and output', async () => {
  const fakeNode = createFakeNode({
    text: () => 'old',
    getMatch: (name) => (name === 'A' ? createFakeNode({ text: () => 'replacement' }) : null),
    replace: (text) => ({ startPos: 0, endPos: 3, insertedText: text }),
  })

  const fakeModule = {
    Lang: { TypeScript: 'TypeScript' as any },
    parseAsync: async () => ({
      root: () => ({
        findAll: () => [fakeNode],
        commitEdits: () => 'new output',
      }),
    }),
  } as any

  const tools = createAstGrepTools(mockToolContext, { loader: () => Promise.resolve(fakeModule) })
  const rewriteTool = tools['ast-grep-rewrite-preview']

  const result = await rewriteTool.execute(
    {
      language: 'TypeScript',
      pattern: 'old',
      source: 'old code',
      replacement: '{{A}}',
    },
    mockToolContext,
  )

  expect(result).toContain('edits')
  expect(result).toContain('output')
  expect(result).toContain('replacement')
})

test('overlapping rewrite previews reject with error', async () => {
  const fakeNode1 = createFakeNode({
    text: () => 'old1',
    replace: (text) => ({ startPos: 0, endPos: 10, insertedText: text }),
  })
  const fakeNode2 = createFakeNode({
    text: () => 'old2',
    replace: (text) => ({ startPos: 5, endPos: 15, insertedText: text }),
  })

  const fakeModule = {
    Lang: { TypeScript: 'TypeScript' as any },
    parseAsync: async () => ({
      root: () => ({
        findAll: () => [fakeNode1, fakeNode2],
        commitEdits: () => 'output',
      }),
    }),
  } as any

  const tools = createAstGrepTools(mockToolContext, { loader: () => Promise.resolve(fakeModule) })
  const rewriteTool = tools['ast-grep-rewrite-preview']

  await expect(
    rewriteTool.execute(
      {
        language: 'TypeScript',
        pattern: 'test',
        source: 'test code',
        replacement: 'new',
      },
      mockToolContext,
    ),
  ).rejects.toThrow(/Cannot preview overlapping ast-grep edits/)
})

test('loader failure rejects with proper error message', async () => {
  const tools = createAstGrepTools(mockToolContext, {
    loader: () => Promise.reject(new Error('import failed')),
  })
  const searchTool = tools['ast-grep-search']

  await expect(
    searchTool.execute(
      {
        language: 'TypeScript',
        pattern: 'test',
        source: 'test',
      },
      mockToolContext,
    ),
  ).rejects.toThrow(/Failed to load @ast-grep\/napi/)
})
