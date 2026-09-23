import type { V2Event } from '@opencode/client'
import type { ForgeEvent, Session } from '../client/port'

export const V2_EVENT_TYPES = {
  sessionIdle: 'session.idle',
  sessionStatus: 'session.status',
  sessionExecutionFailed: 'session.execution.failed',
  sessionExecutionInterrupted: 'session.execution.interrupted',
  sessionCreated: 'session.created',
  sessionDeleted: 'session.deleted',
  locationShutdown: 'location.shutdown',
  sessionTextStarted: 'session.text.started',
  sessionTextDelta: 'session.text.delta',
  sessionTextEnded: 'session.text.ended',
  sessionReasoningStarted: 'session.reasoning.started',
  sessionReasoningDelta: 'session.reasoning.delta',
  sessionReasoningEnded: 'session.reasoning.ended',
  sessionToolInputStarted: 'session.tool.input.started',
  sessionToolInputDelta: 'session.tool.input.delta',
  sessionToolInputEnded: 'session.tool.input.ended',
  sessionToolCalled: 'session.tool.called',
  sessionToolProgress: 'session.tool.progress',
  sessionToolSuccess: 'session.tool.success',
  sessionToolFailed: 'session.tool.failed',
  sessionStepStarted: 'session.step.started',
  sessionStepStreamed: 'session.step.streamed',
  sessionStepEnded: 'session.step.ended',
  sessionStepFailed: 'session.step.failed',
} as const

export const FORGE_EVENT_TYPES = {
  sessionIdle: 'session.idle',
  sessionStatus: 'session.status',
  sessionError: 'session.error',
  sessionCreated: 'session.created',
  sessionDeleted: 'session.deleted',
  serverInstanceDisposed: 'server.instance.disposed',
  messagePartUpdated: 'message.part.updated',
} as const

const V2_LOCATION_BOUND_EVENT_TYPES: ReadonlySet<string> = new Set([
  V2_EVENT_TYPES.sessionTextStarted,
  V2_EVENT_TYPES.sessionTextDelta,
  V2_EVENT_TYPES.sessionTextEnded,
  V2_EVENT_TYPES.sessionReasoningStarted,
  V2_EVENT_TYPES.sessionReasoningDelta,
  V2_EVENT_TYPES.sessionReasoningEnded,
  V2_EVENT_TYPES.sessionToolInputStarted,
  V2_EVENT_TYPES.sessionToolInputDelta,
  V2_EVENT_TYPES.sessionToolInputEnded,
  V2_EVENT_TYPES.sessionToolCalled,
  V2_EVENT_TYPES.sessionToolProgress,
  V2_EVENT_TYPES.sessionToolSuccess,
  V2_EVENT_TYPES.sessionToolFailed,
  V2_EVENT_TYPES.sessionStepStarted,
  V2_EVENT_TYPES.sessionStepStreamed,
  V2_EVENT_TYPES.sessionStepEnded,
  V2_EVENT_TYPES.sessionStepFailed,
])

export function isV2LocationBoundEvent(event: V2Event): boolean {
  return V2_LOCATION_BOUND_EVENT_TYPES.has(event.type)
}

export function v2EventDirectory(event: V2Event): string | undefined {
  return event.location?.directory
}

export function v2EventSessionID(event: V2Event): string | undefined {
  const data = event.data as { sessionID?: unknown }
  return typeof data.sessionID === 'string' ? data.sessionID : undefined
}

export interface V2SessionInfoLike {
  id: string
  slug?: string
  projectID: string
  parentID?: string
  title?: string
  version?: string
  time?: { created: number; updated: number }
  location: { directory: string; workspaceID?: string }
}

export function mapV2SessionInfo(info: V2SessionInfoLike): Session {
  return {
    id: info.id,
    slug: info.slug ?? '',
    projectID: info.projectID,
    directory: info.location.directory,
    title: info.title ?? '',
    version: info.version ?? '',
    time: info.time ?? { created: 0, updated: 0 },
    ...(info.parentID ? { parentID: info.parentID } : {}),
    ...(info.location.workspaceID ? { workspaceID: info.location.workspaceID } : {}),
  }
}

