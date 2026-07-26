/**
 * Returns a per-line mask where `true` means the line sits inside a fenced code
 * block. A line whose trimmed form starts with ``` toggles the state, and the
 * fence line itself is reported as inside the fence. Matches the historical
 * behaviour of decomposeDeterministically so marker scanning is consistent
 * across the plan pipeline.
 */
export function computeFenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length)
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    // Anchored leading-whitespace match rather than `line.trim()`: equivalent
    // for a `^```" test, and avoids one throwaway string per line on what is
    // the hot loop of the whole plan pipeline.
    if (/^\s*```/.test(lines[i])) fence = !fence
    mask[i] = fence
  }
  return mask
}
