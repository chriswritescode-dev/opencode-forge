import { homedir, platform } from 'os'
import { join } from 'path'
import { resolveShippedRoot } from '../utils/shipped-paths'

export function resolvePluginDir(): string {
  return resolveShippedRoot(import.meta.url)
}

export function resolveConfigDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'] || defaultBase
  return join(xdgConfigHome, 'opencode')
}

export function resolveConfigPath(): string {
  return join(resolveConfigDir(), 'forge-config.jsonc')
}

export function resolveCliConfigPath(): string {
  return join(resolveConfigDir(), 'cli.json')
}

export function resolveBundledConfigPath(): string {
  return join(resolvePluginDir(), '..', 'forge-config.jsonc')
}

export function resolveBundledContainerDir(): string {
  return join(resolvePluginDir(), '..', 'container')
}

export function resolveManifestPath(name: string): string {
  return join(resolveConfigDir(), 'forge', 'manifests', `${name}.json`)
}

export function resolvePromptsDir(): string {
  return join(resolveConfigDir(), 'forge', 'prompts')
}

export function resolveBundledPromptsDir(): string {
  return join(resolvePluginDir(), 'prompts')
}

export function resolveSkillsDir(): string {
  return join(resolveConfigDir(), 'skills')
}

export function resolveBundledSkillsDir(): string {
  return join(resolvePluginDir(), '..', 'skills')
}

const PLUGIN_SHIM_FILENAME = 'opencode-forge.js'

export function resolvePluginShimDir(): string {
  return join(resolveConfigDir(), 'plugin')
}

export function resolvePluginShimPath(): string {
  return join(resolvePluginShimDir(), PLUGIN_SHIM_FILENAME)
}

export const VENDOR_DIR_NAME = 'opencode-forge'

export function resolveVendorDir(): string {
  return join(resolvePluginShimDir(), VENDOR_DIR_NAME)
}

export const VENDORED_ASSETS: readonly string[] = ['package.json', 'forge-config.jsonc', 'dist', 'container', 'skills']

export function resolveServerEntryCandidates(): string[] {
  return [join(resolvePluginDir(), 'index.js'), join(resolvePluginDir(), '..', 'dist', 'index.js')]
}

export interface BundleSpec {
  label: string
  title: string
  bundledDir: string
  destDir: string
  manifestPath: string
  filter?: (relPath: string) => boolean
}

const isMarkdown = (rel: string): boolean => rel.endsWith('.md')

export function getBundleSpecs(): BundleSpec[] {
  return [
    {
      label: 'prompts',
      title: 'Agent & command prompts',
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
