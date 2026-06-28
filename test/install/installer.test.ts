import { describe, test, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { BundleSpec } from '../../src/install/paths'
import {
  runInteractiveInstall,
  type ConflictChoice,
  type InstallerPrompter,
  type OrphanChoice,
} from '../../src/install/installer'
import { readManifest, sha256, syncBundledDir } from '../../src/utils/bundled-sync'

const dirs: string[] = []
function tmpDir(label: string): string {
  const dir = `/tmp/forge-installer-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function prompter(file: ConflictChoice, orphan: OrphanChoice): InstallerPrompter {
  return { fileConflict: async () => file, orphan: async () => orphan }
}

function makeSpec(src: string, dest: string, manifestPath: string): BundleSpec {
  return {
    label: 'prompts',
    title: 'Test prompts',
    bundledDir: src,
    destDir: dest,
    manifestPath,
    filter: (rel) => rel.endsWith('.md'),
  }
}

describe('runInteractiveInstall', () => {
  test('installs new files without prompting and records the manifest', async () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    const manifestPath = tmpDir('m') + '.json'
    mkdirSync(join(src, 'commands'), { recursive: true })
    writeFileSync(join(src, 'commands', 'review.md'), 'BUNDLE')

    const summary = await runInteractiveInstall([makeSpec(src, dest, manifestPath)], prompter('keep', 'keep'), {
      prune: true,
      dryRun: false,
    })

    expect(existsSync(join(dest, 'commands', 'review.md'))).toBe(true)
    expect(summary.bundles[0].installed).toContain('commands/review.md')
    expect(readManifest(manifestPath)['commands/review.md']).toBe(sha256('BUNDLE'))
  })

  test('overwrite choice replaces a conflicting file', async () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    const manifestPath = tmpDir('m') + '.json'
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'f.md'), 'BUNDLE_V2')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'f.md'), 'USER EDIT')

    const summary = await runInteractiveInstall(
      [makeSpec(src, dest, manifestPath)],
      prompter('overwrite', 'keep'),
      { prune: true, dryRun: false },
    )

    expect(readFileSync(join(dest, 'f.md'), 'utf-8')).toBe('BUNDLE_V2')
    expect(summary.bundles[0].overwritten).toContain('f.md')
  })

  test('keep choice preserves the file and marks it diverged for future silent syncs', async () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    const manifestPath = tmpDir('m') + '.json'
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'f.md'), 'BUNDLE_V2')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'f.md'), 'USER EDIT')

    const summary = await runInteractiveInstall([makeSpec(src, dest, manifestPath)], prompter('keep', 'keep'), {
      prune: true,
      dryRun: false,
    })

    expect(readFileSync(join(dest, 'f.md'), 'utf-8')).toBe('USER EDIT')
    expect(summary.bundles[0].kept).toContain('f.md')

    // A later silent sync must not clobber the kept edit.
    syncBundledDir(src, dest, manifestPath)
    expect(readFileSync(join(dest, 'f.md'), 'utf-8')).toBe('USER EDIT')
  })

  test('prunes orphans when chosen and leaves them when prune is disabled', async () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    const manifestPath = tmpDir('m') + '.json'
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'keep.md'), 'BUNDLE')
    mkdirSync(join(dest, 'prompts'), { recursive: true })
    writeFileSync(join(dest, 'prompts', 'old.md'), 'CRUFT')
    writeFileSync(manifestPath, JSON.stringify({ 'prompts/old.md': 'stale' }, null, 2))

    // prune disabled: orphan only reported
    const reported = await runInteractiveInstall([makeSpec(src, dest, manifestPath)], prompter('keep', 'delete'), {
      prune: false,
      dryRun: false,
    })
    expect(existsSync(join(dest, 'prompts', 'old.md'))).toBe(true)
    expect(reported.bundles[0].orphansKept).toContain('prompts/old.md')

    // prune enabled + delete: orphan removed and manifest entry dropped
    const pruned = await runInteractiveInstall([makeSpec(src, dest, manifestPath)], prompter('keep', 'delete'), {
      prune: true,
      dryRun: false,
    })
    expect(existsSync(join(dest, 'prompts', 'old.md'))).toBe(false)
    expect(pruned.bundles[0].pruned).toContain('prompts/old.md')
    expect(readManifest(manifestPath)['prompts/old.md']).toBeUndefined()
  })

  test('dry run reports actions without touching disk', async () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    const manifestPath = tmpDir('m') + '.json'
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'f.md'), 'BUNDLE')

    const summary = await runInteractiveInstall([makeSpec(src, dest, manifestPath)], prompter('overwrite', 'delete'), {
      prune: true,
      dryRun: true,
    })

    expect(summary.bundles[0].installed).toContain('f.md')
    expect(existsSync(join(dest, 'f.md'))).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
  })
})
