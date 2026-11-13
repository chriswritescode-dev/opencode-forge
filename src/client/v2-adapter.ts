import type { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import { classify, requestError, unavailableError } from './errors'
import { ForgeClientError } from './port'
import { processShared } from '../utils/process-shared'
import type {
  ForgeClient,
  ForgeEvent,
  ProviderList,
  Session,
  SessionMessageInfo,
  SessionMessagePart,
  SessionMessages,
  SessionStatus,
  SessionToolState,
} from './port'
import { FORGE_EVENT_TYPES, mapV2Error, mapV2SessionInfo } from '../host/v2-events'
import type { ForgeToastInput } from '../host/forge-rpc'
import { LRUCache } from '../utils/lru-cache'

type V2Session = Plugin.Context['session']
type V2SessionInfo = Awaited<ReturnType<V2Session['get']>>
type V2Message = Awaited<ReturnType<V2Session['context']>>[number]
type V2UserMessage = Extract<V2Message, { type: 'user' }>
type V2AssistantMessage = Extract<V2Message, { type: 'assistant' }>
type V2VisibleMessage = V2UserMessage | V2AssistantMessage
type V2AssistantContent = V2AssistantMessage['content'][number]
type V2ToolState = Extract<V2AssistantContent, { type: 'tool' }>['state']
type V2TokenUsage = NonNullable<V2AssistantMessage['tokens']>
type V2ModelInfo = Awaited<ReturnType<Plugin.Context['model']['list']>>['data'][number]

type SessionCreateRequest = {
  title?: string
  location: { directory: string }
  permissions?: V2PermissionRule[]
}

type SessionUpdateRequest = {
  sessionID: string
  title?: string
  permissions?: V2PermissionRule[]
}

type SessionModelRequest = {
  providerID: string
  id: string
  variant?: string
}

type SessionSwitchModelRequest = {
  sessionID: string
  model: SessionModelRequest
}

type V1PermissionRule = NonNullable<Session['permission']>[number]
export type V2PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

const permissionEffectSchema = z.enum(['allow', 'deny', 'ask'])
const sessionStatusEntrySchema = z.object({
  type: z.enum(['idle', 'busy', 'retry']),
  attempt: z.number().optional(),
  message: z.string().optional(),
  next: z.number().optional(),
})
const permissionTableSchema = z.looseObject({})
const modelLimitSchema = z.looseObject({ context: z.number().optional() })

export interface V2ClientLike {
  readonly session: V2Session
  readonly location: Plugin.Context['location']
  readonly model: Plugin.Context['model']
  readonly skill: Plugin.Context['skill']
}

export interface V2ForgeClientOptions {
  directory: string
  workspace: ForgeClient['workspace']
  publishToast?: (toast: ForgeToastInput) => void | Promise<void>
  requestSessionDelete?: (sessionID: string) => Promise<void>
}

export interface V2ForgeClient extends ForgeClient {
  recordStatusEvent(event: ForgeEvent): void
}

export const V1_TO_V2_TOOL_NAMES = {
  bash: 'shell',
  task: 'subagent',
} satisfies Record<string, string>

function renamed(table: Record<string, string>, name: string): string | undefined {
  return table[name]
}

const V1_TO_V2_ACTION_NAMES = {
  ...V1_TO_V2_TOOL_NAMES,
  write: 'edit',
  patch: 'edit',
} satisfies Record<string, string>

export function invertRenameTable(renames: Record<string, string>) {
  const inverted: Record<string, string> = {}
  for (const [from, to] of Object.entries(renames)) {
    if (!(to in inverted)) inverted[to] = from
  }
  return inverted
}

const V2_TO_V1_ACTION_NAMES = {
  ...invertRenameTable(V1_TO_V2_ACTION_NAMES),
  edit: 'write',
} satisfies Record<string, string>

export function toV2Ruleset(ruleset: V1PermissionRule[]): V2PermissionRule[] {
  return ruleset.map((rule) => ({
    action: renamed(V1_TO_V2_ACTION_NAMES, rule.permission) ?? rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
}

export function fromV2Ruleset(ruleset: ReadonlyArray<V2PermissionRule>): V1PermissionRule[] {
  return ruleset.map((rule) => ({
    permission: renamed(V2_TO_V1_ACTION_NAMES, rule.action) ?? rule.action,
    pattern: rule.resource,
    action: rule.effect,
  }))
}

export function toV2PermissionMap<P>(permission: P): V2PermissionRule[] {
  const parsed = permissionTableSchema.safeParse(permission)
  if (!parsed.success) return []
  const rules: V2PermissionRule[] = []
  for (const [tool, value] of Object.entries(parsed.data)) {
    const action = renamed(V1_TO_V2_ACTION_NAMES, tool) ?? tool
    const effect = permissionEffectSchema.safeParse(value)
    if (effect.success) {
      rules.push({ action, resource: '*', effect: effect.data })
      continue
    }
    const perResource = permissionTableSchema.safeParse(value)
    if (!perResource.success) continue
    for (const [resource, resourceEffect] of Object.entries(perResource.data)) {
      const parsedEffect = permissionEffectSchema.safeParse(resourceEffect)
      if (parsedEffect.success) rules.push({ action, resource, effect: parsedEffect.data })
    }
  }
  return rules
}

const SESSION_STATUS_CACHE_CAPACITY = 1000

const MODEL_CONTEXT_CACHE_TTL_MS = 60_000

const sessionStatusCache = processShared('v2-session-status.v1', () => new LRUCache<SessionStatus[string]>(SESSION_STATUS_CACHE_CAPACITY))

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

type ContentPart = { type: string; text?: string }
type MessageContent = string | ReadonlyArray<ContentPart>

function isContentParts(content: MessageContent): content is ReadonlyArray<ContentPart> {
  return Array.isArray(content)
}

export function contentToText(
  content: MessageContent | undefined,
): string {
  if (content === undefined) return ''
  if (!isContentParts(content)) return content
  const lines: string[] = []
  for (const part of content) {
    if (part.type === 'text' && part.text !== undefined) lines.push(part.text)
  }
  return lines.join('\n')
}

function toToolState(state: V2ToolState): SessionToolState {
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

function isVisibleV2Message(message: V2Message): message is V2VisibleMessage {
  return message.type === 'user' || message.type === 'assistant'
}

function lastVisibleMessages(messages: V2Message[], limit: number): V2Message[] {
  const selected: V2Message[] = []
  for (let index = messages.length - 1; index >= 0 && selected.length < limit; index--) {
    const message = messages[index]
    if (isVisibleV2Message(message)) selected.push(message)
  }
  return selected.reverse()
}

function toSessionMessages(messages: V2Message[], sessionID: string, limit?: number): SessionMessages {
  const visible = limit === undefined ? messages : lastVisibleMessages(messages, limit)
  const mapped: SessionMessages = []
  for (const message of visible) {
    if (!isVisibleV2Message(message)) continue
    if (message.type === 'user') {
      mapped.push({ info: toSessionMessageInfo(message, sessionID), parts: toUserMessageParts(message, sessionID) })
    } else {
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

function visibleAssistantUsage(messages: SessionMessages): UsageTotals {
  const tokens = emptyTokenUsage()
  let cost = 0
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    cost += message.info.cost ?? 0
    if (message.info.tokens) addTokenUsage(tokens, message.info.tokens)
  }
  return { cost, tokens }
}

type UsageTotals = { cost: number; tokens: V2TokenUsage }

function usageRemainder(  info: V2SessionInfo,
  used: UsageTotals,
): UsageTotals {
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

function hasUsage(usage: UsageTotals): boolean {
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
  usage: UsageTotals,
): SessionMessages[number] {
  const model = info.model
  const messageInfo: SessionMessageInfo = {
    id: `${sessionID}:usage-remainder`,
    role: 'assistant',
    sessionID,
    time: { created: info.time?.created ?? 0 },
    cost: usage.cost,
    tokens: usage.tokens,
  }
  if (model) {
    messageInfo.providerID = model.providerID
    messageInfo.modelID = model.id
  }
  return {
    info: messageInfo,
    parts: [],
  }
}

function toPortSession(info: V2SessionInfo): Session {
  const session = mapV2SessionInfo(info)
  return info.permissions ? { ...session, permission: fromV2Ruleset(info.permissions) } : session
}

function toProviderModelInfo(model: V2ModelInfo): ProviderList['all'][number]['models'][string] {
  const cost = model.cost[0]
  const info: ProviderList['all'][number]['models'][string] = {
    id: model.id,
    name: model.name,
    release_date: new Date(model.time.released).toISOString(),
    capabilities: {
      toolcall: model.capabilities.tools,
      reasoning: model.compatibility?.reasoningField !== undefined,
    },
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
  }
  if (cost) info.cost = { input: cost.input, output: cost.output }
  return info
}

export function toProviderListFromV2(
  providers: ReadonlyArray<{ id: string; name: string; activation: string }>,
  models: ReadonlyArray<V2ModelInfo>,
): ProviderList {
  return {
    all: providers.map((info) => ({
      id: info.id,
      name: info.name,
      models: Object.fromEntries(
        models
          .filter((model) => model.providerID === info.id)
          .map((model) => [model.id, toProviderModelInfo(model)]),
      ),
    })),
    connected: providers.filter((info) => info.activation !== 'disabled').map((info) => info.id),
    default: {},
  }
}

export function createForgeClientFromV2(ctx: V2ClientLike, options: V2ForgeClientOptions): V2ForgeClient {
  function recordStatusEvent(event: ForgeEvent): void {
    if (event.type === FORGE_EVENT_TYPES.sessionDeleted) {
      const sessionID = event.properties.sessionID
      if (sessionID !== undefined) sessionStatusCache.delete(sessionID)
      return
    }
    if (event.type === FORGE_EVENT_TYPES.sessionIdle) {
      const sessionID = event.properties.sessionID
      if (sessionID !== undefined) sessionStatusCache.set(sessionID, { type: 'idle' })
      return
    }
    if (event.type === FORGE_EVENT_TYPES.sessionStatus) {
      const sessionID = event.properties.sessionID
      const status = sessionStatusEntrySchema.safeParse(event.properties.status)
      if (sessionID !== undefined && status.success) sessionStatusCache.set(sessionID, status.data)
    }
  }

  const session: ForgeClient['session'] = {
    create: (params) => call('session.create', async () => {
      const createParams: SessionCreateRequest = {
        title: params.title,
        location: { directory: params.workspaceID ?? params.workspace ?? params.directory ?? options.directory },
      }
      if (params.permission) createParams.permissions = toV2Ruleset(params.permission)
      return toPortSession(await ctx.session.create(createParams))
    }),
    get: (params) => call('session.get', async () =>
      toPortSession(await ctx.session.get({ sessionID: params.sessionID }))),
    update: (params) => call('session.update', async () => {
      const update: SessionUpdateRequest = { sessionID: params.sessionID }
      if (params.title !== undefined) update.title = params.title
      if (params.permission !== undefined) update.permissions = toV2Ruleset(params.permission)
      await ctx.session.update(update)
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
        const model: SessionModelRequest = {
          providerID: params.model.providerID,
          id: params.model.modelID,
        }
        if (params.variant) model.variant = params.variant
        const switched: SessionSwitchModelRequest = { sessionID: params.sessionID, model }
        await ctx.session.switchModel(switched)
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
    compact: (params) => call('session.compact', async () => {
      await ctx.session.compact({ sessionID: params.sessionID, delivery: 'queue' })
    }),
    delete: (params) => {
      const requestSessionDelete = options.requestSessionDelete
      if (!requestSessionDelete) {
        return Promise.reject(unavailableError('session.delete', 'session.delete is not available on this host'))
      }
      return call('session.delete', () => requestSessionDelete(params.sessionID))
    },
  }

  let modelContextCache: { at: number; limits: Map<string, number> } | null = null

  const model: ForgeClient['model'] = {
    contextLimit: (params) => call('model.contextLimit', async () => {
      const now = Date.now()
      if (!modelContextCache || now - modelContextCache.at >= MODEL_CONTEXT_CACHE_TTL_MS) {
        const listed = await ctx.model.list({ location: { directory: options.directory } })
        const limits = new Map<string, number>()
        for (const info of listed.data) {
          const limit = modelLimitSchema.safeParse(info.limit)
          const context = limit.success ? limit.data.context : undefined
          if (context !== undefined && context > 0) {
            limits.set(`${info.providerID}/${info.id}`, context)
          }
        }
        modelContextCache = { at: now, limits }
      }
      return modelContextCache.limits.get(`${params.providerID}/${params.modelID}`)
    }),
  }

  const skill: ForgeClient['skill'] = {
    list: (params) => call('skill.list', async () => {
      const listed = await ctx.skill.list({ location: { directory: params.directory } })
      return listed.data.map((info) => ({ path: info.path }))
    }),
  }

  const toast: ForgeClient['toast'] = async (input) => {
    if (!options.publishToast) return
    try {
      await options.publishToast({
        title: input.title,
        message: input.message,
        variant: input.variant,
        duration: input.duration,
      })
    } catch (err) {
      console.error('[forge] failed to emit toast over RPC', err)
    }
  }

  return { session, workspace: options.workspace, model, skill, toast, recordStatusEvent }
}
