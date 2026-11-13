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
