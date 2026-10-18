export function generateUniqueName(
  baseName: string,
  existingNames: readonly string[],
  isTaken?: (name: string) => boolean,
): string {
  const maxLength = 25
  const truncated = baseName.length > maxLength ? baseName.substring(0, maxLength) : baseName

  const taken = (name: string): boolean => existingNames.includes(name) || (isTaken?.(name) ?? false)

  if (!taken(truncated)) {
    return truncated
  }

  let counter = 1
  let candidate = `${truncated}-${counter}`

  while (taken(candidate)) {
    counter++
    candidate = `${truncated}-${counter}`
  }

  return candidate
}
