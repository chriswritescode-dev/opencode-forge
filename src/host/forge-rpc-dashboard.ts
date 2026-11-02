import type { LoopRow } from '../storage/repos/loops-repo'
import type {
  LoopUsageAggregate,
  ReviewFindingRow,
  SectionPlanRow,
} from '../storage'
import type {
  AmendmentChangeSummary,
  AmendmentDiffLine,
  AmendmentSectionChange,
} from '../utils/amendment-diff'
import { isRecord } from '../utils/is-record'
import { readForgeRpcResult, type ForgeRpcError } from './forge-rpc-result'

/**
 * Returns a literal enum list typed by the union it must cover. Compilation fails when the list
 * omits a union member or lists a non-member, because OpenCode rejects output whose enum value is
 * not listed.
 */
function enumList<Union>() {
  return <const List extends readonly Union[]>(
    list: List,
    ..._missing: Exclude<Union, List[number]> extends never ? [] : [never]
  ): List => list
}

const DASHBOARD_LOOP_STATUSES = enumList<LoopRow['status']>()([
  'running',
  'completed',
  'cancelled',
  'errored',
  'stalled',
])

const DASHBOARD_LOOP_PHASES = enumList<LoopRow['phase']>()([
  'coding',
  'auditing',
  'post_action',
])

export interface ForgeDashboardUnexecutedPlan {
  sessionId: string
  title: string
  updatedAt: number
  charCount: number
}

export interface ForgeDashboardLoopSummary {
  loopName: string
  status: LoopRow['status']
  phase: LoopRow['phase']
  iteration: number
  maxIterations: number
  currentSectionIndex: number
  totalSections: number
  sectionCount: number
  bugCount: number
  hasPlan: boolean
  startedAt: number
  completedAt?: number
  activityAt: number
  durationText?: string
  totalCost?: number
  branch?: string
  executionModel?: string
  auditorModel?: string
}

export interface ForgeDashboardProjectSummary {
  projectId: string
  projectDir?: string
  loopCount: number
  unexecutedPlanCount: number
  bugCount: number
  loops: ForgeDashboardLoopSummary[]
  unexecutedPlans: ForgeDashboardUnexecutedPlan[]
}

export interface ForgeDashboardSummary {
  generatedAt: number
  projects: ForgeDashboardProjectSummary[]
}

export type ForgeDashboardSummaryOutput = ForgeDashboardSummary | ForgeRpcError

const DASHBOARD_SUMMARY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const

const DASHBOARD_LOOP_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    loopName: { type: 'string' },
    status: { type: 'string', enum: DASHBOARD_LOOP_STATUSES },
    phase: { type: 'string', enum: DASHBOARD_LOOP_PHASES },
    iteration: { type: 'integer' },
    maxIterations: { type: 'integer' },
    currentSectionIndex: { type: 'integer' },
    totalSections: { type: 'integer' },
    sectionCount: { type: 'integer' },
    bugCount: { type: 'integer' },
    hasPlan: { type: 'boolean' },
    startedAt: { type: 'number' },
    completedAt: { type: 'number' },
    activityAt: { type: 'number' },
    durationText: { type: 'string' },
    totalCost: { type: 'number' },
    branch: { type: 'string' },
    executionModel: { type: 'string' },
    auditorModel: { type: 'string' },
  },
  required: [
    'loopName',
    'status',
    'phase',
    'iteration',
    'maxIterations',
    'currentSectionIndex',
    'totalSections',
    'sectionCount',
    'bugCount',
    'hasPlan',
    'startedAt',
    'activityAt',
  ],
  additionalProperties: false,
} as const

const DASHBOARD_UNEXECUTED_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    title: { type: 'string' },
    updatedAt: { type: 'number' },
    charCount: { type: 'integer' },
  },
  required: ['sessionId', 'title', 'updatedAt', 'charCount'],
  additionalProperties: false,
} as const

const DASHBOARD_PROJECT_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    projectDir: { type: 'string' },
    loopCount: { type: 'integer' },
    unexecutedPlanCount: { type: 'integer' },
    bugCount: { type: 'integer' },
    loops: { type: 'array', items: DASHBOARD_LOOP_SUMMARY_SCHEMA },
    unexecutedPlans: { type: 'array', items: DASHBOARD_UNEXECUTED_PLAN_SCHEMA },
  },
  required: ['projectId', 'loopCount', 'unexecutedPlanCount', 'bugCount', 'loops', 'unexecutedPlans'],
  additionalProperties: false,
} as const

