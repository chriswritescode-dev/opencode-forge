import { describe, test, expect, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { resolveV2TuiProjectId, setupForgeTuiV2 } from '../../src/tui/v2'
import tuiModule from '../../src/tui'
import { formatForgeTitle, resolveTuiOptions } from '../../src/tui/options'
import { VERSION } from '../../src/version'
import { useTempConfigHome } from '../helpers/temp-config'
import { join } from 'path'
import { resolveForgeDataDir } from '../../src/utils/opencode-paths'
import { forgeWorktreesRoot } from '../../src/workspace/forge-naming'

interface RecordedCommand {
  id?: string
  title?: string
  description?: string
  group?: string
  palette?: boolean
  bind?: string | false
  run?: (...args: unknown[]) => unknown
}

interface RecordedLayer {
  mode?: string
  commands?: RecordedCommand[]
  bindings?: readonly string[]
}

interface RecordedSlot {
  placement: string
  target: string
  render: (input: unknown) => unknown
}

interface RecordedRpcSubscription {
  name: string
  handler: (event: { data: Record<string, unknown> }) => void
  signal?: AbortSignal
}

const SLOT_PLACEMENTS = ['prepend', 'append', 'before', 'after', 'replace'] as const

function recordSlot(claim: Record<string, unknown>, slots: RecordedSlot[]): void {
  const placements = SLOT_PLACEMENTS.filter((placement) => claim[placement] !== undefined)
  if (placements.length !== 1) throw new Error('slot claim requires exactly one placement key')
  const placement = placements[0]
  slots.push({
    placement,
    target: String(claim[placement]),
    render: claim.render as RecordedSlot['render'],
  })
}

interface FakeV2TuiOptions {
  options?: Record<string, unknown>
  location?: { directory: string; workspaceID?: string }
  defaultDirectory?: string
  defaultDirectoryThrows?: boolean
  locationGet?: (input?: { location?: { directory?: string } }) => Promise<{ project: { id: string } }>
  route?: { type: 'home' } | { type: 'session'; sessionID: string }
  sessions?: Array<{ id: string; location: { directory: string } }>
}

type DataHandler = (event: { data: Record<string, unknown> }) => void

function createFakeV2TuiContext(fakeOptions: FakeV2TuiOptions = {}) {
  const layers: RecordedLayer[] = []
  const slots: RecordedSlot[] = []
  const toasts: Array<Record<string, unknown>> = []
  const rpcDefinitions: unknown[] = []
  const rpcSubscriptions: RecordedRpcSubscription[] = []
  const dataHandlers = new Map<string, DataHandler[]>()
  const navigations: unknown[] = []
  const prompts: Array<Record<string, unknown>> = []
  let route = fakeOptions.route ?? { type: 'home' as const }

  const sessionRemove = vi.fn(async (_input: { sessionID: string }) => {})
  const sessionList = vi.fn(async () => ({ data: [], cursor: {} }))

  const locationGet = vi.fn(
    fakeOptions.locationGet ?? (async () => ({ project: { id: 'proj-1' } })),
  )

  const rpc = vi.fn((definition: unknown) => {
    rpcDefinitions.push(definition)
    return {
      events: {
        on: vi.fn((
          name: string,
          handler: (event: { data: Record<string, unknown> }) => void,
          options?: { signal?: AbortSignal },
        ) => {
          rpcSubscriptions.push({ name, handler, signal: options?.signal })
          return () => {}
        }),
      },
    }
  })

  const ctx = {
    options: fakeOptions.options ?? {},
    location: fakeOptions.location,
    data: {
      location: {
        default: () => {
          if (fakeOptions.defaultDirectoryThrows) throw new Error('no default location')
          return { directory: fakeOptions.defaultDirectory ?? '/test/project' }
        },
      },
      on: vi.fn((type: string, handler: DataHandler) => {
        dataHandlers.set(type, [...(dataHandlers.get(type) ?? []), handler])
        return () => {
          dataHandlers.set(type, (dataHandlers.get(type) ?? []).filter((candidate) => candidate !== handler))
        }
      }),
      session: {
        list: () => fakeOptions.sessions ?? [],
        get: (sessionID: string) => fakeOptions.sessions?.find((session) => session.id === sessionID),
      },
    },
    client: { location: { get: locationGet }, rpc, session: { list: sessionList, remove: sessionRemove } },
    theme: { text: { base: '#ffffff', muted: '#888888' } },
    keymap: {
      layer: vi.fn((input: () => RecordedLayer) => {
        layers.push(input())
      }),
    },
    ui: {
      slot: vi.fn((claim: Record<string, unknown>) => {
        recordSlot(claim, slots)
        return () => {}
      }),
      toast: {
        show: vi.fn((input: Record<string, unknown>) => {
          toasts.push(input)
        }),
      },
      router: {
        current: () => route,
        navigate: vi.fn((destination: typeof route) => {
          navigations.push(destination)
          route = destination
        }),
      },
      dialog: {
        show: vi.fn(),
        set: vi.fn(),
        clear: vi.fn(),
        select: vi.fn(async () => undefined),
        prompt: vi.fn(async (input: Record<string, unknown>) => {
          prompts.push(input)
          return undefined
        }),
      },
    },
  } as unknown as Plugin.Context

  const emit = (type: string, data: Record<string, unknown>) => {
    for (const handler of dataHandlers.get(type) ?? []) handler({ data })
  }

  return { ctx, layers, slots, toasts, locationGet, sessionRemove, sessionList, rpc, rpcDefinitions, rpcSubscriptions, navigations, prompts, emit, dataHandlers }
}

function findCommand(fake: ReturnType<typeof createFakeV2TuiContext>, id: string): RecordedCommand {
  findSlot(fake.slots, 'app').render({})
  const command = fake.layers[0]?.commands?.find((candidate) => candidate.id === id)
  if (!command) throw new Error(`no command registered for ${id}`)
  return command
}

function findSlot(slots: RecordedSlot[], target: string): RecordedSlot {
  const slot = slots.find((candidate) => candidate.target === target)
  if (!slot) throw new Error(`no slot appended for ${target}`)
  return slot
}

describe('V2 TUI setup', () => {
  useTempConfigHome('forge-v2-tui')

  test('the shared TUI module carries the V1 tui and the V2 setup', () => {
    expect(tuiModule.id).toBe('oc-forge')
    expect(typeof tuiModule.tui).toBe('function')
    expect(typeof tuiModule.setup).toBe('function')
  })

  test('registers the forge.dashboard palette command from the app slot', () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    findSlot(fake.slots, 'app').render({})

    expect(fake.layers).toHaveLength(1)
    expect(fake.layers[0]?.mode).toBe('global')
    const dashboard = fake.layers[0]?.commands?.find((command) => command.id === 'forge.dashboard')
    expect(dashboard).toMatchObject({
      title: 'Open dashboard',
      group: 'Forge',
      palette: true,
    })
    cleanup()
  })

  test('appends the loop sidebar slot for the current project', () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)

    expect(findSlot(fake.slots, 'sidebar.content').placement).toBe('append')
    cleanup()
  })

  test('omits the loop sidebar slot when the sidebar option is disabled', () => {
    const fake = createFakeV2TuiContext({ options: { sidebar: false } })

    const cleanup = setupForgeTuiV2(fake.ctx)

    expect(fake.slots.some((slot) => slot.target === 'sidebar.content')).toBe(false)
    cleanup()
  })

  test('shows an RPC toast emitted for the current project', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)

    expect(fake.rpcSubscriptions.map((subscription) => subscription.name)).toEqual(['toast', 'sessionDelete'])
    fake.rpcSubscriptions[0]?.handler({
      data: { projectId: 'proj-1', title: 'Loop done', message: 'All sections passed', variant: 'success', duration: 4000 },
    })

    await vi.waitFor(() => expect(fake.toasts).toEqual([{
      title: 'Loop done',
      message: 'All sections passed',
      variant: 'success',
      duration: 4000,
    }]))
    cleanup()
  })

  test('ignores an RPC toast emitted for another project', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)

    fake.rpcSubscriptions[0]?.handler({
      data: { projectId: 'proj-2', message: 'Other project', variant: 'info' },
    })
    await vi.waitFor(() => expect(fake.locationGet).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.toasts).toEqual([])
    cleanup()
  })

  test('deletes the session named by a sessionDelete RPC event', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    const subscription = fake.rpcSubscriptions.find((candidate) => candidate.name === 'sessionDelete')
    subscription?.handler({ data: { sessionID: 'ses_retired' } })
    subscription?.handler({ data: {} })

    await vi.waitFor(() => expect(fake.sessionRemove).toHaveBeenCalledWith({ sessionID: 'ses_retired' }))
    expect(fake.sessionRemove).toHaveBeenCalledTimes(1)
    cleanup()
  })

  test('cleanup aborts the RPC toast subscription', () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    const signal = fake.rpcSubscriptions[0]?.signal

    expect(signal?.aborted).toBe(false)
    cleanup()
    expect(signal?.aborted).toBe(true)
  })

  test('registers the execute-plan, restart, and sandbox-build palette commands', () => {
    const fake = createFakeV2TuiContext({ options: { keybinds: { executePlan: '<leader>x' } } })

    const cleanup = setupForgeTuiV2(fake.ctx)

    for (const id of ['forge.plan.execute', 'forge.plan.executePasted', 'forge.loop.restart', 'forge.sandbox.buildImage']) {
      expect(findCommand(fake, id)).toMatchObject({ group: 'Forge', palette: true })
    }
    expect(findCommand(fake, 'forge.plan.execute').bind).toBe('<leader>x')
    cleanup()
  })

  test('execute plan asks for a session when none is open', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    await findCommand(fake, 'forge.plan.execute').run?.()

    expect(fake.toasts).toContainEqual(expect.objectContaining({ message: 'Open a session first' }))
    cleanup()
  })

  test('execute plan falls back to the paste dialog when the session has no stored plan', async () => {
    const fake = createFakeV2TuiContext({ route: { type: 'session', sessionID: 'ses_architect' } })

    const cleanup = setupForgeTuiV2(fake.ctx)
    findCommand(fake, 'forge.plan.execute').run?.()

    await vi.waitFor(() => expect(fake.prompts).toEqual([expect.objectContaining({ title: 'Paste plan' })]))
    expect(fake.toasts).toContainEqual(expect.objectContaining({ message: 'No plan in current session — paste one to execute' }))
    cleanup()
  })

  test('follows a loop rotation inside the viewed worktree, but not subagents or non-loop sessions', () => {
    const worktree = join(forgeWorktreesRoot(resolveForgeDataDir()), 'loop-a')
    const fake = createFakeV2TuiContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: worktree } }],
    })

    const cleanup = setupForgeTuiV2(fake.ctx)
    fake.emit('session.created', { sessionID: 'ses_task', parentID: 'ses_code', location: { directory: worktree } })
    fake.emit('session.created', { sessionID: 'ses_other', location: { directory: '/test/project' } })
    expect(fake.navigations).toEqual([])

    fake.emit('session.created', { sessionID: 'ses_audit', location: { directory: worktree } })
    expect(fake.navigations).toEqual([{ type: 'session', sessionID: 'ses_audit' }])

    cleanup()
    expect(fake.dataHandlers.get('session.created')).toEqual([])
  })

  test('resolves the project id from the current location directory', async () => {
    const fake = createFakeV2TuiContext({
      location: { directory: '/work/project', workspaceID: 'ws-1' },
    })

    await expect(resolveV2TuiProjectId(fake.ctx)).resolves.toBe('proj-1')
    expect(fake.locationGet).toHaveBeenCalledWith({ location: { directory: '/work/project' } })
  })

  test('falls back to the default location when context.location is absent', async () => {
    const fake = createFakeV2TuiContext({ defaultDirectory: '/work/default' })

    await expect(resolveV2TuiProjectId(fake.ctx)).resolves.toBe('proj-1')
    expect(fake.locationGet).toHaveBeenCalledWith({ location: { directory: '/work/default' } })
  })

  test('returns null when the location lookup fails', async () => {
    const fake = createFakeV2TuiContext({
      locationGet: async () => {
        throw new Error('location unavailable')
      },
    })

    await expect(resolveV2TuiProjectId(fake.ctx)).resolves.toBeNull()
  })

  test('returns null when the default location cannot be read', async () => {
    const fake = createFakeV2TuiContext({ defaultDirectoryThrows: true })

    await expect(resolveV2TuiProjectId(fake.ctx)).resolves.toBeNull()
    expect(fake.locationGet).not.toHaveBeenCalled()
  })
})

