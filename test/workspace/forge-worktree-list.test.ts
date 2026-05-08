import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createForgeWorktreeAdaptor, type ForgeWorktreeListEntry } from '../../src/workspace/forge-worktree'
import type { WorkspaceInfo } from '@opencode-ai/plugin'

function makeEntry(overrides: Partial<ForgeWorktreeListEntry>): ForgeWorktreeListEntry {
  return {
    id: overrides.id ?? 'ws-1',
    name: overrides.name ?? 'loop-1',
    branch: overrides.branch ?? null,
    directory: overrides.directory ?? '/tmp/wt',
    extra: overrides.extra ?? { loopName: 'loop-1', directory: '/tmp/wt', branch: null },
  }
}

describe('createForgeWorktreeAdaptor', () => {
  describe('configure', () => {
    it('normalizes name from extra.loopName', async () => {
      const adaptor = createForgeWorktreeAdaptor()
      const info: WorkspaceInfo = {
        id: 'ws-1',
        type: 'forge-worktree',
        name: 'unknown',
        branch: null,
        directory: '/tmp/wt',
        extra: JSON.stringify({ loopName: 'my-loop', directory: '/tmp/wt', branch: 'feat/x' }),
        projectID: 'proj-1',
      }
      const result = await adaptor.configure(info)
      expect(result.name).toBe('my-loop')
      expect(result.directory).toBe('/tmp/wt')
      expect(result.branch).toBe('feat/x')
    })

    it('falls back to info.name when extra has no loopName', async () => {
      const adaptor = createForgeWorktreeAdaptor()
      const info: WorkspaceInfo = {
        id: 'ws-1',
        type: 'forge-worktree',
        name: 'fallback-name',
        branch: null,
        directory: '/tmp/wt',
        extra: null,
        projectID: 'proj-1',
      }
      const result = await adaptor.configure(info)
      expect(result.name).toBe('fallback-name')
    })
  })

  describe('list', () => {
    it('happy path returns two entries from resolver', async () => {
      const entries: ForgeWorktreeListEntry[] = [
        makeEntry({ id: 'ws-a', name: 'loop-a', branch: 'feat/a', directory: '/wt/a' }),
        makeEntry({ id: 'ws-b', name: 'loop-b', branch: null, directory: '/wt/b' }),
      ]
      const resolver = vi.fn().mockResolvedValue(entries)
      const adaptor = createForgeWorktreeAdaptor({ listResolver: resolver })

      const result = await adaptor.list?.({ projectID: 'proj-1' })
      expect(result).toHaveLength(2)
      expect(result![0].id).toBe('ws-a')
      expect(result![0].name).toBe('loop-a')
      expect(result![0].directory).toBe('/wt/a')
      expect(result![0].type).toBe('forge-worktree')
      expect(result![1].id).toBe('ws-b')
      expect(resolver).toHaveBeenCalledWith('proj-1')
    })

    it('empty resolver returns []', async () => {
      const resolver = vi.fn().mockResolvedValue([])
      const adaptor = createForgeWorktreeAdaptor({ listResolver: resolver })

      const result = await adaptor.list?.({ projectID: 'proj-1' })
      expect(result).toEqual([])
    })

    it('no resolver returns undefined for list', async () => {
      const adaptor = createForgeWorktreeAdaptor()

      expect(adaptor.list).toBeUndefined()
    })
  })
})
