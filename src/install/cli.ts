import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { dirname } from 'path'
import { spawnSync } from 'child_process'
import { createInterface } from 'readline/promises'
import { stdin, stdout } from 'process'
import {
  getBundleSpecs,
  resolveConfigDir,
  resolveConfigPath,
  resolveBundledConfigPath,
  resolveTuiConfigPath,
  resolveVendorDir,
} from './paths'
import {
  runInteractiveInstall,
  type ConflictChoice,
  type InstallerPrompter,
  type InstallSummary,
  type OrphanChoice,
} from './installer'
import {
  disableConfigRegistration,
  ensureTuiRegistration,
  findConfigRegistrations,
  linkPlugin,
  removeTuiRegistration,
  resolveTuiEntry,
  unlinkPlugin,
  unvendorPlugin,
  vendorPlugin,
  VENDORED_TUI_SPEC,
} from './plugin-link'
import type { OrphanFile, PlannedFile } from '../utils/bundled-sync'

interface CliOptions {
  mode: 'interactive' | 'force' | 'keep' | 'yes'
  prune: boolean
  dryRun: boolean
  help: boolean
  link: 'prompt' | 'external' | 'vendored' | 'off'
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { mode: 'interactive', prune: true, dryRun: false, help: false, link: 'prompt' }
  for (const arg of argv) {
    switch (arg) {
      case '-f':
      case '--force':
        opts.mode = 'force'
        break
      case '-k':
      case '--keep':
        opts.mode = 'keep'
        break
      case '-y':
      case '--yes':
        opts.mode = 'yes'
        break
      case '-n':
      case '--dry-run':
        opts.dryRun = true
        break
      case '--prune':
        opts.prune = true
        break
      case '--no-prune':
        opts.prune = false
        break
      case '--link':
        opts.link = 'external'
        break
      case '--vendor':
        opts.link = 'vendored'
        break
      case '--unlink':
        opts.link = 'off'
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        stdout.write(`Unknown option: ${arg}\n`)
        opts.help = true
    }
  }
  return opts
}

const HELP = `opencode-forge — install bundled prompts & skills into your config dir

Usage:
  bunx opencode-forge [options]

By default this walks through every bundled prompt and skill. New files are
installed silently; when an installed file differs from the bundle you are
prompted to overwrite or keep your version. Orphaned files from older layouts
are offered for removal.

The --link mode always loads the current build, so a rebuild needs no
reinstall, but is tied to this machine's checkout path. The --vendor mode copies
forge into the config dir, so the whole config folder can be version-controlled
and moved to another machine, at the cost of re-running after an upgrade. Both
modes write the tui.json entry, because the TUI plugin is not auto-loaded from
the plugin directory.

Options:
  -f, --force      Overwrite all conflicting files and delete all orphans
  -k, --keep       Keep all local versions; never delete anything
  -y, --yes        Non-interactive: keep edited files, prune orphans
  -n, --dry-run    Show what would change without writing anything
      --no-prune   Do not touch orphaned files (only report them)
      --link       Install into opencode's plugin dir from the current build
      --vendor     Install a self-contained copy into the config dir (portable)
      --unlink     Remove the plugin-dir installation
  -h, --help       Show this help
`

/** Render a colored diff between the installed file and the bundled version. */
function showDiff(file: PlannedFile): void {
  const color = stdout.isTTY ? '--color=always' : '--color=never'
  const res = spawnSync(
    'git',
    ['--no-pager', 'diff', '--no-index', color, '--', file.dest, file.src],
    { encoding: 'utf-8' },
  )
  if (res.error) {
    stdout.write('  (git not available; cannot show diff)\n')
    return
  }
  stdout.write(`\n${res.stdout || '  (no textual diff)\n'}\n`)
}

/** Interactive yes/no question for the plugin-directory step. */
interface LinkPrompter {
  confirm(question: string, defaultYes: boolean): Promise<boolean>
}

