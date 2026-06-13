/**
 * Fully typed `ForgeClient` test fake with cross-namespace call recording.
 *
 * Use this instead of hand-rolling mock clients in every test file. Every
 * method is a `vi.fn()` (via `mock` from `bun:test`) that resolves a sensible
 * default. The returned `calls` array records every method invocation in order
 * across all namespaces, so tests can assert sequencing.
 *
 * @example
 * ```ts
 * const { client, calls } = createFakeForgeClient()
 * await client.session.create({ sessionID: 's1', directory: '/tmp' })
 * expect(calls[0].method).toBe('session.create')
 * ```
 *
 * @example
 * ```ts
 * // Override a specific method — the override replaces the default impl but
 * // calls are still recorded in the `calls` array.
 * const { client } = createFakeForgeClient({
 *   session: { create: async () => ({ id: 'custom' }) },
 * })
 * ```
 */

import { mock } from 'bun:test'
import type { ForgeClient } from '../../src/client/port'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursive `Partial` so callers only need to specify the methods they want to
 * override at any nesting level.
 */
type DeepPartial<T> = T extends (...args: unknown[]) => unknown
  ? (...args: any[]) => any
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T

// ── Public types ──────────────────────────────────────────────────────────────

export interface RecordedCall {
  method: string
  params: unknown
}

export interface CreateFakeForgeClientResult {
  client: ForgeClient
  /**
   * Every method invocation, in call order, across all namespaces. Useful for
   * sequencing assertions that span `session`, `workspace`, `tui`, and `sync`.
   */
  calls: RecordedCall[]
}

// ── Factory ───────────────────────────────────────────────────────────────────

let globalSessionCounter = 0
let globalWorkspaceCounter = 0

export function createFakeForgeClient(
  overrides?: DeepPartial<ForgeClient>,
): CreateFakeForgeClientResult {
  const calls: RecordedCall[] = []

  // Reset per-call counters so each factory invocation starts clean.
  globalSessionCounter = 0
  globalWorkspaceCounter = 0

  /**
   * Create a `mock()` with call recording. If an `overrideImpl` is provided it
   * replaces the default implementation, but the resulting `mock()` still
   * records invocations to the shared `calls` array.
   */
  function makeMethod<T extends (...args: unknown[]) => unknown>(
    methodPath: string,
    defaultImpl: T,
    overrideImpl?: T,
  ): T & ReturnType<typeof mock> {
    const impl = overrideImpl ?? defaultImpl
    return mock(((...args: unknown[]) => {
      calls.push({ method: methodPath, params: args[0] })
      return impl(...args)
    }) as any) as any
  }

  const client: ForgeClient = {
    session: {
      create: makeMethod(
        'session.create',
        async (_p: Record<string, unknown>) => ({
          id: `ses_fake_${++globalSessionCounter}`,
        }),
        overrides?.session?.create,
      ),
      get: makeMethod(
        'session.get',
        async (_p: Record<string, unknown>) => ({
          id: 'ses_fake_1',
        }),
        overrides?.session?.get,
      ),
      update: makeMethod(
        'session.update',
        async (_p: Record<string, unknown>) => {},
        overrides?.session?.update,
      ),
      messages: makeMethod(
        'session.messages',
        async (_p: Record<string, unknown>) => [],
        overrides?.session?.messages,
      ),
      status: makeMethod(
        'session.status',
        async (_p: Record<string, unknown>) => ({}),
        overrides?.session?.status,
      ),
      promptAsync: makeMethod(
        'session.promptAsync',
        async (_p: Record<string, unknown>) => {},
        overrides?.session?.promptAsync,
      ),
      abort: makeMethod(
        'session.abort',
        async (_p: Record<string, unknown>) => {},
        overrides?.session?.abort,
      ),
      delete: makeMethod(
        'session.delete',
        async (_p: Record<string, unknown>) => {},
        overrides?.session?.delete,
      ),
    },
      workspace: {
        create: makeMethod(
          'workspace.create',
          async (_p: Record<string, unknown>) => ({
            id: `ws_fake_${++globalWorkspaceCounter}`,
            directory: '/tmp/fake-workspace-dir',
            branch: 'fake-workspace-branch',
          }),
          overrides?.workspace?.create,
        ),
      list: makeMethod(
        'workspace.list',
        async (_p: Record<string, unknown>) => [],
        overrides?.workspace?.list,
      ),
      status: makeMethod(
        'workspace.status',
        async (_p: Record<string, unknown>) => ({}),
        overrides?.workspace?.status,
      ),
      syncList: makeMethod(
        'workspace.syncList',
        async (_p: Record<string, unknown>) => {},
        overrides?.workspace?.syncList,
      ),
      remove: makeMethod(
        'workspace.remove',
        async (_p: Record<string, unknown>) => {},
        overrides?.workspace?.remove,
      ),
      warp: makeMethod(
        'workspace.warp',
        async (_p: Record<string, unknown>) => {},
        overrides?.workspace?.warp,
      ),
    },
    tui: {
      publish: makeMethod(
        'tui.publish',
        async (_p: Record<string, unknown>) => {},
        overrides?.tui?.publish,
      ),
      selectSession: makeMethod(
        'tui.selectSession',
        async (_p: Record<string, unknown>) => {},
        overrides?.tui?.selectSession,
      ),
    },
    sync: {
      start: makeMethod(
        'sync.start',
        async (_p: Record<string, unknown>) => {},
        overrides?.sync?.start,
      ),
    },
  }

  return { client, calls }
}

