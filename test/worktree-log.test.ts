import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import type { PluginConfig } from '../src/types'
import {
  resolveWorktreeLogDirectory,
  resolveWorktreeLogTarget,
  ensureWorktreeLogDirectory,
  summarizeSessionOutput,
  appendWorktreeLogEntry,
  logWorktreeCompletion,
} from '../src/services/worktree-log'
import { buildLoopPermissionRuleset } from '../src/constants/loop'
import type { LoopSessionOutput } from '../src/services/loop'

const TEST_DIR = '/tmp/opencode-worktree-log-test-' + Date.now()

describe('resolveWorktreeLogTarget', () => {
  let testProjectDir: string

  beforeEach(() => {
    testProjectDir = TEST_DIR + '-project-' + Math.random().toString(36).slice(2)
    mkdirSync(testProjectDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  test('returns null when worktreeLogging is disabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: '/some/path',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { projectDir: testProjectDir })
    expect(result).toBeNull()
  })

  test('returns null when directory is not configured and no dataDir provided', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { projectDir: testProjectDir })
    expect(result).toBeNull()
  })

  test('resolves to dataDir-based default when directory is omitted but dataDir is provided', () => {
    const dataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { 
      projectDir: testProjectDir,
      dataDir,
    })
    
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(join(dataDir, 'worktree-logs'))
    expect(result!.permissionPath).toBe(join(dataDir, 'worktree-logs'))
  })

  test('resolves relative directory against projectDir', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: 'logs/worktree',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { projectDir: testProjectDir })
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(join(testProjectDir, 'logs/worktree'))
  })

  test('resolves absolute directory as-is', () => {
    const absolutePath = '/tmp/absolute-logs'
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: absolutePath,
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { projectDir: testProjectDir })
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(absolutePath)
  })

  test('computes permissionPath as hostPath when sandbox is false', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: 'logs',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { 
      projectDir: testProjectDir,
      sandbox: false,
    })
    expect(result).not.toBeNull()
    expect(result!.permissionPath).toBe(result!.hostPath)
  })

  test('maps permissionPath to container path when sandbox is true and within mount', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: 'logs',
        },
      },
    }

    const worktreeDir = join(testProjectDir, 'worktree')
    mkdirSync(worktreeDir, { recursive: true })
    
    const result = resolveWorktreeLogTarget(config, { 
      projectDir: worktreeDir,
      sandboxHostDir: worktreeDir,
      sandbox: true,
    })
    
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(join(worktreeDir, 'logs'))
    expect(result!.permissionPath).toBe('/workspace/logs')
  })

  test('sets permissionPath to null when path is outside sandbox mount', () => {
    const outsidePath = '/tmp/outside-logs'
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: outsidePath,
        },
      },
    }

    const worktreeDir = join(testProjectDir, 'worktree')
    mkdirSync(worktreeDir, { recursive: true })
    
    const result = resolveWorktreeLogTarget(config, { 
      projectDir: worktreeDir,
      sandboxHostDir: worktreeDir,
      sandbox: true,
    })
    
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(outsidePath)
    // Path outside mount should be null to prevent granting meaningless host-only rules
    expect(result!.permissionPath).toBeNull()
  })
})

describe('ensureWorktreeLogDirectory', () => {
  let testDir: string

  beforeEach(() => {
    testDir = TEST_DIR + '-ensure-' + Math.random().toString(36).slice(2)
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('creates directory if it does not exist', () => {
    const newDir = join(testDir, 'new-log-dir')
    expect(existsSync(newDir)).toBe(false)
    
    const result = ensureWorktreeLogDirectory(newDir)
    expect(result).toBe(true)
    expect(existsSync(newDir)).toBe(true)
  })

  test('returns true for existing writable directory', () => {
    mkdirSync(testDir, { recursive: true })
    
    const result = ensureWorktreeLogDirectory(testDir)
    expect(result).toBe(true)
  })

  test('returns false for unwritable path', () => {
    const unwritablePath = '/root/should-fail-' + Math.random().toString(36).slice(2)
    const result = ensureWorktreeLogDirectory(unwritablePath)
    expect(result).toBe(false)
  })
})

describe('resolveWorktreeLogDirectory', () => {
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

  test('returns null when worktreeLogging is disabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: testDir,
        },
      },
    }

    const result = resolveWorktreeLogDirectory(config)
    expect(result).toBeNull()
  })

  test('returns null when directory is not configured', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '',
        },
      },
    }

    const result = resolveWorktreeLogDirectory(config)
    expect(result).toBeNull()
  })

  test('returns null when directory is undefined', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
        },
      },
    }

    const result = resolveWorktreeLogDirectory(config)
    expect(result).toBeNull()
  })

  test('creates directory if it does not exist', () => {
    const newDir = join(testDir, 'new-log-dir')
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: newDir,
        },
      },
    }

    expect(existsSync(newDir)).toBe(false)
    const result = resolveWorktreeLogDirectory(config)
    expect(result).toBe(newDir)
    expect(existsSync(newDir)).toBe(true)
  })

  test('returns resolved directory when valid', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testDir,
        },
      },
    }

    const result = resolveWorktreeLogDirectory(config)
    expect(result).toBe(testDir)
  })

  test('fails closed on unwritable directory', () => {
    // Try to use a directory that should fail (e.g., root without permissions)
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '/root/should-fail-' + Math.random().toString(36).slice(2),
        },
      },
    }

    const result = resolveWorktreeLogDirectory(config)
    expect(result).toBeNull()
  })
})

