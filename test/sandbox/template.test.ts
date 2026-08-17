import { describe, test, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAndLoadSandboxTemplate, buildTemplateDockerArgs, CONCURRENT_BUILD_MESSAGE, formatTemplateBuildCommands, parseDockerBuildStep } from '../../src/sandbox/template'
import type { BuildTemplateDeps, SandboxBuildProgress } from '../../src/sandbox/template'
import type { Logger } from '../../src/types'

const logger: Logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

test('sandbox image keeps the pnpm store outside mounted projects', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('PNPM_CONFIG_STORE_DIR=/opt/forge/.local/share/pnpm/store')
  expect(dockerfile).not.toContain('npm_config_store_dir=')
})

function leftoverTars(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('forge-sandbox-template-') && f.endsWith('.tar'))
}

function makeFakeRun(
  record: Array<{ command: string; args: string[] }>,
  result?: { exitCode?: number; stdout?: string; stderr?: string },
): BuildTemplateDeps['runCommand'] {
  return async (command: string, args: string[]) => {
    record.push({ command, args })
    if (command === 'docker' && args[0] === 'save') {
      const outIdx = args.indexOf('-o')
      if (outIdx !== -1) writeFileSync(args[outIdx + 1], 'fake-tar')
    }
    return {
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
      exitCode: result?.exitCode ?? 0,
    }
  }
}

