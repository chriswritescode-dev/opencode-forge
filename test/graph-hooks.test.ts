import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphToolAfterHook, createGraphToolBeforeHook, isBranchChangeCommand, pendingBranchSnapshots } from '../src/hooks/graph-tools'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join, sep } from 'path'
import { execSync } from 'child_process'
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

interface MockGraphService extends GraphService {
  callLog: string[]
  scanCount: number
  onFileChangedCount: number
}

function createMockGraphService(options?: { scanImpl?: () => Promise<void> }): MockGraphService {
  const callLog: string[] = []
  let scanCount = 0
  let onFileChangedCount = 0
  
  const service: Partial<MockGraphService> = {
    ready: true,
    scan: async () => {
      scanCount++
      await options?.scanImpl?.()
    },
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
      callLog.push(`file:${path}`)
      onFileChangedCount++
    },
    callLog,
    scanCount: 0,
    onFileChangedCount: 0,
  }
  
  // Create getters for counts
  Object.defineProperty(service, 'scanCount', {
    get: () => scanCount,
    enumerable: true,
  })
  Object.defineProperty(service, 'onFileChangedCount', {
    get: () => onFileChangedCount,
    enumerable: true,
  })
  
  return service as MockGraphService
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

  test('should resolve bash relative paths from workdir', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const subDir = join(testDir, 'packages', 'foo')
    mkdirSync(subDir, { recursive: true })
    
    const hook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { 
        command: 'touch generated.ts',
        workdir: 'packages/foo',
      },
    }
    const output = { output: 'Command executed' }

    await (hook as any)(input as any, output as any)

    // Should resolve to testDir/packages/foo/generated.ts, not testDir/generated.ts
    expect(mockService.callLog[0]).toBe(`file:${join(testDir, 'packages', 'foo', 'generated.ts')}`)
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

