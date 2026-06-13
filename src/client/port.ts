import type { OpencodeClient } from '@opencode-ai/sdk/v2'

type V2 = OpencodeClient

// ── Session param types ──────────────────────────────────────────────────────
export type SessionCreateParams = NonNullable<Parameters<V2['session']['create']>[0]>
export type SessionGetParams = NonNullable<Parameters<V2['session']['get']>[0]>
export type SessionUpdateParams = NonNullable<Parameters<V2['session']['update']>[0]>
export type SessionMessagesParams = NonNullable<Parameters<V2['session']['messages']>[0]>
export type SessionStatusParams = NonNullable<Parameters<V2['session']['status']>[0]>
export type SessionPromptAsyncParams = NonNullable<Parameters<V2['session']['promptAsync']>[0]>
export type SessionAbortParams = NonNullable<Parameters<V2['session']['abort']>[0]>
export type SessionDeleteParams = NonNullable<Parameters<V2['session']['delete']>[0]>

// ── Session result types ─────────────────────────────────────────────────────
export type Session = NonNullable<Awaited<ReturnType<V2['session']['create']>>['data']>
export type SessionMessages = NonNullable<Awaited<ReturnType<V2['session']['messages']>>['data']>
export type SessionStatus = NonNullable<Awaited<ReturnType<V2['session']['status']>>['data']>

// ── Workspace param types ────────────────────────────────────────────────────
export type WorkspaceCreateParams = NonNullable<Parameters<V2['experimental']['workspace']['create']>[0]>
export type WorkspaceListParams = NonNullable<Parameters<V2['experimental']['workspace']['list']>[0]>
export type WorkspaceStatusParams = NonNullable<Parameters<V2['experimental']['workspace']['status']>[0]>
export type WorkspaceSyncListParams = NonNullable<Parameters<V2['experimental']['workspace']['syncList']>[0]>
export type WorkspaceRemoveParams = NonNullable<Parameters<V2['experimental']['workspace']['remove']>[0]>
export type WorkspaceWarpParams = NonNullable<Parameters<V2['experimental']['workspace']['warp']>[0]>

// ── Workspace result types ───────────────────────────────────────────────────
export type WorkspaceCreateResult = NonNullable<Awaited<ReturnType<V2['experimental']['workspace']['create']>>['data']>
export type WorkspaceList = NonNullable<Awaited<ReturnType<V2['experimental']['workspace']['list']>>['data']>
export type WorkspaceStatus = NonNullable<Awaited<ReturnType<V2['experimental']['workspace']['status']>>['data']>

// ── TUI param types ──────────────────────────────────────────────────────────
export type TuiPublishParams = NonNullable<Parameters<V2['tui']['publish']>[0]>
export type TuiSelectSessionParams = NonNullable<Parameters<V2['tui']['selectSession']>[0]>

// ── Sync param types ─────────────────────────────────────────────────────────
export type SyncStartParams = NonNullable<Parameters<V2['sync']['start']>[0]>

// ── Error model ──────────────────────────────────────────────────────────────

export type ForgeClientErrorKind = 'connection' | 'not-found' | 'unavailable' | 'request'

export class ForgeClientError extends Error {
  readonly kind: ForgeClientErrorKind
  readonly method: string
  override readonly cause?: unknown
  /** SDK error code, propagated from `cause.code` when available (e.g. `"concurrent_prompt"`). */
  readonly code?: string

  constructor(args: { kind: ForgeClientErrorKind; method: string; message: string; cause?: unknown }) {
    super(args.message)
    this.name = 'ForgeClientError'
    this.kind = args.kind
    this.method = args.method
    this.cause = args.cause
    // Propagate SDK error code through so callers can detect specific error
    // codes (e.g. 'concurrent_prompt') on a port-level error.
    this.code = (args.cause && typeof args.cause === 'object' && 'code' in (args.cause as Record<string, unknown>))
      ? (args.cause as { code: string }).code
      : undefined
  }
}

// ── Port interface ───────────────────────────────────────────────────────────

export interface ForgeClient {
  session: {
    create(params: SessionCreateParams): Promise<Session>
    get(params: SessionGetParams): Promise<Session>
    update(params: SessionUpdateParams): Promise<void>
    messages(params: SessionMessagesParams): Promise<SessionMessages>
    status(params?: SessionStatusParams): Promise<SessionStatus>
    promptAsync(params: SessionPromptAsyncParams): Promise<void>
    abort(params: SessionAbortParams): Promise<void>
    delete(params: SessionDeleteParams): Promise<void>
  }
  workspace: {
    create(params: WorkspaceCreateParams): Promise<WorkspaceCreateResult>
    list(params?: WorkspaceListParams): Promise<WorkspaceList>
    status(params?: WorkspaceStatusParams): Promise<WorkspaceStatus>
    syncList(params?: WorkspaceSyncListParams): Promise<void>
    remove(params: WorkspaceRemoveParams): Promise<void>
    warp(params: WorkspaceWarpParams): Promise<void>
  }
  tui: {
    publish(params: TuiPublishParams): Promise<void>
    selectSession(params: TuiSelectSessionParams): Promise<void>
  }
  sync: {
    start(params?: SyncStartParams): Promise<void>
  }
}
