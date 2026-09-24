import type { V2Event } from '@opencode/client'
import type { ForgeEvent, Session } from '../client/port'

export const V2_EVENT_TYPES = {
  sessionExecutionStarted: 'session.execution.started',
  sessionExecutionSucceeded: 'session.execution.succeeded',
  sessionExecutionFailed: 'session.execution.failed',
  sessionExecutionInterrupted: 'session.execution.interrupted',
  sessionRetryScheduled: 'session.retry.scheduled',
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

const V2_PART_EVENT_KINDS = {
  [V2_EVENT_TYPES.sessionTextStarted]: 'text',
  [V2_EVENT_TYPES.sessionTextDelta]: 'text',
  [V2_EVENT_TYPES.sessionTextEnded]: 'text',
  [V2_EVENT_TYPES.sessionReasoningStarted]: 'reasoning',
  [V2_EVENT_TYPES.sessionReasoningDelta]: 'reasoning',
  [V2_EVENT_TYPES.sessionReasoningEnded]: 'reasoning',
  [V2_EVENT_TYPES.sessionToolInputStarted]: 'tool',
  [V2_EVENT_TYPES.sessionToolInputDelta]: 'tool',
  [V2_EVENT_TYPES.sessionToolInputEnded]: 'tool',
  [V2_EVENT_TYPES.sessionToolCalled]: 'tool',
  [V2_EVENT_TYPES.sessionToolProgress]: 'tool',
  [V2_EVENT_TYPES.sessionToolSuccess]: 'tool',
  [V2_EVENT_TYPES.sessionToolFailed]: 'tool',
  [V2_EVENT_TYPES.sessionStepStarted]: 'step',
  [V2_EVENT_TYPES.sessionStepStreamed]: 'step',
  [V2_EVENT_TYPES.sessionStepEnded]: 'step',
  [V2_EVENT_TYPES.sessionStepFailed]: 'step',
} as const satisfies Partial<Record<V2Event['type'], 'text' | 'reasoning' | 'tool' | 'step'>>

type V2PartEvent = Extract<V2Event, { type: keyof typeof V2_PART_EVENT_KINDS }>

function isV2PartEvent(event: V2Event): event is V2PartEvent {
  return event.type in V2_PART_EVENT_KINDS
}

function partEventText(event: V2PartEvent): string | undefined {
  switch (event.type) {
    case V2_EVENT_TYPES.sessionTextDelta:
      return event.data.delta
    case V2_EVENT_TYPES.sessionTextEnded:
      return event.data.text
    default:
      return undefined
  }
}

export function v2EventDirectory(event: V2Event): string | undefined {
  return event.location?.directory
}

export function v2EventSessionId(event: V2Event): string | undefined {
  const data = (event as { data?: { sessionID?: unknown } }).data
  return typeof data?.sessionID === 'string' ? data.sessionID : undefined
}

export interface V2SessionOwnershipDeps {
  ownsDirectory(directory: string): boolean
  getSessionDirectory(sessionID: string): Promise<string>
}

export interface V2SessionOwnership {
  owns(event: V2Event): Promise<boolean>
}

export function createV2SessionOwnership(deps: V2SessionOwnershipDeps): V2SessionOwnership {
  const ownedBySession = new Map<string, boolean>()

  return {
    async owns(event) {
      const sessionID = v2EventSessionId(event)
      if (!sessionID) return true

      if (event.type === V2_EVENT_TYPES.sessionCreated) {
        const owned = deps.ownsDirectory(event.data.location.directory)
        ownedBySession.set(sessionID, owned)
        return owned
      }

      const cached = ownedBySession.get(sessionID)
      if (event.type === V2_EVENT_TYPES.sessionDeleted) {
        ownedBySession.delete(sessionID)
        return cached ?? true
      }
      if (cached !== undefined) return cached

      try {
        const owned = deps.ownsDirectory(await deps.getSessionDirectory(sessionID))
        ownedBySession.set(sessionID, owned)
        return owned
      } catch {
        return true
      }
    },
  }
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

function idleEvents(sessionID: string): ForgeEvent[] {
  return [
    {
      type: FORGE_EVENT_TYPES.sessionStatus,
      properties: { sessionID, status: { type: 'idle' } },
    },
    { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID } },
  ]
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
  if (isV2PartEvent(event)) {
    return [partEvent(event.data.sessionID, V2_PART_EVENT_KINDS[event.type], event.data.assistantMessageID, partEventText(event))]
  }

  switch (event.type) {
    case V2_EVENT_TYPES.sessionExecutionStarted:
      return [{
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: event.data.sessionID, status: { type: 'busy' } },
      }]
    case V2_EVENT_TYPES.sessionExecutionSucceeded:
      return idleEvents(event.data.sessionID)
    case V2_EVENT_TYPES.sessionExecutionFailed:
      return [
        {
          type: FORGE_EVENT_TYPES.sessionError,
          properties: { sessionID: event.data.sessionID, error: mapV2Error(event.data.error) },
        },
        ...idleEvents(event.data.sessionID),
      ]
    case V2_EVENT_TYPES.sessionExecutionInterrupted:
      if (event.data.reason === 'shutdown') return []
      if (event.data.reason === 'user') {
        return [
          {
            type: FORGE_EVENT_TYPES.sessionError,
            properties: {
              sessionID: event.data.sessionID,
              error: {
                name: 'MessageAbortedError',
                data: { message: 'Session execution interrupted by user' },
              },
            },
          },
          ...idleEvents(event.data.sessionID),
        ]
      }
      return idleEvents(event.data.sessionID)
    case V2_EVENT_TYPES.sessionRetryScheduled:
      return [{
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: {
          sessionID: event.data.sessionID,
          status: {
            type: 'retry',
            attempt: event.data.attempt,
            message: event.data.error.message,
            next: event.data.at,
          },
        },
      }]
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
    default:
      return []
  }
}