const DASHBOARD_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    generatedAt: { type: 'number' },
    projects: { type: 'array', items: DASHBOARD_PROJECT_SUMMARY_SCHEMA },
  },
  required: ['generatedAt', 'projects'],
  additionalProperties: false,
} as const

export const DASHBOARD_SUMMARY_METHOD = {
  input: DASHBOARD_SUMMARY_INPUT,
  output: {
    type: 'object',
    properties: {
      ...DASHBOARD_SUMMARY_SCHEMA.properties,
      error: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasCounts(row: Record<string, unknown>): boolean {
  return isNumber(row.loopCount)
    && isNumber(row.unexecutedPlanCount)
    && isNumber(row.bugCount)
}

function hasRowKeys(row: unknown, key: string): boolean {
  return isRecord(row) && typeof row[key] === 'string'
}

function isDashboardSummary(record: Record<string, unknown>): boolean {
  if (!isNumber(record.generatedAt) || !Array.isArray(record.projects)) return false
  return record.projects.every((project) =>
    isRecord(project)
    && typeof project.projectId === 'string'
    && hasCounts(project)
    && Array.isArray(project.loops)
    && project.loops.every((loop) => hasRowKeys(loop, 'loopName'))
    && Array.isArray(project.unexecutedPlans)
    && project.unexecutedPlans.every((plan) => hasRowKeys(plan, 'sessionId')))
}

export function readForgeDashboardSummary(value: unknown): ForgeDashboardSummaryOutput {
  return readForgeRpcResult(value, 'dashboard summary', (record) =>
    isDashboardSummary(record) ? (record as unknown as ForgeDashboardSummary) : null)
}

const DASHBOARD_SECTION_STATUSES = enumList<SectionPlanRow['status']>()([
  'pending',
  'in_progress',
  'completed',
  'failed',
])

const DASHBOARD_FINDING_SEVERITIES = enumList<ReviewFindingRow['severity']>()([
  'bug',
  'warning',
])

const DASHBOARD_AMENDMENT_CHANGES = enumList<AmendmentSectionChange>()([
  'added',
  'removed',
  'modified',
  'unchanged',
])

const DASHBOARD_DIFF_LINE_KINDS = enumList<AmendmentDiffLine['kind']>()([
  'add',
  'remove',
  'context',
  'gap',
])

export interface ForgeLoopDetailRow {
  projectId: string
  loopName: string
  status: LoopRow['status']
  currentSessionId: string
  worktree: boolean
  worktreeDir: string
  worktreeBranch?: string
  projectDir: string
  maxIterations: number
  iteration: number
  auditCount: number
  errorCount: number
  phase: LoopRow['phase']
  executionModel?: string
  executionVariant?: string
  auditorModel?: string
  auditorVariant?: string
  auditorFallbackIndex: number
  modelFailed: boolean
  sandbox: boolean
  startedAt: number
  completedAt?: number
  terminationReason?: string
  currentSectionIndex: number
  totalSections: number
  baseCommit?: string
}

export interface ForgeSectionPlan {
  projectId: string
  loopName: string
  sectionIndex: number
  title: string
  content: string
  status: SectionPlanRow['status']
  attempts: number
  summaryDone?: string
  summaryDeviations?: string
  summaryFollowUps?: string
  startedAt?: number
  completedAt?: number
}

export interface ForgeReviewFinding {
  projectId: string
  file: string
  line: number
  severity: ReviewFindingRow['severity']
  description: string
  scenario?: string
  loopName?: string
  sectionIndex?: number
  createdAt: number
}

export type ForgeLoopUsage = LoopUsageAggregate

export interface ForgeLoopTransition {
  id: number
  projectId: string
  loopName: string
  eventType: string
  transitionKind: string
  fromPhase: string
  toPhase?: string
  status?: string
  reason?: string
  iteration: number
  sectionIndex?: number
  createdAt: number
}

export interface ForgePlanAmendment {
  id: number
  projectId: string
  loopName: string
  source: string
  rationale: string
  appliedAtSection: number
  createdAt: number
  summary: AmendmentChangeSummary
}

export interface ForgeAmendmentDiffLine {
  kind: AmendmentDiffLine['kind']
  text: string
}

export interface ForgeAmendmentSectionDiff {
  index: number
  change: AmendmentSectionChange
  title: string
  previousTitle?: string
  lines: ForgeAmendmentDiffLine[]
}

export interface ForgeAmendmentDiff {
  sections: ForgeAmendmentSectionDiff[]
  summary: AmendmentChangeSummary
}

export interface ForgeLoopDetail {
  loop: ForgeLoopDetailRow
  durationText?: string
  lastAuditResult?: string
  postActionReport?: string
  completionSummary?: string
  plan?: string
  sections: ForgeSectionPlan[]
  findings: ForgeReviewFinding[]
  usage?: ForgeLoopUsage
  transitions: ForgeLoopTransition[]
  transitionsCapped: boolean
  amendments: ForgePlanAmendment[]
}

export interface ForgeProjectFindingsLoop {
  loopName: string
  findings: ForgeReviewFinding[]
}

export interface ForgeProjectFindings {
  loops: ForgeProjectFindingsLoop[]
}

export type ForgeLoopDetailOutput = ForgeLoopDetail | ForgeRpcError
export type ForgeProjectFindingsOutput = ForgeProjectFindings | ForgeRpcError
export type ForgeAmendmentDiffOutput = ForgeAmendmentDiff | ForgeRpcError

const LOOP_DETAIL_ROW_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    loopName: { type: 'string' },
    status: { type: 'string', enum: DASHBOARD_LOOP_STATUSES },
    currentSessionId: { type: 'string' },
    worktree: { type: 'boolean' },
    worktreeDir: { type: 'string' },
    worktreeBranch: { type: 'string' },
    projectDir: { type: 'string' },
    maxIterations: { type: 'integer' },
    iteration: { type: 'integer' },
    auditCount: { type: 'integer' },
    errorCount: { type: 'integer' },
    phase: { type: 'string', enum: DASHBOARD_LOOP_PHASES },
    executionModel: { type: 'string' },
    executionVariant: { type: 'string' },
    auditorModel: { type: 'string' },
    auditorVariant: { type: 'string' },
    auditorFallbackIndex: { type: 'integer' },
    modelFailed: { type: 'boolean' },
    sandbox: { type: 'boolean' },
    startedAt: { type: 'number' },
    completedAt: { type: 'number' },
    terminationReason: { type: 'string' },
    currentSectionIndex: { type: 'integer' },
    totalSections: { type: 'integer' },
    baseCommit: { type: 'string' },
  },
  required: [
    'projectId',
    'loopName',
    'status',
    'currentSessionId',
    'worktree',
    'worktreeDir',
    'projectDir',
    'maxIterations',
    'iteration',
    'auditCount',
    'errorCount',
    'phase',
    'auditorFallbackIndex',
    'modelFailed',
    'sandbox',
    'startedAt',
    'currentSectionIndex',
    'totalSections',
  ],
  additionalProperties: false,
} as const

const SECTION_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    loopName: { type: 'string' },
    sectionIndex: { type: 'integer' },
    title: { type: 'string' },
    content: { type: 'string' },
    status: { type: 'string', enum: DASHBOARD_SECTION_STATUSES },
    attempts: { type: 'integer' },
    summaryDone: { type: 'string' },
    summaryDeviations: { type: 'string' },
    summaryFollowUps: { type: 'string' },
    startedAt: { type: 'number' },
    completedAt: { type: 'number' },
  },
  required: ['projectId', 'loopName', 'sectionIndex', 'title', 'content', 'status', 'attempts'],
  additionalProperties: false,
} as const

