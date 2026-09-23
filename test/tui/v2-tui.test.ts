import { describe, test, expect, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { resolveV2TuiProjectId, setupForgeTuiV2 } from '../../src/tui/v2'
import tuiModule from '../../src/tui'
import { useTempConfigHome } from '../helpers/temp-config'

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
}

function createFakeV2TuiContext(fakeOptions: FakeV2TuiOptions = {}) {
  const layers: RecordedLayer[] = []
  const slots: RecordedSlot[] = []
  const toasts: Array<Record<string, unknown>> = []

  const locationGet = vi.fn(
    fakeOptions.locationGet ?? (async () => ({ project: { id: 'proj-1' } })),
  )

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
    },
    client: { location: { get: locationGet } },
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
    },
  } as unknown as Plugin.Context

  return { ctx, layers, slots, toasts, locationGet }
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
