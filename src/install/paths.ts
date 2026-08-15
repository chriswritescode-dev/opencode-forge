import { homedir, platform } from 'os'
import { join } from 'path'
import { resolveShippedRoot } from '../utils/shipped-paths'

/**
 * Single source of truth for every filesystem location the bundled-asset
 * install/sync logic touches. Both the silent startup sync (`setup.ts`) and the
 * interactive installer (`install/cli.ts`) resolve paths from here so the two
 * code paths can never drift apart.
 *
 * This module is intentionally dependency-free (only `os`/`path`/`url`) so the
 * standalone installer CLI can import it without pulling in the storage layer,
 * sqlite, or the TUI runtime.
 */

/**
 * Root of the shipped module tree — `dist/` in a published build, `src/` when
 * running from source. Bundling-safe: it walks up from this module to the
 * nearest `dist`/`src` ancestor instead of assuming a fixed relative position,
 * so it resolves identically for the unbundled layout
 * (`<pluginDir>/install/paths.js`), a future bundled `dist/index.js`, and
 * source runs (`<pluginDir>/src/install/paths.ts`).
 */
export function resolvePluginDir(): string {
  return resolveShippedRoot(import.meta.url)
}

/** `~/.config/opencode` (or the `XDG_CONFIG_HOME`/Windows equivalent). */
export function resolveConfigDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'] || defaultBase
  return join(xdgConfigHome, 'opencode')
}

/** Installed plugin config file. */
export function resolveConfigPath(): string {
  return join(resolveConfigDir(), 'forge-config.jsonc')
}

/** opencode's TUI config file, which lists plugin entries for the TUI surface. */
export function resolveTuiConfigPath(): string {
  return join(resolveConfigDir(), 'tui.json')
}

/** Bundled default config shipped with the package. */
export function resolveBundledConfigPath(): string {
  return join(resolvePluginDir(), '..', 'forge-config.jsonc')
}

/** Bundled sandbox template context shipped with the package. */
export function resolveBundledContainerDir(): string {
  return join(resolvePluginDir(), '..', 'container')
}

/** Content-hash manifest for a named bundle (e.g. `prompts`, `skills`). */
export function resolveManifestPath(name: string): string {
  return join(resolveConfigDir(), 'forge', 'manifests', `${name}.json`)
}

/** Installed agent/command prompts directory. */
export function resolvePromptsDir(): string {
  return join(resolveConfigDir(), 'forge', 'prompts')
}

/** Bundled prompts shipped with the package. */
export function resolveBundledPromptsDir(): string {
  return join(resolvePluginDir(), 'prompts')
}

/** Installed skills directory. */
export function resolveSkillsDir(): string {
  return join(resolveConfigDir(), 'skills')
}

/** Bundled skills shipped with the package. */
export function resolveBundledSkillsDir(): string {
  return join(resolvePluginDir(), '..', 'skills')
}

/** Filename of the one-line server re-export shim installed into opencode's config dir. */
export const PLUGIN_SHIM_FILENAME = 'opencode-forge.js'

/** opencode's global plugin scan directory (`<configDir>/plugin`, non-recursive glob). */
export function resolvePluginShimDir(): string {
  return join(resolveConfigDir(), 'plugin')
}

/** Absolute path of the installed server re-export shim. */
export function resolvePluginShimPath(): string {
  return join(resolvePluginShimDir(), PLUGIN_SHIM_FILENAME)
}

/** Directory name of the vendored package copy inside the plugin shim dir. */
export const VENDOR_DIR_NAME = 'opencode-forge'

/** Absolute path of the vendored forge package copy (`<configDir>/plugin/opencode-forge`). */
export function resolveVendorDir(): string {
  return join(resolvePluginShimDir(), VENDOR_DIR_NAME)
}

/**
 * The package-layout assets copied verbatim into the vendored dir. They mirror
 * the npm package layout because forge resolves its bundled assets as siblings
 * of the loaded module's package root (`<pluginDir>/../forge-config.jsonc`,
 * `container`, `skills`), so a vendored copy must preserve that sibling
 * structure for the sandbox template and bundled skill sync to resolve.
 */
export const VENDORED_ASSETS: readonly string[] = ['package.json', 'forge-config.jsonc', 'dist', 'container', 'skills']

/**
 * Ordered candidates for the built server entry. The first hits a published/built
 * layout where this module lives in `dist/`; the second covers running the
 * installer from source (`pnpm run setup` runs `bun src/install/cli.ts`, so
 * `resolvePluginDir()` is `src/`) where the real entry is the sibling `dist/index.js`.
 */
export function resolveServerEntryCandidates(): string[] {
  return [join(resolvePluginDir(), 'index.js'), join(resolvePluginDir(), '..', 'dist', 'index.js')]
}

/** Candidate filenames for the global opencode config, in lookup order. */
export function resolveOpencodeConfigCandidates(): string[] {
  return ['opencode.jsonc', 'opencode.json'].map((f) => join(resolveConfigDir(), f))
}

/** Declarative description of one installable bundle directory. */
export interface BundleSpec {
  /** Manifest name and stable identifier. */
  label: string
  /** Human-readable title for installer output. */
  title: string
  /** Bundled source directory shipped with the package. */
  bundledDir: string
  /** Destination directory under the user config dir. */
  destDir: string
  /** Manifest tracking file for this bundle. */
  manifestPath: string
  /** Optional filter limiting which relative paths are installed. */
  filter?: (relPath: string) => boolean
}

const isMarkdown = (rel: string): boolean => rel.endsWith('.md')

/**
 * The bundles installed into the user config dir. Iterated identically by the
 * startup sync and the interactive installer.
 */
export function getBundleSpecs(): BundleSpec[] {
  return [
    {
      label: 'prompts',
      title: 'Agent & command prompts',
      // Only markdown prompts are installed; the bundled dir also contains
      // compiled JS/declaration/sourcemap artifacts that must be skipped.
      bundledDir: resolveBundledPromptsDir(),
      destDir: resolvePromptsDir(),
      manifestPath: resolveManifestPath('prompts'),
      filter: isMarkdown,
    },
    {
      label: 'skills',
      title: 'Bundled skills',
      bundledDir: resolveBundledSkillsDir(),
      destDir: resolveSkillsDir(),
      manifestPath: resolveManifestPath('skills'),
    },
  ]
}
