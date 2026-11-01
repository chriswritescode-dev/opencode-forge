import { describe, test, expect } from 'vitest'
import { generateUniqueName } from '../../src/loop/name-uniqueness'

describe('generateUniqueName', () => {
  test('generates unique name when loop collision exists', () => {
    const existingNames = ['api-integration', 'api-integration-1']
    const result = generateUniqueName('api-integration', existingNames)
    expect(result).toBe('api-integration-2')
  })

  test('generates base name when no collision exists', () => {
    const existingNames = ['other-loop', 'different-loop']
    const result = generateUniqueName('new-loop', existingNames)
    expect(result).toBe('new-loop')
  })
})
