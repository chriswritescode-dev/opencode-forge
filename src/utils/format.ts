export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/**
 * Caps `text` at `maxLen` characters without cutting a word: the cut lands on
 * the last whitespace at or before the cap (a hard cut when there is none), and
 * the result carries no trailing whitespace or separator punctuation. Returns
 * `text` unchanged when it already fits.
 */
export function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const head = text.slice(0, maxLen)
  const lastWhitespace = head.search(/\s\S*$/)
  const cut = lastWhitespace === -1 ? head : head.slice(0, lastWhitespace)
  return cut.replace(/[\s,;:\-–—]+$/, '')
}

const LEADING_STRUCTURAL_ORDINAL = /^(phase|section|step)\s+\d+[a-z]?\s*[:.)\-–—]\s*/i

/**
 * Drops a leading structural ordinal such as `Phase 2:` or `Step 3 -` from a
 * section title, leaving only its human part. The architect mandates
 * `## Phase ...` headings, so the ordinal is structural and belongs to the
 * heading, not to the title or a commit subject. Titles without a numeric
 * ordinal are returned unchanged.
 */
export function stripLeadingStructuralOrdinal(title: string): string {
  return title.replace(LEADING_STRUCTURAL_ORDINAL, '').trim()
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

/**
 * Shared slug core: lowercase, drop punctuation, collapse whitespace runs to
 * single dashes. Callers add their own tail (length cap, edge trimming).
 */
export function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}
