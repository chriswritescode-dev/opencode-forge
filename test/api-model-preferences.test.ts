import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { handleWriteModelPreferences } from '../src/api/handlers/models'
import { errorResponse } from '../src/api/response'
import { openForgeDatabase, resolveDataDir } from '../src/storage/database'
import { readExecutionPreferences } from '../src/utils/tui-execution-preferences'
import type { ApiDeps } from '../src/api/types'

const TEST_DIR = '/tmp/opencode-forge-api-model-preferences-' + Date.now()

describe('model preferences API', () => {
  const originalDataHome = process.env.XDG_DATA_HOME
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    process.env.XDG_DATA_HOME = testDataDir
    mkdirSync(resolveDataDir(), { recursive: true })
    const db = openForgeDatabase(join(resolveDataDir(), 'graph.db'))
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
      const req = new Request('http://test.local/preferences', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      })

      const res = await handleWriteModelPreferences(req, {} as ApiDeps, { projectId })
      expect(res.status).toBe(200)

      const prefs = readExecutionPreferences(projectId)
      expect(prefs?.mode).toBe(expected)
    }
  })

  test('defaults omitted mode to new session', async () => {
    const projectId = 'project-omitted-mode'
    const req = new Request('http://test.local/preferences', {
      method: 'POST',
      body: JSON.stringify({ executionModel: 'test/model' }),
    })

    const res = await handleWriteModelPreferences(req, {} as ApiDeps, { projectId })
    expect(res.status).toBe(200)

    const prefs = readExecutionPreferences(projectId)
    expect(prefs?.mode).toBe('New session')
    expect(prefs?.executionModel).toBe('test/model')
  })

  test('invalid preference body returns bad request error', async () => {
    const req = new Request('http://test.local/preferences', {
      method: 'POST',
      body: JSON.stringify({ mode: 'invalid-mode' }),
    })

    let res: Response
    try {
      res = await handleWriteModelPreferences(req, {} as ApiDeps, { projectId: 'project-invalid-mode' })
    } catch (err) {
      res = errorResponse(err)
    }

    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('bad_request')
  })
})
