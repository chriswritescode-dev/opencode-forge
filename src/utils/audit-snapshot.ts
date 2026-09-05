import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { isAbsolute, join } from 'path'
import { tmpdir } from 'os'
import type { Logger } from '../types'
import { runCommand } from '../sandbox/process'
import { WORKTREE_OPENCODE_CONFIG_FILENAME } from '../workspace/worktree-opencode-config'

export interface AuditSnapshotResult {
  commit: string
  ref: string
}

const AUDIT_REF_PREFIX = 'refs/forge/audits/'
const AUDIT_REF_SEGMENT_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{40}|[0-9a-f]{64})$/
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ZERO_OID = '0'.repeat(40)
const GIT_SECURITY_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.fsmonitor=false']
const SNAPSHOT_COMMIT_MESSAGE = 'Forge checkpoint'
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Forge',
  GIT_AUTHOR_EMAIL: 'forge@localhost',
  GIT_COMMITTER_NAME: 'Forge',
  GIT_COMMITTER_EMAIL: 'forge@localhost',
}
const SNAPSHOT_TIMEOUT_MS = 120000
const TEMP_DIR_PREFIX = 'forge-audit-snapshot-'
const DIFF_LINE_LIMIT = 200
const SECRET_BASENAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'])
const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'])

function isSecretLikePath(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  if (base === '.env' || base.startsWith('.env.')) return true
  if (SECRET_BASENAMES.has(base)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex < 0) return false
  return SECRET_EXTENSIONS.has(base.slice(dotIndex).toLowerCase())
}

function isForgeTransientPath(path: string): boolean {
  return path === '.forge' || path.startsWith('.forge/')
}

function validateAuditRef(ref: string): string {
  if (!ref.startsWith(AUDIT_REF_PREFIX)) {
    throw new Error(`invalid audit ref "${ref}": must start with ${AUDIT_REF_PREFIX}`)
  }
  const segment = ref.slice(AUDIT_REF_PREFIX.length)
  if (!AUDIT_REF_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`invalid audit ref "${ref}": segment must be a UUID or hex commit hash`)
  }
  return ref
}

function validateCommitSha(sha: string, label: string): string {
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`invalid ${label} "${sha.slice(0, 80)}": expected a hex commit SHA`)
  }
  return sha
}

function gitEnv(overrides: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    ...overrides,
  }
}

