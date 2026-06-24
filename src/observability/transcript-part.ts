import { isRecord } from '../utils/is-record'

/**
 * Part-specific transcript fields shared by the DB-backed transcript query and
 * the live `message.part.updated` event stream. Both code paths map an opencode
 * `part.data` object (a `{ type, text, tool, state, ... }` record) through this
 * single function so text/tool extraction stays consistent.
 */
export interface TranscriptPartFields {
  type: 'text' | 'tool'
  text: string | null
  toolName: string | null
  toolTitle: string | null
  toolStatus: string | null
}

/**
 * Map an opencode part-data object to the transcript fields we render.
 *
 * Returns `null` for null/invalid input and for part types other than
 * `'text'` and `'tool'` (e.g. `step-start`, `reasoning`), which the dashboard
 * does not display.
 */
export function mapTranscriptPartData(data: unknown): TranscriptPartFields | null {
  if (!isRecord(data)) return null

  const type = typeof data.type === 'string' ? data.type : ''
  if (type !== 'text' && type !== 'tool') return null

  if (type === 'text') {
    return {
      type,
      text: typeof data.text === 'string' ? data.text : null,
      toolName: null,
      toolTitle: null,
      toolStatus: null,
    }
  }

  const toolName = typeof data.tool === 'string' ? data.tool : null
  let toolStatus: string | null = null
  let toolTitle: string | null = null

  const state = data.state
  if (isRecord(state)) {
    toolStatus = typeof state.status === 'string' ? state.status : null
    toolTitle = typeof state.title === 'string'
      ? state.title
      : isRecord(state.input) && typeof state.input.description === 'string'
        ? state.input.description
        : null
  }

  return { type, text: null, toolName, toolTitle, toolStatus }
}
