import { describe, test, expect, vi, beforeEach } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAndLoadSandboxTemplate, CONCURRENT_BUILD_MESSAGE, formatTemplateBuildCommands, parseDockerBuildStep, readSandboxTemplateBuildStatus, resolveTemplateBuildArgs, startSandboxTemplateBuild } from '../../src/sandbox/template'
import type { BuildTemplateDeps, SandboxBuildProgress } from '../../src/sandbox/template'
import type { Logger } from '../../src/types'

const logger: Logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

test('sandbox image keeps the pnpm store and every tool cache on the mounted cache disk', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('XDG_CACHE_HOME=/opt/forge/cache')
  expect(dockerfile).toContain('PNPM_CONFIG_STORE_DIR=/opt/forge/cache/pnpm/store')
  expect(dockerfile).toContain('npm_config_store_dir=/opt/forge/cache/pnpm/store')
  expect(dockerfile).toContain('npm_config_cache=/opt/forge/cache/npm')
  expect(dockerfile).toContain('UV_PYTHON_INSTALL_DIR=/opt/forge/cache/uv-python')
  expect(dockerfile).toContain('UV_TOOL_DIR=/opt/forge/cache/uv-tools')
  expect(dockerfile).toContain('UV_TOOL_BIN_DIR=/opt/forge/cache/uv-bin')
  expect(dockerfile).toContain('PATH=/opt/forge/.cargo/bin:/opt/forge/cache/cargo/bin:/opt/forge/cache/uv-bin:/opt/forge/.local/share/pnpm/bin:/opt/forge/.local/share/pnpm:$PATH')
  expect(dockerfile).toContain('CARGO_HOME=/opt/forge/cache/cargo')
  expect(dockerfile).toContain('GOPATH=/opt/forge/cache/go')
  expect(dockerfile).toContain('mkdir -p /opt/forge/cache /opt/forge/.local/share/pnpm')
  expect(dockerfile).toContain('forge-cache-prune')
})

test('the image ships a Rust toolchain outside the shadowed cache disk', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('https://sh.rustup.rs')
  expect(dockerfile).toContain('RUSTUP_HOME=/opt/forge/.rustup')
  expect(dockerfile).toContain('CARGO_HOME=/opt/forge/cache/cargo')
  expect(dockerfile).toContain('/opt/forge/.cargo/bin/rustup component add clippy rustfmt')
})

test('forge-cache-prune preserves toolchain roots, prunes cache subtrees, and trims the cache mount', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')
  const pruneStart = dockerfile.indexOf('cat > /usr/local/bin/forge-cache-prune')
  const prune = dockerfile.slice(pruneStart, dockerfile.indexOf('\nEOF', pruneStart))

  expect(prune).toContain('set -u')
  expect(prune).toContain('XDG_CACHE_HOME:-/opt/forge/cache')
  expect(prune).toContain('"$cache"/uv-python|"$cache"/uv-tools|"$cache"/uv-bin) ;;')
  expect(prune).toContain('wipe "$cache/cargo/registry"')
  expect(prune).toContain('wipe "$cache/cargo/git"')
  expect(prune).toContain('wipe "$cache/go/pkg/mod"')
  expect(prune).toContain('*) wipe "$entry" ;;')
  expect(prune).toContain('sudo -n apt-get clean')
  expect(prune).toContain('sudo -n /usr/sbin/fstrim -v "$cache" 2>/dev/null || true')
  expect(prune).toContain('sudo -n rm -rf "$1"')
})

