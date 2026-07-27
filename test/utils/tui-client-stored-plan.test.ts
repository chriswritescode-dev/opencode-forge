import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/utils/tui-execution-preferences', () => ({
  deriveExecutionPreferencesFromWorkspaces: vi.fn().mockReturnValue(null),
}))

vi.mock('../../src/utils/tui-models', () => ({
  fetchAvailableModels: vi.fn().mockResolvedValue({ providers: [] }),
  readOpenCodeFavoriteModels: vi.fn().mockReturnValue([]),
}))

vi.mock('../../src/utils/workspace-listing', () => ({
  listConnectedWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
  resolveDataDir: vi.fn().mockReturnValue('/tmp/forge-test-data-dir'),
  resolveForgeDbPath: vi.fn((dataDir?: string) => `${dataDir ?? '/tmp/forge-test-data-dir'}/forge.db`),
}))

vi.mock('../../src/services/execution', () => ({
  ForgeLoopExtra: {},
}))

import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { connectForgeProject } from '../../src/utils/tui-client'
import { openForgeDatabase } from '../../src/storage/database'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'

const PROJECT_ID = 'proj_stored_plan'
const DIRECTORY = '/tmp/test'
const SESSION_ID = 'sess_stored_plan'

function makeDbPath(): string {
  return join(tmpdir(), `forge-tui-client-stored-plan-${randomUUID()}.db`)
}

describe('connectForgeProject.loadLatestPlan honors configured dataDir', () => {
  let mockApi: any

  beforeEach(() => {
    mockApi = {
      client: {
        project: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: PROJECT_ID, worktree: DIRECTORY }],
          }),
        },
        session: {
          // Spy used to assert the chat-scan fallback is NOT hit when the
          // stored plan resolves from the configured data directory.
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    }
  })

  test('returns the stored plan from the configured dataDir without calling session.messages', async () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Stored Plan\n## Phase 1\nbody')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const client = await connectForgeProject(mockApi, DIRECTORY, [], dbPath)
    expect(client).not.toBeNull()

    const plan = await client!.loadLatestPlan(SESSION_ID)
    expect(plan).toBe('# Stored Plan\n## Phase 1\nbody')

    // Storage-first means the chat scan must not run when a stored row exists.
    expect(mockApi.client.session.messages).not.toHaveBeenCalled()
  })

  test('falls back to the chat scan when no stored row exists for the session', async () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    db.close()

    const client = await connectForgeProject(mockApi, DIRECTORY, [], dbPath)
    expect(client).not.toBeNull()

    const plan = await client!.loadLatestPlan(SESSION_ID)
    expect(plan).toBeNull()

    // No stored plan → the message-scan fallback runs.
    expect(mockApi.client.session.messages).toHaveBeenCalledTimes(1)
    expect(mockApi.client.session.messages.mock.calls[0][0]).toMatchObject({
      sessionID: SESSION_ID,
      directory: DIRECTORY,
    })
  })

  test('with no dbPath override, reads from the default data dir path (still null for unknown session)', async () => {
    // No configured dataDir → connectForgeProject receives undefined and
    // fetchStoredSessionPlan falls back to the default path. We can't write
    // into the real default DB from a test, so we only assert that the
    // chat-scan fallback is reached (proving the default path was tried and
    // missed).
    const client = await connectForgeProject(mockApi, DIRECTORY, [], undefined)
    expect(client).not.toBeNull()

    const plan = await client!.loadLatestPlan(SESSION_ID)
    expect(plan).toBeNull()
    expect(mockApi.client.session.messages).toHaveBeenCalledTimes(1)
  })
})
