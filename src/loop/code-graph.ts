import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { CODE_GRAPH_LINK_NAME, isLoopCodeGraphEnabled } from '../constants/loop'
import { SANDBOX_CACHE_DIR } from '../sandbox/msb'
import { quoteShellArg } from '../sandbox/exec-fs'
import type { SandboxContextManager } from '../sandbox/context'
import type { CommandResult } from '../sandbox/process'
import type { Logger, PluginConfig } from '../types'
import { LRUCache } from '../utils/lru-cache'

const CODE_GRAPH_ENV = 'CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_DAEMON=1 CODEGRAPH_NO_WATCH=1'
const CODE_GRAPH_CACHE_DIR = `${SANDBOX_CACHE_DIR}/codegraph`
const BINARY_PROBE_TIMEOUT_MS = 30000
const INDEX_TIMEOUT_MS = 600000
const SYNC_TIMEOUT_MS = 120000
const QUERY_TIMEOUT_MS = 120000
const PROBED_CONTAINER_LIMIT = 100

export interface CodeGraphTarget {
  key: string
  worktreeDir: string
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
  if (!isLoopCodeGraphEnabled(config)) return null
  if (!state?.sandbox || !state.worktreeDir || !sandboxManager) return null
  const active = sandboxManager.getActive(state.loopName)
  if (!active) return null
  const worktreeDir = state.worktreeDir
  return {
    key: active.containerName,
    worktreeDir,
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

function describeQueryFailure(failure: CommandResult | unknown): string {
  if (failure && typeof failure === 'object' && 'exitCode' in failure) {
    const result = failure as CommandResult
    const detail = result.stderr.trim() || result.stdout.trim()
    return detail ? `_Query failed: ${detail}_` : `_Query failed (exit code ${result.exitCode})._`
  }
  const message = failure instanceof Error ? failure.message : String(failure)
  return `_Query failed: ${message}_`
}

function formatCodeGraphReport(input: {
  title: string
  takenAt: Date
  files: string[]
  affected: string
  nodes: Array<{ file: string; text: string }>
}): string {
  const title = input.title.replace(/\s+/g, ' ').trim() || 'snapshot'
  const lines = [
    `# Code graph: ${title}`,
    '',
    `Snapshot taken at ${input.takenAt.toISOString()} and reflects the worktree at that moment.`,
    '',
    '## Changed or planned files',
    '',
    ...input.files.map((file) => `- ${file}`),
    '',
    '## Affected test files',
    '',
    input.affected,
  ]
  for (const node of input.nodes) {
    lines.push('', `## ${node.file}`, '', '```text', node.text, '```')
  }
  lines.push('')
  return lines.join('\n')
}

export function createCodeGraphSnapshotter({ logger }: { logger: Logger }): CodeGraphSnapshotter {
  const binaryProbes = new LRUCache<Promise<boolean>>(PROBED_CONTAINER_LIMIT)

  function probeBinary(target: CodeGraphTarget): Promise<boolean> {
    const cached = binaryProbes.get(target.key)
    if (cached) return cached
    const pending = target
      .exec('command -v codegraph', BINARY_PROBE_TIMEOUT_MS)
      .then((result) => {
        const found = result.exitCode === 0 && result.stdout.trim().length > 0
        if (!found) logger.error(`[code-graph] codegraph is not available in ${target.key}`)
        return found
      })
      .catch((err) => {
        logger.error(`[code-graph] binary probe failed for ${target.key}`, err)
        return false
      })
    binaryProbes.set(target.key, pending)
    return pending
  }

  async function ensureIndex(target: CodeGraphTarget): Promise<boolean> {
    const mkdir = await target.exec(`mkdir -p ${quoteShellArg(CODE_GRAPH_CACHE_DIR)}`, BINARY_PROBE_TIMEOUT_MS)
    if (mkdir.exitCode !== 0) {
      logger.error(`[code-graph] cannot create ${CODE_GRAPH_CACHE_DIR} in ${target.key}`)
      return false
    }
    if (!ensureCacheLink(target.worktreeDir, logger)) return false

    const dbProbe = await target.exec(
      `if [ -f ${CODE_GRAPH_LINK_NAME}/codegraph.db ]; then echo present; else echo missing; fi`,
      BINARY_PROBE_TIMEOUT_MS,
    )
    const hasIndex = dbProbe.exitCode === 0 && dbProbe.stdout.includes('present')
    const command = hasIndex ? 'codegraph sync --quiet' : 'codegraph init --yes'
    const result = await target.exec(`${CODE_GRAPH_ENV} ${command}`, hasIndex ? SYNC_TIMEOUT_MS : INDEX_TIMEOUT_MS)
    if (result.exitCode === 0) return true
    if (!hasIndex) {
      logger.error(`[code-graph] index creation failed in ${target.key}: ${result.stderr.trim()}`)
      return false
    }

    logger.error(`[code-graph] sync failed in ${target.key}; running a full index`)
    const indexed = await target.exec(`${CODE_GRAPH_ENV} codegraph index --quiet`, INDEX_TIMEOUT_MS)
    if (indexed.exitCode === 0) return true
    logger.error(`[code-graph] full index failed in ${target.key}: ${indexed.stderr.trim()}`)
    return false
  }

  async function runAffected(target: CodeGraphTarget, files: string[]): Promise<string> {
    const command = `${CODE_GRAPH_ENV} codegraph affected --json ${files.map(quoteShellArg).join(' ')}`
    try {
      const result = await target.exec(command, QUERY_TIMEOUT_MS)
      if (result.exitCode !== 0) return describeQueryFailure(result)
      const parsed = JSON.parse(result.stdout) as { affectedTests?: unknown }
      const tests = Array.isArray(parsed.affectedTests)
        ? parsed.affectedTests.filter((test): test is string => typeof test === 'string')
        : []
      return tests.length > 0 ? tests.map((test) => `- ${test}`).join('\n') : '_None reported._'
    } catch (err) {
      return describeQueryFailure(err)
    }
  }

  async function runNode(target: CodeGraphTarget, file: string): Promise<string> {
    try {
      const result = await target.exec(
        `${CODE_GRAPH_ENV} codegraph node --file ${quoteShellArg(file)} --symbols-only`,
        QUERY_TIMEOUT_MS,
      )
      if (result.exitCode !== 0) return describeQueryFailure(result)
      return result.stdout.trim() || '_No symbols reported._'
    } catch (err) {
      return describeQueryFailure(err)
    }
  }

  return {
    async snapshotFiles(target, input) {
      try {
        if (!(await probeBinary(target))) return null
        if (!(await ensureIndex(target))) return null
        const files = filterCodeGraphFiles(target.worktreeDir, input.files)
        if (files.length === 0) return null

        const affected = await runAffected(target, files)
        const nodes: Array<{ file: string; text: string }> = []
        for (const file of files) {
          nodes.push({ file, text: await runNode(target, file) })
        }
        return formatCodeGraphReport({ title: input.title, takenAt: new Date(), files, affected, nodes })
      } catch (err) {
        logger.error(`[code-graph] snapshot failed for ${target.key}`, err)
        return null
      }
    },
  }
}
