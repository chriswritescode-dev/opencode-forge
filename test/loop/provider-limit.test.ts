import { describe, it, expect } from 'vitest'
import { classifyProviderLimit, extractErrorSignal } from '../../src/loop/provider-limit'

describe('classifyProviderLimit', () => {
  describe('matches — provider usage limit', () => {
    it('matches "You have hit your usage limit..."', () => {
      const result = classifyProviderLimit({ message: 'You have hit your usage limit...' })
      expect(result).not.toBeNull()
      expect(result).toContain('You have hit your usage limit...')
    })

    it('matches "5-hour usage limit reached"', () => {
      const result = classifyProviderLimit({ message: '5-hour usage limit reached' })
      expect(result).not.toBeNull()
      expect(result).toContain('5-hour usage limit reached')
    })

    it('matches "monthly quota exceeded"', () => {
      const result = classifyProviderLimit({ message: 'monthly quota exceeded' })
      expect(result).not.toBeNull()
      expect(result).toContain('monthly quota exceeded')
    })

    it('matches case-insensitively', () => {
      const result = classifyProviderLimit({ message: 'USAGE LIMIT' })
      expect(result).not.toBeNull()
      expect(result).toContain('USAGE LIMIT')
    })
  })

  describe('matches — 403 status', () => {
    it('matches statusCode 403 with message', () => {
      const result = classifyProviderLimit({ statusCode: 403, message: 'forbidden' })
      expect(result).not.toBeNull()
      expect(result).toContain('forbidden')
    })

    it('matches statusCode 403 without message', () => {
      const result = classifyProviderLimit({ statusCode: 403 })
      expect(result).not.toBeNull()
      expect(result).toContain('403')
    })
  })

  describe('matches — ProviderAuthError', () => {
    it('matches ProviderAuthError with message', () => {
      const result = classifyProviderLimit({ name: 'ProviderAuthError', message: 'invalid api key' })
      expect(result).not.toBeNull()
      expect(result).toContain('invalid api key')
    })

    it('matches ProviderAuthError without message', () => {
      const result = classifyProviderLimit({ name: 'ProviderAuthError' })
      expect(result).not.toBeNull()
      expect(result).toContain('unknown')
    })
  })

  describe('non-matches', () => {
    it('returns null for overloaded_error', () => {
      expect(classifyProviderLimit({ message: 'overloaded_error' })).toBeNull()
    })

    it('returns null for 429 rate limit', () => {
      expect(classifyProviderLimit({ statusCode: 429, message: 'rate limited, retrying' })).toBeNull()
    })

    it('returns null for APIError with 500', () => {
      expect(classifyProviderLimit({ name: 'APIError', message: 'internal server error', statusCode: 500 })).toBeNull()
    })

    it('returns null for empty object', () => {
      expect(classifyProviderLimit({})).toBeNull()
    })
  })
})

describe('extractErrorSignal', () => {
  it('returns message for plain string error', () => {
    const signal = extractErrorSignal('something went wrong')
    expect(signal.message).toBe('something went wrong')
  })

  it('returns message for Error instance', () => {
    const signal = extractErrorSignal(new Error('quota exceeded'))
    expect(signal.message).toBe('quota exceeded')
  })

  it('extracts from ForgeClientError-like with cause containing provider auth error', () => {
    const forgeError = Object.assign(new Error('auth failed'), {
      name: 'ForgeClientError',
      cause: {
        name: 'ProviderAuthError',
        message: 'Invalid API key',
        data: { message: 'Invalid API key', statusCode: 403 },
      },
    })
    const signal = extractErrorSignal(forgeError)
    expect(signal.name).toBe('ProviderAuthError')
    expect(signal.message).toBe('Invalid API key')
    expect(signal.statusCode).toBe(403)
  })

  it('extracts from ForgeClientError-like with cause containing 403', () => {
    const forgeError = Object.assign(new Error('forbidden'), {
      name: 'ForgeClientError',
      cause: {
        data: { message: 'Forbidden', statusCode: 403 },
      },
    })
    const signal = extractErrorSignal(forgeError)
    expect(signal.statusCode).toBe(403)
    expect(signal.message).toBe('Forbidden')
  })

  it('falls back to direct properties when cause is absent', () => {
    const error = Object.assign(new Error('usage limit'), {
      name: 'SomeError',
      data: { message: 'usage limit reached', statusCode: 429 },
    })
    const signal = extractErrorSignal(error)
    expect(signal.name).toBe('SomeError')
    // Error.message is used when both obj.message and data.message exist;
    // the former wins because it's checked first.
    expect(signal.message).toBe('usage limit')
    expect(signal.statusCode).toBe(429)
  })

  it('handles null/undefined gracefully', () => {
    expect(extractErrorSignal(null).message).toBeUndefined()
    expect(extractErrorSignal(undefined).message).toBeUndefined()
  })

  it('extracts from cause with data but no statusCode', () => {
    const forgeError = Object.assign(new Error('provider error'), {
      name: 'ForgeClientError',
      cause: {
        data: { message: 'quota exceeded' },
      },
    })
    const signal = extractErrorSignal(forgeError)
    expect(signal.message).toBe('quota exceeded')
    expect(signal.statusCode).toBeUndefined()
  })
})