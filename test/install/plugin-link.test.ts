import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  ensurePluginRegistration,
  removePluginRegistration,
  resolveCliConfigTarget,
  resolveCliPluginDir,
  buildShimSource,
  linkPlugin,
  unlinkPlugin,
  unvendorPlugin,
  vendorPlugin,
  VENDORED_CLI_SPEC,
} from '../../src/install/plugin-link'
import {
  resolveCliConfigPath,
  resolvePluginShimDir,
  resolvePluginShimPath,
  resolveVendorDir,
} from '../../src/install/paths'

const cliTarget = () => resolveCliConfigTarget()

let configHome: string
const inheritedXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'forge-link-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  if (inheritedXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = inheritedXdgConfigHome
  }
  rmSync(configHome, { recursive: true, force: true })
})

function writeGlobalConfig(name: string, lines: string[]): string {
  const configDir = join(configHome, 'opencode')
  mkdirSync(configDir, { recursive: true })
  const file = join(configDir, name)
  writeFileSync(file, lines.join('\n'))
  return file
}

describe('buildShimSource', () => {
  test('produces a valid single-line re-export', () => {
    expect(buildShimSource('/abs/path/dist/index.js')).toBe('export { default } from "/abs/path/dist/index.js"\n')
  })
})

describe('linkPlugin', () => {
  test('external mode writes an absolute shim, then reports unchanged and updated', () => {
    const created = linkPlugin({ dryRun: false, mode: 'external' })
    expect(created.action).toBe('created')
    expect(created.target).toMatch(/dist[\\/]index\.js$/)
    expect(readFileSync(resolvePluginShimPath(), 'utf-8')).toBe(buildShimSource(created.target!))

    expect(linkPlugin({ dryRun: false, mode: 'external' }).action).toBe('unchanged')

    writeFileSync(resolvePluginShimPath(), 'export { default } from "/somewhere/else"\n')
    expect(linkPlugin({ dryRun: false, mode: 'external' }).action).toBe('updated')
  })

  test('vendored mode writes a shim relative to the plugin directory', () => {
    const result = linkPlugin({ dryRun: false, mode: 'vendored' })
    expect(result.target).toBe('./opencode-forge/dist/index.js')
    expect(readFileSync(resolvePluginShimPath(), 'utf-8')).toBe('export { default } from "./opencode-forge/dist/index.js"\n')
  })

  test('dry run reports the action without writing anything', () => {
    expect(linkPlugin({ dryRun: true, mode: 'external' }).action).toBe('created')
    expect(existsSync(resolvePluginShimPath())).toBe(false)
  })
})

describe('unlinkPlugin', () => {
  test('removes a leftover shim and reports absent when already gone', () => {
    mkdirSync(resolvePluginShimDir(), { recursive: true })
    writeFileSync(resolvePluginShimPath(), 'export { default } from "/somewhere/dist/index.js"\n')

    const removed = unlinkPlugin({ dryRun: false })
    expect(removed.action).toBe('removed')
    expect(existsSync(resolvePluginShimPath())).toBe(false)

    const absent = unlinkPlugin({ dryRun: false })
    expect(absent.action).toBe('absent')
  })

  test('dry run reports the action without deleting anything', () => {
    mkdirSync(resolvePluginShimDir(), { recursive: true })
    writeFileSync(resolvePluginShimPath(), 'export { default } from "/somewhere/dist/index.js"\n')

    expect(unlinkPlugin({ dryRun: true }).action).toBe('removed')
    expect(existsSync(resolvePluginShimPath())).toBe(true)
  })
})

