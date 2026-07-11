import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import {
  writeWorktreeOpencodeConfig,
  WORKTREE_OPENCODE_CONFIG_FILENAME,
  SANDBOX_CONTAINER_PLACEHOLDER,
  type WriteWorktreeOpencodeConfigInput,
  type WriteWorktreeOpencodeConfigResult,
} from '../../src/workspace/worktree-opencode-config'

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('writeWorktreeOpencodeConfig', () => {
  let logger: ReturnType<typeof createMockLogger>
  let tmpDir: string

  beforeEach(() => {
    logger = createMockLogger()
    tmpDir = mkdtempSync(join(tmpdir(), 'worktree-opencode-config-test-'))
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeInput(
    overrides?: Partial<WriteWorktreeOpencodeConfigInput>,
  ): WriteWorktreeOpencodeConfigInput {
    return {
      directory: tmpDir,
      config: undefined,
      logger,
      ...overrides,
    }
  }

  it('returns no-config when config is undefined', () => {
    const result = writeWorktreeOpencodeConfig(makeInput({ config: undefined }))
    expect(result).toEqual<WriteWorktreeOpencodeConfigResult>({
      written: false,
      reason: 'no-config',
    })
    expect(existsSync(join(tmpDir, WORKTREE_OPENCODE_CONFIG_FILENAME))).toBe(false)
  })

  it('returns no-config when config is an empty object', () => {
    const result = writeWorktreeOpencodeConfig(makeInput({ config: {} }))
    expect(result).toEqual<WriteWorktreeOpencodeConfigResult>({
      written: false,
      reason: 'no-config',
    })
    expect(existsSync(join(tmpDir, WORKTREE_OPENCODE_CONFIG_FILENAME))).toBe(false)
  })

  it('writes opencode.jsonc in an empty directory', () => {
    const config = {
      mcp: {
        foo: { type: 'local' as const, command: ['x'], enabled: true },
      },
    }
    const result = writeWorktreeOpencodeConfig(makeInput({ config }))
    expect(result).toEqual<WriteWorktreeOpencodeConfigResult>({
      written: true,
      reason: 'written',
      path: join(tmpDir, WORKTREE_OPENCODE_CONFIG_FILENAME),
    })
    expect(existsSync(result.path!)).toBe(true)
    const written = JSON.parse(readFileSync(result.path!, 'utf-8'))
    expect(written).toEqual(config)
  })

  it('skips when opencode.jsonc already exists', () => {
    const sentinel = { existing: true }
    writeFileSync(join(tmpDir, 'opencode.jsonc'), JSON.stringify(sentinel), 'utf-8')
    const config = { mcp: { foo: { type: 'local' as const, command: ['x'], enabled: true } } }
    const result = writeWorktreeOpencodeConfig(makeInput({ config }))
    expect(result).toEqual<WriteWorktreeOpencodeConfigResult>({
      written: false,
      reason: 'exists',
    })
    // Original content stays untouched
    expect(readFileSync(join(tmpDir, 'opencode.jsonc'), 'utf-8')).toBe(JSON.stringify(sentinel))
  })

  it('substitutes the sandbox container placeholder in all string values', () => {
    const config = {
      mcp: {
        'chrome-devtools': {
          type: 'local' as const,
          command: ['docker', 'exec', '-i', SANDBOX_CONTAINER_PLACEHOLDER, 'chrome-devtools-mcp'],
          environment: { CONTAINER: SANDBOX_CONTAINER_PLACEHOLDER },
          enabled: true,
        },
      },
    }
    const result = writeWorktreeOpencodeConfig(makeInput({ config, sandboxContainerName: 'forge-my-loop' }))
    expect(result.written).toBe(true)
    const written = JSON.parse(readFileSync(result.path!, 'utf-8'))
    expect(written.mcp['chrome-devtools'].command).toEqual([
      'docker', 'exec', '-i', 'forge-my-loop', 'chrome-devtools-mcp',
    ])
    expect(written.mcp['chrome-devtools'].environment.CONTAINER).toBe('forge-my-loop')
    expect(JSON.stringify(written)).not.toContain(SANDBOX_CONTAINER_PLACEHOLDER)
  })

  it('drops mcp entries referencing the placeholder when there is no sandbox', () => {
    const config = {
      mcp: {
        'chrome-devtools': {
          type: 'local' as const,
          command: ['docker', 'exec', '-i', SANDBOX_CONTAINER_PLACEHOLDER, 'chrome-devtools-mcp'],
          enabled: true,
        },
        other: { type: 'local' as const, command: ['x'], enabled: true },
      },
    }
    const result = writeWorktreeOpencodeConfig(makeInput({ config }))
    expect(result.written).toBe(true)
    const written = JSON.parse(readFileSync(result.path!, 'utf-8'))
    expect(written.mcp['chrome-devtools']).toBeUndefined()
    expect(written.mcp.other).toEqual({ type: 'local', command: ['x'], enabled: true })
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('chrome-devtools'))
  })

  it('skips writing when pruning placeholder mcp entries empties the config', () => {
    const config = {
      mcp: {
        'chrome-devtools': {
          type: 'local' as const,
          command: ['docker', 'exec', '-i', SANDBOX_CONTAINER_PLACEHOLDER, 'chrome-devtools-mcp'],
          enabled: true,
        },
      },
    }
    const result = writeWorktreeOpencodeConfig(makeInput({ config }))
    expect(result).toEqual<WriteWorktreeOpencodeConfigResult>({
      written: false,
      reason: 'no-config',
    })
    expect(existsSync(join(tmpDir, WORKTREE_OPENCODE_CONFIG_FILENAME))).toBe(false)
  })

  it('warns when the placeholder appears outside mcp and there is no sandbox', () => {
    const config = {
      instructions: [`container is ${SANDBOX_CONTAINER_PLACEHOLDER}`],
    }
    const result = writeWorktreeOpencodeConfig(makeInput({ config }))
    expect(result.written).toBe(true)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('warning'))
    const written = JSON.parse(readFileSync(result.path!, 'utf-8'))
    expect(written.instructions[0]).toContain(SANDBOX_CONTAINER_PLACEHOLDER)
  })

  it('does not mutate the caller config object during substitution', () => {
    const config = {
      mcp: {
        demo: { type: 'local' as const, command: [SANDBOX_CONTAINER_PLACEHOLDER], enabled: true },
      },
    }
    writeWorktreeOpencodeConfig(makeInput({ config, sandboxContainerName: 'forge-x' }))
    expect(config.mcp.demo.command).toEqual([SANDBOX_CONTAINER_PLACEHOLDER])
  })

  it('skips when opencode.json already exists', () => {
    const sentinel = { existing: true }
    writeFileSync(join(tmpDir, 'opencode.json'), JSON.stringify(sentinel), 'utf-8')
    const config = { mcp: { foo: { type: 'local' as const, command: ['x'], enabled: true } } }
    const result = writeWorktreeOpencodeConfig(makeInput({ config }))
    expect(result).toEqual<WriteWorktreeOpencodeConfigResult>({
      written: false,
      reason: 'exists',
    })
    // opencode.jsonc should not be created
    expect(existsSync(join(tmpDir, WORKTREE_OPENCODE_CONFIG_FILENAME))).toBe(false)
  })
})
