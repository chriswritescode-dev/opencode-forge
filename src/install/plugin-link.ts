import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser/lib/esm/main.js'
import type { Node } from 'jsonc-parser/lib/esm/main.js'
import {
  resolveCliConfigPath,
  resolveConfigDir,
  resolvePluginShimPath,
  resolveServerEntryCandidates,
  resolveVendorDir,
  VENDORED_ASSETS,
} from './paths'

export interface UnlinkResult {
  action: 'removed' | 'absent'
  shimPath: string
}

/** Relative specifier for `cli.json`, resolved by opencode against the config dir. */
export const VENDORED_CLI_SPEC = './plugin/opencode-forge/dist'

/** First built server entry candidate that exists on disk, if any. */
function resolveServerEntry(): string | undefined {
  return resolveServerEntryCandidates().find((candidate) => existsSync(candidate))
}

/**
 * Package root owning the built server entry — the directory above `dist/`, or
 * the entry's parent when the module layout has no `dist` — or undefined when
 * no built entry exists on disk.
 */
function resolvePackageRoot(): string | undefined {
  const entry = resolveServerEntry()
  if (!entry) return undefined
  const entryDir = dirname(entry)
  return basename(entryDir) === 'dist' ? dirname(entryDir) : resolve(entryDir, '..')
}

/**
 * Built `dist` directory of the package, or undefined when it is absent. `cli.json`
 * lists opencode V2 plugins by directory, and V2 resolves the configured
 * directory's package entrypoints, so this directory is the spec written into
 * `cli.json` for the external mode.
 */
export function resolveCliPluginDir(): string | undefined {
  const root = resolvePackageRoot()
  if (!root) return undefined
  const dir = join(root, 'dist')
  return existsSync(dir) ? dir : undefined
}

/** Remove a leftover V1 server re-export shim from opencode's plugin directory. */
export function unlinkPlugin(options: { dryRun: boolean }): UnlinkResult {
  const shimPath = resolvePluginShimPath()
  if (!existsSync(shimPath)) {
    return { action: 'absent', shimPath }
  }
  if (!options.dryRun) {
    rmSync(shimPath, { force: true })
  }
  return { action: 'removed', shimPath }
}

export interface VendorResult {
  action: 'vendored' | 'missing-entry' | 'failed'
  vendorDir: string
  copied: string[]
  missing: string[]
}

/**
 * Copy the installed package's assets into the vendored dir so the config
 * folder is self-contained. Each asset's destination is removed before copying
 * so stale files never survive an upgrade, and assets absent from the package
 * root are recorded rather than failing the whole operation.
 */
export function vendorPlugin(options: { dryRun: boolean }): VendorResult {
  const vendorDir = resolveVendorDir()
  const root = resolvePackageRoot()
  if (!root) {
    return { action: 'missing-entry', vendorDir, copied: [], missing: [] }
  }
  try {
    const copied: string[] = []
    const missing: string[] = []
    for (const name of VENDORED_ASSETS) {
      const src = join(root, name)
      if (!existsSync(src)) {
        missing.push(name)
        continue
      }
      copied.push(name)
      if (!options.dryRun) {
        const dest = join(vendorDir, name)
        rmSync(dest, { recursive: true, force: true })
        cpSync(src, dest, { recursive: true })
      }
    }
    return { action: 'vendored', vendorDir, copied, missing }
  } catch {
    return { action: 'failed', vendorDir, copied: [], missing: [] }
  }
}

/** Remove the vendored package copy from opencode's global plugin directory. */
export function unvendorPlugin(options: { dryRun: boolean }): 'removed' | 'absent' {
  const vendorDir = resolveVendorDir()
  if (!existsSync(vendorDir)) {
    return 'absent'
  }
  if (!options.dryRun) {
    rmSync(vendorDir, { recursive: true, force: true })
  }
  return 'removed'
}

export interface PluginConfigTarget {
  file: string
  key: string
  schema: string
}

/** `cli.json` is opencode V2's plugin list. */
export function resolveCliConfigTarget(): PluginConfigTarget {
  return { file: resolveCliConfigPath(), key: 'plugins', schema: 'https://opencode.ai/v2/cli.json' }
}

export interface PluginRegistrationResult {
  action: 'created' | 'added' | 'updated' | 'present' | 'failed'
  file: string
  spec: string
}

const PLUGIN_MODIFY_OPTIONS = { formattingOptions: { insertSpaces: true, tabSize: 2 } } as const

function pluginConfigSource(spec: string, target: PluginConfigTarget): string {
  return `{\n  "$schema": ${JSON.stringify(target.schema)},\n  ${JSON.stringify(target.key)}: [${JSON.stringify(spec)}]\n}\n`
}

