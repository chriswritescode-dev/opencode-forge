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
import { FORGE_EVENT_TYPES, mapV2Error, mapV2SessionInfo } from '../host/v2-events'
import type { ForgeToastInput } from '../host/forge-rpc'
import { LRUCache } from '../utils/lru-cache'
import { isRecord } from '../utils/is-record'

type V2Session = Plugin.Context['session']
type V2SessionInfo = Awaited<ReturnType<V2Session['get']>>
type V2Message = Awaited<ReturnType<V2Session['context']>>[number]
type V2UserMessage = Extract<V2Message, { type: 'user' }>
type V2AssistantMessage = Extract<V2Message, { type: 'assistant' }>
type V2AssistantContent = V2AssistantMessage['content'][number]
type V2ToolState = Extract<V2AssistantContent, { type: 'tool' }>['state']
type V2TokenUsage = NonNullable<V2AssistantMessage['tokens']>
type V2ModelInfo = Awaited<ReturnType<Plugin.Context['model']['list']>>['data'][number]

type V1PermissionRule = NonNullable<Session['permission']>[number]
export type V2PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

export interface V2ClientLike {
  readonly session: V2Session
  readonly location: Plugin.Context['location']
  readonly provider: Plugin.Context['provider']
  readonly model: Plugin.Context['model']
}

export interface V2ForgeClientOptions {
  directory: string
  workspace: ForgeClient['workspace']
  publishToast?: (toast: ForgeToastInput) => void | Promise<void>
}

export interface V2ForgeClient extends ForgeClient {
  recordStatusEvent(event: ForgeEvent): void
}

export const V1_TO_V2_TOOL_NAMES: Record<string, string> = {
  bash: 'shell',
  task: 'subagent',
}

const V1_TO_V2_ACTION_NAMES: Record<string, string> = {
  ...V1_TO_V2_TOOL_NAMES,
  write: 'edit',
  patch: 'edit',
}

export function invertRenameTable(renames: Record<string, string>): Record<string, string> {
  const inverted: Record<string, string> = {}
  for (const [from, to] of Object.entries(renames)) {
    if (!(to in inverted)) inverted[to] = from
  }
  return inverted
}

const V2_TO_V1_ACTION_NAMES: Record<string, string> = {
  ...invertRenameTable(V1_TO_V2_ACTION_NAMES),
  edit: 'write',
}