export function mapV2Error(error: { type: string; message: string; status?: number }): Record<string, unknown> {
  return {
    name: error.type,
    data: {
      message: error.message,
      ...(error.status === undefined ? {} : { statusCode: error.status }),
    },
  }
}

function partEvent(
  sessionID: string,
  type: string,
  messageID?: string,
  text?: string,
): ForgeEvent {
  return {
    type: FORGE_EVENT_TYPES.messagePartUpdated,
    properties: {
      sessionID,
      part: {
        sessionID,
        type,
        ...(messageID ? { messageID } : {}),
        ...(text === undefined ? {} : { text }),
      },
    },
  }
}

export function normalizeV2Event(event: V2Event): ForgeEvent[] {
  const events = mapV2EventBody(event)
  const directory = v2EventDirectory(event)
  if (directory === undefined || !isV2LocationBoundEvent(event)) return events
  return events.map((item) => ({
    ...item,
    properties: { ...item.properties, directory },
  }))
}

function mapV2EventBody(event: V2Event): ForgeEvent[] {
  switch (event.type) {
    case V2_EVENT_TYPES.sessionIdle:
      return [{ type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: event.data.sessionID } }]
    case V2_EVENT_TYPES.sessionStatus:
      return [{
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: event.data.sessionID, status: event.data.status },
      }]
    case V2_EVENT_TYPES.sessionExecutionFailed:
      return [{
        type: FORGE_EVENT_TYPES.sessionError,
        properties: { sessionID: event.data.sessionID, error: mapV2Error(event.data.error) },
      }]
    case V2_EVENT_TYPES.sessionExecutionInterrupted:
      return event.data.reason === 'user'
        ? [{
            type: FORGE_EVENT_TYPES.sessionError,
            properties: {
              sessionID: event.data.sessionID,
              error: {
                name: 'MessageAbortedError',
                data: { message: 'Session execution interrupted by user' },
              },
            },
          }]
        : []
    case V2_EVENT_TYPES.sessionCreated:
      return [{
        type: FORGE_EVENT_TYPES.sessionCreated,
        properties: {
          info: mapV2SessionInfo({
            id: event.data.sessionID,
            slug: event.data.slug,
            projectID: event.data.projectID,
            parentID: event.data.parentID,
            title: event.data.title,
            version: event.data.version,
            time: { created: event.created, updated: event.created },
            location: event.data.location,
          }),
        },
      }]
    case V2_EVENT_TYPES.sessionDeleted:
      return [{ type: FORGE_EVENT_TYPES.sessionDeleted, properties: { sessionID: event.data.sessionID } }]
    case V2_EVENT_TYPES.locationShutdown:
      return [{
        type: FORGE_EVENT_TYPES.serverInstanceDisposed,
        properties: { directory: event.location?.directory ?? '' },
      }]
    case V2_EVENT_TYPES.sessionTextStarted:
      return [partEvent(event.data.sessionID, 'text', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionTextDelta:
      return [partEvent(event.data.sessionID, 'text', event.data.assistantMessageID, event.data.delta)]
    case V2_EVENT_TYPES.sessionTextEnded:
      return [partEvent(event.data.sessionID, 'text', event.data.assistantMessageID, event.data.text)]
    case V2_EVENT_TYPES.sessionReasoningStarted:
      return [partEvent(event.data.sessionID, 'reasoning', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionReasoningDelta:
      return [partEvent(event.data.sessionID, 'reasoning', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionReasoningEnded:
      return [partEvent(event.data.sessionID, 'reasoning', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolInputStarted:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolInputDelta:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolInputEnded:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolCalled:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolProgress:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolSuccess:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionToolFailed:
      return [partEvent(event.data.sessionID, 'tool', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionStepStarted:
      return [partEvent(event.data.sessionID, 'step', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionStepStreamed:
      return [partEvent(event.data.sessionID, 'step', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionStepEnded:
      return [partEvent(event.data.sessionID, 'step', event.data.assistantMessageID)]
    case V2_EVENT_TYPES.sessionStepFailed:
      return [partEvent(event.data.sessionID, 'step', event.data.assistantMessageID)]
    default:
      return []
  }
}
