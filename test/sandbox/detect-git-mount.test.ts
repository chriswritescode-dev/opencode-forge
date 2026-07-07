import { describe, it, expect, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createFakeGitService } from '../helpers/fake-git'
import type { DockerService } from '../../src/sandbox/docker'
import type { Logger } from '../../src/types'

describe('detectGitMount', () => {
  function createMockDocker(): DockerService {
    return {
      checkDocker: vi.fn(async () => true),
      imageExists: vi.fn(async () => true),
      containerName: vi.fn((worktreeName: string) => `forge-${worktreeName}`),
      isRunning: vi.fn(async () => false),
      createContainer: vi.fn(async () => {}),
      removeContainer: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      execPipe: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      buildImage: vi.fn(async () => {}),
      listContainersByPrefix: vi.fn(async () => []),
    }
  }

  function createMockLogger(): Logger {
    return {
      log: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
  }

  it('mounts external git dirs when rev-parse returns out-of-tree paths', async () => {
    const mockDocker = createMockDocker()
    const mockLogger = createMockLogger()
    const fakeGit = createFakeGitService({
      revParseGitDir: vi.fn(() => ({ ok: true, status: 0, stdout: '/external/repo/.git', stderr: '' })),
      revParseGitCommonDir: vi.fn(() => ({ ok: true, status: 0, stdout: '/external/repo/.git', stderr: '' })),
    })

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker, config, mockLogger, fakeGit)

    await manager.start('test', '/some/project')

    const createMock = mockDocker.createContainer as ReturnType<typeof vi.fn>
    const calls = createMock.mock.calls
    expect(calls.length).toBe(1)
    const extraMounts = (calls[0][3] as { extraMounts?: string[] } | undefined)?.extraMounts ?? []
    expect(extraMounts).toContain('/external/repo/.git:/external/repo/.git')
  })

  it('returns no git mount when rev-parse fails', async () => {
    const mockDocker = createMockDocker()
    const mockLogger = createMockLogger()
    const fakeGit = createFakeGitService({
      revParseGitDir: vi.fn(() => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository' })),
      revParseGitCommonDir: vi.fn(() => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository' })),
    })

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker, config, mockLogger, fakeGit)

    await manager.start('test', '/some/project')

    const createMock = mockDocker.createContainer as ReturnType<typeof vi.fn>
    const calls = createMock.mock.calls
    expect(calls.length).toBe(1)
    const extraMounts = (calls[0][3] as { extraMounts?: string[] } | undefined)?.extraMounts ?? []
    // No git mount should be present — only the identical-path worktree mount remains
    expect(extraMounts).toEqual(['/some/project:/some/project'])
  })
})
