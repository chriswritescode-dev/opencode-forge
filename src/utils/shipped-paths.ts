import { basename, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Resolve the root of the shipped module tree from the URL of a compiled or
 * source module inside it.
 *
 * Why this exists: several modules independently derived on-disk locations from
 * `import.meta.url`, each one hard-coding the unbundled `tsc` output layout
 * (`dist/install/paths.js`, `dist/storage/migrations/index.js`, and
 * `dist/prompts/loader.js` respectively). Once the server entry is bundled into
 * a single `dist/index.js`, every `import.meta.url` inside that bundle collapses
 * to the same file, so those per-module anchors would all misresolve. This
 * function is the single shared anchor: it walks up from the module's own
 * directory to the nearest `dist` (published build) or `src` (source runs via
 * `bun`) ancestor, which is the layout root for every shipped or in-development
 * module.
 *
 * Nearest-match is deliberate: a `dist` or `src` directory higher in the user's
 * absolute path (for example `/Users/x/src/...`) must not win over the one that
 * actually contains the module tree.
 *
 * If the filesystem root is reached without finding a `dist` or `src` ancestor,
 * the module's own directory is returned unchanged as a safe fallback, so
 * callers keep a deterministic base instead of throwing.
 */
export function resolveShippedRoot(moduleUrl: string): string {
  const startDir = dirname(fileURLToPath(moduleUrl))
  let current = startDir
  while (true) {
    if (basename(current) === 'dist' || basename(current) === 'src') {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return startDir
    current = parent
  }
}
