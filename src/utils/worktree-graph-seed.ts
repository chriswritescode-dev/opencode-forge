/**
 * Worktree graph seeding helper.
 * 
 * This module provides a shared helper for seeding a worktree-scoped graph cache
 * from an existing source repo graph cache. This reduces loop startup latency by
 * reusing the graph cache when the target worktree matches the source fingerprint.
 */

import { existsSync, mkdirSync, cpSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../types'
import { resolveGraphCacheDir } from '../storage/graph-projects'
import { readGraphCacheMetadata, writeGraphCacheMetadata, type GraphCacheMetadata } from '../graph/database'
import { collectIndexFingerprint } from '../graph/utils'
import { readGraphStatus, writeGraphStatus } from '../utils/graph-status-store'
import type { GraphStatusRepo } from '../storage/repos/graph-status-repo'
import { Database } from 'bun:sqlite'

/**
 * Options for seeding a worktree graph scope
 */
export interface SeedWorktreeGraphScopeOptions {
  /** Project ID for the graph cache */
  projectId: string
  /** Source working directory (original repo) */
  sourceCwd: string
  /** Target working directory (worktree) */
  targetCwd: string
  /** Data directory for graph cache storage */
  dataDir: string
  /** Graph status repo for status copy (optional, for tool-side path) */
  graphStatusRepo?: GraphStatusRepo
  /** Optional logger for logging seed operations */
  logger?: Logger
}

/**
 * Result of a graph seeding attempt
 */
export interface SeedResult {
  /** Whether the graph was successfully seeded */
  seeded: boolean
  /** Reason for the result (success or skip reason) */
  reason: string
}

/**
 * Validates that a graph database is healthy by checking:
 * 1. Integrity check passes
 * 2. Tables exist
 * 3. Files table row count matches the expected indexedFileCount from metadata
 * 
 * @param dbPath - Path to the graph.db file
 * @param expectedFileCount - Expected number of indexed files from metadata
 * @returns true if the database is healthy and matches expected state, false otherwise
 */
function validateGraphDatabaseHealth(dbPath: string, expectedFileCount: number): boolean {
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      // Run integrity check
      const integrityResult = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      if (integrityResult.integrity_check !== 'ok') {
        return false
      }

      // Check that graph tables exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      const hasFilesTable = tables.some(t => t.name === 'files')
      
      if (!hasFilesTable) {
        // No files table means empty graph
        return expectedFileCount === 0
      }

      // Verify the files table row count matches metadata
      const countResult = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }
      if (countResult.c !== expectedFileCount) {
        // Row count mismatch indicates partial/corrupt graph
        return false
      }

      // If we get here, the database is healthy and matches metadata
      return true
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

/**
 * Seeds a worktree graph scope from an existing source graph cache.
 * 
 * This function:
 * 1. Resolves source and target cache directories
 * 2. Validates source metadata exists with fingerprint fields
 * 3. Computes target fingerprint and compares to source
 * 4. Copies graph cache (DB, WAL/SHM, metadata) if fingerprints match
 * 5. Rewrites target metadata with new cwd
 * 6. Copies ready graph status if source status is ready
 * 
 * @param options - Seeding options
 * @returns SeedResult indicating success or skip reason
 */
export async function seedWorktreeGraphScope(options: SeedWorktreeGraphScopeOptions): Promise<SeedResult> {
  const {
    projectId,
    sourceCwd,
    targetCwd,
    dataDir,
    graphStatusRepo,
    logger,
  } = options

  const log = logger?.log ?? (() => {})

  // Step 1: Resolve source and target cache directories
  const sourceCacheDir = resolveGraphCacheDir(projectId, sourceCwd, dataDir)
  const targetCacheDir = resolveGraphCacheDir(projectId, targetCwd, dataDir)

  // Step 2: Skip if source cache directory or metadata is missing
  if (!existsSync(sourceCacheDir)) {
    const reason = 'source cache directory missing'
    log(`graph seed: ${reason} (${sourceCacheDir})`)
    return { seeded: false, reason }
  }

  const sourceMetadata = readGraphCacheMetadata(sourceCacheDir)
  if (!sourceMetadata) {
    const reason = 'source metadata file missing'
    log(`graph seed: ${reason} (${sourceCacheDir})`)
    return { seeded: false, reason }
  }

  // Step 2b: Skip if source graph.db is missing
  const sourceGraphDbPath = join(sourceCacheDir, 'graph.db')
  if (!existsSync(sourceGraphDbPath)) {
    const reason = 'source graph.db missing'
    log(`graph seed: ${reason} (${sourceGraphDbPath})`)
    return { seeded: false, reason }
  }

  // Step 3: Require fingerprint fields to exist in source metadata
  if (sourceMetadata.indexedFileCount === undefined || sourceMetadata.indexedMaxMtimeMs === undefined) {
    const reason = 'source metadata incomplete (missing fingerprint fields)'
    log(`graph seed: ${reason}`)
    return { seeded: false, reason }
  }

  // Step 4: Skip if target cache already exists
  if (existsSync(targetCacheDir)) {
    const reason = 'target cache already exists'
    log(`graph seed: ${reason} (${targetCacheDir})`)
    return { seeded: false, reason }
  }

  // Step 5: Compute target fingerprint and compare
  const targetFingerprint = await collectIndexFingerprint(targetCwd, targetCacheDir)

  if (
    targetFingerprint.fileCount !== sourceMetadata.indexedFileCount ||
    targetFingerprint.maxMtimeMs !== sourceMetadata.indexedMaxMtimeMs
  ) {
    const reason = 'worktree fingerprint mismatch'
    log(`graph seed: ${reason} (source: ${sourceMetadata.indexedFileCount} files, ${sourceMetadata.indexedMaxMtimeMs} mtime; target: ${targetFingerprint.fileCount} files, ${targetFingerprint.maxMtimeMs} mtime)`)
    return { seeded: false, reason }
  }

  // Step 5b: Validate source graph database health before copying
  // This prevents seeding a worktree with a corrupt or empty graph database
  // Also verify row count matches metadata to catch partial/corrupt graphs
  const sourceGraphHealthy = validateGraphDatabaseHealth(sourceGraphDbPath, sourceMetadata.indexedFileCount ?? 0)
  if (!sourceGraphHealthy) {
    const reason = 'source graph database unhealthy or empty'
    log(`graph seed: ${reason} (${sourceGraphDbPath})`)
    return { seeded: false, reason }
  }

  // Step 6: Copy graph cache directory (graph.db, WAL/SHM, metadata)
  try {
    mkdirSync(targetCacheDir, { recursive: true })
    cpSync(sourceCacheDir, targetCacheDir, { recursive: true, dereference: false })
    log(`graph seed: copied cache from ${sourceCacheDir} to ${targetCacheDir}`)
  } catch (err) {
    const reason = `copy failed: ${err instanceof Error ? err.message : String(err)}`
    log(`graph seed: ${reason}`)
    return { seeded: false, reason }
  }

  // Step 7: Rewrite target metadata with new cwd
  const targetMetadata: GraphCacheMetadata = {
    projectId: sourceMetadata.projectId,
    cwd: targetCwd,
    createdAt: sourceMetadata.createdAt,
    lastIndexedAt: sourceMetadata.lastIndexedAt,
    indexedFileCount: sourceMetadata.indexedFileCount,
    indexedMaxMtimeMs: sourceMetadata.indexedMaxMtimeMs,
  }

  const metadataWriteSuccess = writeGraphCacheMetadata(targetCacheDir, targetMetadata)
  if (!metadataWriteSuccess) {
    const reason = 'failed to rewrite target metadata'
    log(`graph seed: ${reason}`)
    // Continue anyway - cache is still usable
  }

  // Step 8: Copy ready graph status if source status is ready AND source graph is healthy
  let statusCopied = false
  
  // Source graph health was already validated before copying the cache
  // Reuse the sourceGraphHealthy value from earlier in this function
  
  if (graphStatusRepo) {
    const sourceStatus = readGraphStatus(graphStatusRepo, projectId, sourceCwd)
    if (sourceStatus && sourceStatus.state === 'ready' && sourceGraphHealthy) {
      writeGraphStatus(graphStatusRepo, projectId, {
        ...sourceStatus,
        updatedAt: Date.now(),
      }, targetCwd)
      statusCopied = true
      log(`graph seed: copied ready status to worktree scope`)
    } else if (sourceStatus && sourceStatus.state === 'ready' && !sourceGraphHealthy) {
      log(`graph seed: skipped status copy - source graph unhealthy`)
    }
  }

  const seedReason = `seeded successfully (${statusCopied ? 'with status' : 'without status'})`
  log(`graph seed: ${seedReason}`)
  return { seeded: true, reason: seedReason }
}