describe('vendorPlugin', () => {
  test('copies the real package assets into the vendored layout', () => {
    const result = vendorPlugin({ dryRun: false })
    expect(result.action).toBe('vendored')
    expect(result.vendorDir).toBe(resolveVendorDir())
    expect(result.copied).toEqual(['package.json', 'forge-config.jsonc', 'dist', 'container', 'skills'])
    expect(result.missing).toEqual([])

    const vendorDir = resolveVendorDir()
    expect(existsSync(join(vendorDir, 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(vendorDir, 'container'))).toBe(true)
    expect(existsSync(join(vendorDir, 'skills'))).toBe(true)
    expect(existsSync(join(vendorDir, 'forge-config.jsonc'))).toBe(true)
  })

  test('is idempotent and removes stale files from the destination', () => {
    vendorPlugin({ dryRun: false })
    writeFileSync(join(resolveVendorDir(), 'dist', 'junk.js'), 'junk')
    const result = vendorPlugin({ dryRun: false })
    expect(result.action).toBe('vendored')
    expect(existsSync(join(resolveVendorDir(), 'dist', 'junk.js'))).toBe(false)
    expect(existsSync(join(resolveVendorDir(), 'dist', 'index.js'))).toBe(true)
  })

  test('dry run reports the copy without writing anything', () => {
    const result = vendorPlugin({ dryRun: true })
    expect(result.action).toBe('vendored')
    expect(result.copied).toEqual(['package.json', 'forge-config.jsonc', 'dist', 'container', 'skills'])
    expect(existsSync(resolveVendorDir())).toBe(false)
  })
})

describe('unvendorPlugin', () => {
  test('removes the vendored directory and reports absent when already gone', () => {
    vendorPlugin({ dryRun: false })
    expect(existsSync(resolveVendorDir())).toBe(true)
    expect(unvendorPlugin({ dryRun: false })).toBe('removed')
    expect(existsSync(resolveVendorDir())).toBe(false)
    expect(unvendorPlugin({ dryRun: false })).toBe('absent')
  })
})

describe('ensurePluginRegistration', () => {
  test('creates cli.json with the schema key and the plugins array when missing', () => {
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('created')
    expect(result.file).toBe(resolveCliConfigPath())
    expect(result.spec).toBe(VENDORED_CLI_SPEC)
    expect(existsSync(resolveCliConfigPath())).toBe(true)
    const text = readFileSync(resolveCliConfigPath(), 'utf-8')
    expect(text).toContain('"$schema": "https://opencode.ai/v2/cli.json"')
    expect(text).toContain(JSON.stringify(VENDORED_CLI_SPEC))
    expect(JSON.parse(text)).toEqual({
      $schema: 'https://opencode.ai/v2/cli.json',
      plugins: [VENDORED_CLI_SPEC],
    })
  })

  test('appends the spec to an existing commented cli.json without disturbing keys or comments', () => {
    writeGlobalConfig('cli.json', [
      '{',
      '  // CLI plugins are loaded by opencode V2 only.',
      '  "theme": "legacy",',
      '  "plugins": [',
      '    "some-other-plugin"',
      '  ]',
      '}',
      '',
    ])
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('added')
    const text = readFileSync(resolveCliConfigPath(), 'utf-8')
    expect(text).toContain('// CLI plugins are loaded by opencode V2 only.')
    expect(text).toContain('"theme": "legacy"')
    expect(text).toContain('"some-other-plugin"')
    expect(text).toContain(JSON.stringify(VENDORED_CLI_SPEC))
  })

  test('returns present and leaves the file byte-identical when the spec already exists', () => {
    ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    const before = readFileSync(resolveCliConfigPath(), 'utf-8')
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('present')
    expect(readFileSync(resolveCliConfigPath(), 'utf-8')).toBe(before)
  })

  test('replaces a stale forge entry while keeping unrelated entries and comments', () => {
    writeGlobalConfig('cli.json', [
      '{',
      '  // user comment',
      '  "plugins": [',
      '    "some-other-plugin",',
      '    "opencode-forge@0.8.8",',
      '  ],',
      '}',
      '',
    ])
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('updated')
    const text = readFileSync(resolveCliConfigPath(), 'utf-8')
    expect(text).toContain('// user comment')
    expect(text).toContain('"some-other-plugin"')
    expect(text).not.toContain('opencode-forge@0.8.8')
    expect(text).toContain(JSON.stringify(VENDORED_CLI_SPEC))
  })

  test('dry run reports the action without writing cli.json', () => {
    const result = ensurePluginRegistration({ dryRun: true, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('created')
    expect(existsSync(resolveCliConfigPath())).toBe(false)
  })
})

describe('removePluginRegistration', () => {
  test('removes the vendored cli.json entry and keeps unrelated entries', () => {
    const file = writeGlobalConfig('cli.json', [
      '{',
      '  "plugins": [',
      '    "unrelated",',
      `    ${JSON.stringify(VENDORED_CLI_SPEC)},`,
      '    "other",',
      '  ],',
      '}',
      '',
    ])
    expect(removePluginRegistration({ dryRun: false, target: cliTarget() })).toBe('removed')
    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('"unrelated"')
    expect(text).toContain('"other"')
    expect(text).not.toContain('opencode-forge')
    expect(removePluginRegistration({ dryRun: false, target: cliTarget() })).toBe('absent')
  })

  test('reports absent when cli.json is missing', () => {
    expect(removePluginRegistration({ dryRun: false, target: cliTarget() })).toBe('absent')
  })
})

describe('resolveCliPluginDir', () => {
  test('points at the built dist directory holding both entrypoints', () => {
    const dir = resolveCliPluginDir()
    expect(dir).toBeDefined()
    expect(basename(dir!)).toBe('dist')
    expect(existsSync(join(dir!, 'index.js'))).toBe(true)
    expect(existsSync(join(dir!, 'tui.js'))).toBe(true)
  })
})

describe('VENDORED_CLI_SPEC', () => {
  test('resolves against the config dir to the vendored dist directory', () => {
    const configDir = join(configHome, 'opencode')
    mkdirSync(join(configDir, 'plugin', 'opencode-forge', 'dist'), { recursive: true })
    writeFileSync(join(configDir, 'plugin', 'opencode-forge', 'dist', 'index.js'), '// built')

    const resolved = resolve(configDir, VENDORED_CLI_SPEC)
    expect(existsSync(resolved)).toBe(true)
    expect(statSync(resolved).isDirectory()).toBe(true)
    expect(existsSync(join(resolved, 'index.js'))).toBe(true)
  })
})
