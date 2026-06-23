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
  messageId: string
  role: string | null
  type: string
  text: string | null
  toolName: string | null
  toolTitle: string | null
  toolStatus: string | null
  timeCreated: number | null
}

/** Lightweight activity event for the recent-activity stream. */
export interface OpencodeActivityEvent {
  type: string
  sessionId: string | null
  title: string | null
  /**
   * Project/worktree the event originated from. Authoritative when sourced
   * from the server global stream (its `directory` wrapper); best-effort
   * (`info.directory`) when sourced from the TUI event bus.
   */
  directory: string | null
  time: number
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