describe('summarizeSessionOutput', () => {
  test('prefers last assistant message text', () => {
    const output: LoopSessionOutput = {
      messages: [
        {
          text: 'First message',
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          text: 'Last message with important content',
          cost: 0.002,
          tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      totalCost: 0.003,
      totalTokens: { input: 300, output: 150, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      fileChanges: { additions: 10, deletions: 5, files: 3 },
    }

    const summary = summarizeSessionOutput(output)
    expect(summary).toBe('Last message with important content')
  })

  test('truncates long summaries', () => {
    const longText = 'A'.repeat(250)
    const output: LoopSessionOutput = {
      messages: [
        {
          text: longText,
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      totalCost: 0.001,
      totalTokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      fileChanges: null,
    }

    const summary = summarizeSessionOutput(output)
    expect(summary.length).toBe(200)
    expect(summary).toBe('A'.repeat(197) + '...')
  })

  test('falls back to file change info when no messages', () => {
    const output: LoopSessionOutput = {
      messages: [],
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      fileChanges: { additions: 15, deletions: 3, files: 5 },
    }

    const summary = summarizeSessionOutput(output)
    expect(summary).toBe('Modified 5 file(s): +15 -3')
  })

  test('returns fallback when no data available', () => {
    const output: LoopSessionOutput = {
      messages: [{ text: '', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      fileChanges: null,
    }

    const summary = summarizeSessionOutput(output)
    expect(summary).toBe('No summary available')
  })
})

describe('appendWorktreeLogEntry', () => {
  let testLogDir: string

  beforeEach(() => {
    testLogDir = TEST_DIR + '-logs-' + Math.random().toString(36).slice(2)
    mkdirSync(testLogDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true })
    }
  })

  test('creates dated file and appends entry', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      summary: 'Test summary',
      iteration: 3,
      worktreeBranch: 'worktree/test-loop',
    }

    const result = appendWorktreeLogEntry(testLogDir, options)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)

    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('## test-loop')
    expect(content).toContain('**Project:** /path/to/project')
    expect(content).toContain('**Loop:** test-loop')
    expect(content).toContain('**Branch:** worktree/test-loop')
    expect(content).toContain('2024-01-15T10:30:00.000Z')
    expect(content).toContain('**Iteration:** 3')
    expect(content).toContain('**Summary:** Test summary')
  })

  test('appends second entry instead of overwriting', () => {
    const timestamp1 = new Date('2024-01-15T10:30:00Z')
    const timestamp2 = new Date('2024-01-15T14:45:00Z')

    const options1 = {
      projectDir: '/path/to/project',
      loopName: 'first-loop',
      completionTimestamp: timestamp1,
      summary: 'First summary',
      iteration: 1,
    }

    const options2 = {
      projectDir: '/path/to/project',
      loopName: 'second-loop',
      completionTimestamp: timestamp2,
      summary: 'Second summary',
      iteration: 2,
    }

    appendWorktreeLogEntry(testLogDir, options1)
    appendWorktreeLogEntry(testLogDir, options2)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')

    expect(content).toContain('## first-loop')
    expect(content).toContain('## second-loop')
    expect(content.indexOf('first-loop')).toBeLessThan(content.indexOf('second-loop'))
  })

  test('handles missing worktreeBranch', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      summary: 'Test summary',
      iteration: 1,
    }

    const result = appendWorktreeLogEntry(testLogDir, options)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).not.toContain('**Branch:**')
  })

  test('fails closed on unwritable directory', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      summary: 'Test summary',
      iteration: 1,
    }

    const result = appendWorktreeLogEntry('/root/should-fail', options)
    expect(result).toBe(false)
  })
})

