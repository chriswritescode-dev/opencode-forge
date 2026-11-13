import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmdirSync, unlinkSync } from 'fs'
import { dirname, join, relative } from 'path'
import { z } from 'zod'

export type Manifest = Record<string, string>

const manifestSchema = z.record(z.string(), z.string())

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
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf-8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function writeManifest(manifestPath: string, manifest: Manifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

export type FileState = 'missing' | 'unchanged' | 'pristine' | 'edited' | 'unknown'

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
  bundleDiffers: boolean
}

export interface OrphanFile {
  rel: string
  dest: string
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
    if (destHash === bundledHash) {
      state = 'unchanged'
      autoAction = 'adopt'
    } else {
      state = 'unknown'
      autoAction = 'skip'
    }
  } else if (destHash === recorded) {
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

export function installFile(file: PlannedFile, manifest: Manifest): void {
  mkdirSync(dirname(file.dest), { recursive: true })
  copyFileSync(file.src, file.dest)
  manifest[file.rel] = file.bundledHash
}

export function recordKeptFile(file: PlannedFile, manifest: Manifest): void {
  manifest[file.rel] = file.bundledHash
}

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

export function pruneOrphan(orphan: OrphanFile, destDir: string, manifest: Manifest): void {
  if (orphan.destExists) {
    try {
      unlinkSync(orphan.dest)
      removeEmptyDirsUpTo(dirname(orphan.dest), destDir)
    } catch {
    }
  }
  delete manifest[orphan.rel]
}

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
