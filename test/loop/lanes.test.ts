import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLane, laneExists, mergeLane, removeLoopLanes } from '../../src/loop/lanes'
import { createGitService } from '../../src/utils/git-service'
import { forgeLanesDir } from '../../src/workspace/forge-naming'
import { createMockLogger } from '../helpers/logger'

const tempDirs: string[] = []

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8' })
}

function initRepoWithLoopWorktree(): { repoDir: string; loopDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'forge-lanes-'))
  tempDirs.push(rootDir)
  const repoDir = join(rootDir, 'repo')
  mkdirSync(repoDir)
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: repoDir })
  const baseBranch = git(repoDir, 'rev-parse --abbrev-ref HEAD').trim()
  const loopDir = join(rootDir, 'loop')
  git(repoDir, `worktree add "${loopDir}" -b forge/demo ${baseBranch}`)
  return { repoDir, loopDir }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('section lanes', () => {
  it('merges lanes that edit different files into the loop worktree', () => {
    const { loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()

    const lane1 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1' })
    const lane2 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-2' })

    expect(laneExists(lane1.laneDir)).toBe(true)
    writeFileSync(join(lane1.laneDir, 'one.txt'), 'one\n')
    writeFileSync(join(lane2.laneDir, 'two.txt'), 'two\n')

    expect(
      mergeLane({ git: gitService, logger, worktreeDir: loopDir, laneDir: lane1.laneDir, laneBranch: lane1.laneBranch, title: 'section 1' }),
    ).toMatchObject({ kind: 'merged' })
    expect(
      mergeLane({ git: gitService, logger, worktreeDir: loopDir, laneDir: lane2.laneDir, laneBranch: lane2.laneBranch, title: 'section 2' }),
    ).toMatchObject({ kind: 'merged' })

    expect(readFileSync(join(loopDir, 'one.txt'), 'utf-8')).toBe('one\n')
    expect(readFileSync(join(loopDir, 'two.txt'), 'utf-8')).toBe('two\n')
    expect(git(loopDir, 'rev-list --merges --count HEAD').trim()).toBe('2')
  })

  it('aborts a conflicting merge in the loop worktree and reports lane conflicts', () => {
    const { loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()

    const lane1 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1' })
    const lane2 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-2' })
    writeFileSync(join(lane1.laneDir, 'conflict.txt'), 'from-one\n')
    writeFileSync(join(lane2.laneDir, 'conflict.txt'), 'from-two\n')

    expect(
      mergeLane({ git: gitService, logger, worktreeDir: loopDir, laneDir: lane1.laneDir, laneBranch: lane1.laneBranch, title: 'section 1' }),
    ).toMatchObject({ kind: 'merged' })

    const beforeSha = git(loopDir, 'rev-parse HEAD').trim()
    const beforeStatus = git(loopDir, 'status --porcelain')

    const result = mergeLane({
      git: gitService,
      logger,
      worktreeDir: loopDir,
      laneDir: lane2.laneDir,
      laneBranch: lane2.laneBranch,
      title: 'section 2',
    })

    expect(result).toEqual({ kind: 'conflict', files: ['conflict.txt'] })
    expect(git(loopDir, 'rev-parse HEAD').trim()).toBe(beforeSha)
    expect(git(loopDir, 'status --porcelain')).toBe(beforeStatus)
    expect(readFileSync(join(lane2.laneDir, 'conflict.txt'), 'utf-8')).toContain('<<<<<<<')

    writeFileSync(join(lane2.laneDir, 'conflict.txt'), 'resolved\n')
    execSync('git add -A && git commit -q -m resolve', { cwd: lane2.laneDir })

    expect(
      mergeLane({ git: gitService, logger, worktreeDir: loopDir, laneDir: lane2.laneDir, laneBranch: lane2.laneBranch, title: 'section 2' }),
    ).toMatchObject({ kind: 'merged' })
    expect(readFileSync(join(loopDir, 'conflict.txt'), 'utf-8')).toBe('resolved\n')
  })

  it('removes every lane worktree and branch of a loop', async () => {
    const { loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()

    createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1' })
    createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-2' })

    await removeLoopLanes({ git: gitService, logger, worktreeDir: loopDir, loopName: 'demo' })

    expect(existsSync(forgeLanesDir(loopDir))).toBe(false)
    expect(git(loopDir, "branch --list 'forge-lane/demo/*'").trim()).toBe('')
  })

  it('force-updates a stale lane branch to the loop worktree tip', () => {
    const { repoDir, loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()
    const baseBranch = git(repoDir, 'rev-parse --abbrev-ref HEAD').trim()

    execSync('git commit -q --allow-empty -m other', { cwd: repoDir })
    git(repoDir, `branch forge-lane/demo/section-1 ${baseBranch}`)

    const loopTip = git(loopDir, 'rev-parse HEAD').trim()
    expect(git(repoDir, 'rev-parse forge-lane/demo/section-1').trim()).not.toBe(loopTip)

    const lane = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1' })

    expect(lane.baseCommit).toBe(loopTip)
    expect(git(lane.laneDir, 'rev-parse HEAD').trim()).toBe(loopTip)
  })
})
