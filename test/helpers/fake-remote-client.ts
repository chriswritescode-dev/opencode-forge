/**
 * Shared remote-loop test fakes: a `ForgeClient` with remote-launch flow
 * defaults (fixed workspace/session ids, `connected` workspace status, one
 * matching project) plus a `vi.fn()` client factory that records produced
 * clients. Used by both `test/utils/tui-remote-launch.test.ts` and
 * `test/services/loop-migration.test.ts`.
 */

import { vi } from 'vitest'
import type { ForgeClient } from '../../src/client/port'
import type { RemoteClientOptions } from '../../src/client/sdk-adapter'
import { createFakeForgeClient } from './fake-client'

export const REMOTE_URL = 'http://remote:4096'
export const LOCAL_PROJECT_ID = 'proj_1'
export const REMOTE_PROJECT_WORKTREE = '/remote/my-project'
export const REMOTE_SESSION_ID = 'sess_remote'
export const REMOTE_WORKSPACE_ID = 'ws_remote'

export function makeFakeRemoteClient(overrides?: Parameters<typeof createFakeForgeClient>[0]): ForgeClient {
  const { client } = createFakeForgeClient({
    session: {
      create: async () => ({ id: REMOTE_SESSION_ID }),
    },
    workspace: {
      create: async () => ({ id: REMOTE_WORKSPACE_ID, directory: REMOTE_PROJECT_WORKTREE, branch: null }),
      status: async () => [{ workspaceID: REMOTE_WORKSPACE_ID, status: 'connected' }],
    },
    project: {
      list: async () => [{ id: LOCAL_PROJECT_ID, worktree: REMOTE_PROJECT_WORKTREE }],
    },
    ...overrides,
  })
  return client
}

/** Create a `vi.fn()` based `createClient` factory that records produced clients. */
export function createClientSpy(overrides?: Parameters<typeof createFakeForgeClient>[0]): {
  spy: ReturnType<typeof vi.fn>
  clients: ForgeClient[]
} {
  const clients: ForgeClient[] = []
  const spy = vi.fn((_opts: RemoteClientOptions) => {
    const client = makeFakeRemoteClient(overrides)
    clients.push(client)
    return client
  })
  return { spy, clients }
}
