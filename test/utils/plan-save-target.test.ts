import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { savePlanFromDialog } from '../../src/utils/plan-save-target'
import { resolvePlanArchiveDir } from '../../src/utils/plan-archive'

const TEST_DIR = '/tmp/opencode-forge-plan-save-target-test-' + Date.now()

describe('savePlanFromDialog', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('sessionId present writes to session and does not touch archive', async () => {
    const calls: Array<[string, string]> = []
    const outcome = await savePlanFromDialog({
      sessionId: 'session-1',
      projectId: 'project-1',
      text: '# Session Plan',
      writeSession: async (sessionId, text) => {
        calls.push([sessionId, text])
        return true
      },
    })

    expect(calls).toEqual([['session-1', '# Session Plan']])
    expect(existsSync(resolvePlanArchiveDir('project-1'))).toBe(false)
    expect(outcome).toEqual({ kind: 'session', ok: true })
  })

  test('sessionId present returns false when session write fails', async () => {
    const outcome = await savePlanFromDialog({
      sessionId: 'session-1',
      projectId: 'project-1',
      text: '# Session Plan',
      writeSession: async () => false,
    })

    expect(outcome).toEqual({ kind: 'session', ok: false })
  })

  test('sessionId empty archives and dedupes identical content', async () => {
    let sessionWrites = 0
    const args = {
      sessionId: undefined,
      projectId: 'project-archive',
      text: '# Archived Plan',
      writeSession: async () => {
        sessionWrites += 1
        return true
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    }

    const first = await savePlanFromDialog(args)
    const second = await savePlanFromDialog(args)

    expect(sessionWrites).toBe(0)
    if (first.kind === 'archive' && first.ok) {
      expect(first.deduped).toBe(false)
      expect(first.filename).toMatch(/^[0-9a-f]{64}\.md$/)
      expect(existsSync(first.filepath)).toBe(true)
    } else {
      throw new Error('expected archive success')
    }
    if (second.kind === 'archive' && second.ok) {
      expect(second.deduped).toBe(true)
      expect(existsSync(second.filepath)).toBe(true)
    } else {
      throw new Error('expected archive success')
    }
  })

  test('sessionId empty and projectId missing returns noop and writes nothing', async () => {
    let sessionWrites = 0
    const outcome = await savePlanFromDialog({
      sessionId: '',
      projectId: undefined,
      text: '# No Context',
      writeSession: async () => {
        sessionWrites += 1
        return true
      },
    })

    expect(sessionWrites).toBe(0)
    expect(outcome).toEqual({ kind: 'noop', reason: 'missing-project' })
    expect(existsSync(join(testDataDir, 'opencode', 'forge', 'plans'))).toBe(false)
  })

  test('archive write errors are returned as archive failures', async () => {
    const sentinel = join(testDataDir, 'opencode')
    mkdirSync(testDataDir, { recursive: true })
    writeFileSync(sentinel, 'not a directory')

    const outcome = await savePlanFromDialog({
      sessionId: undefined,
      projectId: 'project-error',
      text: '# Error Plan',
      writeSession: async () => true,
    })

    if (outcome.kind === 'archive' && !outcome.ok) {
      expect(outcome.error).toBeInstanceOf(Error)
    } else {
      throw new Error('expected archive failure')
    }
  })
})
