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
} from './paths'
import {
  runInteractiveInstall,
  type ConflictChoice,
  type InstallerPrompter,
  type InstallSummary,
  type OrphanChoice,
} from './installer'
import type { OrphanFile, PlannedFile } from '../utils/bundled-sync'

interface CliOptions {
  mode: 'interactive' | 'force' | 'keep' | 'yes'
  prune: boolean
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { mode: 'interactive', prune: true, dryRun: false, help: false }
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

Options:
  -f, --force      Overwrite all conflicting files and delete all orphans
  -k, --keep       Keep all local versions; never delete anything
  -y, --yes        Non-interactive: keep edited files, prune orphans
  -n, --dry-run    Show what would change without writing anything
      --no-prune   Do not touch orphaned files (only report them)
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

/** Interactive prompter backed by a readline interface. */
function interactivePrompter(rl: ReturnType<typeof createInterface>): InstallerPrompter {
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
    const prompter = rl ? interactivePrompter(rl) : autoPrompter(opts.mode as 'force' | 'keep' | 'yes')
    const summary = await runInteractiveInstall(getBundleSpecs(), prompter, {
      prune: opts.prune,
      dryRun: opts.dryRun,
    })
    printSummary(summary)
  } finally {
    rl?.close()
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  stdout.write(`\nInstaller failed: ${message}\n`)
  process.exitCode = 1
})
