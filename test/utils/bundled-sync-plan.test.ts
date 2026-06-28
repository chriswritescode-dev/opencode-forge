import { describe, test, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  planBundledSync,
  pruneOrphan,
  recordKeptFile,
  readManifest,
  writeManifest,
  sha256,
  syncBundledDir,
  type Manifest,
} from '../../src/utils/bundled-sync'

const dirs: string[] = []
function tmpDir(label: string): string {
  const dir = `/tmp/forge-plan-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('planBundledSync', () => {
  test('classifies missing / unchanged / pristine / edited / unknown states', () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    mkdirSync(src, { recursive: true })
    mkdirSync(dest, { recursive: true })

    writeFileSync(join(src, 'missing.md'), 'BUNDLE')
    writeFileSync(join(src, 'unchanged.md'), 'SAME')
    writeFileSync(join(src, 'pristine.md'), 'BUNDLE_V2')
    writeFileSync(join(src, 'edited.md'), 'BUNDLE_V2')
    writeFileSync(join(src, 'unknown.md'), 'BUNDLE')

    writeFileSync(join(dest, 'unchanged.md'), 'SAME')
    writeFileSync(join(dest, 'pristine.md'), 'BUNDLE_V1') // matches recorded, bundle moved
    writeFileSync(join(dest, 'edited.md'), 'USER EDIT')
    writeFileSync(join(dest, 'unknown.md'), 'MYSTERY') // untracked, differs from bundle

    const manifest: Manifest = {
      'unchanged.md': sha256('SAME'),
      'pristine.md': sha256('BUNDLE_V1'),
      'edited.md': sha256('BUNDLE_V2'),
    }

    const plan = planBundledSync(src, dest, manifest)
    const byRel = Object.fromEntries(plan.files.map((f) => [f.rel, f]))

    expect(byRel['missing.md'].state).toBe('missing')
    expect(byRel['missing.md'].autoAction).toBe('create')

    expect(byRel['unchanged.md'].state).toBe('unchanged')
    expect(byRel['unchanged.md'].autoAction).toBe('skip')
    expect(byRel['unchanged.md'].bundleDiffers).toBe(false)

    expect(byRel['pristine.md'].state).toBe('pristine')
    expect(byRel['pristine.md'].autoAction).toBe('refresh')
    expect(byRel['pristine.md'].bundleDiffers).toBe(true)

    expect(byRel['edited.md'].state).toBe('edited')
    expect(byRel['edited.md'].autoAction).toBe('skip')
    expect(byRel['edited.md'].bundleDiffers).toBe(true)

    expect(byRel['unknown.md'].state).toBe('unknown')
    expect(byRel['unknown.md'].autoAction).toBe('skip')
  })

  test('reports manifest entries whose bundled source no longer exists as orphans', () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    mkdirSync(join(src, 'commands'), { recursive: true })
    mkdirSync(join(dest, 'prompts', 'commands'), { recursive: true })
    writeFileSync(join(src, 'commands', 'review.md'), 'NEW')
    writeFileSync(join(dest, 'prompts', 'commands', 'review.md'), 'OLD LAYOUT')

    const manifest: Manifest = {
      'commands/review.md': 'irrelevant',
      'prompts/commands/review.md': 'stale-hash', // no longer in the bundle
    }

    const plan = planBundledSync(src, dest, manifest)
    expect(plan.orphans).toHaveLength(1)
    expect(plan.orphans[0].rel).toBe('prompts/commands/review.md')
    expect(plan.orphans[0].destExists).toBe(true)
  })
})

describe('pruneOrphan', () => {
  test('deletes the orphan file, removes empty parent dirs, and drops the manifest entry', () => {
    const dest = tmpDir('dest')
    const orphanRel = 'prompts/commands/review.md'
    const orphanPath = join(dest, orphanRel)
    mkdirSync(join(dest, 'prompts', 'commands'), { recursive: true })
    writeFileSync(orphanPath, 'CRUFT')

    const manifest: Manifest = { 'prompts/commands/review.md': 'h' }
    pruneOrphan({ rel: orphanRel, dest: orphanPath, destExists: true }, dest, manifest)

    expect(existsSync(orphanPath)).toBe(false)
    expect(existsSync(join(dest, 'prompts', 'commands'))).toBe(false)
    expect(existsSync(join(dest, 'prompts'))).toBe(false)
    expect(existsSync(dest)).toBe(true) // never removes the root
    expect(manifest['prompts/commands/review.md']).toBeUndefined()
  })
})

describe('recordKeptFile interaction with syncBundledDir', () => {
  test('a kept conflict is preserved by a subsequent silent sync', () => {
    const src = tmpDir('src')
    const dest = tmpDir('dest')
    const manifestPath = tmpDir('m') + '.json'
    mkdirSync(src, { recursive: true })

    writeFileSync(join(src, 'f.md'), 'BUNDLE_V1')
    syncBundledDir(src, dest, manifestPath) // installs V1, pristine

    // Bundle moves to V2 while the user keeps a customized version.
    writeFileSync(join(src, 'f.md'), 'BUNDLE_V2')
    writeFileSync(join(dest, 'f.md'), 'USER VERSION')

    const manifest = readManifest(manifestPath)
    const plan = planBundledSync(src, dest, manifest)
    const file = plan.files.find((f) => f.rel === 'f.md')!
    recordKeptFile(file, manifest)
    writeManifest(manifestPath, manifest)

    // A later silent sync must NOT clobber the kept version.
    syncBundledDir(src, dest, manifestPath)
    expect(readFileSync(join(dest, 'f.md'), 'utf-8')).toBe('USER VERSION')
  })
})
