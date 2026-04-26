import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { attachForgeApiServer } from '../../src/api/server'
import { getProjectRegistry } from '../../src/api/project-registry'
import { initializeDatabase, closeDatabase, createLoopsRepo, createPlansRepo } from '../../src/storage'
import type { ToolContext } from '../../src/tools/types'
import type { LoopRow, LoopLargeFields } from '../../src/storage/repos/loops-repo'

const TEST_DIR = '/tmp/opencode-forge-api-multi-project-' + Date.now()

function makeLoopRow(projectId: string, loopName: string): { row: LoopRow; large: LoopLargeFields } {
  return {
    row: {
      projectId,
      loopName,
      status: 'running',
      currentSessionId: `${loopName}-session`,
      auditSessionId: null,
      worktree: false,
      worktreeDir: `/tmp/${loopName}`,
      worktreeBranch: null,
      projectDir: `/tmp/${loopName}`,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
    },
    large: {
      prompt: null,
      lastAuditResult: null,
    },
  }
}

function makeCtx(projectId: string, directory: string, plansRepo: ReturnType<typeof createPlansRepo>): ToolContext {
  return {
    projectId,
    directory,
    plansRepo,
    logger: {
      log: () => {},
      debug: () => {},
      error: () => {},
    },
    config: {
      api: {
        enabled: true,
        host: '127.0.0.1',
        port: 35556,
      },
    },
    loopService: {
      listActive: () => [],
    },
  } as unknown as ToolContext
}

describe('multi-project API handlers', () => {
  const registry = getProjectRegistry()
  const originalServe = Bun.serve
  const originalDataHome = process.env['XDG_DATA_HOME']
  const originalPassword = process.env['OPENCODE_SERVER_PASSWORD']

  let testDataDir = ''
  let serverHandle: { stop: () => Promise<void> } | null = null
  let fetchHandler: ((req: Request) => Promise<Response>) | null = null
  let db: ReturnType<typeof initializeDatabase> | null = null

  beforeEach(() => {
    testDataDir = `${TEST_DIR}-${Math.random().toString(36).slice(2)}`
    mkdirSync(testDataDir, { recursive: true })
    process.env['XDG_DATA_HOME'] = testDataDir
    delete process.env['OPENCODE_SERVER_PASSWORD']
    for (const ctx of registry.list()) {
      registry.unregister(ctx.projectId)
    }

    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock((options) => {
      fetchHandler = options.fetch
      return {
        stop: () => {},
      } as ReturnType<typeof Bun.serve>
    })
  })

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.stop()
      serverHandle = null
    }
    if (db) {
      closeDatabase(db)
      db = null
    }
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe
    for (const ctx of registry.list()) {
      registry.unregister(ctx.projectId)
    }
    if (originalDataHome === undefined) {
      delete process.env['XDG_DATA_HOME']
    } else {
      process.env['XDG_DATA_HOME'] = originalDataHome
    }
    if (originalPassword === undefined) {
      delete process.env['OPENCODE_SERVER_PASSWORD']
    } else {
      process.env['OPENCODE_SERVER_PASSWORD'] = originalPassword
    }
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('dispatches requests by project and supports directory-filtered project listing', async () => {
    db = initializeDatabase(`${testDataDir}/opencode/forge`)
    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)

    const projectA = makeCtx('project-a', '/path/A', plansRepo)
    const projectB = makeCtx('project-b', '/path/B', plansRepo)
    registry.register(projectA)
    registry.register(projectB)

    serverHandle = attachForgeApiServer(projectA, registry)
    expect(serverHandle).not.toBeNull()
    expect(fetchHandler).not.toBeNull()

    const loopA = makeLoopRow('project-a', 'loop-a')
    const loopB = makeLoopRow('project-b', 'loop-b')
    loopsRepo.insert(loopA.row, loopA.large)
    loopsRepo.insert(loopB.row, loopB.large)
    plansRepo.writeForSession('project-a', 'session-1', '# Plan A')

    const filteredRes = await fetchHandler!(
      new Request('http://127.0.0.1:35556/api/v1/projects?directory=%2Fpath%2FA')
    )
    const filtered = await filteredRes.json() as { data: { projects: Array<{ id: string }> } }
    expect(filteredRes.status).toBe(200)
    expect(filtered.data.projects.map((project) => project.id)).toEqual(['project-a'])

    const listRes = await fetchHandler!(new Request('http://127.0.0.1:35556/api/v1/projects'))
    const listBody = await listRes.json() as { data: { projects: Array<{ id: string }> } }
    expect(listRes.status).toBe(200)
    expect(listBody.data.projects.map((project) => project.id).sort()).toEqual(['project-a', 'project-b'])

    const loopsRes = await fetchHandler!(
      new Request('http://127.0.0.1:35556/api/v1/projects/project-b/loops', {
        headers: { 'x-opencode-directory': '/path/B' },
      })
    )
    const loopsBody = await loopsRes.json() as {
      data: { loops: Array<{ loopName: string }> }
    }
    expect(loopsRes.status).toBe(200)
    expect(loopsBody.data.loops.map((loop) => loop.loopName)).toEqual(['loop-b'])

    const mismatchedDirectoryRes = await fetchHandler!(
      new Request('http://127.0.0.1:35556/api/v1/projects/project-b/loops', {
        headers: { 'x-opencode-directory': '/path/A' },
      })
    )
    expect(mismatchedDirectoryRes.status).toBe(404)

    const planARes = await fetchHandler!(
      new Request('http://127.0.0.1:35556/api/v1/projects/project-a/plans/session/session-1')
    )
    expect(planARes.status).toBe(200)

    const planBRes = await fetchHandler!(
      new Request('http://127.0.0.1:35556/api/v1/projects/project-b/plans/session/session-1')
    )
    expect(planBRes.status).toBe(404)

    const unknownRes = await fetchHandler!(
      new Request('http://127.0.0.1:35556/api/v1/projects/project-c/loops')
    )
    const unknownBody = await unknownRes.json() as { error: { message: string } }
    expect(unknownRes.status).toBe(404)
    expect(unknownBody.error.message).toContain('project not registered')
  })
})
