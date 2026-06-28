import { existsSync, mkdirSync } from 'fs'
import type { BundleSpec } from './paths'
import {
  installFile,
  planBundledSync,
  pruneOrphan,
  readManifest,
  recordKeptFile,
  writeManifest,
  type OrphanFile,
  type PlannedFile,
} from '../utils/bundled-sync'

/** What to do with a bundled file whose installed copy differs from the bundle. */
export type ConflictChoice = 'overwrite' | 'keep'
/** What to do with an orphaned file no longer present in the bundle. */
export type OrphanChoice = 'delete' | 'keep'

/**
 * Decides conflict and orphan resolutions. The CLI supplies an interactive
 * (readline) implementation; tests and `--force`/`--keep` flags supply
 * non-interactive ones. Keeping this injectable keeps the installer pure and
 * testable.
 */
export interface InstallerPrompter {
  fileConflict(file: PlannedFile): Promise<ConflictChoice>
  orphan(orphan: OrphanFile): Promise<OrphanChoice>
}

export interface InstallOptions {
  /** Resolve orphaned files (prompt to delete). When false, orphans are only reported. */
  prune: boolean
  /** Compute and report the plan without touching disk. */
  dryRun: boolean
}

export interface BundleResult {
  label: string
  title: string
  /** Bundle source directory was missing — nothing to install. */
  unavailable: boolean
  installed: string[]
  overwritten: string[]
  kept: string[]
  /** Untracked-but-identical files whose provenance was recorded. */
  adopted: string[]
  /** Already installed and identical to the bundle. */
  unchanged: number
  pruned: string[]
  orphansKept: string[]
}

export interface InstallSummary {
  bundles: BundleResult[]
  dryRun: boolean
}

function emptyResult(spec: BundleSpec): BundleResult {
  return {
    label: spec.label,
    title: spec.title,
    unavailable: false,
    installed: [],
    overwritten: [],
    kept: [],
    adopted: [],
    unchanged: 0,
    pruned: [],
    orphansKept: [],
  }
}

async function installBundle(
  spec: BundleSpec,
  prompter: InstallerPrompter,
  opts: InstallOptions,
): Promise<BundleResult> {
  const result = emptyResult(spec)

  if (!existsSync(spec.bundledDir)) {
    result.unavailable = true
    return result
  }

  if (!opts.dryRun && !existsSync(spec.destDir)) {
    mkdirSync(spec.destDir, { recursive: true })
  }

  const manifest = readManifest(spec.manifestPath)
  const plan = planBundledSync(spec.bundledDir, spec.destDir, manifest, spec.filter)
  let changed = false

  for (const file of plan.files) {
    if (file.state === 'missing') {
      if (!opts.dryRun) installFile(file, manifest)
      result.installed.push(file.rel)
      changed = true
      continue
    }

    if (!file.bundleDiffers) {
      // Installed copy already matches the bundle; just ensure provenance is recorded.
      if (manifest[file.rel] !== file.bundledHash) {
        if (!opts.dryRun) manifest[file.rel] = file.bundledHash
        result.adopted.push(file.rel)
        changed = true
      } else {
        result.unchanged += 1
      }
      continue
    }

    // The installed copy differs from the bundled version — a real conflict.
    const choice = await prompter.fileConflict(file)
    if (choice === 'overwrite') {
      if (!opts.dryRun) installFile(file, manifest)
      result.overwritten.push(file.rel)
      changed = true
    } else {
      // Keep the user's version but mark it diverged so future silent syncs preserve it.
      if (manifest[file.rel] !== file.bundledHash) {
        if (!opts.dryRun) recordKeptFile(file, manifest)
        changed = true
      }
      result.kept.push(file.rel)
    }
  }

  for (const orphan of plan.orphans) {
    if (!opts.prune) {
      result.orphansKept.push(orphan.rel)
      continue
    }
    const choice = await prompter.orphan(orphan)
    if (choice === 'delete') {
      if (!opts.dryRun) pruneOrphan(orphan, spec.destDir, manifest)
      result.pruned.push(orphan.rel)
      changed = true
    } else {
      result.orphansKept.push(orphan.rel)
    }
  }

  if (changed && !opts.dryRun) {
    writeManifest(spec.manifestPath, manifest)
  }

  return result
}

/**
 * Install every bundle interactively, resolving conflicts and orphans through
 * the supplied prompter. Returns a structured summary for reporting and tests.
 */
export async function runInteractiveInstall(
  specs: BundleSpec[],
  prompter: InstallerPrompter,
  opts: InstallOptions,
): Promise<InstallSummary> {
  const bundles: BundleResult[] = []
  for (const spec of specs) {
    bundles.push(await installBundle(spec, prompter, opts))
  }
  return { bundles, dryRun: opts.dryRun }
}
