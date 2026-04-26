import { describe, test, expect } from 'bun:test'
import { buildOpencodeBasicAuthHeader, sanitizeServerUrl, createOpencodeClientFromServer } from '../src/utils/opencode-client'

describe('opencode-client helpers', () => {
  describe('sanitizeServerUrl', () => {
    test('extracts password from URL with credentials', () => {
      const result = sanitizeServerUrl('http://opencode:secret@example.com:4096')
      expect(result.baseUrl).toBe('http://example.com:4096/')
      expect(result.password).toBe('secret')
    })

    test('returns undefined password when URL has no credentials', () => {
      const result = sanitizeServerUrl('http://example.com:4096')
      expect(result.baseUrl).toBe('http://example.com:4096/')
      expect(result.password).toBeUndefined()
    })

    test('strips both username and password from base URL', () => {
      const result = sanitizeServerUrl('https://user:pass@secure.example.com:8080/path')
      expect(result.baseUrl).toBe('https://secure.example.com:8080/path')
      expect(result.password).toBe('pass')
    })
  })

  describe('buildOpencodeBasicAuthHeader', () => {
    test('builds Basic auth header for opencode user', () => {
      const header = buildOpencodeBasicAuthHeader('secret')
      expect(header).toBe('Basic ' + Buffer.from('opencode:secret').toString('base64'))
    })

    test('produces correct base64 encoding', () => {
      const header = buildOpencodeBasicAuthHeader('test123')
      const expected = 'Basic ' + Buffer.from('opencode:test123').toString('base64')
      expect(header).toBe(expected)
    })
  })

  describe('createOpencodeClientFromServer', () => {
    test('accepts URL without embedded password', () => {
      const originalPassword = process.env.OPENCODE_SERVER_PASSWORD
      process.env.OPENCODE_SERVER_PASSWORD = 'env-secret'

      expect(() => {
        createOpencodeClientFromServer({
          serverUrl: 'http://example.com:4096',
          directory: '/test',
        })
      }).not.toThrow()

      if (originalPassword === undefined) {
        delete process.env.OPENCODE_SERVER_PASSWORD
      } else {
        process.env.OPENCODE_SERVER_PASSWORD = originalPassword
      }
    })

    test('uses passwordEnv when provided', () => {
      expect(() => {
        createOpencodeClientFromServer({
          serverUrl: 'http://example.com:4096',
          directory: '/test',
          passwordEnv: 'custom-secret',
        })
      }).not.toThrow()
    })

    test('URL password takes priority over passwordEnv and env var', () => {
      const originalPassword = process.env.OPENCODE_SERVER_PASSWORD
      process.env.OPENCODE_SERVER_PASSWORD = 'env-secret'

      const result = sanitizeServerUrl('http://opencode:url-secret@example.com:4096')
      expect(result.password).toBe('url-secret')

      if (originalPassword === undefined) {
        delete process.env.OPENCODE_SERVER_PASSWORD
      } else {
        process.env.OPENCODE_SERVER_PASSWORD = originalPassword
      }
    })
  })
})
