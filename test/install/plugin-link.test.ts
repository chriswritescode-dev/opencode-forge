import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  buildShimSource,
  disableConfigRegistration,
  ensurePluginRegistration,
  findConfigRegistrations,
  isVendoredShim,
  linkPlugin,
  readPluginShimState,
  removePluginRegistration,
  resolveCliConfigTarget,
  resolveCliPluginDir,
  resolveServerEntry,
  resolveTuiConfigTarget,
  resolveTuiEntry,
  unlinkPlugin,
  unvendorPlugin,
  vendorPlugin,
  VENDORED_CLI_SPEC,
  VENDORED_TUI_SPEC,
  type ConfigRegistration,
} from '../../src/install/plugin-link'
import {
  resolveCliConfigPath,
  resolvePluginShimDir,
  resolvePluginShimPath,
  resolveTuiConfigPath,
  resolveVendorDir,
} from '../../src/install/paths'

const tuiTarget = () => resolveTuiConfigTarget()
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

  test('escapes backslashes and double quotes in the entry path', () => {
    const source = buildShimSource('C:\\Users\\a"b\\dist\\index.js')
    expect(source).toBe('export { default } from "C:\\\\Users\\\\a\\"b\\\\dist\\\\index.js"\n')
  })
})

describe('linkPlugin', () => {
  test('creates the shim and the plugin directory, then reports unchanged and updated', () => {
    const created = linkPlugin({ dryRun: false })
    expect(created.action).toBe('created')
    expect(created.target).toBe(resolveServerEntry())
    expect(existsSync(resolvePluginShimDir())).toBe(true)
    expect(existsSync(resolvePluginShimPath())).toBe(true)
    expect(readFileSync(resolvePluginShimPath(), 'utf-8')).toBe(buildShimSource(resolveServerEntry()!))

    expect(linkPlugin({ dryRun: false }).action).toBe('unchanged')

    writeFileSync(resolvePluginShimPath(), 'export { default } from "/somewhere/else"\n')
    const updated = linkPlugin({ dryRun: false })
    expect(updated.action).toBe('updated')
    expect(readFileSync(resolvePluginShimPath(), 'utf-8')).toBe(buildShimSource(resolveServerEntry()!))
  })

  test('dry run reports the action without writing anything', () => {
    const result = linkPlugin({ dryRun: true })
    expect(result.action).toBe('created')
    expect(existsSync(resolvePluginShimDir())).toBe(false)
    expect(existsSync(resolvePluginShimPath())).toBe(false)
  })

  test('vendored mode writes a relative shim that round-trips as vendored', () => {
    const result = linkPlugin({ dryRun: false, mode: 'vendored' })
    expect(result.action).toBe('created')
    expect(result.target).toBe('./opencode-forge/dist/index.js')
    expect(readFileSync(resolvePluginShimPath(), 'utf-8')).toBe('export { default } from "./opencode-forge/dist/index.js"\n')

    const state = readPluginShimState()
    expect(state.present).toBe(true)
    expect(state.target).toBe('./opencode-forge/dist/index.js')
    expect(isVendoredShim(state)).toBe(true)

    linkPlugin({ dryRun: false })
    expect(isVendoredShim(readPluginShimState())).toBe(false)
  })

  test('omitting mode keeps the absolute external shim', () => {
    const result = linkPlugin({ dryRun: false })
    expect(result.action).toBe('created')
    expect(result.target).toBe(resolveServerEntry())
    expect(readPluginShimState().target).toBe(resolveServerEntry())
    expect(isVendoredShim(readPluginShimState())).toBe(false)
  })
})

describe('readPluginShimState', () => {
  test('round-trips the target written by linkPlugin', () => {
    linkPlugin({ dryRun: false })
    const state = readPluginShimState()
    expect(state.present).toBe(true)
    expect(state.target).toBe(resolveServerEntry())
  })

  test('returns present with no target for garbage content and absent when missing', () => {
    const missing = readPluginShimState()
    expect(missing.present).toBe(false)
    expect(missing.target).toBeUndefined()

    mkdirSync(resolvePluginShimDir(), { recursive: true })
    writeFileSync(resolvePluginShimPath(), 'module.exports = 42')
    const garbage = readPluginShimState()
    expect(garbage.present).toBe(true)
    expect(garbage.target).toBeUndefined()
  })
})

