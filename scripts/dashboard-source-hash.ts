/**
 * Shared utility to compute a SHA-256 hash of the dashboard app source files.
 * Used by both the build script (to embed the hash in the bundle) and the drift
 * test (to verify the bundle is in sync with the source). Node-only; no Bun APIs.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'dashboard', 'app')

function collectTsFiles(dir: string, base: string): string[] {
  const entries: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      // (recursion placeholder – currently no subdirs, but support it)
      entries.push(...collectTsFiles(full, base))
    } else if (name.endsWith('.ts')) {
      entries.push(full)
    }
  }
  return entries
}

export function computeDashboardAppSourceHash(): string {
  const files = collectTsFiles(APP_DIR, APP_DIR)
    .sort((a, b) => relative(APP_DIR, a).localeCompare(relative(APP_DIR, b)))

  const hash = createHash('sha256')
  for (const full of files) {
    const rel = relative(APP_DIR, full)
    const content = readFileSync(full, 'utf-8')
    hash.update(rel)
    hash.update('\n')
    hash.update(content)
    hash.update('\n')
  }
  return hash.digest('hex')
}
