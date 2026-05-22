import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import type { PluginConfig } from '../src/types'
import {
  resolveWorktreeLogTarget,
  ensureWorktreeLogDirectory,
  appendWorktreeLogEntry,
  buildWorktreeCompletionPayload,
  writeWorktreeCompletionLog,
  formatWorktreeCompletionEntry,
} from '../src/services/worktree-log'
import { buildLoopPermissionRuleset } from '../src/constants/loop'
import type { LoopSessionOutput } from '../src/loop/session-output'
import type { LoopUsageSummary } from '../src/loop/token-usage'
import { formatUsageSummary } from '../src/utils/loop-format'

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

  test('expands tilde shorthand to home directory', () => {
    const { homedir } = require('os')
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '~/Documents/Obsidian/GFPRO/Plans',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { projectDir: testProjectDir })
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(join(homedir(), 'Documents/Obsidian/GFPRO/Plans'))
    expect(result!.hostPath).not.toBe(join(testProjectDir, '~/Documents/Obsidian/GFPRO/Plans'))
  })

  test('expands bare tilde to home directory', () => {
    const { homedir } = require('os')
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: '~',
        },
      },
    }

    const result = resolveWorktreeLogTarget(config, { projectDir: testProjectDir })
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(homedir())
  })

  test('preserves already-absolute paths unchanged', () => {
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

  test('preserves ordinary relative paths against projectDir', () => {
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

  test('computes permissionPath from normalized host path for sandbox mapping', () => {
    const { homedir } = require('os')
    const tildePath = '~/sandbox-logs'
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: tildePath,
        },
      },
    }

    const worktreeDir = join(testProjectDir, 'worktree')
    mkdirSync(worktreeDir, { recursive: true })
    
    // When tilde path resolves to a location within the sandbox mount
    const result = resolveWorktreeLogTarget(config, { 
      projectDir: worktreeDir,
      sandboxHostDir: worktreeDir,
      sandbox: true,
    })
    
    // The hostPath should be expanded
    expect(result).not.toBeNull()
    expect(result!.hostPath).toBe(join(homedir(), 'sandbox-logs'))
    // Permission path should be null since homedir is outside sandbox mount
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

  test('creates dated file and appends entry with plan-based format', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
      worktreeBranch: 'worktree/test-loop',
    }

    const result = appendWorktreeLogEntry(testLogDir, options)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)

    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('# /path/to/project')
    expect(content).toContain('## test-loop')
    expect(content).toContain('**Loop:** test-loop')
    expect(content).toContain('**Branch:** worktree/test-loop')
    expect(content).toContain('2024-01-15T10:30:00.000Z')
    expect(content).toContain('**Iteration:** 3')
    expect(content).toContain('### Plan')
    expect(content).toContain('Plan unavailable')
  })

  test('renders Plan unavailable for whitespace-only planText', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 1,
    }

    const result = appendWorktreeLogEntry(testLogDir, options, '   ')
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('Plan unavailable')
  })

  test('appends second entry instead of overwriting', () => {
    const timestamp1 = new Date('2024-01-15T10:30:00Z')
    const timestamp2 = new Date('2024-01-15T14:45:00Z')

    const options1 = {
      projectDir: '/path/to/project',
      loopName: 'first-loop',
      completionTimestamp: timestamp1,
      iteration: 1,
    }

    const options2 = {
      projectDir: '/path/to/project',
      loopName: 'second-loop',
      completionTimestamp: timestamp2,
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
      iteration: 1,
    }

    const result = appendWorktreeLogEntry(testLogDir, options)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).not.toContain('**Branch:')
  })

  test('fails closed on unwritable directory', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 1,
    }

    const result = appendWorktreeLogEntry('/root/should-fail', options)
    expect(result).toBe(false)
  })
})