describe('unlinkPlugin', () => {
  test('removes the shim and reports absent when already gone', () => {
    linkPlugin({ dryRun: false })
    const removed = unlinkPlugin({ dryRun: false })
    expect(removed.action).toBe('removed')
    expect(existsSync(resolvePluginShimPath())).toBe(false)

    const absent = unlinkPlugin({ dryRun: false })
    expect(absent.action).toBe('absent')
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

describe('findConfigRegistrations', () => {
  function writeDistPackage(name: string): string {
    const root = mkdtempSync(join(tmpdir(), 'forge-pkg-'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name }))
    return join(root, 'dist')
  }

  test('detects forge entries by npm name, version, path, and array form', () => {
    const forgeDist = writeDistPackage('opencode-forge')
    writeGlobalConfig('opencode.jsonc', [
      '{',
      '  "plugin": [',
      '    "opencode-forge",',
      '    "opencode-forge@0.8.8",',
      `    ${JSON.stringify(forgeDist)},`,
      '    ["opencode-forge@1.0.0", { "x": 1 }],',
      '    "opencode-eyesight@0.1.9"',
      '    // "opencode-forge"',
      '  ]',
      '}',
      '',
    ])

    const regs = findConfigRegistrations()
    expect(regs.map((r) => r.spec)).toEqual([
      'opencode-forge',
      'opencode-forge@0.8.8',
      forgeDist,
      'opencode-forge@1.0.0',
    ])
    expect(regs.map((r) => r.line)).toEqual([3, 4, 5, 6])
    rmSync(forgeDist, { recursive: true, force: true })
  })

  test('ignores a dist path belonging to an unrelated package', () => {
    const otherDist = writeDistPackage('some-other-plugin')
    writeGlobalConfig('opencode.jsonc', [
      '{',
      '  "plugin": [',
      `    ${JSON.stringify(otherDist)},`,
      `    ${JSON.stringify(join(otherDist, 'index.js'))}`,
      '  ]',
      '}',
      '',
    ])

    expect(findConfigRegistrations()).toEqual([])
    rmSync(otherDist, { recursive: true, force: true })
  })
})

describe('disableConfigRegistration', () => {
  test('comments out a sole forge entry in jsonc in place', () => {
    const file = writeGlobalConfig('opencode.jsonc', [
      '{',
      '  // plugin declarations',
      '  "plugin": [',
      '    "opencode-eyesight@0.1.9",',
      '    "opencode-forge",',
      '    "opencode-eyesight@0.1.9"',
      '  ]',
      '}',
      '',
    ])
    const original = readFileSync(file, 'utf-8')
    const reg: ConfigRegistration = { file, spec: 'opencode-forge', line: 5 }

    expect(disableConfigRegistration(reg, { dryRun: true })).toBe('commented')
    expect(readFileSync(file, 'utf-8')).toBe(original)

    expect(disableConfigRegistration(reg, { dryRun: false })).toBe('commented')
    expect(readFileSync(file, 'utf-8')).toBe(
      [
        '{',
        '  // plugin declarations',
        '  "plugin": [',
        '    "opencode-eyesight@0.1.9",',
        '    // "opencode-forge",',
        '    "opencode-eyesight@0.1.9"',
        '  ]',
        '}',
        '',
      ].join('\n'),
    )
  })

  test('removes the forge entry from a json file leaving valid JSON', () => {
    const file = writeGlobalConfig('opencode.json', [
      '{',
      '  "plugin": [',
      '    "opencode-eyesight@0.1.9",',
      '    "opencode-forge",',
      '    "opencode-eyesight@0.1.9"',
      '  ]',
      '}',
      '',
    ])

    const action = disableConfigRegistration({ file, spec: 'opencode-forge', line: 4 }, { dryRun: false })
    expect(action).toBe('removed')

    const next = readFileSync(file, 'utf-8')
    expect(() => JSON.parse(next)).not.toThrow()
    expect(next).not.toContain('opencode-forge')
  })
})

describe('ensurePluginRegistration', () => {
  test('creates tui.json with the schema key and the spec when missing', () => {
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_TUI_SPEC, target: tuiTarget() })
    expect(result.action).toBe('created')
    expect(result.file).toBe(resolveTuiConfigPath())
    expect(result.spec).toBe(VENDORED_TUI_SPEC)
    expect(existsSync(resolveTuiConfigPath())).toBe(true)
    const text = readFileSync(resolveTuiConfigPath(), 'utf-8')
    expect(text).toContain('"$schema": "https://opencode.ai/tui.json"')
    expect(text).toContain(JSON.stringify(VENDORED_TUI_SPEC))
    expect(() => JSON.parse(text)).not.toThrow()
  })

  test('appends the spec to a commented trailing-comma file without disturbing comments', () => {
    writeGlobalConfig('tui.json', [
      '{',
      '  // TUI plugins are not auto-discovered; list them explicitly.',
      '  "plugin": [',
      '    "some-other-plugin",',
      '  ],',
      '}',
      '',
    ])
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_TUI_SPEC, target: tuiTarget() })
    expect(result.action).toBe('added')
    const text = readFileSync(resolveTuiConfigPath(), 'utf-8')
    expect(text).toContain('// TUI plugins are not auto-discovered; list them explicitly.')
    expect(text).toContain('"some-other-plugin"')
    expect(text).toContain(JSON.stringify(VENDORED_TUI_SPEC))
  })

  test('returns present and leaves the file byte-identical when the spec already exists', () => {
    ensurePluginRegistration({ dryRun: false, spec: VENDORED_TUI_SPEC, target: tuiTarget() })
    const before = readFileSync(resolveTuiConfigPath(), 'utf-8')
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_TUI_SPEC, target: tuiTarget() })
    expect(result.action).toBe('present')
    expect(readFileSync(resolveTuiConfigPath(), 'utf-8')).toBe(before)
  })

  test('replaces a stale forge entry while keeping unrelated entries and comments', () => {
    writeGlobalConfig('tui.json', [
      '{',
      '  // user comment',
      '  "plugin": [',
      '    "some-other-plugin",',
      '    "opencode-forge@0.8.8",',
      '  ],',
      '}',
      '',
    ])
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_TUI_SPEC, target: tuiTarget() })
    expect(result.action).toBe('updated')
    const text = readFileSync(resolveTuiConfigPath(), 'utf-8')
    expect(text).toContain('// user comment')
    expect(text).toContain('"some-other-plugin"')
    expect(text).not.toContain('opencode-forge@0.8.8')
    expect(text).toContain(JSON.stringify(VENDORED_TUI_SPEC))
  })

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

  test('is idempotent for the vendored cli.json spec', () => {
    expect(ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() }).action).toBe('created')
    const before = readFileSync(resolveCliConfigPath(), 'utf-8')
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('present')
    expect(readFileSync(resolveCliConfigPath(), 'utf-8')).toBe(before)
  })

  test('replaces a stale file spec migrated from tui.json', () => {
    writeGlobalConfig('cli.json', [
      '{',
      '  "plugins": [',
      '    "./plugin/opencode-forge/dist/tui.js"',
      '  ]',
      '}',
      '',
    ])
    const result = ensurePluginRegistration({ dryRun: false, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('updated')
    const text = readFileSync(resolveCliConfigPath(), 'utf-8')
    expect(text).not.toContain('dist/tui.js')
    expect(JSON.parse(text).plugins).toEqual([VENDORED_CLI_SPEC])
  })

  test('dry run reports the action without writing cli.json', () => {
    const result = ensurePluginRegistration({ dryRun: true, spec: VENDORED_CLI_SPEC, target: cliTarget() })
    expect(result.action).toBe('created')
    expect(existsSync(resolveCliConfigPath())).toBe(false)
  })
})

