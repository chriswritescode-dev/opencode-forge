export const SECTION_SUMMARY_START_MARKER = '<!-- section-summary:start -->'
export const SECTION_SUMMARY_END_MARKER = '<!-- section-summary:end -->'

export function hasSectionSummaryMarkers(text: string): boolean {
  return text.includes(SECTION_SUMMARY_START_MARKER) && text.includes(SECTION_SUMMARY_END_MARKER)
}
