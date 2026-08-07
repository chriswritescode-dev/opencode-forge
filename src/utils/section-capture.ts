export interface ParsedSection {
  index: number
  title: string
  content: string
  /** 0-based line of the first content line (marker line + 1); set by the decomposer. */
  startLine?: number
  /** Exclusive 0-based boundary: the stop heading, next marker, or end of plan. */
  endLine?: number
}
