import { vi } from 'vitest'
import type { Plugin } from '@opencode/plugin'

type AnyMethod = (...args: any[]) => any

export interface V2ContextCall {
  method: string
  args: unknown[]
}

export interface V2HookRegistration {
  domain: string
  event: string
  callback: (event: any) => unknown
}

export interface RecordedTool {
  name: string
  description: string
  input: unknown
  options?: unknown
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

export interface RecordedAgent {
  id: string
  info: Record<string, any>
}

export interface RecordedCommand {
  name: string
  description?: string
  execute: (input: any) => Promise<void>
}

export interface RecordedRpcRegistration {
  definition: unknown
  handlers: unknown
}

export interface RecordedRpcEvent {
  event: string
  data: unknown
}

export interface FakeV2Rpc {
  registrations: RecordedRpcRegistration[]
  emitted: RecordedRpcEvent[]
  disposed: number
}

export interface FakeV2Context {
  ctx: Plugin.Context
  calls: V2ContextCall[]
  hooks: V2HookRegistration[]
  tools: RecordedTool[]
  builtinTools: Record<string, FakeBuiltinTool>
  agents: RecordedAgent[]
  commands: RecordedCommand[]
  defaultAgent: { id: string | undefined }
  rpc: FakeV2Rpc
}

export interface FakeV2ContextOptions {
  app?: Partial<Plugin.Context['app']>
  location?: {
    directory?: string
    workspaceID?: string
    project?: Partial<Plugin.Context['location']['project']>
  }
  options?: Record<string, unknown>
  session?: Record<string, AnyMethod>
  permission?: Record<string, AnyMethod>
  event?: Record<string, AnyMethod>
  provider?: Record<string, AnyMethod>
  model?: Record<string, AnyMethod>
  tool?: Record<string, AnyMethod>
  agent?: Record<string, AnyMethod>
  command?: Record<string, AnyMethod>
  shell?: Record<string, AnyMethod>
  storage?: Record<string, AnyMethod>
  worktree?: Record<string, AnyMethod>
  rpc?: Record<string, AnyMethod>
}

const DEFAULT_DIRECTORY = '/tmp/forge-project'
const DEFAULT_PROJECT_ID = 'proj_fake'

function makeSessionDefaults(directory: string): Record<string, AnyMethod> {
  const session = {
    id: 'ses_fake_1',
    projectID: DEFAULT_PROJECT_ID,
    location: { directory },
    time: { created: 1, updated: 1 },
  }
  return {
    create: async (input?: { title?: string; parentID?: string; location?: { directory: string }; permissions?: unknown }) => ({
      ...session,
      id: 'ses_fake_1',
      title: input?.title,
      parentID: input?.parentID,
      location: input?.location ?? { directory },
      permissions: input?.permissions,
    }),
    get: async (input?: { sessionID?: string }) => ({
      ...session,
      id: input?.sessionID ?? session.id,
    }),
    update: async () => {},
    switchAgent: async () => {},
    switchModel: async () => {},
    prompt: async () => ({ id: 'msg_fake_1', sessionID: 'ses_fake_1', time: { created: 1 }, type: 'user', text: '' }),
    interrupt: async () => ({ interrupted: true }),
    move: async () => {},
    wait: async () => {},
    context: async () => [],
    hook: async () => ({ dispose: async () => {} }),
  }
}

const PERMISSION_DEFAULTS: Record<string, AnyMethod> = {
  list: async () => [],
  get: async () => undefined,
  reply: async () => {},
  hook: async () => ({ dispose: async () => {} }),
}

const EVENT_DEFAULTS: Record<string, AnyMethod> = {
  subscribe: () => (async function* () {})(),
}

const PROVIDER_DEFAULTS: Record<string, AnyMethod> = {
  list: async () => ({ location: { directory: DEFAULT_DIRECTORY }, data: [] }),
}

const MODEL_DEFAULTS: Record<string, AnyMethod> = {
  list: async () => ({ location: { directory: DEFAULT_DIRECTORY }, data: [] }),
}

const TOOL_DEFAULTS: Record<string, AnyMethod> = {
  reload: async () => {},
  hook: async () => ({ dispose: async () => {} }),
}

export interface FakeBuiltinTool {
  execute: (input: unknown, context: Record<string, unknown>) => Promise<unknown>
}

function makeToolDefaults(recorded: RecordedTool[], builtins: Record<string, FakeBuiltinTool>): Record<string, AnyMethod> {
  return {
    transform: async (callback: (editor: {
      add: (tool: RecordedTool) => void
      update: (id: string, update: (tool: FakeBuiltinTool) => void) => void
    }) => void) => {
      callback({
        add: (tool) => recorded.push(tool),
        update: (id, update) => {
          const builtin = builtins[id]
          if (builtin) update(builtin)
        },
      })
      return { dispose: async () => {} }
    },
    ...TOOL_DEFAULTS,
  }
}

const AGENT_PERMISSION_DEFAULTS = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
]

function makeAgentInfo(id: string): Record<string, any> {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: 'primary',
    hidden: false,
    permissions: AGENT_PERMISSION_DEFAULTS.map((rule) => ({ ...rule })),
  }
}

