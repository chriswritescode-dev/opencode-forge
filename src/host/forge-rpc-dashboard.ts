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
import { z } from 'zod'
import type { JsonSchemaDefinition } from '../utils/json-schema'
import { readForgeRpcResult, type ForgeRpcError } from './forge-rpc-result'

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
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

const DASHBOARD_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    generatedAt: { type: 'number' },
    projects: { type: 'array', items: DASHBOARD_PROJECT_SUMMARY_SCHEMA },
  },
  required: ['generatedAt', 'projects'],
  additionalProperties: false,
} as const satisfies JsonSchemaDefinition

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

const DASHBOARD_UNEXECUTED_PLAN_READ_SCHEMA = z.looseObject({
  sessionId: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  charCount: z.number().int(),
})

const DASHBOARD_LOOP_SUMMARY_READ_SCHEMA = z.looseObject({
  loopName: z.string(),
  status: z.enum(DASHBOARD_LOOP_STATUSES),
  phase: z.enum(DASHBOARD_LOOP_PHASES),
  iteration: z.number().int(),
  maxIterations: z.number().int(),
  currentSectionIndex: z.number().int(),
  totalSections: z.number().int(),
  sectionCount: z.number().int(),
  bugCount: z.number().int(),
  hasPlan: z.boolean(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  activityAt: z.number(),
  durationText: z.string().optional(),
  totalCost: z.number().optional(),
  branch: z.string().optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
})

const DASHBOARD_PROJECT_SUMMARY_READ_SCHEMA = z.looseObject({
  projectId: z.string(),
  projectDir: z.string().optional(),
  loopCount: z.number().int(),
  unexecutedPlanCount: z.number().int(),
  bugCount: z.number().int(),
  loops: z.array(DASHBOARD_LOOP_SUMMARY_READ_SCHEMA),
  unexecutedPlans: z.array(DASHBOARD_UNEXECUTED_PLAN_READ_SCHEMA),
})

const DASHBOARD_SUMMARY_READ_SCHEMA = z.looseObject({
  generatedAt: z.number(),
  projects: z.array(DASHBOARD_PROJECT_SUMMARY_READ_SCHEMA),
})

export function readForgeDashboardSummary<P>(payload: P): ForgeDashboardSummaryOutput {
  return readForgeRpcResult(payload, 'dashboard summary', (value) => {
    const parsed = DASHBOARD_SUMMARY_READ_SCHEMA.safeParse(value)
    return parsed.success ? parsed.data : null
  })
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
  sectionId: string
  dependsOn: string[]
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
} as const satisfies JsonSchemaDefinition

const SECTION_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    loopName: { type: 'string' },
    sectionIndex: { type: 'integer' },
    sectionId: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
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
  required: ['projectId', 'loopName', 'sectionIndex', 'sectionId', 'dependsOn', 'title', 'content', 'status', 'attempts'],
  additionalProperties: false,
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

const AMENDMENT_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    added: { type: 'integer' },
    removed: { type: 'integer' },
    modified: { type: 'integer' },
  },
  required: ['added', 'removed', 'modified'],
  additionalProperties: false,
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

const AMENDMENT_DIFF_LINE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: DASHBOARD_DIFF_LINE_KINDS },
    text: { type: 'string' },
  },
  required: ['kind', 'text'],
  additionalProperties: false,
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

const AMENDMENT_DIFF_SCHEMA = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: AMENDMENT_SECTION_DIFF_SCHEMA },
    summary: AMENDMENT_SUMMARY_SCHEMA,
  },
  required: ['sections', 'summary'],
  additionalProperties: false,
} as const satisfies JsonSchemaDefinition

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
} as const satisfies JsonSchemaDefinition

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