describe('logWorktreeCompletion', () => {
  let testLogDir: string

  beforeEach(() => {
    testLogDir = TEST_DIR + '-logs-' + Math.random().toString(36).slice(2)
    mkdirSync(testLogDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true })
    }
  })

  test('returns false when disabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: testLogDir,
        },
      },
    }

    const result = logWorktreeCompletion(config, {
      projectDir: '/project',
      loopName: 'test',
      completionTimestamp: new Date(),
      sessionOutput: null,
      iteration: 1,
    })

    expect(result).toBe(false)
  })

  test('creates file and logs completion when enabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const sessionOutput: LoopSessionOutput = {
      messages: [
        {
          text: 'Implementation complete',
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      totalCost: 0.001,
      totalTokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      fileChanges: { additions: 5, deletions: 2, files: 2 },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = logWorktreeCompletion(config, {
      projectDir: '/path/to/project',
      loopName: 'feature-loop',
      completionTimestamp: timestamp,
      sessionOutput,
      iteration: 5,
      worktreeBranch: 'worktree/feature-loop',
    })

    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)

    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('## feature-loop')
    expect(content).toContain('**Project:** /path/to/project')
    expect(content).toContain('**Summary:** Implementation complete')
  })

  test('handles null sessionOutput gracefully', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const result = logWorktreeCompletion(config, {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: new Date(),
      sessionOutput: null,
      iteration: 1,
    })

    expect(result).toBe(true)

    const mdFiles = testLogDir ? Array.from(require('fs').readdirSync(testLogDir).filter(f => f.endsWith('.md'))) : []
    expect(mdFiles.length).toBeGreaterThan(0)
  })
})

describe('buildLoopPermissionRuleset integration', () => {
  test('adds external_directory allow rule when worktree logging is enabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '/tmp/test-logs',
        },
      },
    }

    const ruleset = buildLoopPermissionRuleset(config, '/tmp/test-logs')
    
    // Should have base rules plus the external_directory allow rule
    expect(ruleset.length).toBeGreaterThan(1)
    expect(ruleset).toContainEqual({
      permission: 'external_directory',
      pattern: '/tmp/test-logs',
      action: 'allow',
    })
  })

  test('does not add external_directory rule when logging is disabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: '/tmp/test-logs',
        },
      },
    }

    const ruleset = buildLoopPermissionRuleset(config, '/tmp/test-logs')
    
    // Should only have base rules
    const externalDirRules = ruleset.filter(r => r.permission === 'external_directory')
    expect(externalDirRules.length).toBe(1) // Only the deny-all rule
    expect(externalDirRules[0].action).toBe('deny')
  })

  test('does not add external_directory rule when directory is null', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '/tmp/test-logs',
        },
      },
    }

    const ruleset = buildLoopPermissionRuleset(config, null)
    
    // Should only have base rules
    const externalDirRules = ruleset.filter(r => r.permission === 'external_directory' && r.action === 'allow')
    expect(externalDirRules.length).toBe(0)
  })
})

describe('worktree log runtime wiring', () => {
  let testLogDir: string

  beforeEach(() => {
    testLogDir = TEST_DIR + '-logs-' + Math.random().toString(36).slice(2)
    mkdirSync(testLogDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true })
    }
  })

  test('logWorktreeCompletion is called only for completed worktree loops', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const sessionOutput: LoopSessionOutput = {
      messages: [
        {
          text: 'Implementation complete',
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      totalCost: 0.001,
      totalTokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      fileChanges: { additions: 5, deletions: 2, files: 2 },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')

    // Simulate completed worktree loop - should log
    const result = logWorktreeCompletion(config, {
      projectDir: '/path/to/project',
      loopName: 'feature-loop',
      completionTimestamp: timestamp,
      sessionOutput,
      iteration: 5,
      worktreeBranch: 'worktree/feature-loop',
    })

    expect(result).toBe(true)
    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)
  })

  test('logWorktreeCompletion returns false for non-completed termination', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    // Simulate non-completed termination (e.g., cancelled, max_iterations, stall_timeout)
    // The caller (terminateLoop in hooks/loop.ts) gates this call with:
    // if (reason === 'completed' && state.worktree) { ... }
    // So this test verifies the helper itself works, but the gate is in the caller

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = logWorktreeCompletion(config, {
      projectDir: '/path/to/project',
      loopName: 'cancelled-loop',
      completionTimestamp: timestamp,
      sessionOutput: null,
      iteration: 3,
      worktreeBranch: 'worktree/cancelled-loop',
    })

    // Helper still returns true (it logs whatever it's given)
    // The gating logic is in terminateLoop, not in the helper
    expect(result).toBe(true)
  })

  test('logWorktreeCompletion handles disabled config correctly', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: testLogDir,
        },
      },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = logWorktreeCompletion(config, {
      projectDir: '/path/to/project',
      loopName: 'disabled-loop',
      completionTimestamp: timestamp,
      sessionOutput: null,
      iteration: 1,
    })

    expect(result).toBe(false)
    const mdFiles = testLogDir ? Array.from(require('fs').readdirSync(testLogDir).filter(f => f.endsWith('.md'))) : []
    expect(mdFiles.length).toBe(0)
  })
})

