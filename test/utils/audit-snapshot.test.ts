import { describe, it, expect, afterEach, vi } from 'vitest'
import { execSync } from 'child_process'
import { randomBytes } from 'crypto'
import { isAbsolute, join } from 'path'
import { tmpdir } from 'os'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { captureAuditSnapshot, compareAuditSnapshots, deleteAuditSnapshot } from '../../src/utils/audit-snapshot'
import type { Logger } from '../../src/types'

const runCommandState = vi.hoisted(() => ({
  intercept: null as null | ((command: string, args: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined),
}))

vi.mock('../../src/sandbox/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sandbox/process')>()
  return {
    ...actual,
    runCommand: (command: string, args: string[], opts: Parameters<typeof actual.runCommand>[2]) => {
      const scripted = runCommandState.intercept?.(command, args)
      if (scripted) return Promise.resolve(scripted)
      return actual.runCommand(command, args, opts)
    },
  }
})

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

const tempDirs: string[] = []

function initRepo(prefix: string, withCommit = true): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  execSync('git init && git config user.email t@t && git config user.name t', { cwd: dir, encoding: 'utf-8' })
  if (withCommit) {
    writeFileSync(join(dir, 'base.txt'), 'base\n', 'utf-8')
    writeFileSync(join(dir, 'gone.txt'), 'gone\n', 'utf-8')
    writeFileSync(join(dir, 'with space.txt'), 'spaced\n', 'utf-8')
    writeFileSync(join(dir, '.gitignore'), 'ignored.log\n', 'utf-8')
    execSync('git add -A && git commit -m init', { cwd: dir, encoding: 'utf-8' })
  }
  return dir
}

function gitOut(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8' })
}

function treePaths(dir: string, commit: string): string[] {
  return gitOut(dir, `ls-tree -r --name-only ${commit}`).split('\n').filter((line) => line.length > 0)
}

function hexSha(): string {
  return randomBytes(20).toString('hex')
}

function auditRef(): string {
  return `refs/forge/audits/${hexSha()}`
}

function headSha(dir: string): string {
  return gitOut(dir, 'rev-parse HEAD').trim()
}

function indexBytes(dir: string): Buffer {
  const raw = gitOut(dir, 'rev-parse --git-path index').trim()
  const path = isAbsolute(raw) ? raw : join(dir, raw)
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
}

