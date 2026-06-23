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

import { vi } from 'vitest'
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
   * Create a `vi.fn()` with call recording. If an `overrideImpl` is provided it
   * replaces the default implementation, but the resulting `vi.fn()` still
   * records invocations to the shared `calls` array.
   */
  function makeMethod<T extends (...args: unknown[]) => unknown>(
    methodPath: string,
    defaultImpl: T,
    overrideImpl?: T,
  ): T & ReturnType<typeof vi.fn> {
    const impl = overrideImpl ?? defaultImpl
    return vi.fn(((...args: unknown[]) => {
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
      list: makeMethod(
        'session.list',
        async (_p: Record<string, unknown>) => [],
        overrides?.session?.list,
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
    project: {
      list: makeMethod(
        'project.list',
        async (_p: Record<string, unknown>) => [],
        overrides?.project?.list,
      ),
    },
    provider: {
      list: makeMethod(
        'provider.list',
        async (_p: Record<string, unknown>) => ({ all: [], connected: [] }),
        overrides?.provider?.list,
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
    events: {
      subscribeGlobal: makeMethod(
        'events.subscribeGlobal',
        (_onEvent: unknown, _opts?: unknown) => () => {},
        overrides?.events?.subscribeGlobal,
      ),
    },
  }

  return { client, calls }
}
