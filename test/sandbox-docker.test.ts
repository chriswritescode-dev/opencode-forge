import { describe, test, expect } from 'bun:test'
import { createDockerService } from '../src/sandbox/docker'

function createMockLogger() {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('DockerService containerName', () => {
  const logger = createMockLogger()
  const docker = createDockerService(logger)

  test('containerName returns forge-prefixed name', () => {
    const result = docker.containerName('my-worktree')
    expect(result).toBe('oc-forge-sandbox-my-worktree')
  })

  test('containerName handles names with special characters', () => {
    const result = docker.containerName('feature/test-123')
    expect(result).toBe('oc-forge-sandbox-feature/test-123')
  })

  test('containerName handles empty string', () => {
    const result = docker.containerName('')
    expect(result).toBe('oc-forge-sandbox-')
  })
})
