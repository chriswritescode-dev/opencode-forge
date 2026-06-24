/** A single row from the opencode `session` table. */
export interface OpencodeSessionRow {
  id: string
  title: string | null
  directory: string | null
  projectName: string | null
  worktree: string | null
  agent: string | null
  modelId: string | null
  providerId: string | null
  cost: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
  timeCreated: number | null
  timeUpdated: number | null
}

/** A single message entry from a session transcript. */
export interface TranscriptEntry {
  /** Stable opencode part id; used to upsert/replace entries from live events. */
  partId: string
  messageId: string
  role: string | null
  /** Assistant model id for this message (null for user messages / unknown). */
  model: string | null
  type: string
  text: string | null
  toolName: string | null
  toolTitle: string | null
  toolStatus: string | null
  timeCreated: number | null
}

/**
 * Per-message metadata carried on `message.updated` activity events, used to
 * label transcript sections with the author (user) or assistant model name.
 */
export interface TranscriptMessageMeta {
  sessionId: string
  messageId: string
  role: string | null
  model: string | null
}

/**
 * A live transcript part change carried on `message.part.*` activity events.
 * `entry` is the mapped transcript entry for an update, or `null` when the part
 * was removed (`message.part.removed`).
 */
export interface TranscriptPartUpdate {
  sessionId: string
  messageId: string
  partId: string
  entry: TranscriptEntry | null
}

/**
 * Session run status from a `session.status` event. Mirrors opencode's
 * authoritative status set by the runner at turn boundaries: `busy` while a
 * turn is processing, `retry` while retrying, `idle` when finished.
 */
export type SessionActivityStatus = 'idle' | 'busy' | 'retry'

/** Lightweight activity event for the recent-activity stream. */
export interface OpencodeActivityEvent {
  type: string
  sessionId: string | null
  time: number
  /**
   * Session row built from a `session.*` event's `info` payload, used to upsert
   * the live session list. `null` for events without session info (e.g.
   * `session.idle`/`session.error`) and for non-session events. Cost/token
   * fields are not present in session events and default to 0.
   */
  session?: OpencodeSessionRow | null
  /**
   * Transcript part change for `message.part.updated`/`message.part.removed`
   * events; `null`/absent for other event types.
   */
  part?: TranscriptPartUpdate | null
  /**
   * Per-message metadata for `message.updated` events (role + model), used to
   * label transcript sections; `null`/absent for other event types.
   */
  messageMeta?: TranscriptMessageMeta | null
  /**
   * Run status from a `session.status` event, used to drive the live activity
   * indicator; `null`/absent for other event types.
   */
  sessionStatus?: SessionActivityStatus | null
}

/** Payload returned by the sessions list endpoint. */
export interface OpencodeSessionsPayload {
  generatedAt: number
  available: boolean
  sessions: OpencodeSessionRow[]
}

/** Payload returned by the transcript endpoint. */
export interface OpencodeTranscriptPayload {
  generatedAt: number
  available: boolean
  sessionId: string
  entries: TranscriptEntry[]
}
