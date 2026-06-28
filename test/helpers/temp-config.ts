import { beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'

export function useTempConfigHome(prefix: string): () => string {
  let dir = ''
  beforeEach(() => {
    dir = `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    mkdirSync(dir, { recursive: true })
    process.env['XDG_CONFIG_HOME'] = dir
  })
  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME']
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })
  return () => dir
}