const REVIEW_FINDING_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: DASHBOARD_FINDING_SEVERITIES },
    description: { type: 'string' },
    scenario: { type: 'string' },
    loopName: { type: 'string' },
    sectionIndex: { type: 'integer' },
    createdAt: { type: 'number' },
  },
  required: ['projectId', 'file', 'line', 'severity', 'description', 'createdAt'],
  additionalProperties: false,
} as const

const USAGE_BUCKET_SCHEMA = {
  type: 'object',
  properties: {
    cost: { type: 'number' },
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    reasoningTokens: { type: 'integer' },
    cacheReadTokens: { type: 'integer' },
    cacheWriteTokens: { type: 'integer' },
    messageCount: { type: 'integer' },
  },
  required: ['cost', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'messageCount'],
  additionalProperties: false,
} as const

const LOOP_USAGE_SCHEMA = {
  type: 'object',
  properties: {
    loopName: { type: 'string' },
    totalCost: { type: 'number' },
    totalInputTokens: { type: 'integer' },
    totalOutputTokens: { type: 'integer' },
    totalReasoningTokens: { type: 'integer' },
    totalCacheReadTokens: { type: 'integer' },
    totalCacheWriteTokens: { type: 'integer' },
    totalMessageCount: { type: 'integer' },
    byModel: { type: 'object', additionalProperties: USAGE_BUCKET_SCHEMA },
    byRole: { type: 'object', additionalProperties: USAGE_BUCKET_SCHEMA },
  },
  required: [
    'loopName',
    'totalCost',
    'totalInputTokens',
    'totalOutputTokens',
    'totalReasoningTokens',
    'totalCacheReadTokens',
    'totalCacheWriteTokens',
    'totalMessageCount',
    'byModel',
    'byRole',
  ],
  additionalProperties: false,
} as const

