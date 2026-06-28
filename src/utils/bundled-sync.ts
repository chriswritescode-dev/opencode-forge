import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmdirSync, unlinkSync } from 'fs'
import { dirname, join, relative } from 'path'

export type Manifest = Record<string, string>

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

function collectFiles(dir: string, root: string, filter?: (relPath: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(abs, root, filter))
    } else {
      const rel = relative(root, abs)
      if (!filter || filter(rel)) {
        files.push(rel)
      }
    }
  }
  return files
}

export function readManifest(manifestPath: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
  } catch {
    return {}
  }
}

export function writeManifest(manifestPath: string, manifest: Manifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

/**
 * Provenance of a destination file relative to the bundled source and manifest.
 * - `missing`   — not installed yet
 * - `unchanged` — present and byte-identical to the bundled version
 * - `pristine`  — matches the last installed bundled hash but the bundle has since changed
 * - `edited`    — tracked in the manifest but locally modified by the user
 * - `unknown`   — present, untracked, and differs from the bundled version
 */
export type FileState = 'missing' | 'unchanged' | 'pristine' | 'edited' | 'unknown'

/**
 * Action the silent startup sync takes for a file. This is the conservative,
 * non-interactive resolution that never destroys user edits.
 * - `create`  — copy in a brand-new file and record it
 * - `refresh` — overwrite a pristine file with a changed bundle and record it
 * - `adopt`   — record an already-identical untracked file (no copy)
 * - `skip`    — leave the file untouched (unchanged, edited, or unknown)
 */
export type AutoAction = 'create' | 'refresh' | 'adopt' | 'skip'

export interface PlannedFile {
  rel: string
  src: string
  dest: string
  bundledHash: string
  recorded: string | undefined
  destHash: string | undefined
  state: FileState
  autoAction: AutoAction
  /** Installing the bundled version would change the file's current content. */
  bundleDiffers: boolean
}

export interface OrphanFile {
  rel: string
  dest: string
  /** The orphan still exists on disk (vs. only lingering in the manifest). */
  destExists: boolean
}

export interface SyncPlan {
  files: PlannedFile[]
  orphans: OrphanFile[]
}

function classify(
  rel: string,
  srcDir: string,
  destDir: string,
  manifest: Manifest,
): PlannedFile {
  const src = join(srcDir, rel)
  const dest = join(destDir, rel)
  const bundledHash = sha256(readFileSync(src, 'utf-8'))
  const recorded = manifest[rel]
  const destExists = existsSync(dest)
  const destHash = destExists ? sha256(readFileSync(dest, 'utf-8')) : undefined

  let state: FileState
  let autoAction: AutoAction

  if (!destExists) {
    state = 'missing'
    autoAction = 'create'
  } else if (recorded === undefined) {
    // Untracked: adopt only when it already matches the bundle, otherwise it is
    // a file of unknown provenance and must be left alone.
    if (destHash === bundledHash) {
      state = 'unchanged'
      autoAction = 'adopt'
    } else {
      state = 'unknown'
      autoAction = 'skip'
    }
  } else if (destHash === recorded) {
    // Pristine relative to the last install; refresh only if the bundle moved.
    if (bundledHash !== recorded) {
      state = 'pristine'
      autoAction = 'refresh'
    } else {
      state = 'unchanged'
      autoAction = 'skip'
    }
  } else {
    state = 'edited'
    autoAction = 'skip'
  }

  return {
    rel,
    src,
    dest,
    bundledHash,
    recorded,
    destHash,
    state,
    autoAction,
    bundleDiffers: destHash !== bundledHash,
  }
}

/**
 * Build a sync plan describing, per bundled file, the current provenance of the
 * destination and what the silent sync would do. Also lists orphans: manifest
 * entries whose bundled source no longer exists (left over from older layouts).
 */
export function planBundledSync(
  srcDir: string,
  destDir: string,
  manifest: Manifest,
  filter?: (relPath: string) => boolean,
): SyncPlan {
  const files = existsSync(srcDir)
    ? collectFiles(srcDir, srcDir, filter).map((rel) => classify(rel, srcDir, destDir, manifest))
    : []

  const bundled = new Set(files.map((f) => f.rel))
  const orphans: OrphanFile[] = []
  for (const rel of Object.keys(manifest)) {
    if (bundled.has(rel)) continue
    const src = join(srcDir, rel)
    if (existsSync(src)) continue
    const dest = join(destDir, rel)
    orphans.push({ rel, dest, destExists: existsSync(dest) })
  }

  return { files, orphans }
}

/** Copy the bundled version over the destination and record its hash. */
export function installFile(file: PlannedFile, manifest: Manifest): void {
  mkdirSync(dirname(file.dest), { recursive: true })
  copyFileSync(file.src, file.dest)
  manifest[file.rel] = file.bundledHash
}

/**
 * Keep the user's current destination file but mark it as diverged from the
 * bundle, so future silent syncs preserve it instead of refreshing it.
 */
export function recordKeptFile(file: PlannedFile, manifest: Manifest): void {
  // Recording the bundled hash guarantees `destHash !== recorded`, which the
  // silent sync treats as a user edit and leaves untouched.
  manifest[file.rel] = file.bundledHash
}

/** Remove an empty directory and any now-empty parents up to (not incl.) root. */
function removeEmptyDirsUpTo(dir: string, root: string): void {
  let current = dir
  while (current.startsWith(root) && current !== root) {
    try {
      if (readdirSync(current).length > 0) break
      rmdirSync(current)
    } catch {
      break
    }
    current = dirname(current)
  }
}

/** Delete an orphaned destination file and drop its manifest entry. */
export function pruneOrphan(orphan: OrphanFile, destDir: string, manifest: Manifest): void {
  if (orphan.destExists) {
    try {
      unlinkSync(orphan.dest)
      removeEmptyDirsUpTo(dirname(orphan.dest), destDir)
    } catch {
      // best-effort cleanup
    }
  }
  delete manifest[orphan.rel]
}

/**
 * Apply the conservative, non-interactive resolution of a plan to disk and
 * return whether the manifest changed. Shared by the silent startup sync.
 */
function applyAutoPlan(plan: SyncPlan, manifest: Manifest): boolean {
  let changed = false
  for (const file of plan.files) {
    switch (file.autoAction) {
      case 'create':
      case 'refresh':
        installFile(file, manifest)
        changed = true
        break
      case 'adopt':
        manifest[file.rel] = file.bundledHash
        changed = true
        break
      case 'skip':
        break
    }
  }
  return changed
}

/**
 * Silent, non-interactive sync used at plugin startup. Installs new files,
 * refreshes pristine files when the bundle changes, adopts already-identical
 * files, and preserves anything the user has edited. Never deletes files.
 */
export function syncBundledDir(
  srcDir: string,
  destDir: string,
  manifestPath: string,
  filter?: (relPath: string) => boolean,
): void {
  if (!existsSync(srcDir)) return

  const manifest = readManifest(manifestPath)
  const plan = planBundledSync(srcDir, destDir, manifest, filter)
  const changed = applyAutoPlan(plan, manifest)

  if (changed) {
    writeManifest(manifestPath, manifest)
  }
}