describe('buildAndLoadSandboxTemplate', () => {
  test('builds, saves, loads, and leaves no tar on disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const loadTemplate = vi.fn(async (_tar: string) => {})
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record),
        loadTemplate,
        logger,
        tmpDir: tmp,
      }

      await buildAndLoadSandboxTemplate('/ctx', 'oc-forge-sandbox:latest', deps)

      expect(record.map((r) => r.command)).toEqual(['docker', 'docker'])
      expect(record[0].args).toEqual(['build', '--progress=plain', '-t', 'oc-forge-sandbox:latest', '/ctx'])
      expect(record[1].args[0]).toBe('save')
      expect(loadTemplate).toHaveBeenCalledTimes(1)
      expect(loadTemplate.mock.calls[0][0]).toMatch(/forge-sandbox-template-\d+\.tar$/)
      expect(loadTemplate.mock.calls[0][1]).toBe('oc-forge-sandbox:latest')
      expect(leftoverTars(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('opt-in browserControl adds the build arg to docker build', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const loadTemplate = vi.fn(async () => {})
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record),
        loadTemplate,
        logger,
        tmpDir: tmp,
      }

      await buildAndLoadSandboxTemplate('/ctx', 'oc-forge-sandbox:latest', deps, { browserControl: true })

      expect(record[0].args).toEqual([
        'build',
        '--progress=plain',
        '--build-arg',
        'INSTALL_BROWSER_CONTROL=true',
        '-t',
        'oc-forge-sandbox:latest',
        '/ctx',
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('a failing build rejects with the last output line and never calls loadTemplate', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const loadTemplate = vi.fn(async () => {})
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record, { exitCode: 1, stderr: 'first line\nerror detail' }),
        loadTemplate,
        logger,
        tmpDir: tmp,
      }

      await expect(buildAndLoadSandboxTemplate('/ctx', 't', deps)).rejects.toThrow(/error detail/)
      expect(loadTemplate).not.toHaveBeenCalled()
      expect(leftoverTars(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('a spawn docker ENOENT output rejects with the Docker-CLI message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const loadTemplate = vi.fn(async () => {})
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record, { exitCode: 1, stderr: 'spawn docker ENOENT' }),
        loadTemplate,
        logger,
        tmpDir: tmp,
      }

      await expect(buildAndLoadSandboxTemplate('/ctx', 't', deps)).rejects.toThrow(
        /Docker CLI not found\. Building the sandbox template requires Docker; the msb runtime itself does not\./,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('a timed-out build rejects with the timed-out message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record, { exitCode: 124 }),
        loadTemplate: vi.fn(async () => {}),
        logger,
        tmpDir: tmp,
      }

      await expect(buildAndLoadSandboxTemplate('/ctx', 't', deps)).rejects.toThrow(
        /Docker build timed out after 600 seconds\./,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('a failing loadTemplate still removes the tar', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record),
        loadTemplate: vi.fn(async () => { throw new Error('load boom') }),
        logger,
        tmpDir: tmp,
      }

      await expect(buildAndLoadSandboxTemplate('/ctx', 't', deps)).rejects.toThrow(/load boom/)
      expect(leftoverTars(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('build progress reporting', () => {
  test('reports docker build steps, carries split lines, and marks the save and load stages', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const events: SandboxBuildProgress[] = []
      const deps: BuildTemplateDeps = {
        runCommand: async (command: string, args: string[], opts) => {
          if (args[0] === 'build') {
            opts.onOutput?.('#1 [internal] load build definition\n#7 [ 2/22] RUN apt-ge')
            opts.onOutput?.('t update\n#7 0.512 Get:1 http://archive\n')
          }
          if (args[0] === 'save') writeFileSync(args[args.indexOf('-o') + 1], 'fake-tar')
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        loadTemplate: vi.fn(async () => {}),
        logger,
        tmpDir: tmp,
        onProgress: (progress) => events.push(progress),
      }

      await buildAndLoadSandboxTemplate('/ctx', 'tag:1', deps)

      expect(events.map((e) => e.line)).toEqual([
        '#1 [internal] load build definition',
        '#7 [ 2/22] RUN apt-get update',
        '#7 0.512 Get:1 http://archive',
        'Saving tag:1 to a temporary tar...',
        'Loading tag:1 into the msb image store...',
      ])
      expect(events[0].step).toBeUndefined()
      expect(events[1].step).toEqual({ current: 2, total: 22, description: 'RUN apt-get update' })
      expect(events[3].stage).toBe('save')
      expect(events[4].stage).toBe('load')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('omitting onProgress leaves onOutput unset so nothing streams', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const seen: Array<boolean> = []
      const deps: BuildTemplateDeps = {
        runCommand: async (_command: string, args: string[], opts) => {
          seen.push(opts.onOutput !== undefined)
          if (args[0] === 'save') writeFileSync(args[args.indexOf('-o') + 1], 'fake-tar')
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        loadTemplate: vi.fn(async () => {}),
        logger,
        tmpDir: tmp,
      }

      await buildAndLoadSandboxTemplate('/ctx', 'tag:1', deps)

      expect(seen).toEqual([false, false])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('concurrent build guard', () => {
  test('a second overlapping build is rejected and never touches the shared tar', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      let releaseBuild: () => void = () => {}
      const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve })
      const deps: BuildTemplateDeps = {
        runCommand: async (command: string, args: string[]) => {
          record.push({ command, args })
          if (args[0] === 'build') await buildGate
          if (args[0] === 'save') writeFileSync(args[args.indexOf('-o') + 1], 'fake-tar')
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        loadTemplate: vi.fn(async () => {}),
        logger,
        tmpDir: tmp,
      }

      const first = buildAndLoadSandboxTemplate('/ctx', 'tag:1', deps)
      await expect(buildAndLoadSandboxTemplate('/ctx', 'tag:1', deps)).rejects.toThrow(CONCURRENT_BUILD_MESSAGE)
      releaseBuild()
      await first

      expect(record.filter((r) => r.args[0] === 'build')).toHaveLength(1)
      expect(leftoverTars(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('the guard is released after a failed build so a retry can start', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const failing: BuildTemplateDeps = {
        runCommand: makeFakeRun(record, { exitCode: 1, stderr: 'boom' }),
        loadTemplate: vi.fn(async () => {}),
        logger,
        tmpDir: tmp,
      }

      await expect(buildAndLoadSandboxTemplate('/ctx', 'tag:1', failing)).rejects.toThrow(/boom/)
      await expect(
        buildAndLoadSandboxTemplate('/ctx', 'tag:1', { ...failing, runCommand: makeFakeRun(record) }),
      ).resolves.toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('parseDockerBuildStep', () => {
  test('parses padded and named stage counters', () => {
    expect(parseDockerBuildStep('#5 [ 1/8] FROM docker.io/library/ubuntu:24.04')).toEqual({
      current: 1,
      total: 8,
      description: 'FROM docker.io/library/ubuntu:24.04',
    })
    expect(parseDockerBuildStep('#12 [builder 4/22] RUN pnpm install')).toEqual({
      current: 4,
      total: 22,
      description: 'RUN pnpm install',
    })
  })

  test('rejects lines without a step counter and impossible counters', () => {
    expect(parseDockerBuildStep('#1 [internal] load build definition from Dockerfile')).toBeNull()
    expect(parseDockerBuildStep('#7 0.512 Get:1 http://archive.ubuntu.com')).toBeNull()
    expect(parseDockerBuildStep('#7 DONE 12.4s')).toBeNull()
    expect(parseDockerBuildStep('#7 [ 0/8] FROM x')).toBeNull()
    expect(parseDockerBuildStep('#7 [ 9/8] FROM x')).toBeNull()
  })
})

describe('template build args and command formatter', () => {
  test('buildTemplateDockerArgs defaults to no build args', () => {
    expect(buildTemplateDockerArgs()).toEqual([])
    expect(buildTemplateDockerArgs({})).toEqual([])
    expect(buildTemplateDockerArgs({ browserControl: false })).toEqual([])
  })

  test('buildTemplateDockerArgs adds the build arg only for exact true', () => {
    expect(buildTemplateDockerArgs({ browserControl: true })).toEqual(['--build-arg', 'INSTALL_BROWSER_CONTROL=true'])
  })

  test('formatTemplateBuildCommands reflects default args', () => {
    expect(formatTemplateBuildCommands('/ctx', 'oc-forge-sandbox:latest')).toBe(
      'docker build -t oc-forge-sandbox:latest "/ctx" && docker save oc-forge-sandbox:latest -o <tar> && msb load --input <tar> --tag oc-forge-sandbox:latest',
    )
  })

  test('formatTemplateBuildCommands reflects the browser-control build arg', () => {
    expect(formatTemplateBuildCommands('/ctx', 'oc-forge-sandbox:latest', { browserControl: true })).toBe(
      'docker build --build-arg INSTALL_BROWSER_CONTROL=true -t oc-forge-sandbox:latest "/ctx" && docker save oc-forge-sandbox:latest -o <tar> && msb load --input <tar> --tag oc-forge-sandbox:latest',
    )
  })
})