describe('buildLoopPermissionRuleset integration', () => {
  test('always denies loop-cancel and loop-status for worktree loops', () => {
    const ruleset = buildLoopPermissionRuleset()

    expect(ruleset).toContainEqual({ permission: 'loop-cancel', pattern: '*', action: 'deny' })
    expect(ruleset).toContainEqual({ permission: 'loop-status', pattern: '*', action: 'deny' })
  })

  test('DENIES auditor review tools at session level (auditor now runs in separate session)', () => {
    const ruleset = buildLoopPermissionRuleset()

    // These tools are now denied at session level because auditor runs in its own session
    expect(ruleset.some(r => r.permission === 'review-write' && r.action === 'deny')).toBe(true)
    expect(ruleset.some(r => r.permission === 'review-delete' && r.action === 'deny')).toBe(true)
    expect(ruleset).toContainEqual({ permission: 'question', pattern: '*', action: 'deny' })
    expect(ruleset).toContainEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(ruleset).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
    expect(ruleset).toContainEqual({ permission: 'bash', pattern: '*', action: 'deny' })
    expect(ruleset).toContainEqual({ permission: 'forge-bash', pattern: 'git push *', action: 'deny' })
    expect(ruleset).toContainEqual({ permission: 'loop-cancel', pattern: '*', action: 'deny' })
    expect(ruleset).toContainEqual({ permission: 'loop-status', pattern: '*', action: 'deny' })
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

})

describe('buildWorktreeCompletionPayload', () => {
  let testLogDir: string
  let testProjectDir: string

  beforeEach(() => {
    testLogDir = TEST_DIR + '-logs-' + Math.random().toString(36).slice(2)
    testProjectDir = TEST_DIR + '-project-' + Math.random().toString(36).slice(2)
    mkdirSync(testLogDir, { recursive: true })
    mkdirSync(testProjectDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true })
    }
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  test('returns null when logging is disabled', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: false,
          directory: testLogDir,
        },
      },
    }

    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'test-loop',
      completionTimestamp: new Date(),
      iteration: 1,
    })

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

    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'test-loop',
      completionTimestamp: new Date(),
      iteration: 1,
    })

    expect(result).toBeNull()
  })

  test('builds serializable payload with all required fields', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')

    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'feature-loop',
      completionTimestamp: timestamp,
      iteration: 5,
      worktreeBranch: 'worktree/feature-loop',
    })

    expect(result).not.toBeNull()
    expect(result!.payload).toEqual({
      logDirectory: expect.stringContaining('logs-'),
      projectDir: testProjectDir,
      loopName: 'feature-loop',
      completionTimestamp: '2024-01-15T10:30:00.000Z',
      iteration: 5,
      worktreeBranch: 'worktree/feature-loop',
    })
    expect(result!.hostPath).toBe(result!.payload.logDirectory)
  })

  test('payload is serializable without worktree session access', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
      worktreeBranch: 'worktree/test',
    })

    expect(result).not.toBeNull()
    
    // Verify payload can be JSON serialized (no circular refs or special objects)
    const serialized = JSON.stringify(result!.payload)
    expect(serialized).toContain('test-loop')
    expect(serialized).toContain('2024-01-15T10:30:00.000Z')
    
    // Verify deserialized payload has all required fields
    const deserialized = JSON.parse(serialized)
    expect(deserialized.loopName).toBe('test-loop')
    expect(deserialized.iteration).toBe(3)
    expect(deserialized.worktreeBranch).toBe('worktree/test')
  })
})

describe('writeWorktreeCompletionLog', () => {
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

  test('writes log entry from payload alone', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const payload = {
      logDirectory: testLogDir,
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp.toISOString(),
      iteration: 5,
      worktreeBranch: 'worktree/test-loop',
    }

    const result = writeWorktreeCompletionLog(payload)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)

    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('# /path/to/project')
    expect(content).toContain('## test-loop')
    expect(content).toContain('**Loop:** test-loop')
    expect(content).toContain('**Branch:** worktree/test-loop')
    expect(content).toContain('2024-01-15T10:30:00.000Z')
    expect(content).toContain('**Iteration:** 5')
    expect(content).toContain('### Plan')
    expect(content).toContain('Plan unavailable')
  })

  test('handles missing worktreeBranch in payload', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const payload = {
      logDirectory: testLogDir,
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp.toISOString(),
      iteration: 1,
    }

    const result = writeWorktreeCompletionLog(payload)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).not.toContain('**Branch:')
  })

  test('returns false when directory is unwritable', () => {
    const payload = {
      logDirectory: '/root/should-fail',
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: new Date().toISOString(),
      iteration: 1,
    }

    const result = writeWorktreeCompletionLog(payload)
    expect(result).toBe(false)
  })

  test('appends multiple entries from payloads', () => {
    const timestamp1 = new Date('2024-01-15T10:30:00Z')
    const timestamp2 = new Date('2024-01-15T14:45:00Z')

    const payload1 = {
      logDirectory: testLogDir,
      projectDir: '/project1',
      loopName: 'first-loop',
      completionTimestamp: timestamp1.toISOString(),
      iteration: 1,
    }

    const payload2 = {
      logDirectory: testLogDir,
      projectDir: '/project2',
      loopName: 'second-loop',
      completionTimestamp: timestamp2.toISOString(),
      iteration: 2,
    }

    writeWorktreeCompletionLog(payload1)
    writeWorktreeCompletionLog(payload2)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')

    expect(content).toContain('## first-loop')
    expect(content).toContain('## second-loop')
    expect(content.indexOf('first-loop')).toBeLessThan(content.indexOf('second-loop'))
  })
})

