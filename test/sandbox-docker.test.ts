import { describe, test, expect } from 'vitest'
import { createDockerService, buildCreateContainerArgs } from '../src/sandbox/docker'

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
    expect(result).toBe('forge-my-worktree')
  })

  test('containerName handles names with special characters', () => {
    const result = docker.containerName('feature/test-123')
    expect(result).toBe('forge-feature/test-123')
  })

  test('containerName handles empty string', () => {
    const result = docker.containerName('')
    expect(result).toBe('forge-')
  })
})

describe('buildCreateContainerArgs', () => {
  test('returns base args with no opts', () => {
    const args = buildCreateContainerArgs('my-container', '/project', 'my-image')
    expect(args).toEqual([
      'run', '-d', '--name', 'my-container',
      '-v', '/project:/workspace',
      '-w', '/workspace', 'my-image', 'sleep', 'infinity',
    ])
  })

  test('includes resource flags when provided', () => {
    const args = buildCreateContainerArgs('c', '/p', 'img', {
      resources: { memory: '4g', cpus: '2', shmSize: '512m', memorySwap: '8g' },
    })
    expect(args).toContain('--memory')
    expect(args).toContain('4g')
    expect(args).toContain('--memory-swap')
    expect(args).toContain('8g')
    expect(args).toContain('--cpus')
    expect(args).toContain('2')
    expect(args).toContain('--shm-size')
    expect(args).toContain('512m')
  })

  test('includes add-hosts flags', () => {
    const args = buildCreateContainerArgs('c', '/p', 'img', {
      addHosts: ['host.docker.internal:host-gateway', 'other:1.2.3.4'],
    })
    expect(args).toContain('--add-host')
    const addHostIndex = args.indexOf('--add-host')
    expect(args[addHostIndex + 1]).toBe('host.docker.internal:host-gateway')
    expect(args[addHostIndex + 2]).toBe('--add-host')
    expect(args[addHostIndex + 3]).toBe('other:1.2.3.4')
  })

  test('includes env-file flag', () => {
    const args = buildCreateContainerArgs('c', '/p', 'img', {
      envFile: '/tmp/.env',
    })
    expect(args).toContain('--env-file')
    expect(args).toContain('/tmp/.env')
  })

  test('includes user flag', () => {
    const args = buildCreateContainerArgs('c', '/p', 'img', {
      user: '1000:1000',
    })
    expect(args).toContain('--user')
    expect(args).toContain('1000:1000')
  })

  test('includes extra mounts', () => {
    const args = buildCreateContainerArgs('c', '/p', 'img', {
      extraMounts: ['/ext:/ext:ro', '/data:/data'],
    })
    expect(args).toContain('-v')
    const vIndex = args.indexOf('-v', args.indexOf('-v') + 1)
    expect(args[vIndex + 1]).toBe('/ext:/ext:ro')
    expect(args[vIndex + 2]).toBe('-v')
    expect(args[vIndex + 3]).toBe('/data:/data')
  })

  test('combines all opt types together', () => {
    const args = buildCreateContainerArgs('c', '/p', 'img', {
      resources: { memory: '2g', cpus: '1' },
      addHosts: ['host.docker.internal:host-gateway'],
      envFile: '/e/.env',
      user: '1001:1001',
      extraMounts: ['/extra:/extra'],
    })
    const memIdx = args.indexOf('--memory')
    const addHostIdx = args.indexOf('--add-host')
    const envIdx = args.indexOf('--env-file')
    const userIdx = args.indexOf('--user')
    const extraVIdx = args.lastIndexOf('-v')
    const trailerIdx = args.indexOf('-w')

    expect(memIdx).toBeGreaterThan(0)
    expect(addHostIdx).toBeGreaterThan(memIdx)
    expect(envIdx).toBeGreaterThan(addHostIdx)
    expect(userIdx).toBeGreaterThan(envIdx)
    expect(extraVIdx).toBeGreaterThan(userIdx)
    expect(trailerIdx).toBeGreaterThan(extraVIdx)
  })
})
