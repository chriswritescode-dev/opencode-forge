#!/usr/bin/env bun
import { parseGlobalOptions, resolveProjectIdByName } from './utils'
import { getGitProjectId } from '../utils/project-id'

interface CommandModule {
  cli: (args: string[], globalOpts: { dbPath?: string; resolvedProjectId?: string; dir?: string }) => Promise<void> | void
  help: () => void | Promise<void>
}

const loopCommands: Record<string, CommandModule> = {
  status: {
    cli: async (args, globalOpts) => {
      const { cli } = await import('./commands/status')
      await cli(args, globalOpts)
    },
    help: async () => {
      const { help } = await import('./commands/status')
      help()
    },
  },
  cancel: {
    cli: async (args, globalOpts) => {
      const { cli } = await import('./commands/cancel')
      await cli(args, globalOpts)
    },
    help: async () => {
      const { help } = await import('./commands/cancel')
      help()
    },
  },
  restart: {
    cli: async (args, globalOpts) => {
      const { cli } = await import('./commands/restart')
      await cli(args, globalOpts)
    },
    help: async () => {
      const { help } = await import('./commands/restart')
      help()
    },
  },
}

const commands: Record<string, CommandModule> = {
  upgrade: {
    cli: async (_args, _globalOpts) => {
      const { run } = await import('./commands/upgrade')
      await run()
    },
    help: async () => {
      const { help } = await import('./commands/upgrade')
      help()
    },
  },
  loop: {
    cli: async (args, globalOpts) => {
      const subcommandName = args[0]
      if (!subcommandName || subcommandName === 'help') {
        printLoopHelp()
        return
      }
      const subcommand = loopCommands[subcommandName]
      if (!subcommand) {
        console.error(`Unknown loop command: ${subcommandName}`)
        printLoopHelp()
        process.exit(1)
      }
      await subcommand.cli(args.slice(1), globalOpts)
    },
    help: () => printLoopHelp(),
  },
}

function printMainHelp(): void {
  console.log(`
OpenCode Forge CLI

Usage:
  oc-forge <command> [options]

Commands:
  upgrade         Check for and install plugin updates
  loop <command>  Manage iterative development loops


Global Options:
  --project, -p <name>   Project name or SHA (auto-detected from git)
  --dir, -d <path>       Git repo path for project detection
  --db-path <path>       Path to forge database
  --help, -h             Show help

Run 'oc-forge <command> --help' for more information.
  `.trim())
}

function printLoopHelp(): void {
  console.log(`
Manage iterative development loops

Usage:
  oc-forge loop <command> [options]

Commands:
  status    Show loop status
  cancel    Cancel a loop
  restart   Restart a loop
  `.trim())
}


function resolveProjectId(input: string): string {
  const isSha = /^[0-9a-f]{40}$/.test(input)
  if (isSha) return input
  return resolveProjectIdByName(input) || input
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || (args.length === 1 && (args[0] === 'help' || args[0] === '--help' || args[0] === '-h'))) {
    printMainHelp()
    process.exit(0)
  }

  const hasHelpFlag = (arr: string[]) => arr.includes('--help') || arr.includes('-h')

  if (hasHelpFlag(args) && args.length === 1) {
    printMainHelp()
    process.exit(0)
  }

  const { globalOpts, remainingArgs } = parseGlobalOptions(args)
  const commandName = remainingArgs[0]

  if (!commandName) {
    printMainHelp()
    process.exit(0)
  }

  const command = commands[commandName]

  if (!command) {
    console.error(`Unknown command: ${commandName}`)
    printMainHelp()
    process.exit(1)
  }

  if (globalOpts.help && remainingArgs.length === 1) {
    await command.help()
    process.exit(0)
  }

  const commandArgs = globalOpts.help && remainingArgs.length > 1
    ? [...remainingArgs.slice(1), '--help']
    : remainingArgs.slice(1)

  if (hasHelpFlag(commandArgs) && commandName !== 'loop') {
    await command.help()
    process.exit(0)
  }

  const resolvedProjectId = globalOpts.projectId
    ? resolveProjectId(globalOpts.projectId)
    : getGitProjectId(globalOpts.dir) ?? undefined

  await command.cli(commandArgs, {
    dbPath: globalOpts.dbPath,
    resolvedProjectId,
    dir: globalOpts.dir,
  })
}

runCli().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
