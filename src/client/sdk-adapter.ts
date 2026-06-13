import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { PluginInput } from '@opencode-ai/plugin'
import { ForgeClientError, type ForgeClient, type ForgeClientErrorKind } from './port'

// ── Error classification ─────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (obj.data && typeof obj.data === 'object') {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === 'string') return data.message
    }
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function classify(err: unknown, method: string): ForgeClientError {
  const rawMessage = extractMessage(err)
  let kind: ForgeClientErrorKind = 'request'
  if (/Unable to connect|fetch failed|ECONNREFUSED/i.test(rawMessage)) {
    kind = 'connection'
  } else if (/not found/i.test(rawMessage)) {
    kind = 'not-found'
  }
  return new ForgeClientError({ kind, method, message: rawMessage, cause: err })
}

// ── Result normalisation helpers ─────────────────────────────────────────────

/**
 * Call an SDK method that returns meaningful data. Normalises the
 * `{ data, error }` envelope so callers always get data or a classified error.
 */
async function withData<T>(
  method: string,
  promise: Promise<{ data?: T | undefined; error?: unknown }>,
): Promise<T> {
  let result: { data?: T | undefined; error?: unknown }
  try {
    result = await promise
  } catch (err: unknown) {
    throw classify(err, method)
  }
  if (result.error) {
    throw classify(result.error, method)
  }
  if (result.data == null) {
    throw classify(new Error('no data returned'), method)
  }
  return result.data
}

/**
 * Call an SDK method that returns no meaningful data (void). Only checks the
 * `{ data, error }` envelope for errors.
 */
async function withVoid(
  method: string,
  promise: Promise<{ data?: unknown; error?: unknown }>,
): Promise<void> {
  let result: { data?: unknown; error?: unknown }
  try {
    result = await promise
  } catch (err: unknown) {
    throw classify(err, method)
  }
  if (result.error) {
    throw classify(result.error, method)
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createForgeClient(v2: OpencodeClient): ForgeClient {
  // ── session namespace ────────────────────────────────────────────────────
  const session: ForgeClient['session'] = {
    create: (params) => withData('session.create', v2.session.create(params)),
    get: (params) => withData('session.get', v2.session.get(params)),
    update: (params) => withVoid('session.update', v2.session.update(params)),
    messages: (params) => withData('session.messages', v2.session.messages(params)),
    status: (params) => withData('session.status', v2.session.status(params)),
    promptAsync: (params) => withVoid('session.promptAsync', v2.session.promptAsync(params)),
    abort: (params) => withVoid('session.abort', v2.session.abort(params)),
    delete: (params) => withVoid('session.delete', v2.session.delete(params)),
  }

  // ── workspace namespace ──────────────────────────────────────────────────
  // Guard: experimental.workspace must be available at runtime.
  const wsApi = v2.experimental?.workspace

  function requireWsApi(method: string): NonNullable<typeof wsApi> {
    if (!wsApi || typeof wsApi[method.split('.').pop() as keyof typeof wsApi] !== 'function') {
      throw new ForgeClientError({
        kind: 'unavailable',
        method: `workspace.${method}`,
        message: `experimental.workspace.${method} not available on this host`,
      })
    }
    return wsApi
  }

  function guardWs<T>(method: string, fn: () => Promise<T>): Promise<T> {
    try {
      requireWsApi(method)
    } catch (err: unknown) {
      return Promise.reject(err)
    }
    return fn()
  }

  const workspace: ForgeClient['workspace'] = {
    create: (params) => guardWs('create', () => withData('workspace.create', wsApi!.create(params))),
    list: (params) => guardWs('list', () => withData('workspace.list', wsApi!.list(params))),
    status: (params) => guardWs('status', () => withData('workspace.status', wsApi!.status(params))),
    syncList: (params) => guardWs('syncList', () => withVoid('workspace.syncList', wsApi!.syncList(params))),
    remove: (params) => guardWs('remove', () => withVoid('workspace.remove', wsApi!.remove(params))),
    warp: (params) => guardWs('warp', () => withVoid('workspace.warp', wsApi!.warp(params))),
  }

  // ── tui namespace ────────────────────────────────────────────────────────
  const tui: ForgeClient['tui'] = {
    publish: async (params) => {
      if (!v2.tui) return // resolve as no-op when namespace unavailable
      return withVoid('tui.publish', v2.tui.publish(params))
    },
    selectSession: async (params) => {
      if (!v2.tui) {
        throw new ForgeClientError({
          kind: 'unavailable',
          method: 'tui.selectSession',
          message: 'tui namespace not available on this host',
        })
      }
      return withVoid('tui.selectSession', v2.tui.selectSession(params))
    },
  }

  // ── sync namespace ───────────────────────────────────────────────────────
  const sync: ForgeClient['sync'] = {
    start: async (params) => {
      if (!v2.sync?.start) return // resolve as no-op when method unavailable
      return withVoid('sync.start', v2.sync.start(params))
    },
  }

  return { session, workspace, tui, sync }
}

// ── Combined factory ─────────────────────────────────────────────────────────

/**
 * One-stop factory: create an SDK v2 client from plugin input, then wrap it in
 * a `ForgeClient`. This is the only import callers in `src/` (outside the
 * adapter) need.
 */
export function createForgeClientFromPluginInput(
  pluginInput: PluginInput,
): ForgeClient {
  return createForgeClient(createV2ClientFromPluginInput(pluginInput))
}

// ── Legacy client adapter ────────────────────────────────────────────────────

/**
 * Create an SDK v2 client from the plugin's legacy client. This is the **only**
 * place in `src/` that should touch the legacy client after this port completes.
 *
 * Extracts the in-process fetch function and Authorization header from the
 * plugin-provided legacy client so the v2 client can dispatch in-process AND
 * satisfy the server's Basic auth requirement.
 */
export function createV2ClientFromPluginInput(pluginInput: PluginInput): OpencodeClient {
  const legacyHttp = (
    pluginInput.client as unknown as {
      _client?: { getConfig: () => { fetch?: typeof fetch; headers?: Headers } }
    }
  )._client
  const legacyConfig = legacyHttp?.getConfig?.()
  const legacyFetch = legacyConfig?.fetch
  const legacyAuthHeader =
    legacyConfig?.headers?.get?.('authorization') ?? legacyConfig?.headers?.get?.('Authorization')
  const v2ClientConfig: Parameters<typeof createV2Client>[0] = {
    baseUrl: pluginInput.serverUrl.toString(),
    directory: pluginInput.directory,
    ...(legacyFetch ? { fetch: legacyFetch } : {}),
    ...(legacyAuthHeader ? { headers: { Authorization: legacyAuthHeader } } : {}),
  }
  return createV2Client(v2ClientConfig)
}
