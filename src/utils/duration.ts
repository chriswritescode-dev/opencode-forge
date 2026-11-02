// Pure, dependency-free duration helpers shared by the server (loop tooling,
// dashboard service) and the TUI dashboard.

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`
}

export function computeElapsedSeconds(startedAt?: string | number, endedAt?: string | number): number {
  if (!startedAt) return 0
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  return Math.round((end - start) / 1000)
}
