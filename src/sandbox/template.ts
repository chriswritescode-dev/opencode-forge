import { rmSync } from 'fs'
import { join } from 'path'
import type { Logger, PluginConfig } from '../types'
import { runCommand, type CommandResult, type RunCommandOpts } from './process'

const BUILD_TIMEOUT = 600000
const SAVE_TIMEOUT = 600000
const DOCKER_NOT_FOUND_RE = /spawn docker ENOENT/i
export const DEFAULT_SANDBOX_IMAGE = 'oc-forge-sandbox:latest'

export type SandboxBuildStage = 'build' | 'save' | 'load'

export interface SandboxBuildProgress {
  stage: SandboxBuildStage
  line: string
  step?: { current: number; total: number; description: string }
}

export interface BuildTemplateDeps {
  runCommand: typeof runCommand
  loadTemplate: (tar: string, ref: string) => Promise<void>
  logger: Logger
  tmpDir: string
  onProgress?: (progress: SandboxBuildProgress) => void
  buildArgs?: string[]
}

export function resolveTemplateBuildArgs(config: PluginConfig | undefined): string[] {
  return config?.codeGraph?.install === false ? ['--build-arg', 'INSTALL_CODEGRAPH=false'] : []
}

const DOCKER_BUILD_STEP_RE = /^#\d+\s+\[\s*(?:.+\s+)?(\d+)\/(\d+)\]\s*(.*)$/

export function parseDockerBuildStep(line: string): SandboxBuildProgress['step'] | null {
  const match = DOCKER_BUILD_STEP_RE.exec(line)
  if (!match) return null
  const current = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total)) return null
  if (current < 1 || total < 1 || current > total) return null
  return { current, total, description: match[3].trim() }
}

function reportLines(stage: SandboxBuildStage, onProgress: (progress: SandboxBuildProgress) => void): (chunk: string) => void {
  let carry = ''
  return (chunk: string) => {
    carry += chunk
    const parts = carry.split('\n')
    carry = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trimEnd()
      if (!line) continue
      const step = stage === 'build' ? parseDockerBuildStep(line) : null
      onProgress(step ? { stage, line, step } : { stage, line })
    }
  }
}

export function formatTemplateBuildCommands(contextDir: string, tag: string, buildArgs: string[] = []): string {
  const args = buildArgs.length > 0 ? ` ${buildArgs.join(' ')}` : ''
  const build = ['docker', `build${args}`, '-t', tag, `"${contextDir}"`].join(' ')
  return `${build} && docker save ${tag} -o <tar> && msb load --input <tar> --tag ${tag}`
}

function dockerStageError(stage: 'build' | 'save', result: CommandResult): Error {
  const output = `${result.stdout}\n${result.stderr}`
  if (result.exitCode === 124) {
    const seconds = Math.round((stage === 'build' ? BUILD_TIMEOUT : SAVE_TIMEOUT) / 1000)
    return new Error(`Docker ${stage} timed out after ${seconds} seconds.`)
  }
  if (DOCKER_NOT_FOUND_RE.test(output)) {
    return new Error('Docker CLI not found. Building the sandbox template requires Docker; the msb runtime itself does not.')
  }
  const lastLine = output.split('\n').filter(Boolean).at(-1)?.trim()
  return new Error(`Docker ${stage} failed: ${lastLine ?? output.trim()}`)
}

export const CONCURRENT_BUILD_MESSAGE = 'A sandbox template build is already running in this process.'

let activeBuild: Promise<void> | null = null

export function buildAndLoadSandboxTemplate(
  contextDir: string,
  tag: string,
  deps: BuildTemplateDeps,
): Promise<void> {
  if (activeBuild) return Promise.reject(new Error(CONCURRENT_BUILD_MESSAGE))
  const run = runBuildAndLoad(contextDir, tag, deps)
  activeBuild = run
  return run.finally(() => {
    activeBuild = null
  })
}

async function runBuildAndLoad(
  contextDir: string,
  tag: string,
  deps: BuildTemplateDeps,
): Promise<void> {
  const tarPath = join(deps.tmpDir, `forge-sandbox-template-${process.pid}.tar`)
  const onProgress = deps.onProgress
  try {
    const buildArgs = deps.buildArgs ?? []
    const buildOpts: RunCommandOpts = {
      logger: deps.logger,
      logLabel: 'docker',
      timeout: BUILD_TIMEOUT,
    }
    if (onProgress) buildOpts.onOutput = reportLines('build', onProgress)
    const build = await deps.runCommand('docker', ['build', '--progress=plain', ...buildArgs, '-t', tag, contextDir], buildOpts)
    if (build.exitCode !== 0) throw dockerStageError('build', build)

    onProgress?.({ stage: 'save', line: `Saving ${tag} to a temporary tar...` })
    const saveOpts: RunCommandOpts = {
      logger: deps.logger,
      logLabel: 'docker',
      timeout: SAVE_TIMEOUT,
    }
    if (onProgress) saveOpts.onOutput = reportLines('save', onProgress)
    const save = await deps.runCommand('docker', ['save', tag, '-o', tarPath], saveOpts)
    if (save.exitCode !== 0) throw dockerStageError('save', save)

    onProgress?.({ stage: 'load', line: `Loading ${tag} into the msb image store...` })
    await deps.loadTemplate(tarPath, tag)
  } finally {
    rmSync(tarPath, { force: true })
  }
}
