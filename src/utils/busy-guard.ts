export interface BusyGuardOptions {
  isBusy: () => boolean
  setBusy: (value: boolean) => void
  onBusy?: () => void
}

export function withBusyGuard<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
  opts: BusyGuardOptions,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    if (opts.isBusy()) {
      opts.onBusy?.()
      return
    }
    opts.setBusy(true)
    try {
      await fn(...args)
    } finally {
      opts.setBusy(false)
    }
  }
}
