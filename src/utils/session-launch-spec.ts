import { extractPlanExecutionMetadata, sanitizeLoopName } from './plan-execution'

export type SessionLaunchSpecKind = 'plan' | 'goal'

export interface SessionLaunchSpec {
  kind: SessionLaunchSpecKind
  text: string
  updatedAt: number
}

const GOAL_TITLE_CAP = 80

function truncateGoalTitle(line: string): string {
  return line.length > GOAL_TITLE_CAP ? `${line.slice(0, GOAL_TITLE_CAP - 1)}…` : line
}

function deriveGoalTitle(brief: string): string {
  const lines = brief.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Goal\s*$/i.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim()
      if (line.length === 0) continue
      if (/^#{1,6}\s+/.test(line)) break
      return truncateGoalTitle(line)
    }
    break
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (/^#{1,6}\s+/.test(line)) continue
    return truncateGoalTitle(line)
  }
  const firstLine = lines.map((l) => l.trim()).find((l) => l.length > 0) ?? brief.trim()
  return truncateGoalTitle(firstLine)
}

export function extractLaunchSpecMetadata(spec: SessionLaunchSpec): { title: string; executionName: string } {
  if (spec.kind === 'plan') {
    const { title, executionName } = extractPlanExecutionMetadata(spec.text)
    return { title, executionName }
  }
  const title = deriveGoalTitle(spec.text)
  return { title, executionName: sanitizeLoopName(title) }
}
