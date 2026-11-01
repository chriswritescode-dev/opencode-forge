import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { CODE_GRAPH_LINK_NAME, isCodeGraphEnabled } from '../constants/loop'
import { SANDBOX_CACHE_DIR } from '../sandbox/msb'
import { quoteShellArg } from '../sandbox/exec-fs'
import type { SandboxContextManager } from '../sandbox/context'
import type { CommandResult } from '../sandbox/process'
import type { Logger, PluginConfig } from '../types'
import { LRUCache } from '../utils/lru-cache'
import {
  buildCodeGraphRunnerScript,
  parseCodeGraphRunnerResult,
  type CodeGraphFileReport,
  type CodeGraphRunnerInput,
  type CodeGraphRunnerResult,
} from './code-graph-runner'

const CODE_GRAPH_HOME = '/opt/codegraph'
const CODE_GRAPH_NODE = `${CODE_GRAPH_HOME}/node`
const CODE_GRAPH_LIB_DIR = `${CODE_GRAPH_HOME}/lib`
const CODE_GRAPH_CACHE_DIR = `${SANDBOX_CACHE_DIR}/codegraph`
const CODE_GRAPH_ENV = 'CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_DAEMON=1 CODEGRAPH_NO_WATCH=1'
/** Succeeds only when the bundled Node and the library the runner loads both exist. */
export const CODE_GRAPH_PROBE_COMMAND = `test -x ${CODE_GRAPH_NODE} && test -f ${CODE_GRAPH_LIB_DIR}/dist/index.js && echo present`
const BINARY_PROBE_TIMEOUT_MS = 30000
/** One runner exec, which may build a full index for a loop's first snapshot. */
const SNAPSHOT_TIMEOUT_MS = 600000
const AFFECTED_MAX_DEPTH = 5
const PROBED_CONTAINER_LIMIT = 100

export interface CodeGraphTarget {
  key: string
  worktreeDir: string
  /** The config asks for codegraph explicitly, so a missing binary is an error rather than a skip. */
  required: boolean
  exec(command: string, timeoutMs: number): Promise<CommandResult>
}

export interface CodeGraphSnapshotInput {
  title: string
  files: string[]
}

export interface CodeGraphSnapshotter {
  snapshotFiles(target: CodeGraphTarget, input: CodeGraphSnapshotInput): Promise<string | null>
}

export interface LoopCodeGraphState {
  loopName: string
  sandbox?: boolean
  worktreeDir?: string
}

export function resolveLoopCodeGraphTarget(
  sandboxManager: Pick<SandboxContextManager, 'runtime' | 'getActive'> | null | undefined,
  state: LoopCodeGraphState | null | undefined,
  config: PluginConfig | undefined,
): CodeGraphTarget | null {
  if (!isCodeGraphEnabled(config)) return null
  if (!state?.sandbox || !state.worktreeDir || !sandboxManager) return null
  const active = sandboxManager.getActive(state.loopName)
  if (!active) return null
  const worktreeDir = state.worktreeDir
  return {
    key: active.containerName,
    worktreeDir,
    required: config?.codeGraph?.enabled === true || config?.codeGraph?.install === true,
    exec: (command, timeoutMs) =>
      sandboxManager.runtime.exec(active.containerName, command, { cwd: worktreeDir, timeout: timeoutMs }),
  }
}

export function codeGraphReportPath(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `.forge/codegraph/${sanitized || 'snapshot'}.md`
}

export function ensureCodeGraphReportFile(worktreeDir: string, relPath: string, text: string): boolean {
  const absolute = join(worktreeDir, relPath)
  try {
    if (existsSync(absolute) && readFileSync(absolute, 'utf8') === text) return true
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, text, 'utf8')
    return true
  } catch {
    return false
  }
}

export function buildCodeGraphPromptBlock(relPath: string, point: 'section start' | 'audit checkpoint'): string {
  return [
    '',
    '',
    '---',
    '## Code graph',
    '',
    `Forge ran \`codegraph\` at the ${point}; the full output (affected tests and the dependents of each file) is in \`${relPath}\`; read it in parts or grep it.`,
    '',
    'The index at `.codegraph` reflects that snapshot. Run `codegraph explore <query>`, `codegraph node <symbol|--file path>`, `codegraph callers|callees|impact <symbol>`, or `codegraph affected <files>` in bash, and prefer them over grep-driven exploration.',
    '',
    'Files edited since the snapshot must be read directly.',
    '',
    'Never run `codegraph init`, `uninit`, or `index`, and never delete `.codegraph`.',
  ].join('\n')
}

function ensureCacheLink(worktreeDir: string, logger: Logger): boolean {
  const linkPath = join(worktreeDir, CODE_GRAPH_LINK_NAME)
  try {
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) {
      logger.error(`[code-graph] ${linkPath} exists and is not a symlink; leaving it untouched`)
      return false
    }
    const target = readlinkSync(linkPath)
    if (target !== CODE_GRAPH_CACHE_DIR) {
      logger.error(`[code-graph] ${linkPath} points elsewhere (${target}); leaving it untouched`)
      return false
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(`[code-graph] cannot inspect ${linkPath}`, err)
      return false
    }
  }
  try {
    symlinkSync(CODE_GRAPH_CACHE_DIR, linkPath)
    return true
  } catch (err) {
    logger.error(`[code-graph] cannot create ${linkPath}`, err)
    return false
  }
}

