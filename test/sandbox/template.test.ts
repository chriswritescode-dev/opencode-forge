import { describe, test, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAndLoadSandboxTemplate, buildTemplateDockerArgs, formatTemplateBuildCommands } from '../../src/sandbox/template'
import type { BuildTemplateDeps } from '../../src/sandbox/template'
import type { Logger } from '../../src/types'

const logger: Logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

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
      expect(record[0].args).toEqual(['build', '-t', 'oc-forge-sandbox:latest', '/ctx'])
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