/** Interactive prompter backed by a readline interface. */
function interactivePrompter(rl: ReturnType<typeof createInterface>): InstallerPrompter & LinkPrompter {
  return {
    async fileConflict(file: PlannedFile): Promise<ConflictChoice> {
      const label = file.state === 'edited' ? 'locally edited' : file.state
      for (;;) {
        const answer = (
          await rl.question(`  conflict: ${file.rel} (${label}) — [o]verwrite / [k]eep / [d]iff (default keep): `)
        )
          .trim()
          .toLowerCase()
        if (answer === 'o' || answer === 'overwrite') return 'overwrite'
        if (answer === '' || answer === 'k' || answer === 'keep') return 'keep'
        if (answer === 'd' || answer === 'diff') {
          showDiff(file)
          continue
        }
        stdout.write('  Please answer o, k, or d.\n')
      }
    },
    async orphan(orphan: OrphanFile): Promise<OrphanChoice> {
      for (;;) {
        const answer = (
          await rl.question(`  orphan: ${orphan.rel} (no longer bundled) — [d]elete / [k]eep (default keep): `)
        )
          .trim()
          .toLowerCase()
        if (answer === 'd' || answer === 'delete') return 'delete'
        if (answer === '' || answer === 'k' || answer === 'keep') return 'keep'
        stdout.write('  Please answer d or k.\n')
      }
    },
    async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      for (;;) {
        const answer = (
          await rl.question(`  ${question} — [y]es / [n]o (default ${defaultYes ? 'yes' : 'no'}): `)
        )
          .trim()
          .toLowerCase()
        if (answer === 'y' || answer === 'yes') return true
        if (answer === 'n' || answer === 'no') return false
        if (answer === '') return defaultYes
        stdout.write('  Please answer y or n.\n')
      }
    },
  }
}

function autoPrompter(mode: 'force' | 'keep' | 'yes'): InstallerPrompter {
  const file: ConflictChoice = mode === 'force' ? 'overwrite' : 'keep'
  const orphan: OrphanChoice = mode === 'keep' ? 'keep' : 'delete'
  return {
    fileConflict: async () => file,
    orphan: async () => orphan,
  }
}

function ensureConfig(dryRun: boolean): string {
  const configPath = resolveConfigPath()
  if (existsSync(configPath)) return 'exists'
  const bundled = resolveBundledConfigPath()
  if (!existsSync(bundled)) return 'no-bundled-default'
  if (!dryRun) {
    mkdirSync(dirname(configPath), { recursive: true })
    copyFileSync(bundled, configPath)
  }
  return 'created'
}

function list(label: string, items: string[]): void {
  if (items.length === 0) return
  stdout.write(`  ${label} (${items.length}):\n`)
  for (const item of items) stdout.write(`    - ${item}\n`)
}

function printSummary(summary: InstallSummary): void {
  stdout.write('\nSummary:\n')
  for (const b of summary.bundles) {
    if (b.unavailable) {
      stdout.write(`\n${b.title}: bundled source not found, skipped.\n`)
      continue
    }
    stdout.write(`\n${b.title}:\n`)
    list('installed', b.installed)
    list('overwritten', b.overwritten)
    list('kept (yours)', b.kept)
    list('recorded', b.adopted)
    list('pruned', b.pruned)
    list('orphans left', b.orphansKept)
    if (
      b.installed.length + b.overwritten.length + b.kept.length + b.adopted.length + b.pruned.length === 0 &&
      b.orphansKept.length === 0
    ) {
      stdout.write(`  up to date (${b.unchanged} files)\n`)
    } else {
      stdout.write(`  unchanged: ${b.unchanged}\n`)
    }
  }
  if (summary.dryRun) {
    stdout.write('\nDry run — no files were written.\n')
  }
}

/**
 * Perform the plugin-directory step after the bundle install: install or remove
 * the server re-export shim, register the TUI entry, and surface any
 * double-loading config registrations.
 */
