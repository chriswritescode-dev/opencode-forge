import { describe, it, expect } from 'bun:test'
import { isWorkspaceNotFoundError } from '../src/hooks/loop'

describe('workspace recovery', () => {
  describe('isWorkspaceNotFoundError', () => {
    it('returns true for Error with Workspace not found message', () => {
      const err = new Error('Workspace not found: wrk_x')
      expect(isWorkspaceNotFoundError(err)).toBe(true)
    })

    it('returns true for string message with Workspace not found', () => {
      const msg = 'Workspace not found: wrk_y'
      expect(isWorkspaceNotFoundError(msg)).toBe(true)
    })

    it('returns true for JSON-stringified error data', () => {
      const data = { message: 'Workspace not found' }
      expect(isWorkspaceNotFoundError(data)).toBe(true)
    })

    it('returns false for unrelated errors', () => {
      const err = new Error('Connection timeout')
      expect(isWorkspaceNotFoundError(err)).toBe(false)
    })

    it('handles null/undefined gracefully', () => {
      expect(isWorkspaceNotFoundError(null)).toBe(false)
      expect(isWorkspaceNotFoundError(undefined)).toBe(false)
    })
  })
})
