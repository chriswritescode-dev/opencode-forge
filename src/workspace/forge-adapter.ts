import { join } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import type { WorkspaceAdapter, WorkspaceInfo } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import { slugify } from '../utils/logger'

export interface ForgeAdapterDeps {
  dataDir: string
  projectRoot: string
  logger: Logger
}

export function createForgeWorkspaceAdapter(deps: ForgeAdapterDeps): WorkspaceAdapter {
  const { dataDir, projectRoot, logger } = deps

  function deriveLoopName(info: WorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { loopName?: unknown }
    const raw = typeof extra.loopName === 'string' ? extra.loopName : ''
    if (!raw) throw new Error('forge workspace adapter: extra.loopName is required')
    return slugify(raw).slice(0, 60)
  }

  return {
    name: 'Forge Worktree',
    description: 'Named git worktree under the forge data directory',
    configure(info) {
      const loopName = deriveLoopName(info)
      return {
        ...info,
        name: loopName,
        branch: `forge/${loopName}`,
        directory: join(dataDir, 'worktrees', loopName),
      }
    },
    async create(info) {
      if (!info.directory || !info.branch) {
        throw new Error('forge workspace adapter: configure must set directory and branch')
      }
      await mkdir(join(dataDir, 'worktrees'), { recursive: true })
      const res = spawnSync('git', ['worktree', 'add', info.directory, '-b', info.branch], {
        cwd: projectRoot,
        encoding: 'utf-8',
      })
      if (res.status !== 0) {
        const stderr = res.stderr?.trim() || 'unknown error'
        logger.error(`forge-adapter: git worktree add failed: ${stderr}`)
        throw new Error(`git worktree add failed: ${stderr}`)
      }
      logger.log(`forge-adapter: created worktree ${info.directory} on branch ${info.branch}`)
    },
    async remove(info) {
      if (!info.directory) return
      if (existsSync(info.directory)) {
        const res = spawnSync('git', ['worktree', 'remove', '-f', info.directory], {
          cwd: projectRoot,
          encoding: 'utf-8',
        })
        if (res.status !== 0 && existsSync(info.directory)) {
          const stderr = res.stderr?.trim() || 'unknown error'
          logger.error(`forge-adapter: git worktree remove failed: ${stderr}`)
          throw new Error(`git worktree remove failed: ${stderr}`)
        }
      }
      spawnSync('git', ['worktree', 'prune'], { cwd: projectRoot, encoding: 'utf-8' })
      logger.log(`forge-adapter: removed worktree ${info.directory}`)
    },
    target(info) {
      return { type: 'local', directory: info.directory! }
    },
  }
}
