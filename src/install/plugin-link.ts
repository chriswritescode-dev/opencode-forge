import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser/lib/esm/main.js'
import type { Node } from 'jsonc-parser/lib/esm/main.js'
import {
  resolveConfigDir,
  resolveOpencodeConfigCandidates,
  resolvePluginShimPath,
  resolveServerEntryCandidates,
  resolveTuiConfigPath,
  resolveVendorDir,
  VENDORED_ASSETS,
} from './paths'

/** Current on-disk state of the installed plugin shim. */
export interface PluginShimState {
  path: string
  present: boolean
  /** Entry specifier the installed shim currently re-exports, when parseable — an absolute path or a relative specifier. */
  target?: string
}

/** How the installed shim locates forge's server entry. */
export type ShimMode = 'external' | 'vendored'

/** A `plugin` array entry in the global opencode config that declares forge. */
export interface ConfigRegistration {
  /** Absolute path of the global opencode config that declares forge. */
  file: string
  /** Raw specifier text as written in the plugin array. */
  spec: string
  /** 1-based line number of the entry. */
  line: number
}

export interface LinkResult {
  action: 'created' | 'updated' | 'unchanged' | 'missing-entry'
  shimPath: string
  target?: string
}

export interface UnlinkResult {
  action: 'removed' | 'absent'
  shimPath: string
}

/** Render the one-line server re-export shim installed into opencode's config dir. */
export function buildShimSource(serverEntry: string): string {
  return `export { default } from ${JSON.stringify(serverEntry)}\n`
}

/**
 * Relative specifier a vendored shim re-exports. opencode resolves it against
 * the shim's own directory (`<configDir>/plugin/`), so the folder stays
 * portable to another machine.
 */
export const VENDORED_SERVER_SPEC = './opencode-forge/dist/index.js'

/** Relative specifier for `tui.json`, resolved by opencode against the config dir. */
export const VENDORED_TUI_SPEC = './plugin/opencode-forge/dist/tui.js'

/** First built server entry candidate that exists on disk, if any. */
export function resolveServerEntry(): string | undefined {
  return resolveServerEntryCandidates().find((candidate) => existsSync(candidate))
}

/**
 * Package root owning the built server entry — the directory above `dist/`, or
 * the entry's parent when the module layout has no `dist` — or undefined when
 * no built entry exists on disk.
 */
export function resolvePackageRoot(): string | undefined {
  const entry = resolveServerEntry()
  if (!entry) return undefined
  const entryDir = dirname(entry)
  return basename(entryDir) === 'dist' ? dirname(entryDir) : resolve(entryDir, '..')
}

/**
 * Built TUI entry of the package (`dist/tui.js`), or undefined when the build
 * output is not present on disk. The TUI surface is loaded only from `tui.json`,
 * so this is the spec written into that file for the external mode.
 */
export function resolveTuiEntry(): string | undefined {
  const root = resolvePackageRoot()
  if (!root) return undefined
  const entry = join(root, 'dist', 'tui.js')
  return existsSync(entry) ? entry : undefined
}

/** Read the installed shim, extracting its re-export target when parseable. */
export function readPluginShimState(): PluginShimState {
  const path = resolvePluginShimPath()
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    return { path, present: false }
  }
  const match = content.match(/^export \{ default \} from ([^\n]*)\n?$/)
  if (!match) {
    return { path, present: true }
  }
  try {
    return { path, present: true, target: JSON.parse(match[1].trimEnd()) as string }
  } catch {
    return { path, present: true }
  }
}

/** True when the installed shim targets the vendored relative specifier. */
export function isVendoredShim(state: PluginShimState): boolean {
  return state.target === VENDORED_SERVER_SPEC
}

/** Install the server re-export shim into opencode's global plugin directory. */
export function linkPlugin(options: { dryRun: boolean; mode?: ShimMode }): LinkResult {
  const shimPath = resolvePluginShimPath()
  const entry = resolveServerEntry()
  if (!entry) {
    return { action: 'missing-entry', shimPath }
  }
  const target = options.mode === 'vendored' ? VENDORED_SERVER_SPEC : entry
  const source = buildShimSource(target)
  const existing = safeReadText(shimPath)
  if (existing === source) {
    return { action: 'unchanged', shimPath, target }
  }
  if (!options.dryRun) {
    mkdirSync(dirname(shimPath), { recursive: true })
    writeFileSync(shimPath, source)
  }
  return { action: existing === undefined ? 'created' : 'updated', shimPath, target }
}

/** Remove the installed shim from opencode's global plugin directory. */
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

export interface TuiRegistrationResult {
  action: 'created' | 'added' | 'updated' | 'present' | 'failed'
  file: string
  spec: string
}

const TUI_MODIFY_OPTIONS = { formattingOptions: { insertSpaces: true, tabSize: 2 } } as const

function tuiConfigSource(spec: string): string {
  return `{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": [${JSON.stringify(spec)}]\n}\n`
}

/**
 * Ensure `tui.json` lists the given plugin spec. opencode loads the TUI surface
 * only from the `plugin` array in this file — there is no directory scan — so
 * the entry must be written explicitly. The file is parsed and edited as JSONC
 * so existing comments and trailing commas survive, and an already-present or
 * stale forge entry is handled without rewriting unrelated content.
 */