const LOOP_TRANSITION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    projectId: { type: 'string' },
    loopName: { type: 'string' },
    eventType: { type: 'string' },
    transitionKind: { type: 'string' },
    fromPhase: { type: 'string' },
    toPhase: { type: 'string' },
    status: { type: 'string' },
    reason: { type: 'string' },
    iteration: { type: 'integer' },
    sectionIndex: { type: 'integer' },
    createdAt: { type: 'number' },
  },
  required: ['id', 'projectId', 'loopName', 'eventType', 'transitionKind', 'fromPhase', 'iteration', 'createdAt'],
  additionalProperties: false,
} as const

const AMENDMENT_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    added: { type: 'integer' },
    removed: { type: 'integer' },
    modified: { type: 'integer' },
  },
  required: ['added', 'removed', 'modified'],
  additionalProperties: false,
} as const

const PLAN_AMENDMENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    projectId: { type: 'string' },
    loopName: { type: 'string' },
    source: { type: 'string' },
    rationale: { type: 'string' },
    appliedAtSection: { type: 'integer' },
    createdAt: { type: 'number' },
    summary: AMENDMENT_SUMMARY_SCHEMA,
  },
  required: ['id', 'projectId', 'loopName', 'source', 'rationale', 'appliedAtSection', 'createdAt', 'summary'],
  additionalProperties: false,
} as const

const AMENDMENT_DIFF_LINE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: DASHBOARD_DIFF_LINE_KINDS },
    text: { type: 'string' },
  },
  required: ['kind', 'text'],
  additionalProperties: false,
} as const

const AMENDMENT_SECTION_DIFF_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer' },
    change: { type: 'string', enum: DASHBOARD_AMENDMENT_CHANGES },
    title: { type: 'string' },
    previousTitle: { type: 'string' },
    lines: { type: 'array', items: AMENDMENT_DIFF_LINE_SCHEMA },
  },
  required: ['index', 'change', 'title', 'lines'],
  additionalProperties: false,
} as const

const LOOP_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    loop: LOOP_DETAIL_ROW_SCHEMA,
    durationText: { type: 'string' },
    lastAuditResult: { type: 'string' },
    postActionReport: { type: 'string' },
    completionSummary: { type: 'string' },
    plan: { type: 'string' },
    sections: { type: 'array', items: SECTION_PLAN_SCHEMA },
    findings: { type: 'array', items: REVIEW_FINDING_SCHEMA },
    usage: LOOP_USAGE_SCHEMA,
    transitions: { type: 'array', items: LOOP_TRANSITION_SCHEMA },
    transitionsCapped: { type: 'boolean' },
    amendments: { type: 'array', items: PLAN_AMENDMENT_SCHEMA },
  },
  required: ['loop', 'sections', 'findings', 'transitions', 'transitionsCapped', 'amendments'],
  additionalProperties: false,
} as const