/**
 * Convenience: create a mock ForgeClient from an existing v2-style mock that
 * has `session.*`, `tui.*`, `experimental.workspace.*` methods. This lets
 * tests that already have a hand-rolled `mockV2Client` also satisfy the
 * `client: ForgeClient` field without rewriting every assertion.
 *
 * The returned object delegates calls to the v2 mock's methods, stripping the
 * `{ data, error }` envelope so the ForgeClient contract (data-or-throw) is
 * upheld.
 */
type V2Mock = {
  session?: Record<string, any>
  tui?: Record<string, any>
  experimental?: { workspace?: Record<string, any> }
}

function unwrapResult(result: any): any {
  if (result?.error) throw result.error
  if (result?.data === undefined || result?.data === null) throw Object.assign(new Error('not found'), { kind: 'not-found' })
  return result.data
}

export function forgeClientFromV2Mock(v2Mock: V2Mock): ForgeClient {
  const ws = v2Mock.experimental?.workspace ?? {}
  const sess = v2Mock.session ?? {}
  const tuiNs = v2Mock.tui ?? {}
  return {
    session: {
      create: async (params: any) => {
        if (!sess.create) throw new Error('session.create not available')
        return unwrapResult(await sess.create(params))
      },
      get: async (params: any) => {
        if (!sess.get) throw new Error('session.get not available')
        return unwrapResult(await sess.get(params))
      },
      update: async (params: any) => {
        if (!sess.update) throw new Error('session.update not available')
        return unwrapResult(await sess.update(params))
      },
      messages: async (params: any) => {
        if (!sess.messages) throw new Error('session.messages not available')
        return unwrapResult(await sess.messages(params))
      },
      status: async (params: any) => {
        if (!sess.status) throw new Error('session.status not available')
        return unwrapResult(await sess.status(params))
      },
      promptAsync: async (params: any) => {
        if (!sess.promptAsync) throw new Error('session.promptAsync not available')
        const result = await sess.promptAsync(params)
        if (result?.error) throw result.error
      },
      abort: async (params: any) => {
        if (!sess.abort) throw new Error('session.abort not available')
        await sess.abort(params)
      },
      delete: async (params: any) => {
        if (!sess.delete) throw new Error('session.delete not available')
        await sess.delete(params)
      },
    },
    workspace: {
      create: async (params: any) => {
        if (!ws.create) throw new Error('workspace.create not available')
        return unwrapResult(await ws.create(params))
      },
      list: async (params?: any) => {
        if (!ws.list) throw new Error('workspace.list not available')
        return unwrapResult(await ws.list(params)) ?? []
      },
      status: async (params?: any) => {
        if (!ws.status) throw new Error('workspace.status not available')
        return unwrapResult(await ws.status(params)) ?? {}
      },
      syncList: async (params?: any) => {
        if (!ws.syncList) throw new Error('workspace.syncList not available')
        await ws.syncList(params)
      },
      remove: async (params: any) => {
        if (!ws.remove) throw new Error('workspace.remove not available')
        await ws.remove(params)
      },
      warp: async (params: any) => {
        if (!ws.warp) throw new Error('workspace.warp not available')
        const result = await ws.warp(params)
        if (result?.error) throw result.error
      },
    },
    tui: {
      publish: async (params: any) => {
        if (!tuiNs.publish) throw new Error('tui.publish not available')
        await tuiNs.publish(params)
      },
      selectSession: async (params: any) => {
        if (!tuiNs.selectSession) throw new Error('tui.selectSession not available')
        await tuiNs.selectSession(params)
      },
    },
    sync: {} as any,
  }
}
