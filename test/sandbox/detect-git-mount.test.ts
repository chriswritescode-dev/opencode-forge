import { describe, it, expect, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createFakeGitService } from '../helpers/fake-git'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'

describe('detectGitMount', () => {
  it('mounts external git dirs when rev-parse returns out-of-tree paths', async () => {
    const mockRuntime = createMockSandboxRuntime()
    const mockLogger = createMockLogger()
    const fakeGit = createFakeGitService({
      revParseGitDir: vi.fn(() => ({ ok: true, status: 0, stdout: '/external/repo/.git', stderr: '' })),
      revParseGitCommonDir: vi.fn(() => ({ ok: true, status: 0, stdout: '/external/repo/.git', stderr: '' })),
    })

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger, fakeGit)

    await manager.start('test', '/some/project')

    const calls = mockRuntime.getCreateSandboxCalls()
    expect(calls.length).toBe(1)
    const workspaces = calls[0][1]
    expect(workspaces.some((w) => w.hostDir === '/external/repo/.git')).toBe(true)
    expect(workspaces.find((w) => w.hostDir === '/external/repo/.git')?.readOnly).not.toBe(true)
  })

  it('returns no git mount when rev-parse fails', async () => {
    const mockRuntime = createMockSandboxRuntime()
    const mockLogger = createMockLogger()
    const fakeGit = createFakeGitService({
      revParseGitDir: vi.fn(() => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository' })),
      revParseGitCommonDir: vi.fn(() => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository' })),
    })

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger, fakeGit)

    await manager.start('test', '/some/project')

    const calls = mockRuntime.getCreateSandboxCalls()
    expect(calls.length).toBe(1)
    // No git mount should be present — only the identical-path worktree workspace remains
    expect(calls[0][1]).toEqual([{ hostDir: '/some/project', readOnly: undefined }])
  })
})
