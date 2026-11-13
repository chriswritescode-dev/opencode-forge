export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

export function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const head = text.slice(0, maxLen)
  const lastWhitespace = /\s/.test(text.charAt(maxLen)) ? -1 : head.search(/\s\S*$/)
  const cut = lastWhitespace === -1 ? head : head.slice(0, lastWhitespace)
  return cut.replace(/[\s,;:\-–—]+$/, '') || head
}

const LEADING_STRUCTURAL_ORDINAL = /^(phase|section|step)\s+\d+(?:\.\d+)*[a-z]?\s*[:.)\-–—]\s*/i

export function stripLeadingStructuralOrdinal(title: string): string {
  return title.replace(LEADING_STRUCTURAL_ORDINAL, '').trim()
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

export function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}
