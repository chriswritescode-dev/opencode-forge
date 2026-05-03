import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { handleWriteModelPreferences } from '../src/api/handlers/models'
import { openForgeDatabase, resolveDataDir } from '../src/storage/database'
import { readExecutionPreferences } from '../src/utils/tui-execution-preferences'
import type { ApiDeps } from '../src/api/types'
import type { ToolContext } from '../src/tools/types'

const TEST_DIR = '/tmp/opencode-forge-api-model-preferences-' + Date.now()

function createMockApiDeps(projectId: string): ApiDeps {
  return {
    ctx: {} as ToolContext,
    logger: { log: () => {}, error: () => {}, debug: () => {} },
    projectId,
  }
}

describe('model preferences API', () => {
  const originalDataHome = process.env.XDG_DATA_HOME
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    process.env.XDG_DATA_HOME = testDataDir
    mkdirSync(resolveDataDir(), { recursive: true })
    const db = openForgeDatabase(join(resolveDataDir(), 'forge.db'))
    db.close()
  })

  afterEach(() => {
    if (originalDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalDataHome
    }
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('maps API mode slugs to execution preference labels', async () => {
    const cases = [
      ['new-session', 'New session'],
      ['execute-here', 'Execute here'],
      ['loop-worktree', 'Loop (worktree)'],
      ['loop', 'Loop'],
    ] as const

    for (const [mode, expected] of cases) {
      const projectId = `project-${mode}`
      const body = { mode }

      const result = await handleWriteModelPreferences(createMockApiDeps(projectId), { projectId }, body)
      expect(result).toEqual({ ok: true })

      const prefs = readExecutionPreferences(projectId)
      expect(prefs?.mode).toBe(expected)
    }
  })

  test('defaults omitted mode to new session', async () => {
    const projectId = 'project-omitted-mode'
    const body = { executionModel: 'test/model' }

    const result = await handleWriteModelPreferences(createMockApiDeps(projectId), { projectId }, body)
    expect(result).toEqual({ ok: true })

    const prefs = readExecutionPreferences(projectId)
    expect(prefs?.mode).toBe('New session')
    expect(prefs?.executionModel).toBe('test/model')
  })

  test('invalid preference body throws bad_request error', async () => {
    const projectId = 'project-invalid-mode'
    const body = { mode: 'invalid-mode' }

    try {
      await handleWriteModelPreferences(createMockApiDeps(projectId), { projectId }, body)
      throw new Error('expected bad_request error')
    } catch (err: any) {
      expect(err.code).toBe('bad_request')
    }
  })
})