const AMENDMENT_DIFF_SCHEMA = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: AMENDMENT_SECTION_DIFF_SCHEMA },
    summary: AMENDMENT_SUMMARY_SCHEMA,
  },
  required: ['sections', 'summary'],
  additionalProperties: false,
} as const

const PROJECT_FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    loops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          loopName: { type: 'string' },
          findings: { type: 'array', items: REVIEW_FINDING_SCHEMA },
        },
        required: ['loopName', 'findings'],
        additionalProperties: false,
      },
    },
  },
  required: ['loops'],
  additionalProperties: false,
} as const

export const DASHBOARD_LOOP_DETAIL_METHOD = {
  input: {
    type: 'object',
    properties: {
      projectId: { type: 'string', minLength: 1 },
      loopName: { type: 'string', minLength: 1 },
    },
    required: ['projectId', 'loopName'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: {
      ...LOOP_DETAIL_SCHEMA.properties,
      error: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

export const DASHBOARD_PROJECT_FINDINGS_METHOD = {
  input: {
    type: 'object',
    properties: {
      projectId: { type: 'string', minLength: 1 },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: {
      ...PROJECT_FINDINGS_SCHEMA.properties,
      error: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

export const DASHBOARD_AMENDMENT_DIFF_METHOD = {
  input: {
    type: 'object',
    properties: {
      projectId: { type: 'string', minLength: 1 },
      loopName: { type: 'string', minLength: 1 },
      id: { type: 'integer', minimum: 1 },
    },
    required: ['projectId', 'loopName', 'id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: {
      ...AMENDMENT_DIFF_SCHEMA.properties,
      error: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

export type ForgePlanDeleteOutput = { deleted: true } | ForgeRpcError

export const DASHBOARD_PLAN_DELETE_METHOD = {
  input: {
    type: 'object',
    properties: {
      projectId: { type: 'string', minLength: 1 },
      sessionId: { type: 'string', minLength: 1 },
    },
    required: ['projectId', 'sessionId'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: {
      deleted: { type: 'boolean' },
      error: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

export function readForgeLoopDetail(value: unknown): ForgeLoopDetailOutput {
  return readForgeRpcResult(value, 'loop detail', (record) => {
    const loop = record.loop
    if (!isRecord(loop)
      || typeof loop.projectId !== 'string'
      || typeof loop.loopName !== 'string'
      || typeof loop.status !== 'string') return null
    if (!Array.isArray(record.sections) || !record.sections.every((row) => isRecord(row) && isNumber(row.sectionIndex))) return null
    if (!Array.isArray(record.findings) || !record.findings.every((row) => isRecord(row) && typeof row.file === 'string')) return null
    if (!Array.isArray(record.transitions) || !record.transitions.every((row) => isRecord(row) && isNumber(row.id))) return null
    if (typeof record.transitionsCapped !== 'boolean') return null
    if (!Array.isArray(record.amendments) || !record.amendments.every((row) => isRecord(row) && isNumber(row.id))) return null
    return record as unknown as ForgeLoopDetail
  })
}

export function readForgeProjectFindings(value: unknown): ForgeProjectFindingsOutput {
  return readForgeRpcResult(value, 'project findings', (record) => {
    if (!Array.isArray(record.loops)) return null
    const loops = record.loops
    if (!loops.every((loop) => isRecord(loop) && typeof loop.loopName === 'string' && Array.isArray(loop.findings))) return null
    return { loops } as unknown as ForgeProjectFindings
  })
}

export function readForgePlanDeleteOutput(value: unknown): ForgePlanDeleteOutput {
  return readForgeRpcResult(value, 'plan delete result', (record) =>
    record.deleted === true ? { deleted: true } : null)
}

export function readForgeAmendmentDiff(value: unknown): ForgeAmendmentDiffOutput {
  return readForgeRpcResult(value, 'amendment diff', (record) => {
    if (!Array.isArray(record.sections)) return null
    const summary = record.summary
    if (!isRecord(summary) || !isNumber(summary.added) || !isNumber(summary.removed) || !isNumber(summary.modified)) return null
    const sections = record.sections
    if (!sections.every((section) => isRecord(section)
      && isNumber(section.index)
      && typeof section.change === 'string'
      && typeof section.title === 'string'
      && Array.isArray(section.lines))) return null
    return record as unknown as ForgeAmendmentDiff
  })
}
