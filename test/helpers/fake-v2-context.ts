import { vi } from 'vitest'
import type { Plugin } from '@opencode/plugin'

type AnyMethod = (...args: any[]) => any

export interface V2ContextCall {
  method: string
  args: unknown[]
}

export interface FakeV2Context {
  ctx: Plugin.Context
  calls: V2ContextCall[]
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
  transform: async () => ({ dispose: async () => {} }),
  reload: async () => {},
  hook: async () => ({ dispose: async () => {} }),
}

const AGENT_DEFAULTS: Record<string, AnyMethod> = {
  transform: async () => ({ dispose: async () => {} }),
  reload: async () => {},
}

const COMMAND_DEFAULTS: Record<string, AnyMethod> = {
  list: async () => [],
  transform: async () => ({ dispose: async () => {} }),
  reload: async () => {},
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

function makeDomain(
  name: string,
  defaults: Record<string, AnyMethod>,
  overrides: Record<string, AnyMethod> | undefined,
  calls: V2ContextCall[],
): Record<string, AnyMethod> {
  const domain: Record<string, AnyMethod> = {}
  for (const [method, impl] of Object.entries({ ...defaults, ...overrides })) {
    domain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method: `${name}.${method}`, args })
      return impl(...args)
    })
  }
  return domain
}

export function createFakeV2Context(options: FakeV2ContextOptions = {}): FakeV2Context {
  const calls: V2ContextCall[] = []
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
    session: makeDomain('session', makeSessionDefaults(directory), options.session, calls),
    permission: makeDomain('permission', PERMISSION_DEFAULTS, options.permission, calls),
    event: makeDomain('event', EVENT_DEFAULTS, options.event, calls),
    provider: makeDomain('provider', PROVIDER_DEFAULTS, options.provider, calls),
    model: makeDomain('model', MODEL_DEFAULTS, options.model, calls),
    tool: makeDomain('tool', TOOL_DEFAULTS, options.tool, calls),
    agent: makeDomain('agent', AGENT_DEFAULTS, options.agent, calls),
    command: makeDomain('command', COMMAND_DEFAULTS, options.command, calls),
    shell: makeDomain('shell', SHELL_DEFAULTS, options.shell, calls),
    storage: makeDomain('storage', STORAGE_DEFAULTS, options.storage, calls),
    worktree: makeDomain('worktree', WORKTREE_DEFAULTS, options.worktree, calls),
  } as unknown as Plugin.Context

  return { ctx, calls }
}