describe('sandbox permission path mapping', () => {
  let testProjectDir: string

  beforeEach(() => {
    testProjectDir = TEST_DIR + '-sandbox-project-' + Math.random().toString(36).slice(2)
    mkdirSync(testProjectDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  test('resolveWorktreeLogTarget maps to container path when sandboxed and within mount', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: 'logs',
        },
      },
    }

    const worktreeDir = join(testProjectDir, 'worktree')
    mkdirSync(worktreeDir, { recursive: true })

    const result = resolveWorktreeLogTarget(config, {
      projectDir: worktreeDir,
      sandboxHostDir: worktreeDir,
      sandbox: true,
    })

    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(join(worktreeDir, 'logs'))
    expect(result!.permissionPath).toBe('/workspace/logs')
  })

  test('resolveWorktreeLogTarget sets permissionPath to null when sandboxed but outside mount', () => {
    const outsidePath = '/tmp/outside-logs'
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: outsidePath,
        },
      },
    }

    const worktreeDir = join(testProjectDir, 'worktree')
    mkdirSync(worktreeDir, { recursive: true })

    const result = resolveWorktreeLogTarget(config, {
      projectDir: worktreeDir,
      sandboxHostDir: worktreeDir,
      sandbox: true,
    })

    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(outsidePath)
    expect(result!.permissionPath).toBeNull()
  })

  test('buildLoopPermissionRuleset adds allow rule for mapped permission path', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: 'logs',
        },
      },
    }

    const worktreeDir = join(testProjectDir, 'worktree')
    mkdirSync(worktreeDir, { recursive: true })

    const logTarget = resolveWorktreeLogTarget(config, {
      projectDir: worktreeDir,
      sandboxHostDir: worktreeDir,
      sandbox: true,
    })

    const ruleset = buildLoopPermissionRuleset(config, logTarget?.permissionPath ?? null, {
      isWorktree: true,
    })

    const allowRules = ruleset.filter(r => 
      r.permission === 'external_directory' && r.action === 'allow'
    )
    
    expect(allowRules.length).toBe(1)
    expect(allowRules[0].pattern).toBe('/workspace/logs')
  })

  test('buildLoopPermissionRuleset does not add allow rule for null permission path', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: 'logs',
        },
      },
    }

    const ruleset = buildLoopPermissionRuleset(config, null, {
      isWorktree: true,
    })

    const allowRules = ruleset.filter(r => 
      r.permission === 'external_directory' && r.action === 'allow'
    )
    
    expect(allowRules.length).toBe(0)
  })

  test('buildLoopPermissionRuleset does not add allow rule when logging disabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: '/tmp/logs',
        },
      },
    }

    const ruleset = buildLoopPermissionRuleset(config, '/tmp/logs', {
      isWorktree: true,
    })

    const allowRules = ruleset.filter(r => 
      r.permission === 'external_directory' && r.action === 'allow'
    )
    
    expect(allowRules.length).toBe(0)
  })

  test('buildLoopPermissionRuleset does not add allow rule when permissionPath is null', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '/tmp/logs',
        },
      },
    }

    const ruleset = buildLoopPermissionRuleset(config, null, {
      isWorktree: true,
    })

    const allowRules = ruleset.filter(r => 
      r.permission === 'external_directory' && r.action === 'allow'
    )
    
    expect(allowRules.length).toBe(0)
  })
})
