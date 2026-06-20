import { describe, it, expect } from 'vitest'
import {
  classifyWorkspaceCreateThrow,
  workspaceCreateMissingId,
  workspaceCreateEmptyDirectory,
  EXPERIMENTAL_WORKSPACES_HINT,
} from '../../src/workspace/workspace-create-error'

describe('classifyWorkspaceCreateThrow', () => {
  it('detects experimental-workspaces-disabled from "experimental workspace API not enabled"', () => {
    const err = new Error('experimental workspace API not enabled')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
    expect(result.message).toBe(EXPERIMENTAL_WORKSPACES_HINT)
    expect(result.cause).toBe('experimental workspace API not enabled')
  })

  it('detects experimental-workspaces-disabled from "workspace.create not enabled"', () => {
    const err = new Error('workspace.create not enabled')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
    expect(result.message).toBe(EXPERIMENTAL_WORKSPACES_HINT)
  })

  it('detects experimental-workspaces-disabled from "not enabled" message', () => {
    const err = new Error('feature not enabled')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })

  it('detects experimental-workspaces-disabled from "disabled" message', () => {
    const err = new Error('the workspace adapter is disabled')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })

  it('treats empty string as experimental-workspaces-disabled', () => {
    const err = new Error('')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
    // Empty string is falsy; classifier normalises it to undefined cause
    expect(result.cause).toBeUndefined()
  })

  it('treats undefined as experimental-workspaces-disabled', () => {
    const result = classifyWorkspaceCreateThrow(undefined)
    expect(result.reason).toBe('experimental-workspaces-disabled')
    // String(undefined) is "undefined"
    expect(result.cause).toBe('undefined')
  })

  it('treats null as experimental-workspaces-disabled', () => {
    const result = classifyWorkspaceCreateThrow(null)
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })

  it('treats "unknown method" with "workspace" as experimental-workspaces-disabled', () => {
    const err = new Error('unknown method: workspace.create')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })

  it('treats "not found" with "workspace" as experimental-workspaces-disabled', () => {
    const err = new Error('workspace adapter not found')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })

  it('returns unknown for clearly unrelated non-empty error', () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:4096')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('unknown')
    expect(result.message).toContain('ECONNREFUSED')
    expect(result.cause).toContain('ECONNREFUSED')
  })

  it('returns unknown for clearly unrelated long error', () => {
    const err = new Error('socket hang up')
    const result = classifyWorkspaceCreateThrow(err)
    expect(result.reason).toBe('unknown')
    expect(result.message).toContain('socket hang up')
  })

  it('handles string errors (not Error instances)', () => {
    const result = classifyWorkspaceCreateThrow('something broke')
    expect(result.reason).toBe('unknown')
    expect(result.message).toContain('something broke')
  })

  it('handles "undefined" string as experimental-workspaces-disabled', () => {
    const result = classifyWorkspaceCreateThrow('undefined')
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })

  it('handles "null" string as experimental-workspaces-disabled', () => {
    const result = classifyWorkspaceCreateThrow('null')
    expect(result.reason).toBe('experimental-workspaces-disabled')
  })
})

describe('workspaceCreateMissingId', () => {
  it('returns no-workspace-id with hint', () => {
    const result = workspaceCreateMissingId({})
    expect(result.reason).toBe('no-workspace-id')
    expect(result.message).toContain('OPENCODE_EXPERIMENTAL_WORKSPACES')
    expect(result.message).toContain('1.17.8')
    expect(result.cause).toContain('{}')
  })

  it('includes raw data in cause', () => {
    const raw = { directory: '/tmp/x', branch: 'b' }
    const result = workspaceCreateMissingId(raw)
    expect(result.reason).toBe('no-workspace-id')
    expect(result.cause).toContain('directory')
    expect(result.cause).toContain('/tmp/x')
  })

  it('truncates very large cause', () => {
    const raw = { data: 'x'.repeat(1000) }
    const result = workspaceCreateMissingId(raw)
    expect(result.cause!.length).toBeLessThanOrEqual(310) // 300 + '…'
  })
})

describe('workspaceCreateEmptyDirectory', () => {
  it('returns empty-directory without the export hint', () => {
    const result = workspaceCreateEmptyDirectory({ id: 'ws-1' })
    expect(result.reason).toBe('empty-directory')
    expect(result.message).not.toContain('OPENCODE_EXPERIMENTAL_WORKSPACES')
    expect(result.message).not.toContain('export')
  })

  it('includes raw data in cause', () => {
    const raw = { id: 'ws-1', directory: '', branch: 'b' }
    const result = workspaceCreateEmptyDirectory(raw)
    expect(result.cause).toContain('ws-1')
    expect(result.cause).toContain('directory')
  })
})
