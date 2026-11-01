import { execSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitService } from '../../src/utils/git-service'
import { commitWorktreeChanges } from '../../src/workspace/worktree-commit'
import { createFakeGitService } from '../helpers/fake-git'

const logger = { log: () => {}, error: () => {}, debug: () => {} }
const tempDirs: string[] = []

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-commit-'))
  tempDirs.push(dir)
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir })
  return dir
}

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8' })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('commitWorktreeChanges', () => {
  it("never commits Forge's .codegraph cache link and leaves it untracked in place", () => {
    const dir = initRepo()
    symlinkSync('/opt/forge/cache/codegraph', join(dir, '.codegraph'))
    writeFileSync(join(dir, 'work.txt'), 'work\n')

    expect(commitWorktreeChanges(createGitService(), logger, dir, 'section 1: work')).toBe('committed')

    expect(git(dir, 'show --name-only --format= HEAD').trim().split('\n')).toEqual(['work.txt'])
    expect(git(dir, 'status --porcelain')).toBe('?? .codegraph\n')
    expect(commitWorktreeChanges(createGitService(), logger, dir, 'section 2: nothing')).toBe('no-changes')
  })

  it('commits a .codegraph directory the repository provides itself', () => {
    const dir = initRepo()
    mkdirSync(join(dir, '.codegraph'))
    writeFileSync(join(dir, '.codegraph', 'config.json'), '{}\n')

    expect(commitWorktreeChanges(createGitService(), logger, dir, 'repo codegraph config')).toBe('committed')

    expect(git(dir, 'show --name-only --format= HEAD').trim()).toBe('.codegraph/config.json')
  })

  it('does not commit when the cache link cannot be unstaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-commit-fake-'))
    tempDirs.push(dir)
    symlinkSync('/opt/forge/cache/codegraph', join(dir, '.codegraph'))
    const fakeGit = createFakeGitService({
      removeFromIndex: () => ({ ok: false, status: 128, stdout: '', stderr: 'index.lock exists' }),
    })

    expect(commitWorktreeChanges(fakeGit, logger, dir, 'section 1')).toBe('failed')
    expect(fakeGit.commit).not.toHaveBeenCalled()
  })
})
