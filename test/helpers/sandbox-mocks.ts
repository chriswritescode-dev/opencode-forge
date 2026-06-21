import { vi } from 'vitest'

/**
 * Creates a mock DockerService for sandbox tests.
 * Tracks createContainer calls and maintains a running-containers set.
 */
export function createMockDockerService() {
  const createContainerCalls: Array<[string, string, string, Record<string, unknown> | undefined]> = []
  let runningContainers = new Set<string>()

  const mock = {
    checkDocker: async () => true,
    imageExists: async () => true,
    buildImage: async () => {},
    createContainer: async (name: string, projectDir: string, image: string, opts?: Record<string, unknown>) => {
      createContainerCalls.push([name, projectDir, image, opts])
      runningContainers.add(name)
    },
    removeContainer: async () => {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execPipe: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    isRunning: async (name: string) => runningContainers.has(name),
    containerName: (worktreeName: string) => `forge-${worktreeName}`,
    listContainersByPrefix: async () => [],
    getCreateContainerCalls: () => createContainerCalls,
    setRunning: (name: string, running: boolean) => {
      if (running) runningContainers.add(name); else runningContainers.delete(name)
    },
  }
  return mock
}

/**
 * Creates a mock Logger for sandbox tests.
 * Returns vi.fn() spies (structurally a Logger) so callers can both use it as a
 * no-op logger and assert on calls (e.g. `logger.log.mock.calls`).
 */
export function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}
