export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

export function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  const keep = maxLen - 5
  const start = Math.ceil(keep / 2)
  const end = Math.floor(keep / 2)
  return str.slice(0, start) + '.....' + str.slice(str.length - end)
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

export function formatDuration(ms: number, opts?: { includeSeconds?: boolean; compact?: boolean }): string {
  const hours = Math.floor(ms / (1000 * 60 * 60))
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((ms % (1000 * 60)) / 1000)

  if (!opts?.includeSeconds) {
    return `${hours}h ${minutes}m`
  }

  if (opts.compact) {
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  return `${hours}h ${minutes}m ${seconds}s`
}
