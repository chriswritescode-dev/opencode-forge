type RepoMethodOverride = (...args: unknown[]) => void

export function withWriteNotifications<T extends object, K extends keyof T>(
  repo: T,
  methods: readonly K[],
  notify: (args: unknown[]) => void,
): T {
  const overrides: Partial<Record<K, RepoMethodOverride>> = {}
  for (const method of methods) {
    const original = repo[method]
    if (!(original instanceof Function)) {
      throw new TypeError(`withWriteNotifications: ${String(method)} is not a repo method`)
    }
    overrides[method] = (...args: unknown[]) => {
      const result = original.apply(repo, args)
      notify(args)
      return result
    }
  }
  return { ...repo, ...overrides }
}