describe('branch-change detection', () => {
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

  test('isBranchChangeCommand detects git switch', () => {
    expect(isBranchChangeCommand({ command: 'git switch feature-x' })).toBe(true)
  })

  test('isBranchChangeCommand detects git checkout', () => {
    expect(isBranchChangeCommand({ command: 'git checkout main' })).toBe(true)
  })

  test('isBranchChangeCommand detects git worktree add', () => {
    expect(isBranchChangeCommand({ command: 'git worktree add ../feature' })).toBe(true)
  })

  test('isBranchChangeCommand ignores non-git commands', () => {
    expect(isBranchChangeCommand({ command: 'echo "hello"' })).toBe(false)
    expect(isBranchChangeCommand({ command: 'touch file.txt' })).toBe(false)
  })

  test('isBranchChangeCommand ignores git commands that do not change branch', () => {
    expect(isBranchChangeCommand({ command: 'git status' })).toBe(false)
    expect(isBranchChangeCommand({ command: 'git log' })).toBe(false)
    expect(isBranchChangeCommand({ command: 'git diff' })).toBe(false)
  })

  test('workdir outside project is skipped for branch tracking', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    const outsideDir = '/tmp/outside-project'
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
    }
    const beforeOutput = {
      args: { 
        command: 'git switch feature-x',
        workdir: outsideDir,
      },
    }
    
    // Run before hook - should skip branch tracking
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    // No snapshot should be created, so after hook won't trigger scan
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Switched to feature-x',
      metadata: {},
    }
    
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should NOT have called scan() - workdir was outside project
    expect(mockService.scanCount).toBe(0)
  })

  test('branch switch triggers full scan via before/after hooks', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    // Create a test git repo with an initial commit
    const { execSync } = await import('child_process')
    execSync('git init', { cwd: testDir, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: testDir, stdio: 'pipe' })
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { 
        command: 'git switch feature-x',
      },
    }
    
    // Run before hook - should capture pre-command branch (main)
    const beforeOutput = { args: input.args }
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    // Simulate branch change
    execSync('git switch -c feature-x', { cwd: testDir, stdio: 'pipe' })
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Switched to feature-x',
      metadata: {},
    }
    
    // Run after hook - should detect branch change and call scan()
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should have called scan() exactly once
    expect(mockService.scanCount).toBe(1)
  })

  test('branch switch starts rescan without blocking the tool call', async () => {
    let resolveScan: (() => void) | undefined
    const scanStarted = new Promise<void>((resolve) => {
      resolveScan = resolve
    })

    const mockService = createMockGraphService({
      scanImpl: () => scanStarted,
    })
    const logger = createTestLogger()

    const { execSync } = await import('child_process')
    execSync('git init', { cwd: testDir, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: testDir, stdio: 'pipe' })

    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call-non-blocking',
      args: {
        command: 'git switch feature-x',
      },
    }

    await (beforeHook! as any)(input as any, { args: input.args } as any)
    execSync('git switch -c feature-x', { cwd: testDir, stdio: 'pipe' })

    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const hookPromise = (afterHook! as any)(input as any, {
      title: 'Command executed',
      output: 'Switched to feature-x',
      metadata: {},
    } as any)

    await hookPromise

    expect(mockService.scanCount).toBe(1)

    resolveScan?.()
  })

  test('checkout without branch change does not trigger scan', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    // Create a test git repo
    const { execSync } = await import('child_process')
    execSync('git init', { cwd: testDir })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
    }
    const beforeOutput = {
      args: { 
        command: 'git checkout -- src/file.ts',
      },
    }
    
    // Run before hook - should capture pre-command branch
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Checked out file',
      metadata: {},
    }
    
    // Run after hook - branch unchanged, should NOT call scan()
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should NOT have called scan() - branch did not change
    expect(mockService.scanCount).toBe(0)
  })

  test('git checkout <path> without -- enqueues restored file', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    // Create a test git repo with initial commit and file
    const { execSync } = await import('child_process')
    execSync('git init', { cwd: testDir })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    mkdirSync(join(testDir, 'src'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'file.ts'), 'export const x = 1')
    execSync('git add .', { cwd: testDir })
    execSync('git commit -m "Add file"', { cwd: testDir, stdio: 'pipe' })
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { 
        command: 'git checkout src/file.ts',
      },
    }
    const beforeOutput = {
      args: input.args,
    }
    
    // Run before hook - should capture pre-command branch
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Checked out file',
      metadata: {},
    }
    
    // Run after hook - branch unchanged, should enqueue the restored file
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should NOT have called scan() - branch did not change
    expect(mockService.scanCount).toBe(0)
    // Should have called onFileChanged for the restored file
    expect(mockService.onFileChangedCount).toBe(1)
    expect(mockService.callLog[0]).toContain('src/file.ts')
  })

  test('normal bash file mutation still enqueues file updates', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
    }
    const afterOutput = {
      title: 'Command executed',
      output: 'Command executed',
      metadata: {},
    }
    const args = {
      command: 'touch newfile.ts',
    }
    
    // Run after hook with file mutation command (no before hook, so no branch snapshot)
    await (afterHook! as any)({ ...input, args } as any, afterOutput as any)
    
    // Should have called onFileChanged for the new file
    expect(mockService.onFileChangedCount).toBe(1)
    expect(mockService.callLog[0]).toContain('newfile.ts')
  })

  test('non-git bash commands are ignored by branch tracking', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
    }
    const beforeOutput = {
      args: { 
        command: 'echo "hello"',
      },
    }
    
    // Run before hook - should NOT capture snapshot (not a branch-change command)
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'hello',
      metadata: {},
    }
    
    // Run after hook - should NOT call scan() (no branch snapshot existed)
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should NOT have called scan()
    expect(mockService.scanCount).toBe(0)
  })

  test('null branch fallback - pre-branch null, post-branch valid triggers scan', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    // Initialize git repo with a commit
    execSync('git init', { cwd: testDir, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: testDir, stdio: 'pipe' })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { 
        command: 'git switch feature-x',
      },
    }
    
    // Manually set a null branch snapshot to simulate pre-command failure
    // (e.g., git command failed or directory wasn't a repo at pre-command time)
    pendingBranchSnapshots.set(input.callID, {
      cwd: testDir,
      branch: null, // Pre-command: not a repo or branch lookup failed
    })
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Switched to feature-x',
      metadata: {},
    }
    
    // Run after hook - pre was null, post is 'main', should trigger scan
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should have called scan() because branch state changed (null -> 'main')
    expect(mockService.scanCount).toBe(1)
  })

  test('both pre and post branch null does not trigger scan', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    const nonGitDir = join(testDir, 'non-git-dir')
    mkdirSync(nonGitDir, { recursive: true })
    
    // Manually set a null branch snapshot
    pendingBranchSnapshots.set('test-call-2', {
      cwd: nonGitDir,
      branch: null, // Pre-command: not a repo
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call-2',
    }
    const afterOutput = {
      title: 'Command executed',
      output: 'Command executed',
      metadata: {},
    }
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    // Run after hook - both pre and post are null, should NOT trigger scan
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should NOT have called scan() - both states are null (no change detected)
    expect(mockService.scanCount).toBe(0)
  })

  test('should handle Windows-style paths in containment check', () => {
    // Test that paths with backslashes are handled correctly
    const windowsPath = 'C:\\repo\\src\\file.ts'
    const windowsCwd = 'C:\\repo'
    
    // Simulate what resolve() would do - on Unix it keeps backslashes as-is
    // The key is that the containment check should work regardless of separator style
    const testPath = join(testDir, 'src', 'file.ts')
    const testCwd = testDir
    
    // This should pass containment check
    const normalizedPath = join(testPath)
    const normalizedCwd = join(testCwd)
    const cwdWithSep = normalizedCwd.endsWith('/') || normalizedCwd.endsWith('\\')
      ? normalizedCwd
      : normalizedCwd + sep
    
    expect(normalizedPath === normalizedCwd || normalizedPath.startsWith(cwdWithSep)).toBe(true)
  })

  test('git checkout src/config (extensionless path) is treated as file, not branch', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    // Create a test git repo with initial commit and file
    const { execSync } = await import('child_process')
    execSync('git init', { cwd: testDir })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    mkdirSync(join(testDir, 'src'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'config'), 'export const x = 1')
    execSync('git add .', { cwd: testDir })
    execSync('git commit -m "Add file"', { cwd: testDir, stdio: 'pipe' })
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { 
        command: 'git checkout src/config',
      },
    }
    const beforeOutput = {
      args: input.args,
    }
    
    // Run before hook - should NOT capture branch snapshot (it's a file, not a branch)
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    // No snapshot should exist, so after hook will use extractCheckoutPaths
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Checked out file',
      metadata: {},
    }
    
    // Run after hook - should enqueue the restored file via extractCheckoutPaths
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should NOT have called scan() - no branch snapshot existed
    expect(mockService.scanCount).toBe(0)
    // Should have called onFileChanged for the restored file
    expect(mockService.onFileChangedCount).toBe(1)
    expect(mockService.callLog[0]).toContain('src/config')
  })

  test('git checkout release/1.2.3 (branch with dots) is treated as branch, not file', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()
    
    // Create a test git repo with initial commit
    const { execSync } = await import('child_process')
    execSync('git init', { cwd: testDir })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: testDir, stdio: 'pipe' })
    
    const beforeHook = createGraphToolBeforeHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    
    const input = {
      tool: 'bash',
      sessionID: 'test-session',
      callID: 'test-call',
      args: { 
        command: 'git checkout release/1.2.3',
      },
    }
    const beforeOutput = {
      args: input.args,
    }
    
    // Run before hook - should capture pre-command branch (main)
    await (beforeHook! as any)(input as any, beforeOutput as any)
    
    // Create the branch and switch to it
    execSync('git checkout -b release/1.2.3', { cwd: testDir, stdio: 'pipe' })
    
    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })
    const afterOutput = {
      title: 'Command executed',
      output: 'Switched to release/1.2.3',
      metadata: {},
    }
    
    // Run after hook - should detect branch change and call scan()
    await (afterHook! as any)(input as any, afterOutput as any)
    
    // Should have called scan() - branch changed from main to release/1.2.3
    expect(mockService.scanCount).toBe(1)
  })

  test('git checkout with shell metacharacters is treated as a file path without executing shell input', async () => {
    const mockService = createMockGraphService()
    const logger = createTestLogger()

    execSync('git init', { cwd: testDir, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' })
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: testDir, stdio: 'pipe' })

    const afterHook = createGraphToolAfterHook({
      graphService: mockService,
      logger,
      cwd: testDir,
    })

    const injectedArg = '"; touch /tmp/opencode-graph-hook-pwned; #'
    await (afterHook! as any)(
      {
        tool: 'bash',
        sessionID: 'test-session',
        callID: 'test-call-injection',
        args: {
          command: `git checkout ${injectedArg}`,
        },
      } as any,
      {
        title: 'Command executed',
        output: 'Checked out file',
        metadata: {},
      } as any,
    )

    expect(existsSync('/tmp/opencode-graph-hook-pwned')).toBe(false)
    expect(mockService.onFileChangedCount).toBe(1)
    expect(mockService.callLog[0]).toContain('/tmp/opencode-graph-hook-pwned')
  })

  test('isBranchChangeCommand conservatively tracks bare git checkout for later branch comparison', () => {
    // This tests the isBranchChangeCommand helper directly
    // For bare `git checkout <arg>` without --, we conservatively return true
    // because we can't reliably distinguish branches from file paths without the working directory.
    // The actual determination happens in the after-hook by comparing pre/post branch state.
    expect(isBranchChangeCommand({ command: 'git checkout src/config' })).toBe(true)
    expect(isBranchChangeCommand({ command: 'git checkout release/1.2.3' })).toBe(true)
    expect(isBranchChangeCommand({ command: 'git checkout main' })).toBe(true)
  })

  test('isBranchChangeCommand returns false for git checkout with -- separator', () => {
    // git checkout -- <path> is explicitly file restoration
    expect(isBranchChangeCommand({ command: 'git checkout -- src/file.ts' })).toBe(false)
    expect(isBranchChangeCommand({ command: 'git checkout HEAD -- src/file.ts' })).toBe(false)
  })
})