describe('removePluginRegistration', () => {
  test('removes forge entries from tui.json, reports absent on a second call, and keeps unrelated entries', () => {
    const file = writeGlobalConfig('tui.json', [
      '{',
      '  "plugin": [',
      '    "unrelated",',
      '    "opencode-forge",',
      '    "opencode-forge@0.8.8",',
      '    "other",',
      '  ],',
      '}',
      '',
    ])
    expect(removePluginRegistration({ dryRun: false, target: tuiTarget() })).toBe('removed')
    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('"unrelated"')
    expect(text).toContain('"other"')
    expect(text).not.toContain('opencode-forge')
    expect(removePluginRegistration({ dryRun: false, target: tuiTarget() })).toBe('absent')
  })

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
})

describe('relative forge path detection', () => {
  test('resolves a relative forge path against the config file directory, not the process cwd', () => {
    const configDir = join(configHome, 'opencode')
    mkdirSync(join(configDir, 'vendor', 'opencode-forge', 'dist'), { recursive: true })
    writeFileSync(join(configDir, 'vendor', 'opencode-forge', 'package.json'), JSON.stringify({ name: 'opencode-forge' }))
    writeFileSync(join(configDir, 'vendor', 'opencode-forge', 'dist', 'index.js'), '// built')
    writeGlobalConfig('opencode.jsonc', [
      '{',
      '  "plugin": [',
      '    "./vendor/opencode-forge/dist/index.js",',
      '  ],',
      '}',
      '',
    ])
    expect(findConfigRegistrations().map((r) => r.spec)).toEqual(['./vendor/opencode-forge/dist/index.js'])
  })

  test('recognizes vendored entries by directory containment even without a package.json', () => {
    const configDir = join(configHome, 'opencode')
    mkdirSync(join(configDir, 'plugin', 'opencode-forge', 'dist'), { recursive: true })
    writeFileSync(join(configDir, 'plugin', 'opencode-forge', 'dist', 'tui.js'), '// built')
    writeGlobalConfig('opencode.jsonc', [
      '{',
      '  "plugin": [',
      '    "./plugin/opencode-forge/dist/tui.js",',
      '  ],',
      '}',
      '',
    ])
    expect(findConfigRegistrations().map((r) => r.spec)).toEqual(['./plugin/opencode-forge/dist/tui.js'])
  })
})

describe('resolveTuiEntry', () => {
  test('points at the built dist/tui.js when present', () => {
    const entry = resolveTuiEntry()
    expect(entry).toBeDefined()
    expect(existsSync(entry!)).toBe(true)
    expect(basename(entry!)).toBe('tui.js')
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
  test('resolves against the config dir to a directory holding the tui entrypoint', () => {
    const configDir = join(configHome, 'opencode')
    mkdirSync(join(configDir, 'plugin', 'opencode-forge', 'dist'), { recursive: true })
    writeFileSync(join(configDir, 'plugin', 'opencode-forge', 'dist', 'tui.js'), '// built')

    const resolved = resolve(configDir, VENDORED_CLI_SPEC)
    expect(existsSync(resolved)).toBe(true)
    expect(statSync(resolved).isDirectory()).toBe(true)
    expect(existsSync(join(resolved, 'tui.js'))).toBe(true)
  })
})
