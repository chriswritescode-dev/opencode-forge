import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLane, laneExists, lanePrepareOptions, listLaneUnmergedFiles, mergeLane, removeLoopLanes } from '../../src/loop/lanes'
import { createGitService } from '../../src/utils/git-service'
import { forgeLanesDir } from '../../src/workspace/forge-naming'
import type { PluginConfig } from '../../src/types'
import { createMockLogger } from '../helpers/logger'
import { createFakeGitService } from '../helpers/fake-git'

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

function excludeContent(dir: string): string {
  let excludePath = git(dir, 'rev-parse --git-path info/exclude').trim()
  if (!isAbsolute(excludePath)) excludePath = join(dir, excludePath)
  return readFileSync(excludePath, 'utf-8')
}

describe('section lanes', () => {
  it('merges lanes that edit different files into the loop worktree', () => {
    const { loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()

    const lane1 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1', prepare: {} })
    const lane2 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-2', prepare: {} })

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

    const lane1 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1', prepare: {} })
    const lane2 = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-2', prepare: {} })
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

    createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1', prepare: {} })
    createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-2', prepare: {} })

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

    const lane = createLane({ git: gitService, logger, loopName: 'demo', worktreeDir: loopDir, sectionId: 'section-1', prepare: {} })

    expect(lane.baseCommit).toBe(loopTip)
    expect(git(lane.laneDir, 'rev-parse HEAD').trim()).toBe(loopTip)
  })

  it('prepares a lane with the loop opencode config and git excludes', () => {
    const { loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()
    const config = {
      loop: {
        worktreeOpencodeConfig: { mcp: { demo: { type: 'local', command: ['x'], enabled: true } } },
      },
    } as PluginConfig

    const lane = createLane({
      git: gitService,
      logger,
      loopName: 'demo',
      worktreeDir: loopDir,
      sectionId: 'section-1',
      prepare: lanePrepareOptions(config, { loopName: 'demo', sandbox: false }),
    })

    expect(JSON.parse(readFileSync(join(lane.laneDir, 'opencode.jsonc'), 'utf-8'))).toEqual(
      config.loop!.worktreeOpencodeConfig,
    )
    const exclude = excludeContent(lane.laneDir)
    expect(exclude).toContain('.forge/')
    expect(exclude).toContain('opencode.jsonc')
    expect(exclude).not.toContain('.codegraph')
  })

  it('prepares a sandboxed lane with the container name and code-graph exclude', () => {
    const { loopDir } = initRepoWithLoopWorktree()
    const gitService = createGitService()
    const logger = createMockLogger()
    const config = {
      loop: {
        worktreeOpencodeConfig: {
          mcp: { demo: { type: 'local', command: ['docker', 'exec', '{{FORGE_SANDBOX_CONTAINER}}', 'x'] } },
        },
      },
    } as PluginConfig

    const lane = createLane({
      git: gitService,
      logger,
      loopName: 'demo',
      worktreeDir: loopDir,
      sectionId: 'section-1',
      prepare: lanePrepareOptions(config, { loopName: 'demo', sandbox: true }),
    })

    const written = JSON.parse(readFileSync(join(lane.laneDir, 'opencode.jsonc'), 'utf-8'))
    expect(written.mcp.demo.command).toEqual(['docker', 'exec', 'forge-demo', 'x'])
    expect(excludeContent(lane.laneDir)).toContain('.codegraph')
  })
})

describe('lane merge failures', () => {
  it('reports a failed merge into the lane when no conflict files are listed', () => {
    const gitService = createFakeGitService({
      revParseHead: () => ({ ok: true, status: 0, stdout: 'abc123\n', stderr: '' }),
      merge: () => ({ ok: false, status: 1, stdout: '', stderr: 'CONFLICT' }),
      mergeAbort: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
      statusPorcelain: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
      mergeIntoWorktree: () => ({ ok: false, status: 1, stdout: '', stderr: 'fatal: merge failed' }),
      listUnmergedFiles: () => ({ ok: true, status: 0, stdout: '\n', stderr: '' }),
    })

    const result = mergeLane({
      git: gitService,
      logger: createMockLogger(),
      worktreeDir: '/loop',
      laneDir: '/loop.lanes/section-1',
      laneBranch: 'forge-lane/demo/section-1',
      title: 'section 1',
    })

    expect(result).toEqual({
      kind: 'failed',
      error: 'lanes: could not merge loop tip into lane: fatal: merge failed',
    })
  })

  it('returns null when the lane conflict list cannot be read', () => {
    expect(
      listLaneUnmergedFiles(
        createFakeGitService({ listUnmergedFiles: () => ({ ok: false, status: 1, stdout: '', stderr: 'boom' }) }),
        '/lane',
      ),
    ).toBeNull()
  })

  it('returns trimmed non-empty lane conflict paths', () => {
    expect(
      listLaneUnmergedFiles(
        createFakeGitService({ listUnmergedFiles: () => ({ ok: true, status: 0, stdout: ' a.txt\n\nb.txt \n', stderr: '' }) }),
        '/lane',
      ),
    ).toEqual(['a.txt', 'b.txt'])
  })
})
