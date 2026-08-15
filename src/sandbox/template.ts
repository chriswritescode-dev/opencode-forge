/**
 * Builds the sandbox template image with Docker and loads it into the `msb` image store.
 * Docker still produces the image, but `msb` needs it in its own image store, so the
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

export type SandboxBuildStage = 'build' | 'save' | 'load'

export interface SandboxBuildProgress {
  stage: SandboxBuildStage
  /** One line of command output, or a synthetic status line for stages that produce none. */
  line: string
  /** Present only for `docker build` lines that announce a numbered step. */
  step?: { current: number; total: number; description: string }
}

export interface BuildTemplateDeps {
  runCommand: typeof runCommand
  loadTemplate: (tar: string, ref: string) => Promise<void>
  logger: Logger
  tmpDir: string
  /**
   * Live progress sink. The build can run for ten minutes with no other signal,
   * so callers that own a UI surface use this to prove the build is alive.
   */
  onProgress?: (progress: SandboxBuildProgress) => void
}

export interface SandboxTemplateOptions {
  browserControl?: boolean
}

/**
 * `#12 [builder 4/22] RUN ...` and `#5 [ 1/8] FROM ...` both carry the step
 * counter that makes the build determinate. Lines without one (`[internal] load
 * build context`, per-step log output) return null and are reported as plain text.
 */
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

/**
 * Adapts chunked child-process output to whole lines. Chunks split mid-line, so
 * the remainder is carried into the next chunk instead of being reported as a line.
 */
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

export function buildTemplateDockerArgs(options?: SandboxTemplateOptions): string[] {
  return options?.browserControl === true
    ? ['--build-arg', 'INSTALL_BROWSER_CONTROL=true']
    : []
}

export function formatTemplateBuildCommands(contextDir: string, tag: string, options?: SandboxTemplateOptions): string {
  const build = ['docker', 'build', ...buildTemplateDockerArgs(options), '-t', tag, `"${contextDir}"`].join(' ')
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

/**
 * One build at a time per process. `tarPath` is keyed by pid, so two concurrent
 * runs share it: the second `docker save` overwrites the first run's tar, and
 * whichever finishes first deletes it out from under the other, producing a
 * corrupt or missing load. Guarding here rather than in the UI keeps every
 * caller — the palette dialog today, anything else later — on one rule.
 */
let activeBuild: Promise<void> | null = null

/**
 * Builds `<tag>` from `contextDir` with Docker, saves it to a temp tar, loads that tar
 * into the msb image store, and removes the tar on both the success and failure paths.
 * Rejects immediately if a build is already in flight.
 */
export function buildAndLoadSandboxTemplate(
  contextDir: string,
  tag: string,
  deps: BuildTemplateDeps,
  options?: SandboxTemplateOptions,
): Promise<void> {
  if (activeBuild) return Promise.reject(new Error(CONCURRENT_BUILD_MESSAGE))
  const run = runBuildAndLoad(contextDir, tag, deps, options)
  activeBuild = run
  return run.finally(() => {
    activeBuild = null
  })
}

async function runBuildAndLoad(
  contextDir: string,
  tag: string,
  deps: BuildTemplateDeps,
  options?: SandboxTemplateOptions,
): Promise<void> {
  const tarPath = join(deps.tmpDir, `forge-sandbox-template-${process.pid}.tar`)
  const onProgress = deps.onProgress
  try {
    // `--progress=plain` is only added to the real invocation, not to
    // `formatTemplateBuildCommands`: it makes output line-oriented and parseable
    // here, but is noise in the copy-paste hint shown to a human.
    const build = await deps.runCommand('docker', ['build', '--progress=plain', ...buildTemplateDockerArgs(options), '-t', tag, contextDir], {
      logger: deps.logger,
      logLabel: 'docker',
      timeout: BUILD_TIMEOUT,
      ...(onProgress ? { onOutput: reportLines('build', onProgress) } : {}),
    })
    if (build.exitCode !== 0) throw dockerStageError('build', build)

    onProgress?.({ stage: 'save', line: `Saving ${tag} to a temporary tar...` })
    const save = await deps.runCommand('docker', ['save', tag, '-o', tarPath], {
      logger: deps.logger,
      logLabel: 'docker',
      timeout: SAVE_TIMEOUT,
      ...(onProgress ? { onOutput: reportLines('save', onProgress) } : {}),
    })
    if (save.exitCode !== 0) throw dockerStageError('save', save)

    onProgress?.({ stage: 'load', line: `Loading ${tag} into the msb image store...` })
    await deps.loadTemplate(tarPath, tag)
  } finally {
    rmSync(tarPath, { force: true })
  }
}