export function ensureTuiRegistration(options: { dryRun: boolean; spec: string }): TuiRegistrationResult {
  const file = resolveTuiConfigPath()
  const report = { file, spec: options.spec }
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    if (!options.dryRun) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, tuiConfigSource(options.spec))
        return { action: 'created', ...report }
      } catch {
        return { action: 'failed', ...report }
      }
    }
    return { action: 'created', ...report }
  }
  try {
    const { plugin, entries } = scanPluginArray(text, resolveConfigDir())
    let next = text
    let action: 'added' | 'updated' | 'present'
    if (plugin) {
      if (entries.some((entry) => entry.spec === options.spec)) {
        action = 'present'
      } else if (entries.length > 0) {
        next = applyEdits(next, modify(next, ['plugin', entries[0].index], options.spec, TUI_MODIFY_OPTIONS))
        action = 'updated'
      } else {
        next = applyEdits(next, modify(next, ['plugin', -1], options.spec, TUI_MODIFY_OPTIONS))
        action = 'added'
      }
    } else {
      next = applyEdits(next, modify(next, ['plugin'], [options.spec], TUI_MODIFY_OPTIONS))
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
 * Remove every forge entry from the `tui.json` `plugin` array, highest index
 * first so earlier indices stay valid. Returns `'absent'` when the file or any
 * forge entry does not exist.
 */
export function removeTuiRegistration(options: { dryRun: boolean }): 'removed' | 'absent' | 'failed' {
  const file = resolveTuiConfigPath()
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return 'absent'
  }
  try {
    const { entries } = scanPluginArray(text, resolveConfigDir())
    if (entries.length === 0) return 'absent'
    let next = text
    for (const { index } of [...entries].sort((a, b) => b.index - a.index)) {
      next = applyEdits(next, modify(next, ['plugin', index], undefined, TUI_MODIFY_OPTIONS))
    }
    if (!options.dryRun) {
      writeFileSync(file, next)
    }
    return 'removed'
  } catch {
    return 'failed'
  }
}

/**
 * Every `plugin` array entry in the global opencode config that refers to forge,
 * either by npm package name (`opencode-forge[@version][/subpath]`) or by a
 * filesystem path whose normalized form ends in a forge `dist` layout.
 */
export function findConfigRegistrations(): ConfigRegistration[] {
  const regs: ConfigRegistration[] = []
  for (const file of resolveOpencodeConfigCandidates()) {
    try {
      const text = readFileSync(file, 'utf-8')
      for (const { node, spec } of scanPluginArray(text, dirname(file)).entries) {
        regs.push({ file, spec, line: lineOf(text, node.offset) })
      }
    } catch {
      continue
    }
  }
  return regs
}

/**
 * Disable a config-array registration so opencode stops double-loading forge.
 * `.jsonc` entries that sit alone on their line(s) are commented out in place so
 * the user's value stays recoverable; everything else is removed structurally
 * with jsonc-parser, keeping `.json` files valid for strict readers.
 */
export function disableConfigRegistration(
  reg: ConfigRegistration,
  options: { dryRun: boolean },
): 'commented' | 'removed' | 'failed' {
  try {
    const text = readFileSync(reg.file, 'utf-8')
    const root = parseTree(text, undefined, { allowTrailingComma: true })
    if (!root) return 'failed'
    const pluginNode = findNodeAtLocation(root, ['plugin'])
    if (!pluginNode || pluginNode.type !== 'array' || !pluginNode.children) return 'failed'
    const index = pluginNode.children.findIndex(
      (child) => entrySpec(child) === reg.spec && lineOf(text, child.offset) === reg.line,
    )
    if (index === -1) return 'failed'
    const node = pluginNode.children[index]

    if (extname(reg.file) === '.jsonc' && isAloneOnLines(text, node)) {
      if (!options.dryRun) {
        writeFileSync(reg.file, commentOut(text, node))
      }
      return 'commented'
    }

    const edits = modify(text, ['plugin', index], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
    if (!options.dryRun) {
      writeFileSync(reg.file, applyEdits(text, edits))
    }
    return 'removed'
  } catch {
    return 'failed'
  }
}

function safeReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return undefined
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
  node: Node
}

function scanPluginArray(text: string, baseDir: string): { plugin?: Node; entries: ForgeEntry[] } {
  const root = parseTree(text, undefined, { allowTrailingComma: true })
  if (!root) return { entries: [] }
  const plugin = findNodeAtLocation(root, ['plugin'])
  if (!plugin || plugin.type !== 'array' || !plugin.children) return { plugin, entries: [] }
  const entries: ForgeEntry[] = []
  plugin.children.forEach((child, index) => {
    const spec = entrySpec(child)
    if (spec && isForgeRef(spec, baseDir)) entries.push({ index, spec, node: child })
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

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function spannedLines(text: string, offset: number, length: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const newline = text.indexOf('\n', offset + length)
  return { start, end: newline === -1 ? text.length : newline }
}

function isAloneOnLines(text: string, node: Node): boolean {
  const { start, end } = spannedLines(text, node.offset, node.length)
  const rest = text.slice(start, end).replace(text.slice(node.offset, node.offset + node.length), '')
  return rest.trim() === '' || rest.trim() === ','
}

function commentOut(text: string, node: Node): string {
  const { start, end } = spannedLines(text, node.offset, node.length)
  const commented = text
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^(\s*)/, '$1// '))
    .join('\n')
  return text.slice(0, start) + commented + text.slice(end)
}
