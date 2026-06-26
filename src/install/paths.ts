import { homedir, platform } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

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
 * Directory containing the loaded plugin module set — `dist/` in a published
 * build, `src/` when running from source. This module lives at
 * `<pluginDir>/install/paths.(ts|js)`, so step up one level.
 */
export function resolvePluginDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
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

/** Bundled default config shipped with the package. */
export function resolveBundledConfigPath(): string {
  return join(resolvePluginDir(), '..', 'forge-config.jsonc')
}

/** Bundled Docker sandbox context shipped with the package. */
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