function makeAgentDefaults(
  agents: RecordedAgent[],
  defaultAgent: { id: string | undefined },
): Record<string, AnyMethod> {
  const find = (id: string) => agents.find((agent) => agent.id === id)
  return {
    transform: async (callback: (editor: Record<string, AnyMethod>) => void) => {
      callback({
        list: () => agents.map((agent) => agent.info),
        get: (id: string) => find(id)?.info,
        default: (id: string | undefined) => {
          defaultAgent.id = id
        },
        update: (id: string, update: (agent: Record<string, any>) => void) => {
          let existing = find(id)
          if (!existing) {
            existing = { id, info: makeAgentInfo(id) }
            agents.push(existing)
          }
          update(existing.info)
        },
        remove: (id: string) => {
          const index = agents.findIndex((agent) => agent.id === id)
          if (index >= 0) agents.splice(index, 1)
        },
      })
      return { dispose: async () => {} }
    },
    reload: async () => {},
  }
}

function makeCommandDefaults(commands: RecordedCommand[]): Record<string, AnyMethod> {
  return {
    list: async () => commands.map((command) => ({ name: command.name, description: command.description })),
    transform: async (callback: (editor: { add: (definition: RecordedCommand) => void }) => void) => {
      callback({ add: (definition) => commands.push(definition) })
      return { dispose: async () => {} }
    },
    reload: async () => {},
  }
}

const SHELL_DEFAULTS: Record<string, AnyMethod> = {
  hook: async () => ({ dispose: async () => {} }),
}

const STORAGE_DEFAULTS: Record<string, AnyMethod> = {
  get: async () => undefined,
  set: async () => {},
  remove: async () => {},
  scan: async () => ({ entries: [] }),
}

const WORKTREE_DEFAULTS: Record<string, AnyMethod> = {
  list: async () => [],
  create: async (input?: { directory?: string }) => ({ directory: input?.directory ?? DEFAULT_DIRECTORY }),
  remove: async () => {},
  refresh: async () => {},
  transform: async () => ({ dispose: async () => {} }),
  reload: async () => {},
}

function makeRpcDefaults(record: FakeV2Rpc): Record<string, AnyMethod> {
  return {
    register: async (definition: unknown, handlers: unknown) => {
      record.registrations.push({ definition, handlers })
      return {
        events: {
          emit: async (event: string, data: unknown) => {
            record.emitted.push({ event, data })
          },
        },
        dispose: async () => {
          record.disposed += 1
        },
      }
    },
  }
}

function makeDomain(
  name: string,
  defaults: Record<string, AnyMethod>,
  overrides: Record<string, AnyMethod> | undefined,
  calls: V2ContextCall[],
  hooks: V2HookRegistration[],
): Record<string, AnyMethod> {
  const domain: Record<string, AnyMethod> = {}
  for (const [method, impl] of Object.entries({ ...defaults, ...overrides })) {
    if (method === 'hook') {
      domain[method] = vi.fn((event: string, callback: (event: any) => unknown) => {
        calls.push({ method: `${name}.hook`, args: [event, callback] })
        hooks.push({ domain: name, event, callback })
        return impl(event, callback)
      })
      continue
    }
    domain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method: `${name}.${method}`, args })
      return impl(...args)
    })
  }
  return domain
}

export function createFakeV2Context(options: FakeV2ContextOptions = {}): FakeV2Context {
  const calls: V2ContextCall[] = []
  const hooks: V2HookRegistration[] = []
  const tools: RecordedTool[] = []
  const builtinTools: Record<string, FakeBuiltinTool> = {
    shell: { execute: async (input) => ({ content: [{ type: 'text', text: JSON.stringify(input) }] }) },
  }
  const agents: RecordedAgent[] = []
  const commands: RecordedCommand[] = []
  const defaultAgent: { id: string | undefined } = { id: undefined }
  const rpc: FakeV2Rpc = { registrations: [], emitted: [], disposed: 0 }
  const directory = options.location?.directory ?? DEFAULT_DIRECTORY
  const project = {
    id: options.location?.project?.id ?? DEFAULT_PROJECT_ID,
    directory: options.location?.project?.directory ?? directory,
    canonical: options.location?.project?.canonical ?? directory,
  }

  const ctx = {
    app: { name: 'opencode-forge', version: '0.0.0', channel: 'test', ...options.app },
    location: {
      directory,
      ...(options.location?.workspaceID ? { workspaceID: options.location.workspaceID } : {}),
      project,
    },
    options: options.options ?? {},
    session: makeDomain('session', makeSessionDefaults(directory), options.session, calls, hooks),
    permission: makeDomain('permission', PERMISSION_DEFAULTS, options.permission, calls, hooks),
    event: makeDomain('event', EVENT_DEFAULTS, options.event, calls, hooks),
    provider: makeDomain('provider', PROVIDER_DEFAULTS, options.provider, calls, hooks),
    model: makeDomain('model', MODEL_DEFAULTS, options.model, calls, hooks),
    tool: makeDomain('tool', makeToolDefaults(tools, builtinTools), options.tool, calls, hooks),
    agent: makeDomain('agent', makeAgentDefaults(agents, defaultAgent), options.agent, calls, hooks),
    command: makeDomain('command', makeCommandDefaults(commands), options.command, calls, hooks),
    shell: makeDomain('shell', SHELL_DEFAULTS, options.shell, calls, hooks),
    storage: makeDomain('storage', STORAGE_DEFAULTS, options.storage, calls, hooks),
    worktree: makeDomain('worktree', WORKTREE_DEFAULTS, options.worktree, calls, hooks),
    rpc: makeDomain('rpc', makeRpcDefaults(rpc), options.rpc, calls, hooks),
  } as unknown as Plugin.Context

  return { ctx, calls, hooks, tools, builtinTools, agents, commands, defaultAgent, rpc }
}