async function runPluginLinkStep(
  opts: CliOptions,
  prompter: InstallerPrompter & Partial<LinkPrompter>,
): Promise<void> {
  if (opts.link === 'prompt') {
    if (!prompter.confirm) return
    const yes = await prompter.confirm("Install forge into opencode's plugin dir?", true)
    if (!yes) return
    const selfContained = await prompter.confirm('Make it self-contained so the config folder is portable?', false)
    opts.link = selfContained ? 'vendored' : 'external'
  }
  stdout.write('\nPlugin directory:\n')
  if (opts.link === 'off') {
    const unlinked = unlinkPlugin({ dryRun: opts.dryRun })
    stdout.write(`  ${unlinked.action}: ${unlinked.shimPath}\n`)
    const unvendored = unvendorPlugin({ dryRun: opts.dryRun })
    stdout.write(`  ${unvendored}: ${resolveVendorDir()}\n`)
    const tuiRemoved = removeTuiRegistration({ dryRun: opts.dryRun })
    stdout.write(`  ${tuiRemoved}: ${resolveTuiConfigPath()}\n`)
    return
  }
  if (opts.link === 'vendored') {
    const vendor = vendorPlugin({ dryRun: opts.dryRun })
    if (vendor.action !== 'vendored') {
      stdout.write(`  ${vendor.action}: ${vendor.vendorDir}\n`)
      if (vendor.action === 'missing-entry') {
        stdout.write('  The built package could not be found. Run `pnpm build` first, then re-run.\n')
      }
      process.exitCode = 1
      return
    }
    stdout.write(`  copied: ${vendor.vendorDir}\n`)
    list('copied', vendor.copied)
    list('missing', vendor.missing)
    const linked = linkPlugin({ dryRun: opts.dryRun, mode: 'vendored' })
    stdout.write(`  ${linked.action}: ${linked.shimPath}\n`)
    if (linked.target) stdout.write(`    re-exports: ${linked.target}\n`)
    const tui = ensureTuiRegistration({ dryRun: opts.dryRun, spec: VENDORED_TUI_SPEC })
    stdout.write(`  ${tui.action}: ${tui.file} ${JSON.stringify(tui.spec)}\n`)
    return
  }
  const linked = linkPlugin({ dryRun: opts.dryRun, mode: 'external' })
  if (linked.action === 'missing-entry') {
    stdout.write(`  missing-entry: ${linked.shimPath}\n`)
    stdout.write('  The built server entry could not be found. Run `pnpm build` first, then re-run.\n')
    process.exitCode = 1
    return
  }
  stdout.write(`  ${linked.action}: ${linked.shimPath}\n`)
  if (linked.target) stdout.write(`    re-exports: ${linked.target}\n`)
  const tuiEntry = resolveTuiEntry()
  if (tuiEntry) {
    const tui = ensureTuiRegistration({ dryRun: opts.dryRun, spec: tuiEntry })
    stdout.write(`  ${tui.action}: ${tui.file} ${JSON.stringify(tui.spec)}\n`)
  } else {
    stdout.write('  warning: TUI entry skipped because dist/tui.js was not found.\n')
  }
  for (const reg of findConfigRegistrations()) {
    stdout.write(`  config registration: ${reg.file}:${reg.line} "${reg.spec}"\n`)
    stdout.write('    Leaving it in place makes opencode load forge twice under the same id (oc-forge).\n')
    if (prompter.confirm) {
      const disable = await prompter.confirm('Disable this entry?', true)
      if (!disable) {
        stdout.write('    kept: left in place\n')
        continue
      }
      stdout.write(`    disabled: ${disableConfigRegistration(reg, { dryRun: opts.dryRun })}\n`)
    } else {
      stdout.write(
        '    warning: not modified. Re-run interactively to disable it, or remove this entry by hand.\n',
      )
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    stdout.write(HELP)
    return
  }

  stdout.write(`opencode-forge installer\n`)
  stdout.write(`Config dir: ${resolveConfigDir()}\n`)
  if (opts.dryRun) stdout.write('(dry run)\n')

  const configState = ensureConfig(opts.dryRun)
  if (configState === 'created') stdout.write(`Installed default config: ${resolveConfigPath()}\n`)
  else if (configState === 'exists') stdout.write(`Config already present (left untouched): ${resolveConfigPath()}\n`)

  const interactive = opts.mode === 'interactive'
  if (interactive && !stdin.isTTY) {
    stdout.write(
      '\nNo interactive terminal detected. Re-run with --force, --keep, or --yes for non-interactive use.\n',
    )
    process.exitCode = 1
    return
  }

  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null
  try {
    const prompter: InstallerPrompter & Partial<LinkPrompter> = rl
      ? interactivePrompter(rl)
      : autoPrompter(opts.mode as 'force' | 'keep' | 'yes')
    const summary = await runInteractiveInstall(getBundleSpecs(), prompter, {
      prune: opts.prune,
      dryRun: opts.dryRun,
    })
    printSummary(summary)
    await runPluginLinkStep(opts, prompter)
  } finally {
    rl?.close()
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  stdout.write(`\nInstaller failed: ${message}\n`)
  process.exitCode = 1
})
