export function computeFenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length)
  let delimiter: '`' | '~' | null = null
  let delimiterLength = 0
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (delimiter === null) {
      if (!fence) {
        mask[i] = false
        continue
      }
      const marker = fence[1][0]
      if (marker !== '`' && marker !== '~') {
        mask[i] = false
        continue
      }
      delimiter = marker
      delimiterLength = fence[1].length
      mask[i] = true
      continue
    }

    const closesFence = fence
      && fence[1][0] === delimiter
      && fence[1].length >= delimiterLength
      && fence[2].trim() === ''
    if (closesFence) {
      delimiter = null
      delimiterLength = 0
      mask[i] = false
      continue
    }
    mask[i] = true
  }
  return mask
}