export function toV2Ruleset(ruleset: V1PermissionRule[]): V2PermissionRule[] {
  return ruleset.map((rule) => ({
    action: V1_TO_V2_ACTION_NAMES[rule.permission] ?? rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
}

export function fromV2Ruleset(ruleset: ReadonlyArray<V2PermissionRule>): V1PermissionRule[] {
  return ruleset.map((rule) => ({
    permission: V2_TO_V1_ACTION_NAMES[rule.action] ?? rule.action,
    pattern: rule.resource,
    action: rule.effect,
  }))
}

function isV2Effect(value: unknown): value is V2PermissionRule['effect'] {
  return value === 'allow' || value === 'deny' || value === 'ask'
}

export function toV2PermissionMap(permission: unknown): V2PermissionRule[] {
  if (!isRecord(permission)) return []
  const rules: V2PermissionRule[] = []
  for (const [tool, value] of Object.entries(permission)) {
    const action = V1_TO_V2_ACTION_NAMES[tool] ?? tool
    if (isV2Effect(value)) {
      rules.push({ action, resource: '*', effect: value })
      continue
    }
    if (!isRecord(value)) continue
    for (const [resource, effect] of Object.entries(value)) {
      if (isV2Effect(effect)) rules.push({ action, resource, effect })
    }
  }
  return rules
}

function isSessionStatus(value: unknown): value is SessionStatus[string] {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'idle' || type === 'busy' || type === 'retry'
}

const SESSION_STATUS_CACHE_CAPACITY = 1000

const sessionStatusCache = new LRUCache<SessionStatus[string]>(SESSION_STATUS_CACHE_CAPACITY)

export function resetV2SessionStatusCache(): void {
  sessionStatusCache.clear()
}

async function call<T>(method: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw err instanceof ForgeClientError ? err : classify(err, method)
  }
}

export function contentToText(
  content: string | ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  const lines: string[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text)
  }
  return lines.join('\n')
}

function toToolState(state: V2ToolState): Record<string, unknown> {
  if (state.status === 'completed') {
    return { status: state.status, input: state.input, output: contentToText(state.content), metadata: state.metadata ?? {} }
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

function lastVisibleMessages(messages: V2Message[], limit: number): V2Message[] {
  const selected: V2Message[] = []
  for (let index = messages.length - 1; index >= 0 && selected.length < limit; index--) {
    const message = messages[index]
    if (message.type === 'user' || message.type === 'assistant') selected.push(message)
  }
  return selected.reverse()
}

function toSessionMessages(messages: V2Message[], sessionID: string, limit?: number): SessionMessages {
  const visible = limit === undefined ? messages : lastVisibleMessages(messages, limit)
  const mapped: SessionMessages = []
  for (const message of visible) {
    if (message.type === 'user') {
      mapped.push({ info: toSessionMessageInfo(message, sessionID), parts: toUserMessageParts(message, sessionID) })
    } else if (message.type === 'assistant') {
      mapped.push({ info: toSessionMessageInfo(message, sessionID), parts: toAssistantMessageParts(message, sessionID) })
    }
  }
  return mapped
}

function emptyTokenUsage(): V2TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokenUsage(total: V2TokenUsage, tokens: V2TokenUsage): void {
  total.input += tokens.input
  total.output += tokens.output
  total.reasoning += tokens.reasoning
  total.cache.read += tokens.cache.read
  total.cache.write += tokens.cache.write
}

function visibleAssistantUsage(messages: SessionMessages): { cost: number; tokens: V2TokenUsage } {
  const tokens = emptyTokenUsage()
  let cost = 0
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    cost += message.info.cost ?? 0
    if (message.info.tokens) addTokenUsage(tokens, message.info.tokens)
  }
  return { cost, tokens }
}

function usageRemainder(
  info: V2SessionInfo,
  used: { cost: number; tokens: V2TokenUsage },
): { cost: number; tokens: V2TokenUsage } {
  const tokens = info.tokens ?? emptyTokenUsage()
  return {
    cost: Math.max(0, (info.cost ?? 0) - used.cost),
    tokens: {
      input: Math.max(0, tokens.input - used.tokens.input),
      output: Math.max(0, tokens.output - used.tokens.output),
      reasoning: Math.max(0, tokens.reasoning - used.tokens.reasoning),
      cache: {
        read: Math.max(0, tokens.cache.read - used.tokens.cache.read),
        write: Math.max(0, tokens.cache.write - used.tokens.cache.write),
      },
    },
  }
}

function hasUsage(usage: { cost: number; tokens: V2TokenUsage }): boolean {
  return usage.cost > 0
    || usage.tokens.input > 0
    || usage.tokens.output > 0
    || usage.tokens.reasoning > 0
    || usage.tokens.cache.read > 0
    || usage.tokens.cache.write > 0
}

function usageRemainderMessage(
  sessionID: string,
  info: V2SessionInfo,
  usage: { cost: number; tokens: V2TokenUsage },
): SessionMessages[number] {
  const model = info.model
  return {
    info: {
      id: `${sessionID}:usage-remainder`,
      role: 'assistant',
      sessionID,
      time: { created: info.time?.created ?? 0 },
      cost: usage.cost,
      tokens: usage.tokens,
      ...(model ? { providerID: model.providerID, modelID: model.id } : {}),
    },
    parts: [],
  }
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
  function recordStatusEvent(event: ForgeEvent): void {
    if (event.type === FORGE_EVENT_TYPES.sessionDeleted) {
      const sessionID = event.properties.sessionID
      if (typeof sessionID === 'string') sessionStatusCache.delete(sessionID)
      return
    }
    if (event.type === FORGE_EVENT_TYPES.sessionIdle) {
      const sessionID = event.properties.sessionID
      if (typeof sessionID === 'string') sessionStatusCache.set(sessionID, { type: 'idle' })
      return
    }
    if (event.type === FORGE_EVENT_TYPES.sessionStatus) {
      const sessionID = event.properties.sessionID
      const status = event.properties.status
      if (typeof sessionID === 'string' && isSessionStatus(status)) sessionStatusCache.set(sessionID, status)
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
    messages: (params) => call('session.messages', async () => {
      const mapped = toSessionMessages(
        await ctx.session.context({ sessionID: params.sessionID }),
        params.sessionID,
        params.limit,
      )
      if (params.limit !== undefined) return mapped
      let info: V2SessionInfo
      try {
        info = await ctx.session.get({ sessionID: params.sessionID })
      } catch {
        return mapped
      }
      const remainder = usageRemainder(info, visibleAssistantUsage(mapped))
      return hasUsage(remainder)
        ? [usageRemainderMessage(params.sessionID, info, remainder), ...mapped]
        : mapped
    }),
    status: () => call('session.status', async () => Object.fromEntries(sessionStatusCache.snapshot())),
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
    publish: async (params) => {
      if (params.body?.type !== 'tui.toast.show') return
      if (!options.publishToast) return
      const properties = params.body.properties
      try {
        await options.publishToast({
          title: properties.title,
          message: properties.message,
          variant: properties.variant,
          duration: properties.duration,
        })
      } catch (err) {
        console.error('[forge] failed to emit toast over RPC', err)
      }
    },
    selectSession: () => Promise.reject(unavailableError('tui.selectSession', 'tui.selectSession is not available on this host')),
  }

  const sync: ForgeClient['sync'] = {
    start: async () => {},
  }

  const event: ForgeClient['event'] = {
    subscribe: () => Promise.reject(unavailableError('event.subscribe', 'event.subscribe is not available on this host')),
  }

  return { session, workspace: options.workspace, project, provider, tui, sync, event, recordStatusEvent }
}
