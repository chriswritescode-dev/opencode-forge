import type { ForgeClient, SessionCreateParams } from '../client/port'
import { computeFenceMask } from './markdown-fences'

export const PLAN_EXECUTION_LABELS = [
  'New session',
  'Execute here',
  'Loop',
] as const

export const MAX_LOOP_NAME_LENGTH = 60

export type PlanExecutionLabel = typeof PLAN_EXECUTION_LABELS[number]

const STRUCTURAL_PLAN_HEADINGS = new Set([
  'objective',
  'loop name',
  'phases',
  'phase',
  'plan',
  'verification',
  'files',
  'edits',
  'acceptance criteria',
  'decisions',
  'conventions',
  'key context',
])

export function extractPlanTitle(planContent: string): string {
  return extractPlanExecutionMetadata(planContent).title
}

function extractFallbackPlanTitle(planContent: string): string {
  const headings: Array<{ text: string; line: number }> = []
  const lines = planContent.split('\n')
  
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#+\s+(.+)$/)
    if (match) {
      headings.push({ text: match[1].trim(), line: i })
    }
  }
  
  for (const heading of headings) {
    const normalized = heading.text.toLowerCase()
    if (STRUCTURAL_PLAN_HEADINGS.has(normalized)) continue
    if (isStructuralHeadingPrefix(normalized)) continue
    const title = heading.text
    return truncateName(title, true)
  }
  
  const objectiveMatch = planContent.match(/^#+\s+Objective\s*\n+(.+)$/im)
  if (objectiveMatch?.[1]) {
    const firstLine = objectiveMatch[1].trim().split('\n')[0]
    if (firstLine) {
      return truncateName(firstLine, true)
    }
  }
  
  const firstLine = planContent.split('\n').find(line => line.trim() && !line.trim().startsWith('---'))
  if (firstLine) {
    const trimmed = firstLine.trim()
    return truncateName(trimmed, true)
  }
  
  return 'Implementation Plan'
}

function isStructuralHeadingPrefix(normalized: string): boolean {
  return Array.from(STRUCTURAL_PLAN_HEADINGS).some(prefix => normalized.startsWith(prefix))
}

export interface LoopNameResult {
  displayName: string
  executionName: string
}

export interface PlanExecutionMetadata extends LoopNameResult {
  title: string
}

function withoutFencedContent(planContent: string): string {
  const lines = planContent.split('\n')
  const fenceMask = computeFenceMask(lines)
  return lines.map((line, index) => fenceMask[index] ? '' : line).join('\n')
}

export function findCanonicalLoopNameDeclarations(planContent: string): string[] {
  const declarations: string[] = []
  for (const line of withoutFencedContent(planContent).split('\n')) {
    const match = line.match(/^Loop Name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/)
    if (match?.[1]) declarations.push(match[1])
  }
  return declarations
}

function extractLoopNameFromHeading(planContent: string): string | null {
  const headingInlineMatch = planContent.match(/^#+\s*Loop Name:\s*(.+)$/im)
  if (headingInlineMatch?.[1]) {
    const name = headingInlineMatch[1].trim()
    return truncateName(name)
  }
  
  const headingBlockMatch = planContent.match(/^#+\s*Loop Name\s*\n+\s*([^\n#]+)/im)
  if (headingBlockMatch?.[1]) {
    const name = headingBlockMatch[1].trim()
    return truncateName(name)
  }
  
  return null
}

export function findExplicitLoopName(planContent: string): string | null {
  const unfencedContent = withoutFencedContent(planContent)
  const canonicalLoopName = findCanonicalLoopNameDeclarations(planContent)[0]
  if (canonicalLoopName) return truncateName(canonicalLoopName)

  const loopNameMatch = unfencedContent.match(/^(?:\s*(?:-\s*)?)?(?:\*\*)?Loop Name(?:\*\*)?:\s*(.+)$/m)
  if (loopNameMatch?.[1]) {
    return truncateName(loopNameMatch[1].trim())
  }
  return extractLoopNameFromHeading(unfencedContent)
}

function truncateName(name: string, ellipsis = false): string {
  if (name.length <= MAX_LOOP_NAME_LENGTH) return name
  return ellipsis
    ? `${name.substring(0, MAX_LOOP_NAME_LENGTH - 3)}...`
    : name.substring(0, MAX_LOOP_NAME_LENGTH)
}

export function extractLoopName(planContent: string): string {
  return findExplicitLoopName(planContent) ?? extractFallbackPlanTitle(planContent)
}

export function extractLoopNames(planContent: string): LoopNameResult {
  const { displayName, executionName } = extractPlanExecutionMetadata(planContent)
  return { displayName, executionName }
}

export function extractPlanExecutionMetadata(planContent: string): PlanExecutionMetadata {
  const displayName = extractLoopName(planContent)
  const executionName = sanitizeLoopName(displayName)
  return { title: truncateName(displayName, true), displayName, executionName }
}

export function sanitizeLoopName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, MAX_LOOP_NAME_LENGTH) || 'loop'
}

export interface PlanExecutionSession {
  sessionId: string
  workspaceId?: string
}

export async function createPlanExecutionSession(
  client: ForgeClient,
  params: SessionCreateParams,
): Promise<PlanExecutionSession> {
  const session = await client.session.create(params)
  return { sessionId: session.id, workspaceId: session.workspaceID }
}
