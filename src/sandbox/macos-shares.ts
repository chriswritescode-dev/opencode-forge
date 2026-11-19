import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'fs'
import { isAbsolute, join } from 'path'
import type { Logger, SandboxMountConfig } from '../types'
import { buildSandboxWorkspaces, resolveCustomMounts } from './manager'
import { canonicalizeExistingPath, canonicalizePath, isSameOrDescendantPath, type SandboxMount } from './path'

export const MACOS_VM_NAME = 'forge-macos'

export const MACOS_SETUP_SHARE_TAG = 'forge-setup'

export function macosShareTag(hostDir: string): string {
  const digest = createHash('sha256').update(canonicalizePath(hostDir)).digest('hex')
  return `forge-${digest.slice(0, 12)}`
}

export interface MacosShare {
  hostDir: string
  guestDir: string
  readOnly: boolean
  tag: string
}

export function planMacosShares(
  input: {
    roots: string[]
    worktreesDir: string
    tmpDir?: string
    toolOutputDir?: string
    skillsDir?: string
    extraMounts: SandboxMountConfig[]
    homeDir: string
  },
  logger: Logger,
): MacosShare[] {
  const candidates: SandboxMount[] = []

  for (const raw of input.roots) {
    const dir = expandHomeDir(raw, input.homeDir)
    if (!isAbsolute(dir)) {
      logger.log(`Sandbox: skipping macOS root; path must be absolute: ${raw}`)
      continue
    }
    if (!existsSync(dir)) {
      logger.log(`Sandbox: skipping macOS root; directory does not exist: ${dir}`)
      continue
    }
    candidates.push({ hostDir: dir, containerDir: dir, readOnly: false })
  }

  mkdirSync(input.worktreesDir, { recursive: true })
  candidates.push({ hostDir: input.worktreesDir, containerDir: input.worktreesDir, readOnly: false })

  if (input.tmpDir) {
    mkdirSync(input.tmpDir, { recursive: true })
    candidates.push({ hostDir: input.tmpDir, containerDir: input.tmpDir, readOnly: false })
  }

  for (const [dir, label] of [
    [input.toolOutputDir, 'tool-output'] as const,
    [input.skillsDir, 'skills'] as const,
  ]) {
    if (!dir) continue
    if (!existsSync(dir)) {
      logger.log(`Sandbox: skipping macOS ${label} mount; directory does not exist: ${dir}`)
      continue
    }
    candidates.push({ hostDir: dir, containerDir: dir, readOnly: true })
  }

  candidates.push(...resolveCustomMounts(input.extraMounts, new Set(), logger))

  return buildSandboxWorkspaces(candidates, logger).map((workspace) => ({
    hostDir: workspace.hostDir,
    guestDir: workspace.containerDir,
    readOnly: workspace.readOnly === true,
    tag: macosShareTag(workspace.hostDir),
  }))
}

export function macosMountsFromShares(shares: MacosShare[]): SandboxMount[] {
  return shares.map((share) => ({
    hostDir: share.guestDir,
    containerDir: share.guestDir,
    readOnly: share.readOnly,
  }))
}

export function assertDirectoryInsideMacosShares(dir: string, shares: MacosShare[]): MacosShare {
  const canonicalDir = canonicalizeExistingPath(dir)
  let match: MacosShare | undefined
  let matchLength = -1
  for (const share of shares) {
    const canonicalHost = canonicalizeExistingPath(share.hostDir)
    if (canonicalHost.length <= matchLength) continue
    if (!isSameOrDescendantPath(canonicalDir, canonicalHost)) continue
    match = share
    matchLength = canonicalHost.length
  }
  if (!match || match.readOnly) {
    const writableGuestDirs = shares.filter((share) => !share.readOnly).map((share) => share.guestDir)
    throw new Error(
      `Directory ${dir} is outside the macOS sandbox roots (${writableGuestDirs.join(', ')}); add a parent folder to sandbox.macos.roots and restart the forge-macos VM (lume stop forge-macos). Refusing to run it on the host.`,
    )
  }
  return match
}

function expandHomeDir(dir: string, homeDir: string): string {
  if (dir === '~') return homeDir
  if (dir.startsWith('~/')) return join(homeDir, dir.slice(2))
  return dir
}
