import { describe, test, expect, vi } from 'vitest'

vi.mock('solid-js', async () => await import('solid-js/dist/dev.js'))

import { createSignal } from 'solid-js'
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
  worktrees?: { root: string; dirs: string[] } | { error: string }
  version?: { version: string } | { error: string }
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
  const [route, setRoute] = createSignal<{ type: 'home' } | { type: 'session'; sessionID: string }>(
    fakeOptions.route ?? { type: 'home' as const },
  )

  const sessionRemove = vi.fn(async (_input: { sessionID: string }) => {})
  const sessionList = vi.fn(async () => ({ data: [], cursor: {} }))

  const worktrees = fakeOptions.worktrees ?? { root: forgeWorktreesRoot(resolveForgeDataDir()), dirs: [] }
  const worktreesMock = vi.fn(async () => worktrees)
  const loopSidebar = vi.fn(async () => ({ loops: [] }))
  const hostSandboxState = vi.fn(async () => ({
    configEnabled: true,
    desired: null,
    applied: null,
    controller: null,
  }))
  const hostSandboxSet = vi.fn(async () => ({ revision: 'rev-1' }))
  const autoApproveState = vi.fn(async () => ({ enabled: false, inherited: false }))
  const autoApproveSet = vi.fn(async () => ({ enabled: true, inherited: false }))
  const version = vi.fn(async () => fakeOptions.version ?? { version: VERSION })

  const locationGet = vi.fn(
    fakeOptions.locationGet ?? (async () => ({ project: { id: 'proj-1' } })),
  )

  const rpc = vi.fn((definition: unknown) => {
    rpcDefinitions.push(definition)
    return {
      worktrees: worktreesMock,
      loops: vi.fn(async () => ({ loops: [] })),
      loopSidebar,
      hostSandboxState,
      hostSandboxSet,
      autoApproveState,
      autoApproveSet,
      version,
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
        current: () => route(),
        navigate: vi.fn((destination: { type: 'home' } | { type: 'session'; sessionID: string }) => {
          navigations.push(destination)
          setRoute(destination)
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

  return {
    ctx,
    layers,
    slots,
    toasts,
    locationGet,
    sessionRemove,
    sessionList,
    rpc,
    rpcDefinitions,
    rpcSubscriptions,
    navigations,
    prompts,
    emit,
    dataHandlers,
    worktrees: worktreesMock,
    loopSidebar,
    hostSandboxState,
    hostSandboxSet,
    autoApproveState,
    autoApproveSet,
    version,
    setRoute,
    findRpcSubscription: (name: string) => rpcSubscriptions.find((subscription) => subscription.name === name),
  }
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

  test('the TUI module exports the V2 setup', () => {
    expect(tuiModule.id).toBe('oc-forge')
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
      title: 'Open web dashboard',
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

    expect(fake.rpcSubscriptions.map((subscription) => subscription.name)).toEqual([
      'toast',
      'sessionDelete',
      'loopsChanged',
      'autoApproveChanged',
      'hostSandboxChanged',
    ])
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

  test('refetches the sidebar on loopsChanged for the current project only', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.loopSidebar).toHaveBeenCalledTimes(1))

    fake.findRpcSubscription('loopsChanged')?.handler({ data: { projectId: 'proj-2' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.loopSidebar).toHaveBeenCalledTimes(1)

    fake.findRpcSubscription('loopsChanged')?.handler({ data: { projectId: 'proj-1' } })
    await vi.waitFor(() => expect(fake.loopSidebar).toHaveBeenCalledTimes(2))
    cleanup()
  })

  test('starts no recurring timers for the sidebar', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)

    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    cleanup()
  })

  test('refetches auto-approve on autoApproveChanged and session change', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.version).toHaveBeenCalledTimes(1))
    expect(fake.autoApproveState).toHaveBeenCalledTimes(0)

    fake.findRpcSubscription('autoApproveChanged')?.handler({ data: { projectId: 'proj-2', sessionId: 'ses_other' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.autoApproveState).toHaveBeenCalledTimes(0)

    fake.setRoute({ type: 'session', sessionID: 'ses_1' })
    await vi.waitFor(() => expect(fake.autoApproveState).toHaveBeenCalledTimes(1))

    fake.findRpcSubscription('autoApproveChanged')?.handler({ data: { projectId: 'proj-1', sessionId: 'ses_child' } })
    await vi.waitFor(() => expect(fake.autoApproveState).toHaveBeenCalledTimes(2))
    cleanup()
  })

  test('refetches host sandbox on hostSandboxChanged and loopsChanged', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.hostSandboxState).toHaveBeenCalledTimes(1))

    fake.findRpcSubscription('hostSandboxChanged')?.handler({ data: { projectId: 'proj-1' } })
    await vi.waitFor(() => expect(fake.hostSandboxState).toHaveBeenCalledTimes(2))

    fake.findRpcSubscription('loopsChanged')?.handler({ data: { projectId: 'proj-1' } })
    await vi.waitFor(() => expect(fake.hostSandboxState).toHaveBeenCalledTimes(3))
    cleanup()
  })

  test('refetches every state on server.connected', async () => {
    const fake = createFakeV2TuiContext({ route: { type: 'session', sessionID: 'ses_1' } })

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.loopSidebar).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(fake.autoApproveState).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(fake.hostSandboxState).toHaveBeenCalledTimes(1))

    fake.emit('server.connected', {})
    await vi.waitFor(() => expect(fake.loopSidebar).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(fake.autoApproveState).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(fake.hostSandboxState).toHaveBeenCalledTimes(2))
    cleanup()
  })

  test('warns once when the server version differs from the TUI', async () => {
    const fake = createFakeV2TuiContext({ version: { version: '0.0.1' } })

    const cleanup = setupForgeTuiV2(fake.ctx)

    await vi.waitFor(() => expect(fake.toasts).toEqual([{
      message: `Forge server plugin 0.0.1 differs from TUI ${VERSION}; restart the OpenCode server`,
      variant: 'warning',
      duration: 10_000,
    }]))
    cleanup()
  })

  test('warns when the server has no version method', async () => {
    const fake = createFakeV2TuiContext({ version: { error: 'method not found' } })

    const cleanup = setupForgeTuiV2(fake.ctx)

    await vi.waitFor(() => expect(fake.toasts).toEqual([{
      message: `Forge server plugin unknown (older than this TUI) differs from TUI ${VERSION}; restart the OpenCode server`,
      variant: 'warning',
      duration: 10_000,
    }]))
    cleanup()
  })

  test('does not warn when the server version matches the TUI', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.version).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.toasts).toEqual([])
    cleanup()
  })

  test('registers one execute-plan command that also covers pasting and restarting', () => {
    const fake = createFakeV2TuiContext({ options: { keybinds: { executePlan: '<leader>x' } } })

    const cleanup = setupForgeTuiV2(fake.ctx)

    for (const id of ['forge.plan.execute', 'forge.sandbox.toggleHost', 'forge.sandbox.buildImage']) {
      expect(findCommand(fake, id)).toMatchObject({ group: 'Forge', palette: true })
    }
    expect(() => findCommand(fake, 'forge.plan.executePasted')).toThrow()
    expect(() => findCommand(fake, 'forge.loop.restart')).toThrow()
    expect(findCommand(fake, 'forge.plan.execute').bind).toBe('<leader>x')
    cleanup()
  })

  test('execute plan without a session falls back to restart and asks for a session when nothing is restartable', async () => {
    const fake = createFakeV2TuiContext()

    const cleanup = setupForgeTuiV2(fake.ctx)
    await findCommand(fake, 'forge.plan.execute').run?.()

    await vi.waitFor(() => expect(fake.toasts).toContainEqual(expect.objectContaining({ message: 'Open a session to execute a plan' })))
    cleanup()
  })

  test('execute plan opens the dialog without prompting when the session has no stored plan', async () => {
    const fake = createFakeV2TuiContext({ route: { type: 'session', sessionID: 'ses_architect' } })

    const cleanup = setupForgeTuiV2(fake.ctx)
    findCommand(fake, 'forge.plan.execute').run?.()

    const dialog = (fake.ctx.ui as unknown as { dialog: { show: ReturnType<typeof vi.fn> } }).dialog
    await vi.waitFor(() => expect(dialog.show).toHaveBeenCalledTimes(1))
    expect(fake.prompts).toEqual([])
    cleanup()
  })

  test('follows a loop rotation inside the viewed worktree, but not subagents or non-loop sessions', async () => {
    const worktree = join(forgeWorktreesRoot(resolveForgeDataDir()), 'loop-a')
    const fake = createFakeV2TuiContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: worktree } }],
    })

    const cleanup = setupForgeTuiV2(fake.ctx)
    fake.emit('session.created', { sessionID: 'ses_task', parentID: 'ses_code', location: { directory: worktree } })
    fake.emit('session.created', { sessionID: 'ses_other', location: { directory: '/test/project' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.navigations).toEqual([])

    fake.emit('session.created', { sessionID: 'ses_audit', location: { directory: worktree } })
    await vi.waitFor(() => expect(fake.navigations).toEqual([{ type: 'session', sessionID: 'ses_audit' }]))

    cleanup()
    expect(fake.dataHandlers.get('session.created')).toEqual([])
  })

  test('shares one worktrees lookup between startup cleanup and session follow', async () => {
    const worktree = join(forgeWorktreesRoot(resolveForgeDataDir()), 'loop-a')
    const fake = createFakeV2TuiContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: worktree } }],
    })

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.worktrees).toHaveBeenCalledTimes(1))

    fake.emit('session.created', { sessionID: 'ses_audit', location: { directory: worktree } })
    await vi.waitFor(() => expect(fake.navigations).toEqual([{ type: 'session', sessionID: 'ses_audit' }]))
    expect(fake.worktrees).toHaveBeenCalledTimes(1)

    cleanup()
  })

  test('negative-caches a failed worktrees lookup within the retry window', async () => {
    const worktree = join(forgeWorktreesRoot(resolveForgeDataDir()), 'loop-a')
    const fake = createFakeV2TuiContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: worktree } }],
    })
    fake.worktrees.mockResolvedValue({ error: 'rpc down' })

    const cleanup = setupForgeTuiV2(fake.ctx)
    await vi.waitFor(() => expect(fake.worktrees).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    fake.emit('session.created', { sessionID: 'ses_audit', location: { directory: worktree } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.worktrees).toHaveBeenCalledTimes(1)
    expect(fake.navigations).toEqual([])

    cleanup()
  })

  test('re-fetches worktrees fresh before deleting an orphaned session', async () => {
    const root = forgeWorktreesRoot(resolveForgeDataDir())
    const spawned = join(root, 'spawned-loop')
    const fake = createFakeV2TuiContext()
    fake.sessionList.mockResolvedValue({ data: [{ id: 'ses_spawned', location: { directory: spawned } }], cursor: {} })
    fake.worktrees
      .mockResolvedValueOnce({ root, dirs: [] })
      .mockResolvedValue({ root, dirs: [spawned] })

    const cleanup = setupForgeTuiV2(fake.ctx)

    await vi.waitFor(() => expect(fake.worktrees).toHaveBeenCalledTimes(2))
    expect(fake.sessionRemove).not.toHaveBeenCalled()
    cleanup()
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
      keybinds: { executePlan: '<leader>f', dashboard: '', toggleHostSandbox: '', toggleAutoApprove: '' },
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
    expect(opts.keybinds).toEqual({ executePlan: '<leader>f', dashboard: '', toggleHostSandbox: '', toggleAutoApprove: '' })
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
      toggleAutoApprove: '',
    })
  })
})

describe('formatForgeTitle', () => {
  test('includes the version only when requested', () => {
    expect(formatForgeTitle(true)).toBe(`Forge v${VERSION}`)
    expect(formatForgeTitle(false)).toBe('Forge')
  })
})