describe('resolveTuiOptions', () => {
  test('uses defaults when no layer supplies a value', () => {
    expect(resolveTuiOptions(undefined)).toEqual({
      sidebar: true,
      showVersion: true,
      keybinds: { executePlan: '<leader>f', dashboard: '', toggleHostSandbox: '' },
    })
  })

  test('applies the forge config layer alone', () => {
    const opts = resolveTuiOptions({
      sidebar: false,
      showVersion: false,
      keybinds: { dashboard: '<leader>d' },
    })

    expect(opts.sidebar).toBe(false)
    expect(opts.showVersion).toBe(false)
    expect(opts.keybinds.dashboard).toBe('<leader>d')
    expect(opts.keybinds.executePlan).toBe('<leader>f')
  })

  test('applies the plugin options layer alone', () => {
    const opts = resolveTuiOptions(undefined, { sidebar: false })

    expect(opts.sidebar).toBe(false)
    expect(opts.showVersion).toBe(true)
    expect(opts.keybinds).toEqual({ executePlan: '<leader>f', dashboard: '', toggleHostSandbox: '' })
  })

  test('later layers win and keybinds merge key by key', () => {
    const opts = resolveTuiOptions(
      { sidebar: true, showVersion: true, keybinds: { executePlan: '<leader>c', dashboard: '<leader>d' } },
      { sidebar: false, showVersion: false, keybinds: { dashboard: '<leader>D' } },
    )

    expect(opts.sidebar).toBe(false)
    expect(opts.showVersion).toBe(false)
    expect(opts.keybinds).toEqual({
      executePlan: '<leader>c',
      dashboard: '<leader>D',
      toggleHostSandbox: '',
    })
  })
})

describe('formatForgeTitle', () => {
  test('includes the version only when requested', () => {
    expect(formatForgeTitle(true)).toBe(`Forge v${VERSION}`)
    expect(formatForgeTitle(false)).toBe('Forge')
  })
})
