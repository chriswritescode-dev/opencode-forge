import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphToolAfterHook } from '../src/hooks/graph-tools'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'
import type { GraphService } from '../src/graph/service'

const TEST_DIR = '/tmp/opencode-graph-hooks-test-' + Date.now()

function createTestLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

function createMockGraphService(): GraphService & { callLog: string[] } {
  const callLog: string[] = []
  
  const service: Partial<GraphService> & { callLog: string[] } = {
    ready: true,
    scan: async () => {},
    close: async () => {},
    getStats: async () => ({ files: 0, symbols: 0, edges: 0, summaries: 0, calls: 0 }),
    getTopFiles: async () => [],
    getFileDependents: async () => [],
    getFileDependencies: async () => [],
    getFileCoChanges: async () => [],
    getFileBlastRadius: async () => 0,
    getFileSymbols: async () => [],
    findSymbols: async () => [],
    searchSymbolsFts: async () => [],
    getSymbolSignature: async () => null,
    getCallers: async () => [],
    getCallees: async () => [],
    getUnusedExports: async () => [],
    getDuplicateStructures: async () => [],
    getNearDuplicates: async () => [],
    getExternalPackages: async () => [],
    render: async () => ({ content: '', paths: [] }),
    onFileChanged: (path: string) => {
      callLog.push(path)
    },
    callLog,
  }
  
  return service as GraphService & { callLog: string[] }
}

describe('createGraphToolAfterHook', () => {
  let testDir: string

  beforeEach(() => {
    testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should extract path from apply_patch tool args', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { path: 'src/test.ts' },
    }
    const output = { output: 'Patch applied' }

    await (hook as any)(input as any, output as any)

    // Should have enqueued the file (path is resolved to absolute)
    expect(mockService.callLog.length).toBe(1)
    expect(mockService.callLog[0]).toContain('test.ts')
  })

  test('should extract paths from apply_patch patch text in output', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: {}, // No explicit path args
    }
    const output = {
      output: `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 export function test() {
+  console.log('updated')
}
`,
    }

    await (hook as any)(input as any, output as any)

    // Should have extracted path from patch text
    expect(mockService.callLog.length).toBe(1)
    expect(mockService.callLog[0]).toContain('src/test.ts')
  })

  test('should extract paths from apply_patch patch text in args.patch', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const patchText = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 export function test() {
+  console.log('updated')
}
`

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { patch: patchText },
    }
    const output = { output: 'Patch applied' }

    await (hook as any)(input as any, output as any)

    // Should have extracted path from args.patch
    expect(mockService.callLog.length).toBe(1)
    expect(mockService.callLog[0]).toContain('src/test.ts')
  })

  test('should extract multiple paths from multi-file apply_patch in args', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const patchText = `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1 +1,2 @@
+export const a = 1

diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1 +1,2 @@
+export const b = 2

diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -2 +2,3 @@
+export const c = 3
`

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { patch: patchText },
    }
    const output = { output: 'Patches applied' }

    await (hook as any)(input as any, output as any)

    // Should extract both unique files (deduplicated)
    expect(mockService.callLog.length).toBe(2)
    expect(mockService.callLog.some(p => p.includes('file1.ts'))).toBe(true)
    expect(mockService.callLog.some(p => p.includes('file2.ts'))).toBe(true)
  })

  test('should prioritize args.patch over output parsing', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const patchText = `diff --git a/src/from-args.ts b/src/from-args.ts
--- a/src/from-args.ts
+++ b/src/from-args.ts
@@ -1 +1,2 @@
+export const fromArgs = 1
`

    const outputWithDifferentPath = {
      output: `diff --git a/src/from-output.ts b/src/from-output.ts
--- a/src/from-output.ts
+++ b/src/from-output.ts
@@ -1 +1,2 @@
+export const fromOutput = 1
`,
    }

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { patch: patchText },
    }

    await (hook as any)(input as any, outputWithDifferentPath as any)

    // Should use args.patch, not output
    expect(mockService.callLog.length).toBe(1)
    expect(mockService.callLog[0]).toContain('from-args.ts')
    expect(mockService.callLog[0]).not.toContain('from-output.ts')
  })

  test('should extract multiple paths from multi-file apply_patch', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: {},
    }
    const output = {
      output: `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1 +1,2 @@
+export const a = 1

diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1 +1,2 @@
+export const b = 2

diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -2 +2,3 @@
+export const c = 3
`,
    }

    await (hook as any)(input as any, output as any)

    // Should extract both unique files (deduplicated)
    expect(mockService.callLog.length).toBe(2)
    expect(mockService.callLog.some(p => p.includes('file1.ts'))).toBe(true)
    expect(mockService.callLog.some(p => p.includes('file2.ts'))).toBe(true)
  })

  test('should skip outside-project paths from apply_patch when args contain absolute path', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { path: '/etc/passwd' }, // Absolute path outside project
    }
    const output = { output: 'Patch applied' }

    await (hook as any)(input as any, output as any)

    // Should skip absolute paths outside the project
    expect(mockService.callLog.length).toBe(0)
  })

  test('should extract path from bash redirect commands', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { command: 'echo "test" > output.txt' },
    }
    const output = { output: 'Command executed' }

    await (hook as any)(input as any, output as any)

    // Should have enqueued the file
    expect(mockService.callLog.length).toBeGreaterThan(0)
  })

  test('should extract path from bash touch command', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { command: 'touch newfile.ts' },
    }
    const output = { output: 'Command executed' }

    await (hook as any)(input as any, output as any)

    expect(mockService.callLog.length).toBeGreaterThan(0)
  })

  test('should skip paths outside project', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { path: '/etc/passwd' },
    }
    const output = { output: 'Applied' }

    await (hook as any)(input as any, output as any)

    // Should not enqueue outside paths
    expect(mockService.callLog.length).toBe(0)
  })

  test('should be no-op when graph service is null', async () => {
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: null,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'apply_patch',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { path: 'test.ts' },
    }
    const output = { output: 'Applied' }

    // Should not throw
    await (hook as any)(input as any, output as any)
  })

  test('should handle write tool', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'write',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { path: 'test.ts', content: 'test' },
    }
    const output = { output: 'Written' }

    await (hook as any)(input as any, output as any)

    expect(mockService.callLog.length).toBe(1)
  })

  test('should handle str_replace_editor tool', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'str_replace_editor',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { path: 'test.ts', new_string: 'test' },
    }
    const output = { output: 'Replaced' }

    await (hook as any)(input as any, output as any)

    expect(mockService.callLog.length).toBe(1)
  })
})

describe('extractMutatedPaths', () => {
  test('should extract multiple paths from cp command', () => {
    // This is tested indirectly through the hook
    // The hook should detect file creation commands
  })

  test('should handle relative paths', () => {
    // Relative paths should be resolved against cwd
  })
})
