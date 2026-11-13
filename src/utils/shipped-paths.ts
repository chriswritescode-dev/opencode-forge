import { basename, dirname } from 'path'
import { fileURLToPath } from 'url'

export function resolveShippedRoot(moduleUrl: string): string {
  const startDir = dirname(fileURLToPath(moduleUrl))
  let current = startDir
  while (true) {
    if (basename(current) === 'dist' || basename(current) === 'src') {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return startDir
    current = parent
  }
}
