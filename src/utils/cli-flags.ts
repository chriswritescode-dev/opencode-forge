/**
 * Reads a value-bearing long flag from an already-sliced argument list,
 * accepting both `--flag value` and `--flag=value`. Returns the last
 * occurrence's value, or `undefined` when the flag is absent or has no value.
 *
 * The `=` form is split on the first separator only, so values that themselves
 * contain `=` survive intact.
 */
export function readFlagValue(args: string[], flag: string): string | undefined {
  const bare = `--${flag}`
  const prefixed = `${bare}=`
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === bare) {
      if (i + 1 < args.length) value = args[++i]
    } else if (arg.startsWith(prefixed)) {
      value = arg.slice(prefixed.length)
    }
  }
  return value
}