function filterCodeGraphFiles(worktreeDir: string, files: string[]): string[] {
  const root = resolve(worktreeDir)
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of files) {
    const file = raw.trim()
    if (!file || isAbsolute(file)) continue
    const absolute = resolve(root, file)
    const rel = relative(root, absolute)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    if (seen.has(absolute)) continue
    try {
      if (!statSync(absolute).isFile()) continue
    } catch {
      continue
    }
    seen.add(absolute)
    result.push(rel)
  }
  return result
}

function formatFileSection(file: CodeGraphFileReport): string[] {
  const usedBy = file.dependents.length > 0 ? `Used by: ${file.dependents.join(', ')}` : 'No dependents in the index.'
  const symbols =
    file.symbols.length > 0
      ? file.symbols.map((symbol) => {
          const signature = symbol.signature ? ` ${symbol.signature}` : ''
          return `- \`${symbol.name}\` (${symbol.kind})${signature} — line ${symbol.startLine}`
        })
      : ['_No symbols in the index._']
  return ['', `## ${file.path}`, '', usedBy, '', ...symbols]
}

function formatCodeGraphReport(input: {
  title: string
  takenAt: Date
  files: CodeGraphFileReport[]
  affectedTests: string[]
}): string {
  const title = input.title.replace(/\s+/g, ' ').trim() || 'snapshot'
  const lines = [
    `# Code graph: ${title}`,
    '',
    `Snapshot taken at ${input.takenAt.toISOString()} and reflects the worktree at that moment.`,
    '',
    '## Changed or planned files',
    '',
    ...input.files.map((file) => `- ${file.path}`),
    '',
    '## Affected test files',
    '',
    ...(input.affectedTests.length > 0 ? input.affectedTests.map((test) => `- ${test}`) : ['_None reported._']),
  ]
  for (const file of input.files) lines.push(...formatFileSection(file))
  lines.push('')
  return lines.join('\n')
}

function describeExecFailure(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
}

export function createCodeGraphSnapshotter({ logger }: { logger: Logger }): CodeGraphSnapshotter {
  const binaryProbes = new LRUCache<Promise<boolean>>(PROBED_CONTAINER_LIMIT)

  function probeBinary(target: CodeGraphTarget): Promise<boolean> {
    const cached = binaryProbes.get(target.key)
    if (cached) return cached
    const pending = target
      .exec(CODE_GRAPH_PROBE_COMMAND, BINARY_PROBE_TIMEOUT_MS)
      .then((result) => {
        const found = result.exitCode === 0 && result.stdout.trim().length > 0
        if (!found && target.required) {
          logger.error(`[code-graph] codegraph is not available in ${target.key}; rebuild the sandbox template with codeGraph.install left on`)
        } else if (!found) {
          logger.log(`[code-graph] codegraph is not installed in ${target.key}; skipping code-graph snapshots`)
        }
        return found
      })
      .catch((err) => {
        logger.error(`[code-graph] binary probe failed for ${target.key}`, err)
        binaryProbes.delete(target.key)
        return false
      })
    binaryProbes.set(target.key, pending)
    return pending
  }

  async function runSnapshot(target: CodeGraphTarget, files: string[]): Promise<CodeGraphRunnerResult> {
    const input: CodeGraphRunnerInput = {
      libDir: CODE_GRAPH_LIB_DIR,
      projectRoot: target.worktreeDir,
      indexDir: CODE_GRAPH_CACHE_DIR,
      files,
      maxDepth: AFFECTED_MAX_DEPTH,
    }
    const command = [
      CODE_GRAPH_ENV,
      CODE_GRAPH_NODE,
      '--liftoff-only',
      '--disable-warning=ExperimentalWarning',
      '-e',
      quoteShellArg(buildCodeGraphRunnerScript()),
      quoteShellArg(JSON.stringify(input)),
    ].join(' ')
    const result = await target.exec(command, SNAPSHOT_TIMEOUT_MS)
    const parsed = parseCodeGraphRunnerResult(result.stdout)
    if (parsed) return parsed
    return { ok: false, stage: 'load', error: `unreadable runner output (${describeExecFailure(result)})` }
  }

  return {
    async snapshotFiles(target, input) {
      try {
        if (!(await probeBinary(target))) return null
        if (!ensureCacheLink(target.worktreeDir, logger)) return null
        const files = filterCodeGraphFiles(target.worktreeDir, input.files)
        if (files.length === 0) return null

        const result = await runSnapshot(target, files)
        if (!result.ok) {
          logger.error(`[code-graph] snapshot ${result.stage} failed in ${target.key}: ${result.error}`)
          return null
        }
        if (result.index !== 'synced') logger.log(`[code-graph] index ${result.index} in ${target.key}`)
        return formatCodeGraphReport({ title: input.title, takenAt: new Date(), files: result.files, affectedTests: result.affectedTests })
      } catch (err) {
        logger.error(`[code-graph] snapshot failed for ${target.key}`, err)
        return null
      }
    },
  }
}
