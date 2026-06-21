import { describe, test, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { syncBundledDir } from '../../src/utils/bundled-sync'

function tmpDir(label: string): string {
  const dir = `/tmp/forge-bundled-sync-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return dir
}

describe('syncBundledDir', () => {
  test('copies missing files and records the manifest', () => {
    const src = tmpDir('missing-src')
    const dest = tmpDir('missing-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'hello.txt'), 'world')

    syncBundledDir(src, dest, manifestPath)

    expect(existsSync(join(dest, 'hello.txt'))).toBe(true)
    expect(readFileSync(join(dest, 'hello.txt'), 'utf-8')).toBe('world')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest['hello.txt']).toBeDefined()
    expect(typeof manifest['hello.txt']).toBe('string')

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('preserves a user-edited dest file when bundled content changes', () => {
    const src = tmpDir('edit-src')
    const dest = tmpDir('edit-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'file.txt'), 'BUNDLED V1')

    // First sync — install bundled version
    syncBundledDir(src, dest, manifestPath)

    // User edits the file
    writeFileSync(join(dest, 'file.txt'), 'USER EDITED')

    // Bundled content changes
    writeFileSync(join(src, 'file.txt'), 'BUNDLED V2')

    // Second sync — should not overwrite user edit
    syncBundledDir(src, dest, manifestPath)

    expect(readFileSync(join(dest, 'file.txt'), 'utf-8')).toBe('USER EDITED')

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('refreshes a pristine dest file when bundled content changes', () => {
    const src = tmpDir('refresh-src')
    const dest = tmpDir('refresh-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'file.txt'), 'BUNDLED V1')

    syncBundledDir(src, dest, manifestPath)

    // File is pristine — same as what was recorded
    writeFileSync(join(src, 'file.txt'), 'BUNDLED V2')

    syncBundledDir(src, dest, manifestPath)

    expect(readFileSync(join(dest, 'file.txt'), 'utf-8')).toBe('BUNDLED V2')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest['file.txt']).toBeDefined()

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('restores a deleted dest file on re-sync', () => {
    const src = tmpDir('restore-src')
    const dest = tmpDir('restore-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'file.txt'), 'BUNDLED')

    syncBundledDir(src, dest, manifestPath)

    // File is deleted
    unlinkSync(join(dest, 'file.txt'))
    expect(existsSync(join(dest, 'file.txt'))).toBe(false)

    syncBundledDir(src, dest, manifestPath)

    expect(existsSync(join(dest, 'file.txt'))).toBe(true)
    expect(readFileSync(join(dest, 'file.txt'), 'utf-8')).toBe('BUNDLED')

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('copies a newly-added bundled file on a later sync', () => {
    const src = tmpDir('new-file-src')
    const dest = tmpDir('new-file-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'existing.txt'), 'EXISTING')

    syncBundledDir(src, dest, manifestPath)

    expect(existsSync(join(dest, 'existing.txt'))).toBe(true)

    // New file added to bundled
    writeFileSync(join(src, 'new.txt'), 'NEW')

    syncBundledDir(src, dest, manifestPath)

    expect(existsSync(join(dest, 'new.txt'))).toBe(true)
    expect(readFileSync(join(dest, 'new.txt'), 'utf-8')).toBe('NEW')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest['new.txt']).toBeDefined()

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('leaves an unknown-provenance dest file untouched', () => {
    const src = tmpDir('unknown-src')
    const dest = tmpDir('unknown-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(src, { recursive: true })
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(src, 'file.txt'), 'BUNDLED')
    writeFileSync(join(dest, 'file.txt'), 'UNKNOWN USER FILE')

    syncBundledDir(src, dest, manifestPath)

    expect(readFileSync(join(dest, 'file.txt'), 'utf-8')).toBe('UNKNOWN USER FILE')

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('only copies files matching the provided filter', () => {
    const src = tmpDir('filter-src')
    const dest = tmpDir('filter-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(join(src, 'agents'), { recursive: true })
    writeFileSync(join(src, 'agents', 'architect.md'), 'ARCHITECT')
    writeFileSync(join(src, 'loader.js'), 'console.log(1)')
    writeFileSync(join(src, 'loader.d.ts'), 'export {}')
    writeFileSync(join(src, 'loader.js.map'), '{}')

    syncBundledDir(src, dest, manifestPath, (rel) => rel.endsWith('.md'))

    expect(existsSync(join(dest, 'agents', 'architect.md'))).toBe(true)
    expect(existsSync(join(dest, 'loader.js'))).toBe(false)
    expect(existsSync(join(dest, 'loader.d.ts'))).toBe(false)
    expect(existsSync(join(dest, 'loader.js.map'))).toBe(false)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest['agents/architect.md']).toBeDefined()
    expect(manifest['loader.js']).toBeUndefined()

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })

  test('handles nested subdirectories', () => {
    const src = tmpDir('nested-src')
    const dest = tmpDir('nested-dest')
    const manifestPath = tmpDir('manifest') + '.json'

    mkdirSync(join(src, 'agents'), { recursive: true })
    mkdirSync(join(src, 'commands'), { recursive: true })
    writeFileSync(join(src, 'agents', 'architect.md'), 'ARCHITECT')
    writeFileSync(join(src, 'commands', 'loop.md'), 'LOOP')

    syncBundledDir(src, dest, manifestPath)

    expect(readFileSync(join(dest, 'agents', 'architect.md'), 'utf-8')).toBe('ARCHITECT')
    expect(readFileSync(join(dest, 'commands', 'loop.md'), 'utf-8')).toBe('LOOP')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest['agents/architect.md']).toBeDefined()
    expect(manifest['commands/loop.md']).toBeDefined()

    // User edits the nested file
    writeFileSync(join(dest, 'agents', 'architect.md'), 'EDITED')

    // Bundled changes the nested file
    writeFileSync(join(src, 'agents', 'architect.md'), 'BUNDLED V2')

    syncBundledDir(src, dest, manifestPath)

    // User edit preserved
    expect(readFileSync(join(dest, 'agents', 'architect.md'), 'utf-8')).toBe('EDITED')

    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(manifestPath, { recursive: true, force: true })
  })
})
