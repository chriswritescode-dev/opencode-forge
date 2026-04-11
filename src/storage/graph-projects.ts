/**
 * Graph cache project inventory helpers.
 * 
 * This module provides canonical helpers for enumerating and managing
 * graph cache directories stored under <dataDir>/graph/<projectId::cwd-hash>/graph.db
 */

import { existsSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { resolveDataDir } from './database'
import { readGraphCacheMetadata } from '../graph/database'
import { resolveProjectNames } from '../cli/utils'

/**
 * Result of graph cache directory enumeration
 */
export interface GraphCacheEntry {
  /** Hash directory name (16-character SHA256 prefix) */
  hashDir: string
  /** Absolute path to graph.db file */
  graphDbPath: string
  /** Project ID if successfully resolved, null if unknown */
  projectId: string | null
  /** Cwd scope if successfully resolved, null if unknown */
  cwdScope: string | null
  /** Friendly project name if available (from opencode.db), null otherwise */
  projectName: string | null
  /** Resolution status: 'known' if projectId resolved, 'unknown' otherwise */
  resolutionStatus: 'known' | 'unknown'
  /** File size in bytes */
  sizeBytes: number
  /** Last modification time as Unix timestamp (ms) */
  mtimeMs: number
  /** Display name combining project and worktree info */
  displayName: string
}

/**
 * Hashes a project ID using SHA256 and returns the first 16 hex characters.
 * This matches the hashing logic used in src/graph/database.ts
 * 
 * @param projectId - The project ID to hash
 * @returns 16-character hex string
 */
export function hashProjectId(projectId: string): string {
  return createHash('sha256').update(projectId).digest('hex').substring(0, 16)
}

/**
 * Hashes a graph cache scope using SHA256 and returns the first 16 hex characters.
 * This creates a unique cache identity from projectId and cwd to ensure worktree
 * sessions with the same logical project ID use separate caches.
 * 
 * @param projectId - The project ID
 * @param cwd - The working directory scope
 * @returns 16-character hex string
 */
export function hashGraphCacheScope(projectId: string, cwd: string): string {
  const normalizedCwd = cwd.replace(/\/$/, '')
  const scopeInput = `${projectId}::${normalizedCwd}`
  return hashProjectId(scopeInput)
}

/**
 * Resolves the graph cache directory path for a given project ID and cwd.
 * The cache identity is derived from both projectId and normalized cwd to ensure
 * worktree sessions with the same logical project ID use separate caches.
 * 
 * @param projectId - The project ID
 * @param cwd - The working directory scope
 * @param dataDir - Optional data directory (defaults to resolved data dir)
 * @returns Absolute path to the graph cache directory
 */
export function resolveGraphCacheDir(projectId: string, cwd: string, dataDir?: string): string {
  const resolvedDataDir = dataDir ?? resolveDataDir()
  const normalizedCwd = cwd.replace(/\/$/, '')
  const scopeInput = `${projectId}::${normalizedCwd}`
  const cacheHash = hashProjectId(scopeInput)
  return join(resolvedDataDir, 'graph', cacheHash)
}

/**
 * Legacy overload for backward compatibility when only project ID and dataDir are provided.
 * Falls back to project-only hashing for non-worktree scenarios.
 */
export function resolveGraphCacheDirLegacy(projectId: string, dataDir?: string): string {
  const resolvedDataDir = dataDir ?? resolveDataDir()
  const projectIdHash = hashProjectId(projectId)
  return join(resolvedDataDir, 'graph', projectIdHash)
}

/**
 * Checks if a graph cache directory exists for a given project ID.
 * Note: This is a legacy function that doesn't account for worktree scopes.
 * Use with caution in worktree scenarios.
 * 
 * @param projectId - The project ID
 * @param dataDir - Optional data directory (defaults to resolved data dir)
 * @returns true if the graph cache directory exists
 */
export function hasGraphCache(projectId: string, dataDir?: string): boolean {
  const graphCacheDir = resolveGraphCacheDirLegacy(projectId, dataDir)
  return existsSync(graphCacheDir)
}

/**
 * Enumerates all graph cache directories under the data directory.
 * 
 * This function scans the <dataDir>/graph/ directory and returns information
 * about each discovered graph cache entry. It attempts to resolve project
 * identity by matching against known project IDs from opencode.db.
 * 
 * @param dataDir - Optional data directory (defaults to resolved data dir)
 * @returns Array of graph cache entries
 */
export function enumerateGraphCache(dataDir?: string): GraphCacheEntry[] {
  const resolvedDataDir = dataDir ?? resolveDataDir()
  const graphBaseDir = join(resolvedDataDir, 'graph')
  
  if (!existsSync(graphBaseDir)) {
    return []
  }

  let entries: GraphCacheEntry[]
  
  try {
    const hashDirs = readdirSync(graphBaseDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .filter(name => /^[0-9a-f]{16}$/i.test(name))
    
    entries = hashDirs.map(hashDir => {
      const graphDir = join(graphBaseDir, hashDir)
      const graphDbPath = join(graphDir, 'graph.db')
      const stat = statSync(graphDbPath, { throwIfNoEntry: false })
      
      // Try to read metadata file for identity resolution
      let projectId: string | null = null
      let cwdScope: string | null = null
      let projectName: string | null = null
      let resolutionStatus: 'known' | 'unknown' = 'unknown'
      
      if (stat) {
        const metadata = readGraphCacheMetadata(graphDir)
        if (metadata) {
          projectId = metadata.projectId
          cwdScope = metadata.cwd
          const nameMap = resolveProjectNames()
          projectName = nameMap.get(projectId) ?? null
          resolutionStatus = 'known'
        }
      }
      
      if (!stat) {
        return {
          hashDir,
          graphDbPath,
          projectId,
          cwdScope,
          projectName,
          resolutionStatus,
          sizeBytes: 0,
          mtimeMs: 0,
          displayName: projectId ?? hashDir,
        }
      }

      return {
        hashDir,
        graphDbPath,
        projectId,
        cwdScope,
        projectName,
        resolutionStatus,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        displayName: `${projectId ?? hashDir}${cwdScope ? ` (${cwdScope})` : ''}`,
      }
    })
  } catch {
    return []
  }

  return entries
}

/**
 * Finds a graph cache entry by project ID or hash directory.
 * 
 * @param identifier - Either a project ID or hash directory name
 * @param dataDir - Optional data directory (defaults to resolved data dir)
 * @returns The matching graph cache entry or null if not found
 */
export function findGraphCacheEntry(
  identifier: string,
  dataDir?: string
): GraphCacheEntry | null {
  const entries = enumerateGraphCache(dataDir)
  
  for (const entry of entries) {
    if (entry.projectId === identifier || entry.hashDir === identifier) {
      return entry
    }
  }
  
  return null
}

/**
 * Deletes a graph cache directory.
 * 
 * This function removes the entire graph cache directory for a given
 * hash directory name. It does NOT delete any KV store data.
 * 
 * @param hashDir - The 16-character hash directory name to delete
 * @param dataDir - Optional data directory (defaults to resolved data dir)
 * @returns true if deletion was successful, false otherwise
 */
export function deleteGraphCacheDir(
  hashDir: string,
  dataDir?: string
): boolean {
  const resolvedDataDir = dataDir ?? resolveDataDir()
  const graphBaseDir = join(resolvedDataDir, 'graph')
  const targetDir = join(graphBaseDir, hashDir)
  
  if (!existsSync(targetDir)) {
    return false
  }
  
  try {
    rmSync(targetDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