const LOOP_DETAIL_ROW_READ_SCHEMA = z.looseObject({
  projectId: z.string(),
  loopName: z.string(),
  status: z.enum(DASHBOARD_LOOP_STATUSES),
  currentSessionId: z.string(),
  worktree: z.boolean(),
  worktreeDir: z.string(),
  worktreeBranch: z.string().optional(),
  projectDir: z.string(),
  maxIterations: z.number().int(),
  iteration: z.number().int(),
  auditCount: z.number().int(),
  errorCount: z.number().int(),
  phase: z.enum(DASHBOARD_LOOP_PHASES),
  executionModel: z.string().optional(),
  executionVariant: z.string().optional(),
  auditorModel: z.string().optional(),
  auditorVariant: z.string().optional(),
  auditorFallbackIndex: z.number().int(),
  modelFailed: z.boolean(),
  sandbox: z.boolean(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  terminationReason: z.string().optional(),
  currentSectionIndex: z.number().int(),
  totalSections: z.number().int(),
  baseCommit: z.string().optional(),
})

const SECTION_PLAN_READ_SCHEMA = z.looseObject({
  projectId: z.string(),
  loopName: z.string(),
  sectionIndex: z.number().int(),
  sectionId: z.string(),
  dependsOn: z.array(z.string()),
  title: z.string(),
  content: z.string(),
  status: z.enum(DASHBOARD_SECTION_STATUSES),
  attempts: z.number().int(),
  summaryDone: z.string().optional(),
  summaryDeviations: z.string().optional(),
  summaryFollowUps: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
})

const REVIEW_FINDING_READ_SCHEMA = z.looseObject({
  projectId: z.string(),
  file: z.string(),
  line: z.number().int(),
  severity: z.enum(DASHBOARD_FINDING_SEVERITIES),
  description: z.string(),
  scenario: z.string().optional(),
  loopName: z.string().optional(),
  sectionIndex: z.number().int().optional(),
  createdAt: z.number(),
})

const USAGE_BUCKET_READ_SCHEMA = z.looseObject({
  cost: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  messageCount: z.number().int(),
})

const LOOP_USAGE_READ_SCHEMA = z.looseObject({
  loopName: z.string(),
  totalCost: z.number(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalReasoningTokens: z.number().int(),
  totalCacheReadTokens: z.number().int(),
  totalCacheWriteTokens: z.number().int(),
  totalMessageCount: z.number().int(),
  byModel: z.record(z.string(), USAGE_BUCKET_READ_SCHEMA),
  byRole: z.record(z.string(), USAGE_BUCKET_READ_SCHEMA),
})

const LOOP_TRANSITION_READ_SCHEMA = z.looseObject({
  id: z.number().int(),
  projectId: z.string(),
  loopName: z.string(),
  eventType: z.string(),
  transitionKind: z.string(),
  fromPhase: z.string(),
  toPhase: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  iteration: z.number().int(),
  sectionIndex: z.number().int().optional(),
  createdAt: z.number(),
})

const AMENDMENT_SUMMARY_READ_SCHEMA = z.looseObject({
  added: z.number().int(),
  removed: z.number().int(),
  modified: z.number().int(),
})

const PLAN_AMENDMENT_READ_SCHEMA = z.looseObject({
  id: z.number().int(),
  projectId: z.string(),
  loopName: z.string(),
  source: z.string(),
  rationale: z.string(),
  appliedAtSection: z.number().int(),
  createdAt: z.number(),
  summary: AMENDMENT_SUMMARY_READ_SCHEMA,
})

const LOOP_DETAIL_READ_SCHEMA = z.looseObject({
  loop: LOOP_DETAIL_ROW_READ_SCHEMA,
  durationText: z.string().optional(),
  lastAuditResult: z.string().optional(),
  postActionReport: z.string().optional(),
  completionSummary: z.string().optional(),
  plan: z.string().optional(),
  sections: z.array(SECTION_PLAN_READ_SCHEMA),
  findings: z.array(REVIEW_FINDING_READ_SCHEMA),
  usage: LOOP_USAGE_READ_SCHEMA.optional(),
  transitions: z.array(LOOP_TRANSITION_READ_SCHEMA),
  transitionsCapped: z.boolean(),
  amendments: z.array(PLAN_AMENDMENT_READ_SCHEMA),
})

const AMENDMENT_DIFF_LINE_READ_SCHEMA = z.looseObject({
  kind: z.enum(DASHBOARD_DIFF_LINE_KINDS),
  text: z.string(),
})

const AMENDMENT_SECTION_DIFF_READ_SCHEMA = z.looseObject({
  index: z.number().int(),
  change: z.enum(DASHBOARD_AMENDMENT_CHANGES),
  title: z.string(),
  previousTitle: z.string().optional(),
  lines: z.array(AMENDMENT_DIFF_LINE_READ_SCHEMA),
})

const AMENDMENT_DIFF_READ_SCHEMA = z.looseObject({
  sections: z.array(AMENDMENT_SECTION_DIFF_READ_SCHEMA),
  summary: AMENDMENT_SUMMARY_READ_SCHEMA,
})

const PROJECT_FINDINGS_READ_SCHEMA = z.looseObject({
  loops: z.array(z.looseObject({
    loopName: z.string(),
    findings: z.array(REVIEW_FINDING_READ_SCHEMA),
  })),
})

const PLAN_DELETE_READ_SCHEMA = z.object({ deleted: z.boolean() })

export function readForgeLoopDetail<P>(payload: P): ForgeLoopDetailOutput {
  return readForgeRpcResult(payload, 'loop detail', (value) => {
    const parsed = LOOP_DETAIL_READ_SCHEMA.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}

export function readForgeProjectFindings<P>(payload: P): ForgeProjectFindingsOutput {
  return readForgeRpcResult(payload, 'project findings', (value) => {
    const parsed = PROJECT_FINDINGS_READ_SCHEMA.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}

export function readForgePlanDeleteOutput<P>(payload: P): ForgePlanDeleteOutput {
  return readForgeRpcResult(payload, 'plan delete result', (value) => {
    const parsed = PLAN_DELETE_READ_SCHEMA.safeParse(value)
    return parsed.success && parsed.data.deleted === true ? { deleted: true } : null
  })
}

export function readForgeAmendmentDiff<P>(payload: P): ForgeAmendmentDiffOutput {
  return readForgeRpcResult(payload, 'amendment diff', (value) => {
    const parsed = AMENDMENT_DIFF_READ_SCHEMA.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}
