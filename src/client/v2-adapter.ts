import type { Plugin } from '@opencode/plugin'
import { classify, requestError, unavailableError } from './errors'
import { ForgeClientError } from './port'
import type {
  ForgeClient,
  ForgeEvent,
  ProviderList,
  Session,
  SessionMessageInfo,
  SessionMessagePart,
  SessionMessages,
  SessionStatus,
} from './port'
import {
  FORGE_EVENT_TYPES,
  mapV2Error,
  mapV2SessionInfo,
  normalizeV2Event,
} from '../host/v2-events'

type V2Session = Plugin.Context['session']
type V2SessionInfo = Awaited<ReturnType<V2Session['get']>>
type V2Message = Awaited<ReturnType<V2Session['context']>>[number]
type V2UserMessage = Extract<V2Message, { type: 'user' }>
type V2AssistantMessage = Extract<V2Message, { type: 'assistant' }>
type V2AssistantContent = V2AssistantMessage['content'][number]
type V2ToolState = Extract<V2AssistantContent, { type: 'tool' }>['state']
type V2ToolContent = Extract<V2ToolState, { status: 'completed' }>['content'][number]
type V2ModelInfo = Awaited<ReturnType<Plugin.Context['model']['list']>>['data'][number]

type V1PermissionRule = NonNullable<Session['permission']>[number]
type V2PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

export interface V2ClientLike {
  readonly session: V2Session
  readonly permission: Plugin.Context['permission']
  readonly event: Plugin.Context['event']
  readonly location: Plugin.Context['location']
  readonly provider: Plugin.Context['provider']
  readonly model: Plugin.Context['model']
}

export interface V2ForgeClientOptions {
  directory: string
  workspace: ForgeClient['workspace']
}

export interface V2ForgeClient extends ForgeClient {
  recordStatusEvent(event: ForgeEvent): void
}

const ACTION_RENAMES: Record<string, string> = {
  bash: 'shell',
  task: 'subagent',
  write: 'edit',
  patch: 'edit',
}

const ACTION_RESTORES: Record<string, string> = {
  shell: 'bash',
  subagent: 'task',
  edit: 'write',
}