/**
 * Ensure the target config file lists the given plugin spec. opencode V2 loads
 * plugins only from the `plugins` array in `cli.json` — there is no directory
 * scan — so the entry must be written explicitly. The file is parsed and edited as
 * JSONC so existing comments and trailing commas survive, and an already-present or
 * stale forge entry is handled without rewriting unrelated content.
 */
export function ensurePluginRegistration(options: {
  dryRun: boolean
  spec: string
  target: PluginConfigTarget
}): PluginRegistrationResult {
  const { file, key } = options.target
  const report = { file, spec: options.spec }
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    if (!options.dryRun) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, pluginConfigSource(options.spec, options.target))
        return { action: 'created', ...report }
      } catch {
        return { action: 'failed', ...report }
      }
    }
    return { action: 'created', ...report }
  }
  try {
    const { plugin, entries } = scanPluginArray(text, key, resolveConfigDir())
    let next = text
    let action: 'added' | 'updated' | 'present'
    if (plugin) {
      if (entries.some((entry) => entry.spec === options.spec)) {
        action = 'present'
      } else if (entries.length > 0) {
        next = applyEdits(next, modify(next, [key, entries[0].index], options.spec, PLUGIN_MODIFY_OPTIONS))
        action = 'updated'
      } else {
        next = applyEdits(next, modify(next, [key, -1], options.spec, PLUGIN_MODIFY_OPTIONS))
        action = 'added'
      }
    } else {
      next = applyEdits(next, modify(next, [key], [options.spec], PLUGIN_MODIFY_OPTIONS))
      action = 'added'
    }
    if (!options.dryRun) {
      writeFileSync(file, next)
    }
    return { action, ...report }
  } catch {
    return { action: 'failed', ...report }
  }
}

/**
 * Remove every forge entry from the target config file's plugin array, highest
 * index first so earlier indices stay valid. Returns `'absent'` when the file or
 * any forge entry does not exist.
 */
export function removePluginRegistration(options: {
  dryRun: boolean
  target: PluginConfigTarget
}): 'removed' | 'absent' | 'failed' {
  const { file, key } = options.target
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return 'absent'
  }
  try {
    const { entries } = scanPluginArray(text, key, resolveConfigDir())
    if (entries.length === 0) return 'absent'
    let next = text
    for (const { index } of [...entries].sort((a, b) => b.index - a.index)) {
      next = applyEdits(next, modify(next, [key, index], undefined, PLUGIN_MODIFY_OPTIONS))
    }
    if (!options.dryRun) {
      writeFileSync(file, next)
    }
    return 'removed'
  } catch {
    return 'failed'
  }
}

function entrySpec(node: Node): string | undefined {
  if (node.type === 'string') return node.value
  const first = node.type === 'array' ? node.children?.[0] : undefined
  if (first && first.type === 'string') return first.value
  return undefined
}

interface ForgeEntry {
  index: number
  spec: string
}

function scanPluginArray(text: string, key: string, baseDir: string): { plugin?: Node; entries: ForgeEntry[] } {
  const root = parseTree(text, undefined, { allowTrailingComma: true })
  if (!root) return { entries: [] }
  const plugin = findNodeAtLocation(root, [key])
  if (!plugin || plugin.type !== 'array' || !plugin.children) return { plugin, entries: [] }
  const entries: ForgeEntry[] = []
  plugin.children.forEach((child, index) => {
    const spec = entrySpec(child)
    if (spec && isForgeRef(spec, baseDir)) entries.push({ index, spec })
  })
  return { plugin, entries }
}

function isForgeRef(spec: string, baseDir: string): boolean {
  return /^opencode-forge(?:@[^/]+)?(?:\/.*)?$/.test(spec) || isForgePath(spec, baseDir)
}

function pathLikeSpec(spec: string): string | undefined {
  if (spec.startsWith('file://')) {
    try {
      return fileURLToPath(spec)
    } catch {
      return undefined
    }
  }
  if (spec.startsWith('./') || spec.startsWith('../')) return spec
  if (spec.startsWith('~/')) return join(homedir(), spec.slice(2))
  if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return spec
  return undefined
}

/**
 * A path entry refers to forge when it resolves inside the vendored package
 * dir, or when it points into a `dist` directory whose owning package is
 * actually named `opencode-forge`. Matching the `dist` suffix alone would
 * falsely claim any unrelated local plugin built into `dist/`.
 */
function isForgePath(spec: string, baseDir: string): boolean {
  const pathLike = pathLikeSpec(spec)
  if (!pathLike) return false
  const normalized = normalize(resolve(baseDir, pathLike))
  const vendorDir = normalize(resolveVendorDir())
  if (normalized === vendorDir || normalized.startsWith(vendorDir + sep)) return true
  const base = basename(normalized)
  const distDir = base === 'index.js' || base === 'tui.js' ? dirname(normalized) : normalized
  if (basename(distDir) !== 'dist') return false
  return readPackageName(dirname(distDir)) === 'opencode-forge'
}

function readPackageName(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown }
    return typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}


