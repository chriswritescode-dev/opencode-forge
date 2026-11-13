import { z } from 'zod'
import type { JsonObject } from '../utils/json-schema'

export type SessionPermissionRule = {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

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
  workspace?: string
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

export type SessionCompactParams = {
  sessionID: string
  directory?: string
}

export type SessionDeleteParams = {
  sessionID: string
  directory?: string
}

export type ModelContextLimitParams = {
  providerID: string
  modelID: string
}

export type SkillListParams = {
  directory?: string
}

export type SkillListEntry = {
  path: string
}

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

export type SessionStatusEntry = {
  type: 'idle' | 'busy' | 'retry'
  attempt?: number
  message?: string
  next?: number
}

export type SessionStatus = Record<string, SessionStatusEntry>

export type SessionToolState = {
  status: string
  input?: string | JsonObject
  output?: string
  metadata?: JsonObject
  error?: string
}

export type SessionMessagePart = {
  id?: string
  messageID?: string
  sessionID?: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  callID?: string
  state?: SessionToolState
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

export type WorkspaceExtra = {
  loopName?: unknown
  baseRef?: unknown
  branch?: unknown
  projectDirectory?: unknown
  workspaceCreatedAt?: unknown
  permissionRules?: unknown
  forgeLoop?: unknown
  loopSandbox?: unknown
}

export type WorkspaceCreateParams = {
  type?: string
  branch?: string | null
  extra?: WorkspaceExtra | null
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

export type WorkspaceInfo = {
  id: string
  type?: string | null
  name?: string
  branch?: string | null
  directory?: string | null
  extra?: WorkspaceExtra | null
  projectID?: string
}

export type WorkspaceCreateResult = WorkspaceInfo & { timeUsed?: number | string }
export type WorkspaceList = WorkspaceInfo[]

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
  variants?: Record<string, { disabled?: boolean }>
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

export type ToastInput = {
  directory: string
  title?: string
  message: string
  variant?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}

export type SessionErrorInfo = {
  name: string
  data: {
    message: string
    statusCode?: number
  }
}

export type ForgeEventProperties = {
  sessionID?: string
  status?: SessionStatusEntry
  info?: Session
  part?: SessionMessagePart
  error?: SessionErrorInfo
}

export type ForgeEvent = {
  type: string
  properties: ForgeEventProperties
}

export type ForgeClientErrorKind = 'connection' | 'not-found' | 'unavailable' | 'request'

const errorCodeSchema = z.looseObject({ code: z.string() })

export class ForgeClientError extends Error {
  readonly kind: ForgeClientErrorKind
  readonly method: string
  override readonly cause?: unknown
  readonly code?: string

  constructor(args: { kind: ForgeClientErrorKind; method: string; message: string; cause?: unknown }) {
    super(args.message)
    this.name = 'ForgeClientError'
    this.kind = args.kind
    this.method = args.method
    this.cause = args.cause
    const coded = errorCodeSchema.safeParse(args.cause)
    this.code = coded.success ? coded.data.code : undefined
  }
}

export interface ForgeClient {
  session: {
    create(params: SessionCreateParams): Promise<Session>
    get(params: SessionGetParams): Promise<Session>
    update(params: SessionUpdateParams): Promise<void>
    messages(params: SessionMessagesParams): Promise<SessionMessages>
    status(params?: SessionStatusParams): Promise<SessionStatus>
    promptAsync(params: SessionPromptAsyncParams): Promise<void>
    abort(params: SessionAbortParams): Promise<void>
    compact(params: SessionCompactParams): Promise<void>
    delete(params: SessionDeleteParams): Promise<void>
  }
  workspace: {
    create(params: WorkspaceCreateParams): Promise<WorkspaceCreateResult>
    list(params?: WorkspaceListParams): Promise<WorkspaceList>
    remove(params: WorkspaceRemoveParams): Promise<void>
    warp(params: WorkspaceWarpParams): Promise<void>
  }
  model: {
    contextLimit(params: ModelContextLimitParams): Promise<number | undefined>
  }
  skill: {
    list(params: SkillListParams): Promise<SkillListEntry[]>
  }
  toast(input: ToastInput): Promise<void>
}
