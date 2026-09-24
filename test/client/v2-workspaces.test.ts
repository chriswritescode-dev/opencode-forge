import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createForgeWorkspaceAdapter } from '../../src/workspace/forge-adapter'
import type { TeardownContextProvider } from '../../src/workspace/forge-adapter'
import { createV2ForgeWorkspaces } from '../../src/client/v2-workspaces'
import {
  readForgeWorkspaceMetadata,
  writeForgeWorkspaceMetadata,
} from '../../src/workspace/forge-workspace-metadata'
import { createPendingTeardownRegistry } from '../../src/workspace/pending-teardown'
import { removeForgeWorkspaceWithContext } from '../../src/workspace/remove-with-context'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeGitService } from '../helpers/fake-git'
import { createFakeV2Context } from '../helpers/fake-v2-context'

const PROJECT_ID = 'proj_fake'
const PROJECT_DIRECTORY = '/repo'
const LOOP_NAME = 'Loop One'
const WORKTREE_DIR_NAME = 'loop-one'
const RESTARTABLE_LOOP_NAME = 'restartable-loop'

function createLogger() {
  return { log: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function createParams(loopName = LOOP_NAME) {
  return {
    type: 'forge',
    branch: null,
    extra: { loopName, projectDirectory: PROJECT_DIRECTORY },
  }
}

describe('createV2ForgeWorkspaces', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'forge-v2-workspaces-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  function setup(
    overrides?: Parameters<typeof createFakeGitService>[0],
    options?: { getTeardownContext?: TeardownContextProvider },
  ) {
    const git = createFakeGitService(overrides)
    const logger = createLogger()
    const adapter = createForgeWorkspaceAdapter({
      dataDir,
      logger,
      gitService: git,
      getTeardownContext: options?.getTeardownContext,
    })
    const { ctx, calls } = createFakeV2Context()
    const workspaces = createV2ForgeWorkspaces({
      adapter,
      worktree: ctx.worktree,
      projectId: PROJECT_ID,
      dataDir,
      sessionMove: ctx.session.move,
    })
    return { git, logger, ctx, calls, workspaces }
  }

  it('creates the worktree, records metadata, and refreshes V2 inventory', async () => {
    const { calls, workspaces } = setup()
    const directory = join(dataDir, 'worktrees', WORKTREE_DIR_NAME)

    const created = await workspaces.create(createParams())

    expect(created.id).toBe(directory)
    expect(created.directory).toBe(directory)
    expect(created.branch).toBe('forge/loop-one')
    expect(created.projectID).toBe(PROJECT_ID)
    expect(readForgeWorkspaceMetadata(directory)).toMatchObject({
      id: directory,
      name: WORKTREE_DIR_NAME,
      type: 'forge',
      branch: 'forge/loop-one',
      directory,
      projectId: PROJECT_ID,
    })
    expect(readForgeWorkspaceMetadata(directory)?.extra?.loopName).toBe(LOOP_NAME)
    expect(calls.map((call) => call.method)).toContain('worktree.refresh')
  })

  it('lists the created workspace', async () => {
    const { workspaces } = setup()
    const created = await workspaces.create(createParams())

    const entries = await workspaces.list()
    expect(entries.map((entry) => entry.id)).toEqual([created.id])
    expect(entries[0].extra).toMatchObject({ loopName: LOOP_NAME })
    expect(entries[0].timeUsed).toBe(created.timeUsed)
  })

  it('drops records from other projects and workspaces whose worktree is gone', async () => {
    const { workspaces } = setup()
    const removed = join(dataDir, 'worktrees', 'removed')
    writeForgeWorkspaceMetadata(removed, {
      id: removed,
      name: 'removed',
      type: 'forge',
      branch: 'forge/removed',
      directory: removed,
      extra: null,
      projectId: PROJECT_ID,
      createdAt: 1,
    })
    await rm(removed, { recursive: true, force: true })
    const other = join(dataDir, 'worktrees', 'other')
    await mkdir(other, { recursive: true })
    writeForgeWorkspaceMetadata(other, {
      id: other,
      name: 'other',
      type: 'forge',
      branch: 'forge/other',
      directory: other,
      extra: null,
      projectId: 'proj_other',
      createdAt: 1,
    })

    await expect(workspaces.list()).resolves.toEqual([])
  })

  it('moves the session into the workspace directory', async () => {
    const { calls, workspaces } = setup()
    const directory = join(dataDir, 'worktrees', WORKTREE_DIR_NAME)

    await workspaces.warp({ id: directory, sessionID: 'ses_1' })

    expect(calls).toContainEqual({
      method: 'session.move',
      args: [{ sessionID: 'ses_1', directory, delivery: 'queue' }],
    })
  })

  it('removes the worktree through the adapter and prunes the listing', async () => {
    const { git, workspaces } = setup({
      worktreeAdd: vi.fn((_repo: string, directory: string) => {
        mkdirSync(join(directory, '.git'), { recursive: true })
        return { ok: true, status: 0, stdout: '', stderr: '' }
      }),
      worktreeRemove: vi.fn((_repo: string, directory: string) => {
        rmSync(directory, { recursive: true, force: true })
        return { ok: true, status: 0, stdout: '', stderr: '' }
      }),
    })
    const created = await workspaces.create(createParams())

    await workspaces.remove({ id: created.id })

    expect(git.worktreeRemove).toHaveBeenCalled()
    expect(existsSync(created.id)).toBe(false)
    await expect(workspaces.list()).resolves.toEqual([])
  })

  it('unregisters a restart-preserving removal and keeps the worktree', async () => {
    const pendingTeardowns = createPendingTeardownRegistry()
    const { logger, workspaces } = setup(undefined, {
      getTeardownContext: (loopName) => pendingTeardowns.get(loopName),
    })
    const created = await workspaces.create(createParams(RESTARTABLE_LOOP_NAME))
    const { client } = createFakeForgeClient({ workspace: workspaces })

    const result = await removeForgeWorkspaceWithContext(
      { client, pendingTeardowns, logger },
      {
        workspaceId: created.id,
        loopName: RESTARTABLE_LOOP_NAME,
        action: 'remove-registration-only',
        reasonLabel: 'attach-safety-net-restartable',
      },
    )

    expect(result.ok).toBe(true)
    expect(existsSync(created.id)).toBe(true)
    expect(readForgeWorkspaceMetadata(created.id)).toBeUndefined()
    await expect(workspaces.list()).resolves.toEqual([])

    const recreated = await workspaces.create(createParams(RESTARTABLE_LOOP_NAME))

    expect(recreated.id).toBe(created.id)
    expect(readForgeWorkspaceMetadata(created.id)).toMatchObject({ id: created.id })
    await expect(workspaces.list()).resolves.toHaveLength(1)
  })

  it('preserves registration when the adapter removal fails', async () => {
    const { workspaces } = setup({
      worktreeAdd: vi.fn((_repo: string, directory: string) => {
        mkdirSync(join(directory, '.git'), { recursive: true })
        return { ok: true, status: 0, stdout: '', stderr: '' }
      }),
      worktreeRemove: vi.fn(() => ({ ok: false, status: 1, stdout: '', stderr: 'worktree remove failed' })),
    })
    const created = await workspaces.create(createParams())

    await expect(workspaces.remove({ id: created.id })).rejects.toThrow(/worktree remove failed/)

    expect(existsSync(created.id)).toBe(true)
    expect(readForgeWorkspaceMetadata(created.id)).toMatchObject({ id: created.id })
    await expect(workspaces.list()).resolves.toHaveLength(1)
  })
})
