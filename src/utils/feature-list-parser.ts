export const FEATURES_START_MARKER = '<!-- forge-features:start -->'
export const FEATURES_END_MARKER = '<!-- forge-features:end -->'

export interface ParsedFeature {
  title: string
  description: string
}

export type FeatureListResult =
  | { ok: true; features: ParsedFeature[] }
  | { ok: false; reason: 'missing' | 'unterminated' | 'invalid_json' | 'empty' | 'invalid_shape' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFeatureList(text: string): FeatureListResult {
  const lines = text.split('\n')

  let startIndex = -1
  let endIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === FEATURES_START_MARKER) startIndex = i
    if (line === FEATURES_END_MARKER) endIndex = i
  }

  if (startIndex === -1 && endIndex === -1) {
    return { ok: false, reason: 'missing' }
  }

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return { ok: false, reason: 'unterminated' }
  }

  const jsonText = lines.slice(startIndex + 1, endIndex).join('\n').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape' }
  }

  if (parsed.length === 0) {
    return { ok: false, reason: 'empty' }
  }

  const features: ParsedFeature[] = []

  for (const element of parsed) {
    if (!isRecord(element)) {
      return { ok: false, reason: 'invalid_shape' }
    }

    const title = typeof element.title === 'string' ? element.title.trim() : ''
    const description = typeof element.description === 'string' ? element.description.trim() : ''

    if (!title || !description) {
      return { ok: false, reason: 'invalid_shape' }
    }

    features.push({ title, description })
  }

  return { ok: true, features }
}