test('forge-cache-prune keeps uv tool installs and bin symlinks while wiping expendable caches', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')
  const marker = "cat > /usr/local/bin/forge-cache-prune <<'EOF'"
  const markerStart = dockerfile.indexOf(marker)
  const bodyStart = dockerfile.indexOf('\n', markerStart) + 1
  const bodyEnd = dockerfile.indexOf('\nEOF', bodyStart)
  const prune = dockerfile.slice(bodyStart, bodyEnd + 1)

  const tmp = mkdtempSync(join(tmpdir(), 'forge-prune-'))
  try {
    const cache = join(tmp, 'cache')
    const toolEnvBin = join(cache, 'uv-tools', 'ruff', 'bin')
    mkdirSync(toolEnvBin, { recursive: true })
    const toolBinary = join(toolEnvBin, 'ruff')
    writeFileSync(toolBinary, 'tool-env')

    const uvBin = join(cache, 'uv-bin')
    mkdirSync(uvBin, { recursive: true })
    const binLink = join(uvBin, 'ruff')
    symlinkSync(toolBinary, binLink)

    const expendable = join(cache, 'npm')
    mkdirSync(expendable, { recursive: true })
    writeFileSync(join(expendable, 'junk'), 'junk')

    const stubBin = join(tmp, 'bin')
    mkdirSync(stubBin)
    writeFileSync(join(stubBin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const script = join(tmp, 'forge-cache-prune')
    writeFileSync(script, prune, { mode: 0o755 })

    const result = spawnSync('sh', [script], {
      env: { ...process.env, XDG_CACHE_HOME: cache, PATH: [stubBin, process.env.PATH ?? ''].join(':') },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    expect(existsSync(toolBinary)).toBe(true)
    expect(lstatSync(binLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(binLink)).toBe(toolBinary)
    expect(existsSync(expendable)).toBe(false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the image installs a pinned codegraph by default behind a build argument that can skip it', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('ARG CODEGRAPH_VERSION=v1.6.4')
  expect(dockerfile).not.toMatch(/pnpm add -g fallow/)
  expect(dockerfile).toContain('ARG INSTALL_CODEGRAPH=true')

  const gateStart = dockerfile.indexOf('RUN if [ "$INSTALL_CODEGRAPH" = "true" ]')
  expect(gateStart).toBeGreaterThan(dockerfile.indexOf('ARG INSTALL_CODEGRAPH=true'))
  expect(gateStart).toBeLessThan(dockerfile.lastIndexOf('USER agent'))

  const gated = dockerfile.slice(gateStart, dockerfile.indexOf('\n    fi', gateStart))
  expect(gated).toContain('/opt/codegraph')
  expect(gated).toContain('/usr/local/bin/codegraph')
  expect(gated).toContain('${CODEGRAPH_VERSION}')
  expect(gated).toContain('codegraph --version')
  expect(dockerfile.match(/codegraph-linux-/g)).toHaveLength(1)
  expect(dockerfile).toContain('CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_DAEMON=1 CODEGRAPH_NO_WATCH=1')

  const pruneStart = dockerfile.indexOf('cat > /usr/local/bin/forge-cache-prune')
  const prune = dockerfile.slice(pruneStart, dockerfile.indexOf('\nEOF', pruneStart))
  expect(prune).not.toContain('codegraph')
})

test('the image installs a pinned ast-grep and never links the zip sg', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('ARG AST_GREP_VERSION=0.51.2')
  expect(dockerfile).toContain('/app-${ast_grep_arch}-unknown-linux-gnu.zip')
  expect(dockerfile).toContain('releases/download/${AST_GREP_VERSION}/')
  expect(dockerfile).toContain('ln -sf /opt/ast-grep/ast-grep /usr/local/bin/ast-grep')
  expect(dockerfile).toContain('ast-grep --version')
  expect(dockerfile).not.toContain('/usr/local/bin/sg')

  const installStart = dockerfile.indexOf('ARG AST_GREP_VERSION=')
  expect(installStart).toBeGreaterThan(-1)
  expect(installStart).toBeLessThan(dockerfile.lastIndexOf('USER agent'))
})

test('the image configures a system-scope git identity as a lowest-precedence fallback', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('git config --system user.name "Forge Sandbox"')
  expect(dockerfile).toContain('git config --system user.email "forge-sandbox@localhost"')
})

test('the image installs ffmpeg, ttyd, and a pinned vhs that can launch the image browser', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('ARG VHS_VERSION=0.12.1')
  expect(dockerfile).toContain('apt-get install -y --no-install-recommends ffmpeg ttyd')
  expect(dockerfile).toContain('/usr/local/bin/vhs')
  expect(dockerfile).toContain('ENV VHS_NO_SANDBOX=true')

  const argStart = dockerfile.indexOf('ARG VHS_VERSION')
  expect(argStart).toBeGreaterThan(-1)
  expect(argStart).toBeLessThan(dockerfile.lastIndexOf('USER agent'))
})

test('the image ships the Playwright ffmpeg revision older Playwright versions record video with', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')

  expect(dockerfile).toContain('ARG PLAYWRIGHT_LEGACY_FFMPEG_VERSION=1.63.0')
  const chromiumInstall = dockerfile.indexOf('install --with-deps chromium')
  const legacyFfmpegInstall = dockerfile.indexOf('pnpm dlx "playwright-core@${PLAYWRIGHT_LEGACY_FFMPEG_VERSION}" install ffmpeg')
  expect(legacyFfmpegInstall).toBeGreaterThan(chromiumInstall)
  expect(chromiumInstall).toBeGreaterThan(dockerfile.indexOf('ENV PLAYWRIGHT_BROWSERS_PATH='))
})

test('globally installed CLIs are built against a store the cache-disk mount cannot shadow', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')
  const globalInstalls = dockerfile.split('\n').filter((line) => line.includes('pnpm add -g'))

  expect(globalInstalls.length).toBeGreaterThan(0)
  for (const line of globalInstalls) {
    expect(line).toContain('--store-dir /opt/forge/.local/share/pnpm/store')
  }
})

test('the image pnpm is pinned exactly to a version whose CLI still accepts --global-bin-dir', () => {
  const dockerfile = readFileSync(new URL('../../container/Dockerfile', import.meta.url), 'utf-8')
  const install = dockerfile.split('\n').find((line) => line.includes('npm install -g pnpm'))

  expect(install).toBe('RUN npm install -g pnpm@11.28.11')
  expect(dockerfile).not.toContain('pnpm@latest')
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

  test('passes the configured build args to the docker build invocation', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const deps: BuildTemplateDeps = {
        runCommand: makeFakeRun(record),
        loadTemplate: vi.fn(async () => {}),
        logger,
        tmpDir: tmp,
        buildArgs: ['--build-arg', 'INSTALL_CODEGRAPH=false'],
      }

      await buildAndLoadSandboxTemplate('/ctx', 'oc-forge-sandbox:latest', deps)

      expect(record[0].args).toEqual([
        'build',
        '--progress=plain',
        '--build-arg',
        'INSTALL_CODEGRAPH=false',
        '-t',
        'oc-forge-sandbox:latest',
        '/ctx',
      ])
      expect(leftoverTars(tmp)).toHaveLength(0)
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

describe('sandbox template build tracker', () => {
  beforeEach(() => {
    delete globalThis.__opencodeForgeShared?.['sandbox-template-build.v1']
  })

  function makeContextDir(): string {
    return mkdtempSync(join(tmpdir(), 'forge-ctx-'))
  }

  function makeGatedDeps(tmp: string, progress?: SandboxBuildProgress[], record?: Array<{ command: string; args: string[] }>): {
    deps: BuildTemplateDeps
    release: () => void
    emit: (chunk: string) => void
  } {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let emit: (chunk: string) => void = () => {}
    const deps: BuildTemplateDeps = {
      runCommand: async (command: string, args: string[], opts) => {
        record?.push({ command, args })
        if (args[0] === 'build') {
          emit = opts.onOutput ?? (() => {})
          await gate
        }
        if (args[0] === 'save') writeFileSync(args[args.indexOf('-o') + 1], 'fake-tar')
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      loadTemplate: vi.fn(async () => {}),
      logger,
      tmpDir: tmp,
      ...(progress ? { onProgress: (entry: SandboxBuildProgress) => progress.push(entry) } : {}),
    }
    return { deps, release, emit: (chunk: string) => emit(chunk) }
  }

  test('reports idle status before any build starts', () => {
    expect(readSandboxTemplateBuildStatus({ contextDir: '/ctx', tag: 'tag:1' })).toEqual({
      phase: 'idle',
      image: 'tag:1',
      contextDir: '/ctx',
      tail: [],
    })
  })

  test('a running build caps the tail, keeps the latest line, and keeps the step monotonic', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    const contextDir = makeContextDir()
    try {
      const progress: SandboxBuildProgress[] = []
      const { deps, release, emit } = makeGatedDeps(tmp, progress)
      let resolveSettled: () => void = () => {}
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
      const started = startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps,
        onSettled: () => { resolveSettled() },
      })

      expect(started).toMatchObject({ phase: 'running', image: 'tag:1', contextDir, stage: 'build', tail: [] })

      for (let step = 1; step <= 14; step += 1) emit(`#${step} [ ${step}/20] step ${step}\n`)
      emit('#15 [ 3/20] step 3\n')

      const running = readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })
      expect(running.phase).toBe('running')
      expect(running.stage).toBe('build')
      expect(running.tail).toHaveLength(12)
      expect(running.tail[0]).toBe('#4 [ 4/20] step 4')
      expect(running.tail[11]).toBe('#15 [ 3/20] step 3')
      expect(running.lastLine).toBe('#15 [ 3/20] step 3')
      expect(running.step).toEqual({ current: 14, total: 20, description: 'step 14' })
      expect(running.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(progress).toHaveLength(15)

      release()
      await settled

      const finished = readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })
      expect(finished.phase).toBe('success')
      expect(finished.stage).toBe('load')
      expect(finished.step).toBeUndefined()
      expect(finished.tail.at(-1)).toBe('Loading tag:1 into the msb image store...')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(contextDir, { recursive: true, force: true })
    }
  })

  test('a successful build settles to success and reports it to onSettled', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    const contextDir = makeContextDir()
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const settled: Array<{ ok: true } | { ok: false; message: string }> = []
      const started = startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps: { runCommand: makeFakeRun(record), loadTemplate: vi.fn(async () => {}), logger, tmpDir: tmp },
        onSettled: (result) => settled.push(result),
      })
      expect(started.phase).toBe('running')

      await vi.waitFor(() => {
        expect(readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' }).phase).toBe('success')
      })

      const finished = readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })
      expect(finished.failure).toBeUndefined()
      expect(typeof finished.elapsedMs).toBe('number')
      expect(settled).toEqual([{ ok: true }])
      expect(leftoverTars(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(contextDir, { recursive: true, force: true })
    }
  })

  test('a failed build settles to error with the message and releases the guard', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    const contextDir = makeContextDir()
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const settled: Array<{ ok: true } | { ok: false; message: string }> = []
      startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps: {
          runCommand: makeFakeRun(record, { exitCode: 1, stderr: 'boom' }),
          loadTemplate: vi.fn(async () => {}),
          logger,
          tmpDir: tmp,
        },
        onSettled: (result) => settled.push(result),
      })

      await vi.waitFor(() => {
        expect(readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' }).phase).toBe('error')
      })

      const failed = readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })
      expect(failed.failure).toBe('Docker build failed: boom')
      expect(settled).toEqual([{ ok: false, message: 'Docker build failed: boom' }])

      const retry = startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps: { runCommand: makeFakeRun(record), loadTemplate: vi.fn(async () => {}), logger, tmpDir: tmp },
      })
      expect(retry.phase).toBe('running')
      await vi.waitFor(() => {
        expect(readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' }).phase).toBe('success')
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(contextDir, { recursive: true, force: true })
    }
  })

  test('a second overlapping start is rejected and never runs another build', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    const contextDir = makeContextDir()
    try {
      const record: Array<{ command: string; args: string[] }> = []
      const progress: SandboxBuildProgress[] = []
      const { deps, release } = makeGatedDeps(tmp, progress, record)
      let resolveSettled: () => void = () => {}
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
      const first = startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps,
        onSettled: () => { resolveSettled() },
      })
      expect(first.phase).toBe('running')

      expect(startSandboxTemplateBuild({ contextDir, tag: 'tag:1', deps })).toEqual({ error: CONCURRENT_BUILD_MESSAGE })

      release()
      await settled

      expect(readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' }).phase).toBe('success')
      expect(record.filter((entry) => entry.args[0] === 'build')).toHaveLength(1)
      expect(leftoverTars(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(contextDir, { recursive: true, force: true })
    }
  })

  test('a missing build context returns an error without running commands', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    const contextDir = join(tmp, 'missing-context')
    try {
      const runCommandFn = vi.fn(makeFakeRun([]))
      expect(startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps: { runCommand: runCommandFn, loadTemplate: vi.fn(async () => {}), logger, tmpDir: tmp },
      })).toEqual({ error: `Sandbox build context is missing at ${contextDir}. Reinstall opencode-forge.` })
      expect(runCommandFn).not.toHaveBeenCalled()
      expect(readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })).toEqual({
        phase: 'idle',
        image: 'tag:1',
        contextDir,
        tail: [],
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('a returned snapshot is a copy of the live run', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-tpl-'))
    const contextDir = makeContextDir()
    try {
      const { deps, release, emit } = makeGatedDeps(tmp)
      let resolveSettled: () => void = () => {}
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
      startSandboxTemplateBuild({
        contextDir,
        tag: 'tag:1',
        deps,
        onSettled: () => { resolveSettled() },
      })
      emit('#4 [ 4/20] RUN copy\n')

      const live = readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })
      live.tail.push('mutated')
      live.step!.current = 99

      const reread = readSandboxTemplateBuildStatus({ contextDir, tag: 'tag:1' })
      expect(reread.tail).toEqual(['#4 [ 4/20] RUN copy'])
      expect(reread.step).toEqual({ current: 4, total: 20, description: 'RUN copy' })

      release()
      await settled
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(contextDir, { recursive: true, force: true })
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

describe('template build command formatter', () => {
  test('formatTemplateBuildCommands formats build, save, and load', () => {
    expect(formatTemplateBuildCommands('/ctx', 'oc-forge-sandbox:latest')).toBe(
      'docker build -t oc-forge-sandbox:latest "/ctx" && docker save oc-forge-sandbox:latest -o <tar> && msb load --input <tar> --tag oc-forge-sandbox:latest',
    )
  })

  test('formatTemplateBuildCommands includes the build args in the docker build command', () => {
    expect(formatTemplateBuildCommands('/ctx', 'oc-forge-sandbox:latest', resolveTemplateBuildArgs({ codeGraph: { install: false } }))).toBe(
      'docker build --build-arg INSTALL_CODEGRAPH=false -t oc-forge-sandbox:latest "/ctx" && docker save oc-forge-sandbox:latest -o <tar> && msb load --input <tar> --tag oc-forge-sandbox:latest',
    )
  })
})

describe('resolveTemplateBuildArgs', () => {
  test('is empty when codegraph installation is unset or true, so the image default installs it', () => {
    expect(resolveTemplateBuildArgs(undefined)).toEqual([])
    expect(resolveTemplateBuildArgs({})).toEqual([])
    expect(resolveTemplateBuildArgs({ codeGraph: {} })).toEqual([])
    expect(resolveTemplateBuildArgs({ codeGraph: { install: true } })).toEqual([])
  })

  test('passes INSTALL_CODEGRAPH=false when codegraph installation is turned off', () => {
    expect(resolveTemplateBuildArgs({ codeGraph: { install: false } })).toEqual([
      '--build-arg',
      'INSTALL_CODEGRAPH=false',
    ])
  })
})
