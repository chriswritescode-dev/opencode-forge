import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { dirname } from 'path'
import type { LoggingConfig } from '../types'
import { slugifyText } from './format'

const PREFIX = '[OpenCodeForge]'
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024

export function slugify(text: string): string {
  return slugifyText(text).substring(0, 50)
}

function ensureLogDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function rotateLogFile(filePath: string): void {
  const backupPath = filePath + '.old'
  // No truncating write after the rename: `appendFileSync` recreates the file on the next write.
  // Recreating it here would erase whatever another process appended in the gap, and many
  // processes share this file. A losing concurrent rename throws ENOENT and is swallowed by the
  // caller, which is the intended outcome — the file it wanted to rotate is already rotated.
  renameSync(filePath, backupPath)
}

function checkFileSize(filePath: string): void {
  try {
    const stats = statSync(filePath)
    if (stats.size > MAX_LOG_FILE_SIZE) {
      rotateLogFile(filePath)
    }
  } catch {
    // File doesn't exist yet, ignore
  }
}

export function createLogger(config: LoggingConfig) {
  const isEnabled = config.enabled
  const isDebug = config.debug ?? false
  // Distinguishes concurrent logger instances inside a single process, and together with the pid
  // it separates the interleaved output of the many processes that share one log file.
  const instanceId = Math.random().toString(36).slice(2, 8)

  if (!isEnabled) {
    return {
      log: (_message: string, ..._args: unknown[]): void => {},
      error: (_message: string, ..._args: unknown[]): void => {},
      debug: (_message: string, ..._args: unknown[]): void => {},
    }
  }

  const filePath = config.file
  ensureLogDir(filePath)

  // Deliberately nothing happens to the existing log here. Many processes load this plugin and
  // share one log file, so any per-init truncate or rotate destroys the window a restart was
  // meant to preserve: truncating erases it outright, and rotating clobbers `.old` once per
  // process start, leaving only the sliver written between the last two inits. Appending is the
  // only behavior that survives concurrent starts; `checkFileSize` still bounds growth.

  function formatArg(arg: unknown): string {
    if (arg === null) return 'null'
    if (arg === undefined) return 'undefined'
    if (arg instanceof Error) {
      return arg.stack ?? `${arg.name}: ${arg.message}`
    }
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    }
    return String(arg)
  }

  function write(level: string, message: string, args: unknown[]): void {
    checkFileSize(filePath)

    const timestamp = new Date().toISOString()
    const formattedArgs = args.length > 0 ? ' ' + args.map(formatArg).join(' ') : ''
    // Every opencode instance on this machine shares one log file, so lines are only attributable
    // to a process if each one carries its pid. Without it, concurrent work by two instances is
    // indistinguishable from one instance repeating itself.
    const line = `${timestamp} ${level} ${PREFIX}[${process.pid}:${instanceId}] ${message}${formattedArgs}\n`

    try {
      appendFileSync(filePath, line, 'utf-8')
    } catch {
      // Silently fail if logging fails - don't crash the plugin
    }
  }

  return {
    log: (message: string, ...args: unknown[]): void => {
      write('INFO', message, args)
    },
    error: (message: string, ...args: unknown[]): void => {
      write('ERROR', message, args)
    },
    debug: isDebug
      ? (message: string, ...args: unknown[]): void => {
          write('DEBUG', message, args)
        }
      : (_message: string, ..._args: unknown[]): void => {},
  }
}
