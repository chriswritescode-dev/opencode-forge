/**
 * Builds the sandbox template image with Docker and loads it into the `sbx` store.
 * Docker still produces the image, but `sbx` needs it in its own image store, so the
 * palette command becomes build -> save -> load. Both steps live here so there is a
 * single point of truth for the sequence and its failure messages.
 */
import { rmSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../types'
import { runCommand, type CommandResult } from './process'

const BUILD_TIMEOUT = 600000
const SAVE_TIMEOUT = 600000
const DOCKER_NOT_FOUND_RE = /spawn docker ENOENT/i
export const DEFAULT_SANDBOX_IMAGE = 'oc-forge-sandbox:latest'

export interface BuildTemplateDeps {
  runCommand: typeof runCommand
  loadTemplate: (tar: string, ref: string) => Promise<void>
  logger: Logger
  tmpDir: string
}

export interface SandboxTemplateOptions {
  browserControl?: boolean
}

export function buildTemplateDockerArgs(options?: SandboxTemplateOptions): string[] {
  return options?.browserControl === true
    ? ['--build-arg', 'INSTALL_BROWSER_CONTROL=true']
    : []
}

export function formatTemplateBuildCommands(
  contextDir: string,
  tag: string,
  loadHint: string,
  options?: SandboxTemplateOptions,
): string {
  const build = ['docker', 'build', ...buildTemplateDockerArgs(options), '-t', tag, `"${contextDir}"`].join(' ')
  return `${build} && docker save ${tag} -o <tar> && ${loadHint}`
}

function dockerStageError(stage: 'build' | 'save', result: CommandResult): Error {
  const output = `${result.stdout}\n${result.stderr}`
  if (result.exitCode === 124) {
    const seconds = Math.round((stage === 'build' ? BUILD_TIMEOUT : SAVE_TIMEOUT) / 1000)
    return new Error(`Docker ${stage} timed out after ${seconds} seconds.`)
  }
  if (DOCKER_NOT_FOUND_RE.test(output)) {
    return new Error('Docker CLI not found. Building the sandbox template requires Docker; the sbx runtime itself does not.')
  }
  const lastLine = output.split('\n').filter(Boolean).at(-1)?.trim()
  return new Error(`Docker ${stage} failed: ${lastLine ?? output.trim()}`)
}

/**
 * Builds `<tag>` from `contextDir` with Docker, saves it to a temp tar, loads that tar
 * into the sbx template store, and removes the tar on both the success and failure paths.
 */
export async function buildAndLoadSandboxTemplate(
  contextDir: string,
  tag: string,
  deps: BuildTemplateDeps,
  options?: SandboxTemplateOptions,
): Promise<void> {
  const tarPath = join(deps.tmpDir, `forge-sandbox-template-${process.pid}.tar`)
  try {
    const build = await deps.runCommand('docker', ['build', ...buildTemplateDockerArgs(options), '-t', tag, contextDir], {
      logger: deps.logger,
      logLabel: 'docker',
      timeout: BUILD_TIMEOUT,
    })
    if (build.exitCode !== 0) throw dockerStageError('build', build)

    const save = await deps.runCommand('docker', ['save', tag, '-o', tarPath], {
      logger: deps.logger,
      logLabel: 'docker',
      timeout: SAVE_TIMEOUT,
    })
    if (save.exitCode !== 0) throw dockerStageError('save', save)

    await deps.loadTemplate(tarPath, tag)
  } finally {
    rmSync(tarPath, { force: true })
  }
}
