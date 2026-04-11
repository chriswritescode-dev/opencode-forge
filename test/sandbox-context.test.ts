import { describe, it, expect } from 'bun:test'
import { getSandboxForSession, isSandboxEnabled } from '../src/sandbox/context'
import type { PluginConfig } from '../src/types'

describe('getSandboxForSession', () => {
  const mockDocker = {} as any
  const mockLoopService = {
    resolveWorktreeName: (sessionId: string) => sessionId === 'valid-session' ? 'test-worktree' : null,
    getActiveState: (name: string) => name === 'test-worktree' ? { active: true, sandbox: true, worktreeDir: '/test' } : null,
  } as any

  it('returns null when sandboxManager is null', () => {
    const result = getSandboxForSession(
      { sandboxManager: null, loopService: mockLoopService },
      'valid-session'
    )
    expect(result).toBeNull()
  })

  it('returns null when worktreeName not found', () => {
    const mockSandboxManager = { docker: mockDocker, getActive: () => null } as any
    const result = getSandboxForSession(
      { sandboxManager: mockSandboxManager, loopService: { ...mockLoopService, resolveWorktreeName: () => null } },
      'invalid-session'
    )
    expect(result).toBeNull()
  })

  it('returns null when state is not active', () => {
    const mockSandboxManager = { docker: mockDocker, getActive: () => null } as any
    const result = getSandboxForSession(
      { sandboxManager: mockSandboxManager, loopService: { ...mockLoopService, getActiveState: () => ({ active: false, sandbox: true }) } },
      'valid-session'
    )
    expect(result).toBeNull()
  })

  it('returns null when sandbox is false', () => {
    const mockSandboxManager = { docker: mockDocker, getActive: () => null } as any
    const result = getSandboxForSession(
      { sandboxManager: mockSandboxManager, loopService: { ...mockLoopService, getActiveState: () => ({ active: true, sandbox: false }) } },
      'valid-session'
    )
    expect(result).toBeNull()
  })

  it('returns context when all conditions met', () => {
    const mockSandboxManager = {
      docker: mockDocker,
      getActive: (name: string) => name === 'test-worktree' ? { containerName: 'test-container', projectDir: '/test/project' } : null,
    } as any
    const result = getSandboxForSession(
      { sandboxManager: mockSandboxManager, loopService: mockLoopService },
      'valid-session'
    )
    expect(result).toEqual({
      docker: mockDocker,
      containerName: 'test-container',
      hostDir: '/test/project',
    })
  })
})

describe('isSandboxEnabled', () => {
  it('returns false when mode is off', () => {
    const config = { sandbox: { mode: 'off' as const } } as PluginConfig
    expect(isSandboxEnabled(config, {})).toBe(false)
  })

  it('returns false when sandboxManager is null', () => {
    const config = { sandbox: { mode: 'docker' as const } } as PluginConfig
    expect(isSandboxEnabled(config, null)).toBe(false)
  })

  it('returns true when mode is docker and manager exists', () => {
    const config = { sandbox: { mode: 'docker' as const } } as PluginConfig
    expect(isSandboxEnabled(config, {})).toBe(true)
  })
})
