import { describe, test, expect } from 'vitest'
import type { V2Event } from '@opencode/client'
import {
  FORGE_EVENT_TYPES,
  mapV2SessionInfo,
  normalizeV2Event,
  v2EventDirectory,
} from '../../src/host/v2-events'

const durableV1 = { aggregateID: 's1', seq: 1, version: 1 } as const
const durableV2 = { aggregateID: 's1', seq: 1, version: 2 } as const

describe('mapV2SessionInfo', () => {
  test('maps id, slug, project, title, directory and workspace onto the port session shape', () => {
    const info = mapV2SessionInfo({
      id: 's1',
      slug: 'loop-1',
      projectID: 'proj-1',
      parentID: 'parent-1',
      title: 'Loop 1',
      version: '2.0.14',
      time: { created: 10, updated: 20 },
      location: { directory: '/repo/.forge/worktrees/loop-1', workspaceID: 'ws-1' },
    })

    expect(info).toEqual({
      id: 's1',
      slug: 'loop-1',
      projectID: 'proj-1',
      parentID: 'parent-1',
      title: 'Loop 1',
      version: '2.0.14',
      time: { created: 10, updated: 20 },
      directory: '/repo/.forge/worktrees/loop-1',
      workspaceID: 'ws-1',
    })
  })

  test('omits parentID and workspaceID when the V2 location has neither', () => {
    const info = mapV2SessionInfo({
      id: 's1',
      projectID: 'proj-1',
      location: { directory: '/repo' },
    })

    expect(info.parentID).toBeUndefined()
    expect(info.workspaceID).toBeUndefined()
    expect(info.directory).toBe('/repo')
    expect(info.slug).toBe('')
    expect(info.title).toBe('')
    expect(info.version).toBe('')
    expect(info.time).toEqual({ created: 0, updated: 0 })
  })
})