async function runGitCommand(cwd: string, args: string[], env: Record<string, string>, logger: Logger, label: string): Promise<string> {
  const result = await runCommand('git', [...GIT_SECURITY_ARGS, ...args], {
    cwd,
    env,
    timeout: SNAPSHOT_TIMEOUT_MS,
    logger,
    logLabel: `audit-snapshot:${label}`,
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`)
  }
  return result.stdout
}

async function runGitProbe(cwd: string, args: string[], logger: Logger, label: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCommand('git', [...GIT_SECURITY_ARGS, ...args], {
    cwd,
    env: gitEnv({}),
    timeout: SNAPSHOT_TIMEOUT_MS,
    logger,
    logLabel: `audit-snapshot:${label}`,
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

async function resolveWorktreeRoot(cwd: string, logger: Logger): Promise<string> {
  const toplevel = (await runGitCommand(cwd, ['rev-parse', '--show-toplevel'], gitEnv({}), logger, 'toplevel')).trim()
  if (toplevel.length === 0) {
    throw new Error(`audit snapshot failed: "${cwd}" is not inside a git worktree`)
  }
  return toplevel
}

async function resolveGitDir(toplevel: string, logger: Logger): Promise<string> {
  const gitDir = (await runGitCommand(toplevel, ['rev-parse', '--git-dir'], gitEnv({}), logger, 'git-dir')).trim()
  return isAbsolute(gitDir) ? gitDir : join(toplevel, gitDir)
}

async function listTrackedFiles(toplevel: string, logger: Logger): Promise<string[]> {
  const out = await runGitCommand(toplevel, ['ls-files', '-z'], gitEnv({}), logger, 'ls-files')
  return out.split('\0').filter((path) => path.length > 0)
}

async function listUntrackedNonIgnoredFiles(toplevel: string, logger: Logger): Promise<string[]> {
  const out = await runGitCommand(toplevel, ['ls-files', '--others', '--exclude-standard', '-z'], gitEnv({}), logger, 'ls-files-others')
  return out.split('\0').filter((path) => path.length > 0)
}

async function assertNoUntrackedSecrets(toplevel: string, logger: Logger): Promise<void> {
  const untracked = await listUntrackedNonIgnoredFiles(toplevel, logger)
  const secrets = untracked.filter((path) => !isForgeTransientPath(path) && isSecretLikePath(path))
  if (secrets.length > 0) {
    const preview = secrets.slice(0, 5).join(', ')
    const suffix = secrets.length > 5 ? `, and ${secrets.length - 5} more` : ''
    throw new Error(`audit snapshot aborted: untracked secret-like files present (${preview}${suffix}); exclude them through repository ignore rules or remove them from the worktree`)
  }
}

async function resolveHeadSha(toplevel: string, logger: Logger): Promise<string | null> {
  const result = await runGitProbe(toplevel, ['rev-parse', '--verify', '--quiet', 'HEAD'], logger, 'head')
  if (result.exitCode === 0) return validateCommitSha(result.stdout.trim(), 'HEAD SHA')
  if (result.exitCode === 1) return null
  throw new Error(`git rev-parse HEAD failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`)
}

async function assertIndexSupported(toplevel: string, logger: Logger): Promise<void> {
  const sparse = await runGitProbe(toplevel, ['config', '--get', 'core.sparseCheckout'], logger, 'config-get')
  if (sparse.exitCode === 0) {
    const value = sparse.stdout.trim().toLowerCase()
    if (value.length > 0 && value !== 'false' && value !== 'no' && value !== 'off' && value !== '0') {
      throw new Error('audit snapshot aborted: sparse checkout is enabled; exact snapshots do not support sparse checkouts')
    }
  }
  const verbose = await runGitCommand(toplevel, ['ls-files', '-v'], gitEnv({}), logger, 'ls-files-flags')
  for (const line of verbose.split('\n')) {
    if (line.length === 0) continue
    const tag = line[0]
    if (tag === 'S' || tag === 's' || tag !== tag.toUpperCase()) {
      throw new Error(`audit snapshot aborted: index contains unsupported entry flags (${tag} for ${line.slice(2)}); exact snapshots require a plain index`)
    }
  }
}

async function listIndexGitlinks(cwd: string, env: Record<string, string>, logger: Logger, label: string): Promise<string[]> {
  const raw = await runGitCommand(cwd, ['ls-files', '--stage', '-z'], env, logger, label)
  return raw
    .split('\0')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
}

async function assertSubmodulesClean(toplevel: string, submodulePaths: string[], logger: Logger): Promise<void> {
  if (submodulePaths.length === 0) return
  const status = await runGitCommand(
    toplevel,
    ['status', '--porcelain=v2', '--ignore-submodules=none', '--', ...submodulePaths],
    gitEnv({}),
    logger,
    'status',
  )
  if (status.trim().length > 0) {
    throw new Error('audit snapshot aborted: submodule working state is dirty, changed, or uninitialized; exact snapshots do not support unclean submodules')
  }
}

async function assertAuditRefAvailable(toplevel: string, refName: string, logger: Logger): Promise<void> {
  const probe = await runGitProbe(toplevel, ['show-ref', '--verify', '--quiet', refName], logger, 'show-ref')
  if (probe.exitCode === 0) {
    throw new Error(`audit snapshot ref already exists: ${refName}`)
  }
}

async function removeIndexEntries(toplevel: string, paths: string[], env: Record<string, string>, logger: Logger): Promise<void> {
  if (paths.length === 0) return
  await runGitCommand(toplevel, ['update-index', '--force-remove', '--', ...paths], env, logger, 'update-index')
}

async function buildSnapshotTree(
  toplevel: string,
  tempDir: string,
  passName: string,
  realIndexPath: string,
  originalTracked: Set<string>,
  originalGitlinks: Set<string>,
  logger: Logger,
): Promise<string> {
  const altIndex = join(tempDir, `index-${passName}`)
  if (existsSync(realIndexPath)) {
    copyFileSync(realIndexPath, altIndex)
  } else {
    await runGitCommand(toplevel, ['read-tree', '--empty'], gitEnv({ GIT_INDEX_FILE: altIndex }), logger, 'read-tree')
  }
  const indexEnv = gitEnv({ GIT_INDEX_FILE: altIndex })
  await assertNoUntrackedSecrets(toplevel, logger)
  const pathspecs = ['.', ':(exclude).forge']
  if (!originalTracked.has(WORKTREE_OPENCODE_CONFIG_FILENAME)) {
    pathspecs.push(`:(exclude)${WORKTREE_OPENCODE_CONFIG_FILENAME}`)
  }
  await runGitCommand(toplevel, ['add', '-A', '--', ...pathspecs], indexEnv, logger, 'add')
  const entries = (await runGitCommand(toplevel, ['ls-files', '-z'], indexEnv, logger, 'ls-files'))
    .split('\0')
    .filter((entry) => entry.length > 0)
  const racedSecrets = entries.filter(
    (entry) => isSecretLikePath(entry) && !isForgeTransientPath(entry) && !originalTracked.has(entry),
  )
  if (racedSecrets.length > 0) {
    const preview = racedSecrets.slice(0, 5).join(', ')
    throw new Error(`audit snapshot aborted: secret-like files appeared during capture (${preview}); exclude them through repository ignore rules or remove them from the worktree`)
  }
  const stagedGitlinks = await listIndexGitlinks(toplevel, indexEnv, logger, 'ls-files-stage')
  const newGitlinks = stagedGitlinks.filter((path) => !originalGitlinks.has(path))
  if (newGitlinks.length > 0) {
    const preview = newGitlinks.slice(0, 5).join(', ')
    throw new Error(`audit snapshot aborted: untracked nested git repositories discovered (${preview}); commit them as submodules or exclude them through repository ignore rules`)
  }
  await assertSubmodulesClean(toplevel, stagedGitlinks, logger)
  const removals = entries.filter(isForgeTransientPath)
  await removeIndexEntries(toplevel, removals, indexEnv, logger)
  const tree = (await runGitCommand(toplevel, ['write-tree'], indexEnv, logger, 'write-tree')).trim()
  return validateCommitSha(tree, 'tree SHA')
}

async function createSnapshotCommit(toplevel: string, tree: string, parent: string | null, logger: Logger): Promise<string> {
  const args = parent
    ? ['commit-tree', tree, '-p', parent, '-m', SNAPSHOT_COMMIT_MESSAGE]
    : ['commit-tree', tree, '-m', SNAPSHOT_COMMIT_MESSAGE]
  const commit = (await runGitCommand(toplevel, args, gitEnv(SNAPSHOT_IDENTITY), logger, 'commit-tree')).trim()
  return validateCommitSha(commit, 'snapshot commit SHA')
}

export async function captureAuditSnapshot(cwd: string, ref: string, logger: Logger): Promise<AuditSnapshotResult> {
  const refName = validateAuditRef(ref)
  const toplevel = await resolveWorktreeRoot(cwd, logger)
  const realIndexPath = join(await resolveGitDir(toplevel, logger), 'index')
  const headBefore = await resolveHeadSha(toplevel, logger)
  const originalTracked = new Set(await listTrackedFiles(toplevel, logger))
  const originalGitlinks = new Set(await listIndexGitlinks(toplevel, gitEnv({}), logger, 'ls-files-stage'))
  await assertIndexSupported(toplevel, logger)
  await assertSubmodulesClean(toplevel, [...originalGitlinks], logger)
  await assertNoUntrackedSecrets(toplevel, logger)
  await assertAuditRefAvailable(toplevel, refName, logger)
  const tempDir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX))
  try {
    const firstTree = await buildSnapshotTree(toplevel, tempDir, 'a', realIndexPath, originalTracked, originalGitlinks, logger)
    const secondTree = await buildSnapshotTree(toplevel, tempDir, 'b', realIndexPath, originalTracked, originalGitlinks, logger)
    if (firstTree !== secondTree) {
      throw new Error('audit snapshot unstable: worktree changed during capture')
    }
    const headAfter = await resolveHeadSha(toplevel, logger)
    if (headAfter !== headBefore) {
      throw new Error('audit snapshot unstable: HEAD moved during capture')
    }
    const commit = await createSnapshotCommit(toplevel, firstTree, headBefore, logger)
    await runGitCommand(toplevel, ['update-ref', refName, commit, ZERO_OID], gitEnv({}), logger, 'update-ref')
    return { commit, ref: refName }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function compareAuditSnapshots(cwd: string, previous: string, current: string, logger: Logger): Promise<string> {
  validateCommitSha(previous, 'previous snapshot SHA')
  validateCommitSha(current, 'current snapshot SHA')
  const toplevel = await resolveWorktreeRoot(cwd, logger)
  for (const sha of [previous, current]) {
    const probe = await runGitProbe(toplevel, ['cat-file', '-e', `${sha}^{commit}`], logger, 'cat-file')
    if (probe.exitCode !== 0) {
      throw new Error(`audit snapshot commit not found in repository: ${sha}`)
    }
  }
  const env = gitEnv({})
  const stat = (
    await runGitCommand(toplevel, ['diff', '--no-ext-diff', '--no-textconv', '--stat', previous, current], env, logger, 'diff-stat')
  ).split('\n').slice(0, DIFF_LINE_LIMIT).join('\n').trim()
  const nameStatusLines = (await runGitCommand(toplevel, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', previous, current], env, logger, 'diff-name-status'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
  const boundedNameStatusLines = nameStatusLines.slice(0, DIFF_LINE_LIMIT)
  const omitted = nameStatusLines.length - boundedNameStatusLines.length
  const nameStatus = omitted > 0 ? `${boundedNameStatusLines.join('\n')}\n... ${omitted} more changed paths` : boundedNameStatusLines.join('\n')
  return [stat, nameStatus].filter((part) => part.length > 0).join('\n')
}

export async function deleteAuditSnapshot(cwd: string, ref: string, logger: Logger): Promise<void> {
  const refName = validateAuditRef(ref)
  const toplevel = await resolveWorktreeRoot(cwd, logger)
  const probe = await runGitProbe(toplevel, ['show-ref', '--verify', '--quiet', refName], logger, 'show-ref')
  if (probe.exitCode !== 0) {
    throw new Error(`audit snapshot ref not found: ${refName}`)
  }
  await runGitCommand(toplevel, ['update-ref', '-d', refName], gitEnv({}), logger, 'update-ref-delete')
}