describe('usage in worktree completion logs', () => {
  let testLogDir: string
  let testProjectDir: string

  beforeEach(() => {
    testLogDir = TEST_DIR + '-logs-' + Math.random().toString(36).slice(2)
    testProjectDir = TEST_DIR + '-project-' + Math.random().toString(36).slice(2)
    mkdirSync(testLogDir, { recursive: true })
    mkdirSync(testProjectDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true })
    }
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  const sampleUsage: LoopUsageSummary = {
    totalCost: 0.1234,
    totalTokens: {
      input: 1000,
      output: 500,
      reasoning: 200,
      cacheRead: 100,
      cacheWrite: 50,
    },
    perModel: [
      {
        model: 'gpt-4',
        cost: 0.0800,
        tokens: {
          input: 800,
          output: 400,
          reasoning: 150,
          cacheRead: 80,
          cacheWrite: 40,
        },
        messageCount: 5,
      },
      {
        model: 'gpt-3.5-turbo',
        cost: 0.0434,
        tokens: {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 20,
          cacheWrite: 10,
        },
        messageCount: 3,
      },
    ],
  }

  test('formatWorktreeCompletionEntry includes Usage section when usage is provided', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
    }

    const result = formatWorktreeCompletionEntry(options, 'Test plan', sampleUsage)

    expect(result).toContain('### Usage')
    expect(result).toContain('Total Cost: $0.1234')
    expect(result).toContain('1.0k in / 500 out / 200 reasoning / 100 cache read / 50 cache write')
    expect(result).toContain('Per-model usage:')
    expect(result).toContain('gpt-4: $0.0800')
    expect(result).toContain('gpt-3.5-turbo: $0.0434')
    expect(result).toContain('### Plan')
    expect(result).toContain('Test plan')
  })

  test('formatWorktreeCompletionEntry omits Usage section when usage is null', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
    }

    const result = formatWorktreeCompletionEntry(options, 'Test plan', null)

    expect(result).not.toContain('### Usage')
    expect(result).toContain('### Plan')
  })

  test('formatWorktreeCompletionEntry omits Usage section when usage is undefined', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
    }

    const result = formatWorktreeCompletionEntry(options, 'Test plan', undefined)

    expect(result).not.toContain('### Usage')
    expect(result).toContain('### Plan')
  })

  test('appendWorktreeLogEntry writes usage to log file', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const options = {
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
    }

    const result = appendWorktreeLogEntry(testLogDir, options, 'Test plan', undefined, sampleUsage)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)

    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('### Usage')
    expect(content).toContain('Total Cost: $0.1234')
    expect(content).toContain('Per-model usage:')
  })

  test('buildWorktreeCompletionPayload accepts and includes usage', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
      usage: sampleUsage,
    })

    expect(result).not.toBeNull()
    expect(result!.payload.usage).toEqual(sampleUsage)
  })

  test('buildWorktreeCompletionPayload handles usage as undefined', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
      usage: undefined,
    })

    expect(result).not.toBeNull()
    expect(result!.payload.usage).toBeUndefined()
  })

  test('payload with usage remains JSON serializable', () => {
    const config: PluginConfig = {
      loop: {
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    }

    const timestamp = new Date('2024-01-15T10:30:00Z')
    const result = buildWorktreeCompletionPayload(config, {
      projectDir: testProjectDir,
      loopName: 'test-loop',
      completionTimestamp: timestamp,
      iteration: 3,
      usage: sampleUsage,
    })

    expect(result).not.toBeNull()
    
    const serialized = JSON.stringify(result!.payload)
    expect(serialized).toContain('0.1234')
    expect(serialized).toContain('gpt-4')
    
    const deserialized = JSON.parse(serialized)
    expect(deserialized.usage.totalCost).toBe(0.1234)
    expect(deserialized.usage.perModel.length).toBe(2)
  })

  test('writeWorktreeCompletionLog persists usage from payload', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const payload = {
      logDirectory: testLogDir,
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp.toISOString(),
      iteration: 5,
      usage: sampleUsage,
    }

    const result = writeWorktreeCompletionLog(payload)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    expect(existsSync(expectedFile)).toBe(true)

    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).toContain('### Usage')
    expect(content).toContain('Total Cost: $0.1234')
    expect(content).toContain('Per-model usage:')
    expect(content).toContain('gpt-4: $0.0800')
    expect(content).toContain('gpt-3.5-turbo: $0.0434')
  })

  test('log omits usage section when usage is absent in payload', () => {
    const timestamp = new Date('2024-01-15T10:30:00Z')
    const payload = {
      logDirectory: testLogDir,
      projectDir: '/path/to/project',
      loopName: 'test-loop',
      completionTimestamp: timestamp.toISOString(),
      iteration: 1,
    }

    const result = writeWorktreeCompletionLog(payload)
    expect(result).toBe(true)

    const expectedFile = join(testLogDir, '2024-01-15.md')
    const content = readFileSync(expectedFile, 'utf-8')
    expect(content).not.toContain('### Usage')
    expect(content).toContain('### Plan')
  })
})