export function toV2Ruleset(ruleset: V1PermissionRule[]): V2PermissionRule[] {
  return ruleset.map((rule) => ({
    action: ACTION_RENAMES[rule.permission] ?? rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
}

export function fromV2Ruleset(ruleset: ReadonlyArray<V2PermissionRule>): V1PermissionRule[] {
  return ruleset.map((rule) => ({
    permission: ACTION_RESTORES[rule.action] ?? rule.action,
    pattern: rule.resource,
    action: rule.effect,
  }))
}

function isSessionStatus(value: unknown): value is SessionStatus[string] {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'idle' || type === 'busy' || type === 'retry'
}

async function call<T>(method: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw err instanceof ForgeClientError ? err : classify(err, method)
  }
}

function toAbortableStream<T>(source: AsyncGenerator<T>, controller: AbortController): AsyncGenerator<T> {
  const close = (value?: unknown): Promise<IteratorResult<T>> => {
    controller.abort()
    return source.return(value)
  }
  const stream: AsyncGenerator<T> = {
    next: () => source.next(),
    return: close,
    throw: (error) => {
      controller.abort()
      return source.throw(error)
    },
    [Symbol.asyncIterator]: () => stream,
    [Symbol.asyncDispose]: () => close().then(() => undefined),
  }
  return stream
}

function toolContentText(content: readonly V2ToolContent[]): string {
  return content.map((item) => (item.type === 'text' ? item.text : '')).join('')
}

function toToolState(state: V2ToolState): Record<string, unknown> {
  if (state.status === 'completed') {
    return { status: state.status, input: state.input, output: toolContentText(state.content), metadata: state.metadata ?? {} }
  }
  if (state.status === 'error') {
    return { status: state.status, input: state.input, error: state.error.message, metadata: state.metadata ?? {} }
  }
  return { status: state.status, input: state.input }
}

function toSessionMessageInfo(message: V2Message, sessionID: string): SessionMessageInfo {
  const info: SessionMessageInfo = {
    id: message.id,
    role: message.type,
    sessionID,
    time: { created: message.time.created },
  }
  if ('completed' in message.time && message.time.completed !== undefined) {
    info.time.completed = message.time.completed
  }
  if (message.type === 'assistant') {
    info.agent = message.agent
    info.providerID = message.model.providerID
    info.modelID = message.model.id
    if (message.cost !== undefined) info.cost = message.cost
    if (message.tokens !== undefined) info.tokens = message.tokens
    if (message.finish !== undefined) info.finish = message.finish
    if (message.error !== undefined) info.error = mapV2Error(message.error)
  }
  return info
}

function toUserMessageParts(message: V2UserMessage, sessionID: string): SessionMessagePart[] {
  return [{ id: message.id, messageID: message.id, sessionID, type: 'text', text: message.text }]
}

function toAssistantMessageParts(message: V2AssistantMessage, sessionID: string): SessionMessagePart[] {
  return message.content.map((part, index) => {
    const id = `${message.id}:${index}`
    if (part.type === 'text') return { id, messageID: message.id, sessionID, type: 'text', text: part.text }
    if (part.type === 'reasoning') return { id, messageID: message.id, sessionID, type: 'reasoning', text: part.text }
    return {
      id: part.id,
      messageID: message.id,
      sessionID,
      type: 'tool',
      callID: part.id,
      tool: part.name,
      state: toToolState(part.state),
    }
  })
}

function toSessionMessages(messages: V2Message[], sessionID: string, limit?: number): SessionMessages {
  const mapped: SessionMessages = []
  for (const message of messages) {
    if (message.type === 'user') {
      mapped.push({ info: toSessionMessageInfo(message, sessionID), parts: toUserMessageParts(message, sessionID) })
    } else if (message.type === 'assistant') {
      mapped.push({ info: toSessionMessageInfo(message, sessionID), parts: toAssistantMessageParts(message, sessionID) })
    }
  }
  return limit === undefined ? mapped : mapped.slice(Math.max(0, mapped.length - limit))
}

function toPortSession(info: V2SessionInfo): Session {
  const session = mapV2SessionInfo(info)
  return info.permissions ? { ...session, permission: fromV2Ruleset(info.permissions) } : session
}

function toProviderModelInfo(model: V2ModelInfo): ProviderList['all'][number]['models'][string] {
  const cost = model.cost[0]
  return {
    id: model.modelID,
    name: model.name,
    release_date: new Date(model.time.released).toISOString(),
    capabilities: {
      toolcall: model.capabilities.tools,
      reasoning: model.compatibility?.reasoningField !== undefined,
    },
    ...(cost ? { cost: { input: cost.input, output: cost.output } } : {}),
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
  }
}

export function createForgeClientFromV2(ctx: V2ClientLike, options: V2ForgeClientOptions): V2ForgeClient {
  const statuses = new Map<string, SessionStatus[string]>()

  function recordStatusEvent(event: ForgeEvent): void {
    if (event.type === FORGE_EVENT_TYPES.sessionIdle) {
      const sessionID = event.properties.sessionID
      if (typeof sessionID === 'string') statuses.set(sessionID, { type: 'idle' })
      return
    }
    if (event.type === FORGE_EVENT_TYPES.sessionStatus) {
      const sessionID = event.properties.sessionID
      const status = event.properties.status
      if (typeof sessionID === 'string' && isSessionStatus(status)) statuses.set(sessionID, status)
    }
  }

  function currentProject(): NonNullable<Awaited<ReturnType<ForgeClient['project']['current']>>> {
    return { id: ctx.location.project.id, worktree: ctx.location.project.canonical }
  }

  const session: ForgeClient['session'] = {
    create: (params) => call('session.create', async () =>
      toPortSession(await ctx.session.create({
        title: params.title,
        location: { directory: params.workspaceID ?? params.workspace ?? params.directory ?? options.directory },
        ...(params.permission ? { permissions: toV2Ruleset(params.permission) } : {}),
      }))),
    get: (params) => call('session.get', async () =>
      toPortSession(await ctx.session.get({ sessionID: params.sessionID }))),
    update: (params) => call('session.update', async () => {
      await ctx.session.update({
        sessionID: params.sessionID,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.permission !== undefined ? { permissions: toV2Ruleset(params.permission) } : {}),
      })
    }),
    messages: (params) => call('session.messages', async () =>
      toSessionMessages(await ctx.session.context({ sessionID: params.sessionID }), params.sessionID, params.limit)),
    status: () => call('session.status', async () => Object.fromEntries(statuses)),
    list: () => Promise.reject(unavailableError('session.list', 'session.list is not available on this host')),
    promptAsync: (params) => call('session.promptAsync', async () => {
      const parts = params.parts ?? []
      const textParts = parts.filter((part) => part.type === 'text')
      if (textParts.length !== parts.length) {
        throw requestError('session.promptAsync', 'Only text prompt parts are supported on this host')
      }
      if (params.agent) {
        await ctx.session.switchAgent({ sessionID: params.sessionID, agent: params.agent })
      }
      if (params.model) {
        await ctx.session.switchModel({
          sessionID: params.sessionID,
          model: {
            providerID: params.model.providerID,
            id: params.model.modelID,
            ...(params.variant ? { variant: params.variant } : {}),
          },
        })
      }
      await ctx.session.prompt({
        sessionID: params.sessionID,
        text: textParts.map((part) => part.text).join('\n\n'),
        delivery: 'queue',
      })
    }),
    abort: (params) => call('session.abort', async () => {
      await ctx.session.interrupt({ sessionID: params.sessionID, resume: false })
    }),
    delete: () => Promise.reject(unavailableError('session.delete', 'session.delete is not available on this host')),
  }

  const project: ForgeClient['project'] = {
    list: async () => [currentProject()],
    current: async () => currentProject(),
  }

  const provider: ForgeClient['provider'] = {
    list: () => call('provider.list', async () => {
      const providers = await ctx.provider.list()
      const models = await ctx.model.list()
      return {
        all: providers.data.map((info) => ({
          id: info.id,
          name: info.name,
          models: Object.fromEntries(
            models.data
              .filter((model) => model.providerID === info.id)
              .map((model) => [model.modelID, toProviderModelInfo(model)]),
          ),
        })),
        connected: providers.data.filter((info) => info.activation !== 'disabled').map((info) => info.id),
        default: {},
      }
    }),
  }

  const tui: ForgeClient['tui'] = {
    publish: async () => {},
    selectSession: () => Promise.reject(unavailableError('tui.selectSession', 'tui.selectSession is not available on this host')),
  }

  const sync: ForgeClient['sync'] = {
    start: async () => {},
  }

  const event: ForgeClient['event'] = {
    subscribe: () => call('event.subscribe', async () => {
      const controller = new AbortController()
      const source = ctx.event.subscribe({ signal: controller.signal })
      const stream = (async function* () {
        try {
          for await (const event of source) {
            for (const normalized of normalizeV2Event(event)) yield normalized
          }
        } finally {
          controller.abort()
        }
      })()
      return { stream: toAbortableStream(stream, controller) }
    }),
  }

  return { session, workspace: options.workspace, project, provider, tui, sync, event, recordStatusEvent }
}
