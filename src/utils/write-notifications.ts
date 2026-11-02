/**
 * Returns a shallow copy of `repo` whose listed methods publish one notification
 * with the call's arguments after each successful call. A method that throws
 * notifies nothing, and a `false`/0 result still notifies because the listener
 * only refetches.
 */
export function withWriteNotifications<T extends object, K extends keyof T>(
  repo: T,
  methods: readonly K[],
  notify: (args: unknown[]) => void,
): T {
  const wrapped = { ...repo }
  for (const method of methods) {
    const original = repo[method]
    if (typeof original !== 'function') {
      throw new TypeError(`withWriteNotifications: ${String(method)} is not a repo method`)
    }
    wrapped[method] = function (this: unknown, ...args: unknown[]): unknown {
      const result = (original as (...callArgs: unknown[]) => unknown).apply(repo, args)
      notify(args)
      return result
    } as unknown as T[K]
  }
  return wrapped
}
