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
  renameSync(filePath, backupPath)
}

function checkFileSize(filePath: string): void {
  try {
    const stats = statSync(filePath)
    if (stats.size > MAX_LOG_FILE_SIZE) {
      rotateLogFile(filePath)
    }
  } catch {
  }
}

export function createLogger(config: LoggingConfig) {
  const isEnabled = config.enabled
  const isDebug = config.debug ?? false
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

  function write(level: string, message: string, args: unknown[]): void {
    checkFileSize(filePath)

    const timestamp = new Date().toISOString()
    const formattedArgs = args.length > 0
      ? ' ' + args.map((arg) => {
          if (arg === null) return 'null'
          if (arg === undefined) return 'undefined'
          if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
          if (arg instanceof Function) return String(arg)
          if (arg instanceof Object || Object.getPrototypeOf(arg) === null) {
            try {
              return JSON.stringify(arg)
            } catch {
              return Object.prototype.toString.call(arg)
            }
          }
          return String(arg)
        }).join(' ')
      : ''
    const line = `${timestamp} ${level} ${PREFIX}[${process.pid}:${instanceId}] ${message}${formattedArgs}\n`

    try {
      appendFileSync(filePath, line, 'utf-8')
    } catch {
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