function refExists(dir: string, ref: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet ${ref}`, { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function scanTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('forge-audit-snapshot-'))
}

afterEach(() => {
  runCommandState.intercept = null
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('captureAuditSnapshot', () => {
  it('captures staged, unstaged, deleted, new, ignored, and spaced-name files correctly', async () => {
    const repo = initRepo('audit-snapshot-capture-')
    writeFileSync(join(repo, 'base.txt'), 'modified\n', 'utf-8')
    rmSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'staged-new.txt'), 'staged\n', 'utf-8')
    execSync('git add staged-new.txt', { cwd: repo, encoding: 'utf-8' })
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n', 'utf-8')
    writeFileSync(join(repo, 'ignored.log'), 'ignored\n', 'utf-8')
    const ref = auditRef()

    const snapshot = await captureAuditSnapshot(repo, ref, logger)

    expect(snapshot.ref).toBe(ref)
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/)
    const paths = treePaths(repo, snapshot.commit)
    expect(paths).toContain('with space.txt')
    expect(paths).toContain('staged-new.txt')
    expect(paths).toContain('untracked.txt')
    expect(paths).toContain('base.txt')
    expect(paths).not.toContain('gone.txt')
    expect(paths).not.toContain('ignored.log')
    expect(gitOut(repo, `show ${snapshot.commit}:base.txt`)).toBe('modified\n')
    expect(gitOut(repo, `show ${snapshot.commit}:staged-new.txt`)).toBe('staged\n')
    expect(gitOut(repo, `rev-parse ${ref}`).trim()).toBe(snapshot.commit)
  })

  it('excludes .forge and untracked opencode.jsonc but keeps tracked opencode.jsonc', async () => {
    const repo = initRepo('audit-snapshot-transient-')
    mkdirSync(join(repo, '.forge'))
    writeFileSync(join(repo, '.forge', 'state.json'), '{}\n', 'utf-8')
    writeFileSync(join(repo, 'opencode.jsonc'), '{}\n', 'utf-8')

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)

    const paths = treePaths(repo, snapshot.commit)
    expect(paths.some((path) => path.startsWith('.forge/'))).toBe(false)
    expect(paths).not.toContain('opencode.jsonc')

    execSync('git add opencode.jsonc && git commit -m add-config', { cwd: repo, encoding: 'utf-8' })
    const trackedSnapshot = await captureAuditSnapshot(repo, auditRef(), logger)
    expect(treePaths(repo, trackedSnapshot.commit)).toContain('opencode.jsonc')
  })

  it('excludes an opencode.jsonc that escapes the initial untracked listing', async () => {
    const repo = initRepo('audit-snapshot-late-config-')
    writeFileSync(join(repo, 'opencode.jsonc'), '{}\n', 'utf-8')
    runCommandState.intercept = (_command, args) => {
      if (args.includes('ls-files') && args.includes('--others')) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return undefined
    }

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)

    expect(treePaths(repo, snapshot.commit)).not.toContain('opencode.jsonc')
  })

  it('throws on untracked non-ignored secret-like files without creating the ref or temp dirs', async () => {
    const repo = initRepo('audit-snapshot-secret-')
    writeFileSync(join(repo, '.env.local'), 'SECRET=1\n', 'utf-8')
    const ref = auditRef()

    await expect(captureAuditSnapshot(repo, ref, logger)).rejects.toThrow(/secret-like/)
    expect(refExists(repo, ref)).toBe(false)
    expect(scanTempDirs()).toHaveLength(0)
  })

  it('throws on untracked non-ignored key files', async () => {
    const repo = initRepo('audit-snapshot-key-')
    writeFileSync(join(repo, 'server.pem'), '-----BEGIN\n', 'utf-8')
    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/secret-like/)
  })

  it('does not fail on secret-like files inside .forge and still excludes them', async () => {
    const repo = initRepo('audit-snapshot-forge-secret-')
    mkdirSync(join(repo, '.forge'))
    writeFileSync(join(repo, '.forge', 'cache.pem'), '-----BEGIN\n', 'utf-8')

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)

    expect(treePaths(repo, snapshot.commit).some((path) => path.startsWith('.forge/'))).toBe(false)
  })

  it('detects a secret that escapes the untracked listing via post-stage verification', async () => {
    const repo = initRepo('audit-snapshot-raced-secret-')
    writeFileSync(join(repo, '.env'), 'SECRET=1\n', 'utf-8')
    const ref = auditRef()
    runCommandState.intercept = (_command, args) => {
      if (args.includes('ls-files') && args.includes('--others')) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return undefined
    }

    await expect(captureAuditSnapshot(repo, ref, logger)).rejects.toThrow(/secret-like/)
    expect(refExists(repo, ref)).toBe(false)
  })

  it('allows ignored secret-like files and leaves them out of the snapshot', async () => {
    const repo = initRepo('audit-snapshot-ignored-secret-')
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n.env\n*.pem\nid_rsa\n', 'utf-8')
    execSync('git add .gitignore && git commit -m ignore-secrets', { cwd: repo, encoding: 'utf-8' })
    writeFileSync(join(repo, '.env'), 'SECRET=1\n', 'utf-8')
    writeFileSync(join(repo, 'id_rsa'), 'private\n', 'utf-8')

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)

    const paths = treePaths(repo, snapshot.commit)
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('id_rsa')
  })

  it('includes tracked key files', async () => {
    const repo = initRepo('audit-snapshot-tracked-key-')
    writeFileSync(join(repo, 'server.key'), 'tracked-key\n', 'utf-8')
    execSync('git add server.key && git commit -m add-key', { cwd: repo, encoding: 'utf-8' })

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)

    expect(treePaths(repo, snapshot.commit)).toContain('server.key')
  })

  it('leaves the user index, HEAD, and worktree files untouched', async () => {
    const repo = initRepo('audit-snapshot-clean-')
    writeFileSync(join(repo, 'staged-new.txt'), 'staged\n', 'utf-8')
    execSync('git add staged-new.txt', { cwd: repo, encoding: 'utf-8' })
    const beforeIndex = indexBytes(repo)
    const beforeHead = headSha(repo)
    const beforeBase = readFileSync(join(repo, 'base.txt'))

    await captureAuditSnapshot(repo, auditRef(), logger)

    expect(indexBytes(repo)).toEqual(beforeIndex)
    expect(headSha(repo)).toBe(beforeHead)
    expect(readFileSync(join(repo, 'base.txt'))).toEqual(beforeBase)
  })

  it('handles an unborn HEAD', async () => {
    const repo = initRepo('audit-snapshot-unborn-', false)
    writeFileSync(join(repo, 'first.txt'), 'first\n', 'utf-8')

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)

    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/)
    const commitObject = gitOut(repo, `cat-file -p ${snapshot.commit}`)
    expect(commitObject).not.toMatch(/^parent /m)
    expect(treePaths(repo, snapshot.commit)).toContain('first.txt')
  })

  it('supports a linked worktree without touching the main worktree index', async () => {
    const repo = initRepo('audit-snapshot-wt-')
    const worktree = join(repo, '..', `audit-wt-${hexSha().slice(0, 8)}`)
    tempDirs.push(worktree)
    execSync(`git worktree add "${worktree}" -b audit-wt-branch`, { cwd: repo, encoding: 'utf-8' })
    writeFileSync(join(worktree, 'wt-file.txt'), 'wt\n', 'utf-8')
    execSync('git add wt-file.txt', { cwd: worktree, encoding: 'utf-8' })
    const beforeIndex = indexBytes(repo)
    const beforeHead = headSha(repo)

    const snapshot = await captureAuditSnapshot(worktree, auditRef(), logger)

    const paths = treePaths(worktree, snapshot.commit)
    expect(paths).toContain('wt-file.txt')
    expect(paths).toContain('base.txt')
    expect(indexBytes(repo)).toEqual(beforeIndex)
    expect(headSha(repo)).toBe(beforeHead)
  })

  it('falls back when sparse checkout is enabled', async () => {
    const repo = initRepo('audit-snapshot-sparse-')
    execSync('git sparse-checkout init --cone', { cwd: repo, encoding: 'utf-8' })
    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/sparse checkout/)
  })

  it('falls back on skip-worktree and assume-unchanged entries', async () => {
    const repo = initRepo('audit-snapshot-flags-')
    execSync('git update-index --skip-worktree base.txt', { cwd: repo, encoding: 'utf-8' })
    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/unsupported entry flags/)
    execSync('git update-index --no-skip-worktree base.txt && git update-index --assume-unchanged base.txt', { cwd: repo, encoding: 'utf-8' })
    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/unsupported entry flags/)
  })

  it('captures clean submodules and falls back on dirty ones', async () => {
    const repo = initRepo('audit-snapshot-sub-')
    const inner = initRepo('audit-snapshot-sub-inner-')
    writeFileSync(join(inner, 'sub-file.txt'), 'sub\n', 'utf-8')
    execSync('git add sub-file.txt && git commit -m sub-commit', { cwd: inner, encoding: 'utf-8' })
    execSync(`git -c protocol.file.allow=always submodule add "${inner}" sub`, { cwd: repo, encoding: 'utf-8' })
    execSync('git commit -m add-submodule', { cwd: repo, encoding: 'utf-8' })

    const snapshot = await captureAuditSnapshot(repo, auditRef(), logger)
    const paths = treePaths(repo, snapshot.commit)
    expect(paths).toContain('sub')
    expect(paths).toContain('.gitmodules')

    writeFileSync(join(repo, 'sub', 'dirty.txt'), 'd\n', 'utf-8')
    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/submodule/)
  })

  it('falls back on an untracked nested git repository, dirty or clean', async () => {
    const repo = initRepo('audit-snapshot-nested-')
    const nested = join(repo, 'nested')
    mkdirSync(nested)
    execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m inner-init', { cwd: nested, encoding: 'utf-8' })
    writeFileSync(join(nested, 'dirty.txt'), 'd\n', 'utf-8')
    const ref = auditRef()
    const beforeIndex = indexBytes(repo)
    const beforeHead = headSha(repo)

    await expect(captureAuditSnapshot(repo, ref, logger)).rejects.toThrow(/nested git/)
    expect(refExists(repo, ref)).toBe(false)

    rmSync(join(nested, 'dirty.txt'))
    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/nested git/)
    expect(refExists(repo, ref)).toBe(false)
    expect(indexBytes(repo)).toEqual(beforeIndex)
    expect(headSha(repo)).toBe(beforeHead)
  })

  it('rejects capturing over an existing audit ref', async () => {
    const repo = initRepo('audit-snapshot-collision-')
    const ref = auditRef()
    await captureAuditSnapshot(repo, ref, logger)
    await expect(captureAuditSnapshot(repo, ref, logger)).rejects.toThrow(/already exists/)
  })

  it('fails when the tree changes between the two capture passes', async () => {
    const repo = initRepo('audit-snapshot-unstable-')
    let writeTreeCalls = 0
    runCommandState.intercept = (_command, args) => {
      if (args.includes('write-tree')) {
        writeTreeCalls++
        if (writeTreeCalls === 2) {
          return { exitCode: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' }
        }
      }
      return undefined
    }
    const ref = auditRef()

    await expect(captureAuditSnapshot(repo, ref, logger)).rejects.toThrow(/unstable/)
    expect(refExists(repo, ref)).toBe(false)
    expect(scanTempDirs()).toHaveLength(0)
  })

  it('fails when HEAD moves during capture', async () => {
    const repo = initRepo('audit-snapshot-headmove-')
    let headProbes = 0
    runCommandState.intercept = (_command, args) => {
      if (args.includes('rev-parse') && args.includes('--verify') && args.includes('HEAD')) {
        headProbes++
        if (headProbes === 2) {
          return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
        }
      }
      return undefined
    }

    await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/HEAD/)
  })

  it('cleans up temp files when capture fails mid-way', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return
    }
    const repo = initRepo('audit-snapshot-fail-')
    writeFileSync(join(repo, 'locked.txt'), 'x\n', 'utf-8')
    chmodSync(join(repo, 'locked.txt'), 0o000)
    try {
      await expect(captureAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow()
    } finally {
      chmodSync(join(repo, 'locked.txt'), 0o644)
    }
    expect(scanTempDirs()).toHaveLength(0)
  })

  it('rejects invalid audit refs', async () => {
    const repo = initRepo('audit-snapshot-badref-')
    await expect(captureAuditSnapshot(repo, 'refs/heads/main', logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, 'refs/forge/other/x', logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, 'refs/forge/audits/', logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, 'refs/forge/audits/not-a-uuid', logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, `refs/forge/audits/${hexSha().toUpperCase()}`, logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, 'refs/forge/audits/../../refs/heads/main', logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, `refs/forge/audits/${'g'.repeat(40)}`, logger)).rejects.toThrow(/invalid audit ref/)
    await expect(captureAuditSnapshot(repo, '', logger)).rejects.toThrow(/invalid audit ref/)
  })

  it('throws a descriptive error outside a git repository', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'audit-snapshot-nonrepo-'))
    tempDirs.push(nonRepo)
    await expect(captureAuditSnapshot(nonRepo, auditRef(), logger)).rejects.toThrow(/not a git repository/i)
  })
})

describe('compareAuditSnapshots', () => {
  it('returns a stat and name-status summary between two snapshots', async () => {
    const repo = initRepo('audit-snapshot-compare-')
    const previous = await captureAuditSnapshot(repo, auditRef(), logger)
    writeFileSync(join(repo, 'base.txt'), 'changed\n', 'utf-8')
    writeFileSync(join(repo, 'added.txt'), 'added\n', 'utf-8')
    const current = await captureAuditSnapshot(repo, auditRef(), logger)

    const summary = await compareAuditSnapshots(repo, previous.commit, current.commit, logger)

    expect(summary).toContain('|')
    expect(summary).toContain('base.txt')
    expect(summary).toContain('added.txt')
    expect(summary).toContain('M\tbase.txt')
    expect(summary).toContain('A\tadded.txt')
  })

  it('returns an empty summary for identical snapshots', async () => {
    const repo = initRepo('audit-snapshot-compare-same-')
    const previous = await captureAuditSnapshot(repo, auditRef(), logger)
    const current = await captureAuditSnapshot(repo, auditRef(), logger)

    const summary = await compareAuditSnapshots(repo, previous.commit, current.commit, logger)

    expect(summary).toBe('')
  })

  it('rejects invalid commit SHAs', async () => {
    const repo = initRepo('audit-snapshot-compare-bad-')
    await expect(compareAuditSnapshots(repo, 'not-a-sha', hexSha(), logger)).rejects.toThrow(/invalid/)
    await expect(compareAuditSnapshots(repo, hexSha(), 'nothex', logger)).rejects.toThrow(/invalid/)
  })

  it('rejects commits missing from the repository', async () => {
    const repo = initRepo('audit-snapshot-compare-missing-')
    const current = await captureAuditSnapshot(repo, auditRef(), logger)
    await expect(compareAuditSnapshots(repo, '0'.repeat(40), current.commit, logger)).rejects.toThrow(/not found/)
    await expect(compareAuditSnapshots(repo, current.commit, '0'.repeat(40), logger)).rejects.toThrow(/not found/)
  })

  it('does not run an external diff helper', async () => {
    const repo = initRepo('audit-snapshot-compare-extdiff-')
    execSync(`git config diff.external "echo EXTERNAL_DIFF_RAN"`, { cwd: repo, encoding: 'utf-8' })
    const previous = await captureAuditSnapshot(repo, auditRef(), logger)
    writeFileSync(join(repo, 'base.txt'), 'changed\n', 'utf-8')
    const current = await captureAuditSnapshot(repo, auditRef(), logger)

    const summary = await compareAuditSnapshots(repo, previous.commit, current.commit, logger)

    expect(summary).toContain('base.txt')
    expect(summary).not.toContain('EXTERNAL_DIFF_RAN')
  })
})

describe('deleteAuditSnapshot', () => {
  it('deletes an existing audit ref', async () => {
    const repo = initRepo('audit-snapshot-delete-')
    const ref = auditRef()
    await captureAuditSnapshot(repo, ref, logger)
    expect(refExists(repo, ref)).toBe(true)

    await deleteAuditSnapshot(repo, ref, logger)

    expect(refExists(repo, ref)).toBe(false)
  })

  it('throws when deleting a nonexistent ref', async () => {
    const repo = initRepo('audit-snapshot-delete-missing-')
    await expect(deleteAuditSnapshot(repo, auditRef(), logger)).rejects.toThrow(/not found/)
  })

  it('throws on invalid refs', async () => {
    const repo = initRepo('audit-snapshot-delete-bad-')
    await expect(deleteAuditSnapshot(repo, 'refs/heads/main', logger)).rejects.toThrow(/invalid audit ref/)
  })
})
