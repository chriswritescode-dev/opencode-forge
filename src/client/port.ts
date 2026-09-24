// ── Permission types ──────────────────────────────────────────────────────────
export type SessionPermissionRule = {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

// ── Session param types ──────────────────────────────────────────────────────
export type SessionCreateParams = {
  title?: string
  directory?: string
  workspaceID?: string
  workspace?: string
  permission?: SessionPermissionRule[]
}

export type SessionGetParams = {
  sessionID: string
  directory?: string
}

export type SessionUpdateParams = {
  sessionID: string
  directory?: string
  title?: string
  permission?: SessionPermissionRule[]
}

export type SessionMessagesParams = {
  sessionID: string
  directory?: string
  limit?: number
}

export type SessionStatusParams = {
  directory?: string
}

export type SessionPromptAsyncParams = {
  sessionID: string
  directory?: string
  workspace?: string
  parts?: SessionMessagePart[]
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

export type SessionAbortParams = {
  sessionID: string
  directory?: string
}

export type SessionDeleteParams = {
  sessionID: string
  directory?: string
}

// ── Session result types ─────────────────────────────────────────────────────
export type Session = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  time: { created: number; updated: number }
  parentID?: string
  workspaceID?: string
  permission?: SessionPermissionRule[]
}

export type SessionStatus = Record<string, {
  type: 'idle' | 'busy' | 'retry'
  attempt?: number
  message?: string
  next?: number
  [key: string]: unknown
}>

// ── Session message types ────────────────────────────────────────────────────
export type SessionMessagePart = {
  id?: string
  messageID?: string
  sessionID?: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  callID?: string
  state?: Record<string, unknown>
}

export type SessionMessageInfo = {
  id?: string
  role: string
  agent?: string
  sessionID?: string
  time: { created: number; completed?: number }
  finish?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  providerID?: string
  modelID?: string
  error?: { name?: string; data?: { message?: string; statusCode?: number } }
}

export type SessionMessage = {
  info: SessionMessageInfo
  parts: SessionMessagePart[]
}

export type SessionMessages = SessionMessage[]

// ── Workspace param types ────────────────────────────────────────────────────
export type WorkspaceCreateParams = {
  type?: string
  branch?: string | null
  extra?: Record<string, unknown> | null
}

export type WorkspaceListParams = {
  directory?: string
}

export type WorkspaceRemoveParams = {
  id: string
}

export type WorkspaceWarpParams = {
  id: string
  sessionID: string
  copyChanges?: boolean
}

// ── Workspace result types ───────────────────────────────────────────────────
export type WorkspaceInfo = {
  id: string
  type?: string | null
  name?: string
  branch?: string | null
  directory?: string | null
  extra?: Record<string, unknown> | null
  projectID?: string
}

export type WorkspaceCreateResult = WorkspaceInfo & { timeUsed?: number | string }
export type WorkspaceList = WorkspaceInfo[]

// ── Provider result types ──────────────────────────────────────────────────
export type ProviderModelInfo = {
  id: string
  name: string
  release_date?: string
  capabilities?: {
    temperature?: boolean
    toolcall?: boolean
    reasoning?: boolean
    attachment?: boolean
  }
  cost?: { input?: number; output?: number }
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>
}

export type ProviderListEntry = {
  id: string
  name: string
  models: Record<string, ProviderModelInfo>
}

export type ProviderList = {
  all: ProviderListEntry[]
  connected: string[]
  default: Record<string, string>
}

// ── Toast types ────────────────────────────────────────────────────────────
export type ToastInput = {
  directory: string
  title?: string
  message: string
  variant?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}

// ── Event types ────────────────────────────────────────────────────────────
export type ForgeEvent = {
  type: string
  properties: Record<string, unknown>
}

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
    remove(params: WorkspaceRemoveParams): Promise<void>
    warp(params: WorkspaceWarpParams): Promise<void>
  }
  /** Emits a toast notification to the host TUI. */
  toast(input: ToastInput): Promise<void>
}