describe('normalizeV2Event', () => {
  test('maps session.execution.started onto a busy session.status', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.execution.started',
      durable: durableV1,
      location: { directory: '/repo' },
      data: { sessionID: 's1' },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 's1', status: { type: 'busy' } },
      },
    ])
  })

  test('maps session.execution.succeeded onto idle status and the idle event', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.execution.succeeded',
      durable: durableV1,
      location: { directory: '/repo' },
      data: { sessionID: 's1' },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
      { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: 's1' } },
    ])
  })

  test('returns an empty list for the never-published V2 session.idle and session.status types', () => {
    const idle: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.idle',
      location: { directory: '/repo' },
      data: { sessionID: 's1' },
    }
    const status: V2Event = {
      id: 'evt-2',
      created: 2,
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'busy' } },
    }

    expect(normalizeV2Event(idle)).toEqual([])
    expect(normalizeV2Event(status)).toEqual([])
  })

  test('maps session.retry.scheduled onto a retry session.status with attempt, message and next', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.retry.scheduled',
      durable: durableV1,
      location: { directory: '/repo' },
      data: {
        sessionID: 's1',
        assistantMessageID: 'm1',
        attempt: 2,
        at: 1500,
        error: { type: 'provider.overloaded', message: 'rate limited' },
      },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: {
          sessionID: 's1',
          status: { type: 'retry', attempt: 2, message: 'rate limited', next: 1500 },
        },
      },
    ])
  })

  test('maps session.execution.failed onto session.error, idle status and idle in that order', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.execution.failed',
      durable: durableV1,
      location: { directory: '/repo' },
      data: {
        sessionID: 's1',
        error: { type: 'provider.quota', message: 'quota exceeded', status: 429 },
      },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionError,
        properties: {
          sessionID: 's1',
          error: { name: 'provider.quota', data: { message: 'quota exceeded', statusCode: 429 } },
        },
      },
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
      { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: 's1' } },
    ])
  })

  test('maps a statusless session.execution.failed error without a statusCode and still emits idle', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.execution.failed',
      durable: durableV1,
      data: { sessionID: 's1', error: { type: 'unknown', message: 'boom' } },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionError,
        properties: {
          sessionID: 's1',
          error: { name: 'unknown', data: { message: 'boom' } },
        },
      },
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
      { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: 's1' } },
    ])
  })

  test('maps a user session.execution.interrupted onto abort error, idle status and idle in that order', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.execution.interrupted',
      durable: durableV1,
      location: { directory: '/repo' },
      data: { sessionID: 's1', reason: 'user' },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionError,
        properties: {
          sessionID: 's1',
          error: {
            name: 'MessageAbortedError',
            data: { message: 'Session execution interrupted by user' },
          },
        },
      },
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
      { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: 's1' } },
    ])
  })

  test('drops shutdown interruptions but idles superseded and inactivity', () => {
    const shutdown: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.execution.interrupted',
      durable: durableV1,
      data: { sessionID: 's1', reason: 'shutdown' },
    }
    const superseded: V2Event = {
      id: 'evt-2',
      created: 2,
      type: 'session.execution.interrupted',
      durable: durableV1,
      data: { sessionID: 's1', reason: 'superseded' },
    }
    const inactivity: V2Event = {
      id: 'evt-3',
      created: 3,
      type: 'session.execution.interrupted',
      durable: durableV1,
      data: { sessionID: 's1', reason: 'inactivity' },
    }

    const idle = [
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
      { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: 's1' } },
    ]

    expect(normalizeV2Event(shutdown)).toEqual([])
    expect(normalizeV2Event(superseded)).toEqual(idle)
    expect(normalizeV2Event(inactivity)).toEqual(idle)
  })

  test('maps session.created onto the V1 session.created event with a port session info', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1700000000000,
      type: 'session.created',
      durable: durableV1,
      location: { directory: '/repo/.forge/worktrees/loop-1', workspaceID: 'ws-1' },
      data: {
        sessionID: 's1',
        projectID: 'proj-1',
        location: { directory: '/repo/.forge/worktrees/loop-1', workspaceID: 'ws-1' },
        slug: 'loop-1',
        parentID: 'parent-1',
        title: 'Loop 1',
        version: '2.0.14',
      },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionCreated,
        properties: {
          info: {
            id: 's1',
            slug: 'loop-1',
            projectID: 'proj-1',
            parentID: 'parent-1',
            title: 'Loop 1',
            version: '2.0.14',
            time: { created: 1700000000000, updated: 1700000000000 },
            directory: '/repo/.forge/worktrees/loop-1',
            workspaceID: 'ws-1',
          },
        },
      },
    ])
  })

  test('maps session.deleted onto the V1 session.deleted event', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.deleted',
      durable: durableV2,
      location: { directory: '/repo' },
      data: { sessionID: 's1' },
    }

    expect(normalizeV2Event(event)).toEqual([
      { type: FORGE_EVENT_TYPES.sessionDeleted, properties: { sessionID: 's1' } },
    ])
  })

  test('returns an empty list for location.shutdown because the host pump handles it raw', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'location.shutdown',
      location: { directory: '/repo' },
      data: {},
    }

    expect(normalizeV2Event(event)).toEqual([])
    expect(v2EventDirectory(event)).toBe('/repo')
  })

  test('maps session.text.started, delta and ended onto message.part.updated text parts', () => {
    const started: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.text.started',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0 },
    }
    const delta: V2Event = {
      id: 'evt-2',
      created: 2,
      type: 'session.text.delta',
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: 'partial' },
    }
    const ended: V2Event = {
      id: 'evt-3',
      created: 3,
      type: 'session.text.ended',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, text: 'full text' },
    }

    expect(normalizeV2Event(started)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: { sessionID: 's1', part: { sessionID: 's1', messageID: 'm1', type: 'text' } },
      },
    ])
    expect(normalizeV2Event(delta)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: {
          sessionID: 's1',
          part: { sessionID: 's1', messageID: 'm1', type: 'text', text: 'partial' },
        },
      },
    ])
    expect(normalizeV2Event(ended)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: {
          sessionID: 's1',
          part: { sessionID: 's1', messageID: 'm1', type: 'text', text: 'full text' },
        },
      },
    ])
  })

  test('maps reasoning events onto message.part.updated reasoning parts', () => {
    const started: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.reasoning.started',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0 },
    }
    const delta: V2Event = {
      id: 'evt-2',
      created: 2,
      type: 'session.reasoning.delta',
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: 'thinking' },
    }
    const ended: V2Event = {
      id: 'evt-3',
      created: 3,
      type: 'session.reasoning.ended',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, text: 'thought' },
    }

    expect(normalizeV2Event(started)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: { sessionID: 's1', part: { sessionID: 's1', messageID: 'm1', type: 'reasoning' } },
      },
    ])
    expect(normalizeV2Event(delta)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: { sessionID: 's1', part: { sessionID: 's1', messageID: 'm1', type: 'reasoning' } },
      },
    ])
    expect(normalizeV2Event(ended)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: { sessionID: 's1', part: { sessionID: 's1', messageID: 'm1', type: 'reasoning' } },
      },
    ])
  })

  test('maps tool input, call, progress and result events onto message.part.updated tool parts', () => {
    const inputStarted: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.tool.input.started',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', id: 't1', name: 'bash' },
    }
    const inputDelta: V2Event = {
      id: 'evt-2',
      created: 2,
      type: 'session.tool.input.delta',
      data: { sessionID: 's1', assistantMessageID: 'm1', id: 't1', delta: '{"cmd"' },
    }
    const inputEnded: V2Event = {
      id: 'evt-3',
      created: 3,
      type: 'session.tool.input.ended',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', id: 't1', text: '{"cmd":"ls"}' },
    }
    const called: V2Event = {
      id: 'evt-4',
      created: 4,
      type: 'session.tool.called',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1', id: 't1', input: {}, executed: true },
    }
    const progress: V2Event = {
      id: 'evt-5',
      created: 5,
      type: 'session.tool.progress',
      data: { sessionID: 's1', assistantMessageID: 'm1', id: 't1', metadata: {} },
    }
    const success: V2Event = {
      id: 'evt-6',
      created: 6,
      type: 'session.tool.success',
      durable: durableV2,
      data: {
        sessionID: 's1',
        assistantMessageID: 'm1',
        id: 't1',
        content: [{ type: 'text', text: 'ok' }],
        executed: true,
      },
    }
    const failed: V2Event = {
      id: 'evt-7',
      created: 7,
      type: 'session.tool.failed',
      durable: durableV2,
      data: {
        sessionID: 's1',
        assistantMessageID: 'm1',
        id: 't1',
        error: { type: 'tool.execution', message: 'boom' },
        executed: true,
      },
    }

    const expected = [
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: { sessionID: 's1', part: { sessionID: 's1', messageID: 'm1', type: 'tool' } },
      },
    ]

    expect(normalizeV2Event(inputStarted)).toEqual(expected)
    expect(normalizeV2Event(inputDelta)).toEqual(expected)
    expect(normalizeV2Event(inputEnded)).toEqual(expected)
    expect(normalizeV2Event(called)).toEqual(expected)
    expect(normalizeV2Event(progress)).toEqual(expected)
    expect(normalizeV2Event(success)).toEqual(expected)
    expect(normalizeV2Event(failed)).toEqual(expected)
  })

  test('maps step started, streamed, ended and failed events onto message.part.updated step parts', () => {
    const started: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.step.started',
      durable: durableV1,
      data: {
        sessionID: 's1',
        assistantMessageID: 'm1',
        agent: 'code',
        model: { id: 'gpt', providerID: 'openai' },
        started: 1,
      },
    }
    const streamed: V2Event = {
      id: 'evt-2',
      created: 2,
      type: 'session.step.streamed',
      durable: durableV1,
      data: { sessionID: 's1', assistantMessageID: 'm1' },
    }
    const ended: V2Event = {
      id: 'evt-3',
      created: 3,
      type: 'session.step.ended',
      durable: durableV1,
      data: {
        sessionID: 's1',
        assistantMessageID: 'm1',
        finish: 'stop',
        cost: 0.01,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }
    const failed: V2Event = {
      id: 'evt-4',
      created: 4,
      type: 'session.step.failed',
      durable: durableV1,
      data: {
        sessionID: 's1',
        assistantMessageID: 'm1',
        error: { type: 'unknown', message: 'boom' },
      },
    }

    const expected = [
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: { sessionID: 's1', part: { sessionID: 's1', messageID: 'm1', type: 'step' } },
      },
    ]

    expect(normalizeV2Event(started)).toEqual(expected)
    expect(normalizeV2Event(streamed)).toEqual(expected)
    expect(normalizeV2Event(ended)).toEqual(expected)
    expect(normalizeV2Event(failed)).toEqual(expected)
  })

  test('does not stamp the location directory onto content events', () => {
    const event: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.text.ended',
      durable: durableV1,
      location: { directory: '/project-a' },
      data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, text: 'full text' },
    }

    expect(normalizeV2Event(event)).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: {
          sessionID: 's1',
          part: { sessionID: 's1', messageID: 'm1', type: 'text', text: 'full text' },
        },
      },
    ])
  })

  test('returns an empty list for V2 events with no V1 consumer', () => {
    const moved: V2Event = {
      id: 'evt-1',
      created: 1,
      type: 'session.moved',
      durable: durableV1,
      data: { sessionID: 's1', location: { directory: '/repo' }, projectID: 'proj-1' },
    }
    const renamed: V2Event = {
      id: 'evt-3',
      created: 3,
      type: 'session.renamed',
      durable: durableV1,
      data: { sessionID: 's1', title: 'Renamed' },
    }
    const toast: V2Event = {
      id: 'evt-4',
      created: 4,
      type: 'tui.toast.show',
      data: { message: 'hello', variant: 'info' },
    }

    expect(normalizeV2Event(moved)).toEqual([])
    expect(normalizeV2Event(renamed)).toEqual([])
    expect(normalizeV2Event(toast)).toEqual([])
  })
})
