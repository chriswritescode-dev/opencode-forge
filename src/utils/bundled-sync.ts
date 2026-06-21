import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
import { dirname, join, relative } from 'path'

function sha256(content: string): string {
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

function readManifest(manifestPath: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    return {}
  }
}

export function syncBundledDir(
  srcDir: string,
  destDir: string,
  manifestPath: string,
  filter?: (relPath: string) => boolean,
): void {
  if (!existsSync(srcDir)) return

  const manifest = readManifest(manifestPath)
  const files = collectFiles(srcDir, srcDir, filter)
  let changed = false

  for (const rel of files) {
    const src = join(srcDir, rel)
    const dest = join(destDir, rel)
    const bundledHash = sha256(readFileSync(src, 'utf-8'))
    const recorded = manifest[rel]

    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      manifest[rel] = bundledHash
      changed = true
    } else if (recorded === undefined) {
      const destHash = sha256(readFileSync(dest, 'utf-8'))
      if (destHash === bundledHash) {
        manifest[rel] = bundledHash
        changed = true
      }
    } else if (sha256(readFileSync(dest, 'utf-8')) === recorded) {
      if (bundledHash !== recorded) {
        copyFileSync(src, dest)
        manifest[rel] = bundledHash
        changed = true
      }
    }
  }

  if (changed) {
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }
}
