import type { Rpc } from '@opencode/plugin/rpc'
import { z } from 'zod'
import { FORGE_PLUGIN_ID } from '../constants/plugin'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import {
  appliedStateSchema,
  controllerStateSchema,
  desiredStateSchema,
  type SessionSandboxAppliedState,
  type SessionSandboxControllerState,
  type SessionSandboxDesiredState,
} from '../storage/session-sandbox-state'
import type { LoopSandboxSettings, SandboxOverrides, SandboxResources } from '../types'
import type { JsonValue } from '../utils/json-schema'
import { TOAST_VARIANTS, type ToastVariant } from '../utils/toast'
import type { LoopInfo } from '../utils/tui-models'
import { DASHBOARD_AMENDMENT_DIFF_METHOD, DASHBOARD_LOOP_DETAIL_METHOD, DASHBOARD_PLAN_DELETE_METHOD, DASHBOARD_PROJECT_FINDINGS_METHOD, DASHBOARD_SUMMARY_METHOD } from './forge-rpc-dashboard'
import { readForgeRpcResult } from './forge-rpc-result'
import type { ForgeRpcError } from './forge-rpc-result'

export type {
  ForgeAmendmentDiff,
  ForgeAmendmentDiffOutput,
  ForgeDashboardLoopSummary,
  ForgeDashboardProjectSummary,
  ForgeDashboardSummary,
  ForgeDashboardSummaryOutput,
  ForgeDashboardUnexecutedPlan,
  ForgeLoopDetail,
  ForgeLoopDetailOutput,
  ForgeLoopDetailRow,
  ForgeLoopTransition,
  ForgeLoopUsage,
  ForgePlanAmendment,
  ForgePlanDeleteOutput,
  ForgeProjectFindings,
  ForgeProjectFindingsLoop,
  ForgeProjectFindingsOutput,
  ForgeReviewFinding,
  ForgeSectionPlan,
} from './forge-rpc-dashboard'
export type { ForgeRpcError } from './forge-rpc-result'
export {
  readForgeAmendmentDiff,
  readForgeDashboardSummary,
  readForgeLoopDetail,
  readForgePlanDeleteOutput,
  readForgeProjectFindings,
} from './forge-rpc-dashboard'

export type ForgeToastInput = {
  title?: string
  message: string
  variant?: ToastVariant
  duration?: number
}

export type ForgeToastEvent = ForgeToastInput & { projectId: string }

export type ForgeProjectChangedEvent = { projectId: string }

export type ForgeAutoApproveChangedEvent = { projectId: string; sessionId: string }

export type ForgeTuiEvent =
  | { type: 'loopsChanged'; projectId: string }
  | { type: 'plansChanged'; projectId: string }
  | { type: 'autoApproveChanged'; projectId: string; sessionId: string }
  | { type: 'hostSandboxChanged'; projectId: string }

export const FORGE_EXECUTION_MODES = ['new-session', 'execute-here', 'loop'] as const

export type ForgeExecutionMode = (typeof FORGE_EXECUTION_MODES)[number]

export interface ForgeExecutePlanInput {
  sessionId: string
  mode: ForgeExecutionMode
  title: string
  plan: string
  loopName?: string
  branch?: string
  baseRef?: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  maxIterations?: number
  sandbox?: LoopSandboxSettings
}

export interface ForgeExecutePlanSuccess {
  sessionId: string
  loopName?: string
  branch?: string
  worktreeDir?: string
  workspaceId?: string
}

export type ForgeExecutePlanOutput = ForgeExecutePlanSuccess | { error: string }

export interface ForgeLoopDefaults {
  maxIterations: number
  sandbox: {
    available: boolean
    resources: Required<SandboxResources>
    allowLan: boolean
  }
}

export type ForgeLoopDefaultsOutput = ForgeLoopDefaults | ForgeRpcError

export type ForgeAutoApproveState =
  | { enabled: boolean; ownerSessionId?: string; inherited: boolean }
  | { error: string }

export type ForgeLoopsOutput = { loops: LoopInfo[] } | ForgeRpcError

export type ForgeLoopSidebarOutput = { loops: LoopSidebarRow[] } | ForgeRpcError

export type ForgeWorktreesOutput = { root: string; dirs: string[] } | ForgeRpcError

export type ForgeSessionPlanOutput = { plan: string | null } | ForgeRpcError

export interface ForgeLoopRestartInput {
  loopName: string
  auditorModel: string
  auditorVariant: string
  executionModel?: string
  executionVariant?: string
  force?: boolean
  expectedStartedAt?: string
}

export type ForgeLoopRestartOutput = { sessionId: string } | ForgeRpcError

export interface ForgeHostSandboxState {
  configEnabled: boolean
  hostSessionsDefault: boolean
  desired: SessionSandboxDesiredState | null
  applied: SessionSandboxAppliedState | null
  controller: SessionSandboxControllerState | null
  activeLoopSandboxes?: Record<string, boolean>
}

export const FORGE_HOST_SANDBOX_DISABLED_ERROR = 'Host sandbox is disabled by config (sandbox.enabled: false)'

export type ForgeHostSandboxStateOutput = ForgeHostSandboxState | ForgeRpcError

export interface ForgeHostSandboxSetInput {
  sessionId: string
  enabled?: boolean
  overrides?: SandboxOverrides
}

export type ForgeHostSandboxSetOutput = { revision: string } | ForgeRpcError

const OPTIONAL_STRING = { type: 'string' } as const

const SANDBOX_RESOURCES_SCHEMA = {
  type: 'object',
  properties: {
    memory: OPTIONAL_STRING,
    cpus: OPTIONAL_STRING,
    dockerDisk: OPTIONAL_STRING,
    cacheDisk: OPTIONAL_STRING,
  },
  additionalProperties: false,
} as const

const SANDBOX_OVERRIDES_SCHEMA = {
  type: 'object',
  properties: {
    resources: SANDBOX_RESOURCES_SCHEMA,
    allowLan: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

const SANDBOX_SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    ...SANDBOX_OVERRIDES_SCHEMA.properties,
  },
  additionalProperties: false,
} as const

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const

const OBJECT = { type: 'object' } as const

const PROJECT_CHANGED_EVENT_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
  },
  required: ['projectId'],
  additionalProperties: false,
} as const

const LOOP_INFO_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    status: { type: 'string' },
    phase: { type: 'string' },
    iteration: { type: 'integer' },
    maxIterations: { type: 'integer' },
    sessionId: { type: 'string' },
    restartable: { type: 'boolean' },
    restartRequiresForce: { type: 'boolean' },
    restartBlockedMessage: OPTIONAL_STRING,
    startedAt: OPTIONAL_STRING,
    executionModel: OPTIONAL_STRING,
    executionVariant: OPTIONAL_STRING,
    auditorModel: OPTIONAL_STRING,
    auditorVariant: OPTIONAL_STRING,
    branch: OPTIONAL_STRING,
  },
  required: ['name', 'status', 'phase', 'iteration', 'maxIterations', 'sessionId', 'restartable', 'restartRequiresForce', 'startedAt'],
  additionalProperties: false,
} as const

const LOOPS_OUTPUT = {
  type: 'object',
  properties: {
    loops: { type: 'array', items: LOOP_INFO_SCHEMA },
    error: OPTIONAL_STRING,
  },
  additionalProperties: false,
} as const

const LOOP_SIDEBAR_OUTPUT = {
  type: 'object',
  properties: {
    loops: { type: 'array', items: OBJECT },
    error: OPTIONAL_STRING,
  },
  additionalProperties: false,
} as const

const AUTO_APPROVE_OUTPUT = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    ownerSessionId: OPTIONAL_STRING,
    inherited: { type: 'boolean' },
    error: OPTIONAL_STRING,
  },
  additionalProperties: false,
} as const

const WORKTREES_OUTPUT = {
  type: 'object',
  properties: {
    root: OPTIONAL_STRING,
    dirs: { type: 'array', items: { type: 'string' } },
    error: OPTIONAL_STRING,
  },
  additionalProperties: false,
} as const

const LOOP_DEFAULTS_OUTPUT = {
  type: 'object',
  properties: {
    maxIterations: { type: 'integer' },
    sandbox: {
      type: 'object',
      properties: {
        available: { type: 'boolean' },
        resources: SANDBOX_RESOURCES_SCHEMA,
        allowLan: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    error: OPTIONAL_STRING,
  },
  additionalProperties: false,
} as const

export const FORGE_RPC = {
  id: FORGE_PLUGIN_ID,
  methods: {
    executePlan: {
      input: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          mode: { type: 'string', enum: FORGE_EXECUTION_MODES },
          title: { type: 'string' },
          plan: { type: 'string', minLength: 1 },
          loopName: OPTIONAL_STRING,
          branch: { type: 'string', minLength: 1 },
          baseRef: { type: 'string', minLength: 1 },
          executionModel: OPTIONAL_STRING,
          auditorModel: OPTIONAL_STRING,
          executionVariant: OPTIONAL_STRING,
          auditorVariant: OPTIONAL_STRING,
          maxIterations: { type: 'integer', minimum: 0 },
          sandbox: SANDBOX_SETTINGS_SCHEMA,
        },
        required: ['sessionId', 'mode', 'title', 'plan'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sessionId: OPTIONAL_STRING,
          loopName: OPTIONAL_STRING,
          branch: OPTIONAL_STRING,
          worktreeDir: OPTIONAL_STRING,
          workspaceId: OPTIONAL_STRING,
          error: OPTIONAL_STRING,
        },
        additionalProperties: false,
      },
    },
    loopDefaults: {
      input: EMPTY_INPUT,
      output: LOOP_DEFAULTS_OUTPUT,
    },
    autoApproveState: {
      input: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: AUTO_APPROVE_OUTPUT,
    },
    autoApproveSet: {
      input: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['sessionId', 'enabled'],
        additionalProperties: false,
      },
      output: AUTO_APPROVE_OUTPUT,
    },
    loops: {
      input: EMPTY_INPUT,
      output: LOOPS_OUTPUT,
    },
    loopSidebar: {
      input: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['limit'],
        additionalProperties: false,
      },
      output: LOOP_SIDEBAR_OUTPUT,
    },
    sessionPlan: {
      input: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          projectId: { type: 'string', minLength: 1 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          plan: OPTIONAL_STRING,
          error: OPTIONAL_STRING,
        },
        additionalProperties: false,
      },
    },
    loopRestart: {
      input: {
        type: 'object',
        properties: {
          loopName: { type: 'string', minLength: 1 },
          auditorModel: { type: 'string', minLength: 1 },
          auditorVariant: { type: 'string' },
          executionModel: OPTIONAL_STRING,
          executionVariant: OPTIONAL_STRING,
          force: { type: 'boolean' },
          expectedStartedAt: OPTIONAL_STRING,
        },
        required: ['loopName', 'auditorModel', 'auditorVariant'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sessionId: OPTIONAL_STRING,
          error: OPTIONAL_STRING,
        },
        additionalProperties: false,
      },
    },
    hostSandboxState: {
      input: EMPTY_INPUT,
      output: {
        type: 'object',
        properties: {
          configEnabled: { type: 'boolean' },
          hostSessionsDefault: { type: 'boolean' },
          desired: OBJECT,
          applied: OBJECT,
          controller: OBJECT,
          activeLoopSandboxes: { type: 'object', additionalProperties: { type: 'boolean' } },
          error: OPTIONAL_STRING,
        },
        additionalProperties: false,
      },
    },
    hostSandboxSet: {
      input: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          enabled: { type: 'boolean' },
          overrides: SANDBOX_OVERRIDES_SCHEMA,
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          revision: OPTIONAL_STRING,
          error: OPTIONAL_STRING,
        },
        additionalProperties: false,
      },
    },
    worktrees: {
      input: EMPTY_INPUT,
      output: WORKTREES_OUTPUT,
    },
    version: {
      input: EMPTY_INPUT,
      output: {
        type: 'object',
        properties: {
          version: OPTIONAL_STRING,
          error: OPTIONAL_STRING,
        },
        additionalProperties: false,
      },
    },
    dashboardSummary: DASHBOARD_SUMMARY_METHOD,
    loopDetail: DASHBOARD_LOOP_DETAIL_METHOD,
    projectFindings: DASHBOARD_PROJECT_FINDINGS_METHOD,
    amendmentDiff: DASHBOARD_AMENDMENT_DIFF_METHOD,
    planDelete: DASHBOARD_PLAN_DELETE_METHOD,
  },
  events: {
    toast: {
      schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          title: { type: 'string' },
          message: { type: 'string' },
          variant: { type: 'string', enum: TOAST_VARIANTS },
          duration: { type: 'number' },
        },
        required: ['projectId', 'message'],
        additionalProperties: false,
      },
    },
    sessionDelete: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
        },
        required: ['sessionID'],
        additionalProperties: false,
      },
    },
    loopsChanged: {
      schema: PROJECT_CHANGED_EVENT_SCHEMA,
    },
    plansChanged: {
      schema: PROJECT_CHANGED_EVENT_SCHEMA,
    },
    autoApproveChanged: {
      schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          sessionId: { type: 'string' },
        },
        required: ['projectId', 'sessionId'],
        additionalProperties: false,
      },
    },
    hostSandboxChanged: {
      schema: PROJECT_CHANGED_EVENT_SCHEMA,
    },
  },
} as const satisfies Rpc.PortableDefinition

const optionalStringFieldSchema = z.string().optional().catch(undefined)

const executePlanOutputSchema = z.looseObject({
  sessionId: z.string().optional().catch(undefined),
  loopName: optionalStringFieldSchema,
  branch: optionalStringFieldSchema,
  worktreeDir: optionalStringFieldSchema,
  workspaceId: optionalStringFieldSchema,
})

export function readForgeExecutePlanOutput<P>(payload: P): ForgeExecutePlanOutput {
  return readForgeRpcResult(payload, 'plan execution result', (value) => {
    const parsed = executePlanOutputSchema.safeParse(value)
    if (!parsed.success) return null
    const data = parsed.data
    if (data.sessionId === undefined) return { error: 'Forge returned no session for the plan execution' }
    const launched: ForgeExecutePlanSuccess = { sessionId: data.sessionId }
    if (data.loopName !== undefined) launched.loopName = data.loopName
    if (data.branch !== undefined) launched.branch = data.branch
    if (data.worktreeDir !== undefined) launched.worktreeDir = data.worktreeDir
    if (data.workspaceId !== undefined) launched.workspaceId = data.workspaceId
    return launched
  })
}

const LOOP_STATUS_SCHEMA = z.enum(['running', 'completed', 'cancelled', 'errored', 'stalled'])
const LOOP_PHASE_SCHEMA = z.enum(['coding', 'auditing', 'post_action'])

const loopInfoSchema = z.looseObject({
  name: z.string(),
  status: LOOP_STATUS_SCHEMA,
  phase: z.string(),
  iteration: z.number(),
  maxIterations: z.number(),
  sessionId: z.string(),
  restartable: z.boolean(),
  restartRequiresForce: z.boolean(),
  restartBlockedMessage: optionalStringFieldSchema,
  startedAt: z.string().optional().catch(undefined),
  executionModel: optionalStringFieldSchema,
  executionVariant: optionalStringFieldSchema,
  auditorModel: optionalStringFieldSchema,
  auditorVariant: optionalStringFieldSchema,
  branch: optionalStringFieldSchema,
})

const loopSidebarRowSchema = z.looseObject({
  loopName: z.string(),
  status: LOOP_STATUS_SCHEMA,
  iteration: z.number(),
  maxIterations: z.number(),
  startedAt: z.number(),
  phase: LOOP_PHASE_SCHEMA,
  phaseStartedAt: z.number(),
  currentSectionIndex: z.number(),
  totalSections: z.number(),
})

function readLoopRows<P, T>(
  payload: P,
  label: string,
  rowSchema: z.ZodType<T>,
): { loops: T[] } | ForgeRpcError {
  const listSchema = z.object({ loops: z.array(rowSchema) })
  return readForgeRpcResult(payload, label, (value) => {
    const parsed = listSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}

export function readForgeLoops<P>(payload: P): ForgeLoopsOutput {
  return readLoopRows(payload, 'loop list', loopInfoSchema)
}

export function readForgeLoopSidebar<P>(payload: P): ForgeLoopSidebarOutput {
  return readLoopRows(payload, 'loop sidebar', loopSidebarRowSchema)
}

const sandboxResourcesSchema = z.object({
  memory: z.string(),
  cpus: z.string(),
  dockerDisk: z.string(),
  cacheDisk: z.string(),
})

const loopDefaultsSchema = z.object({
  maxIterations: z.number().int(),
  sandbox: z.object({
    available: z.boolean(),
    resources: sandboxResourcesSchema,
    allowLan: z.boolean().optional().catch(undefined),
  }),
})

export function readForgeLoopDefaults<P>(payload: P): ForgeLoopDefaultsOutput {
  return readForgeRpcResult(payload, 'loop defaults', (value) => {
    const parsed = loopDefaultsSchema.safeParse(value)
    if (!parsed.success) return null
    const data = parsed.data
    const defaults: ForgeLoopDefaults = {
      maxIterations: data.maxIterations,
      sandbox: {
        available: data.sandbox.available,
        resources: {
          memory: data.sandbox.resources.memory,
          cpus: data.sandbox.resources.cpus,
          dockerDisk: data.sandbox.resources.dockerDisk,
          cacheDisk: data.sandbox.resources.cacheDisk,
        },
        allowLan: data.sandbox.allowLan === true,
      },
    }
    return defaults
  })
}

const topLevelObjectSchema = z.record(z.string(), z.unknown())

export function toForgeRpcJson<T>(value: T): JsonValue {
  const object = topLevelObjectSchema.safeParse(value)
  const source = object.success
    ? Object.fromEntries(Object.entries(object.data).filter(([, entry]) => entry !== null))
    : value
  return JSON.parse(JSON.stringify(source))
}

const sessionPlanOutputSchema = z.object({
  plan: z.string().optional().catch(undefined),
})

export function readForgeSessionPlan<P>(payload: P): ForgeSessionPlanOutput {
  return readForgeRpcResult(payload, 'session plan', (value) => {
    const parsed = sessionPlanOutputSchema.safeParse(value)
    return parsed.success ? { plan: parsed.data.plan ?? null } : null
  })
}

const loopRestartOutputSchema = z.object({
  sessionId: z.string().optional().catch(undefined),
})

export function readForgeLoopRestartOutput<P>(payload: P): ForgeLoopRestartOutput {
  return readForgeRpcResult(payload, 'loop restart result', (value) => {
    const parsed = loopRestartOutputSchema.safeParse(value)
    if (!parsed.success) return null
    return parsed.data.sessionId === undefined
      ? { error: 'Loop restart completed without a session' }
      : { sessionId: parsed.data.sessionId }
  })
}

const hostSandboxStateSchema = z.object({
  configEnabled: z.boolean(),
  hostSessionsDefault: z.boolean().optional().catch(undefined),
  desired: desiredStateSchema.nullable().catch(null),
  applied: appliedStateSchema.nullable().catch(null),
  controller: controllerStateSchema.nullable().catch(null),
  activeLoopSandboxes: z.record(z.string(), z.boolean()).optional().catch(undefined),
})

export function readForgeHostSandboxState<P>(payload: P): ForgeHostSandboxStateOutput {
  return readForgeRpcResult(payload, 'host sandbox state', (value) => {
    const parsed = hostSandboxStateSchema.safeParse(value)
    if (!parsed.success) return null
    const data = parsed.data
    const state: ForgeHostSandboxState = {
      configEnabled: data.configEnabled,
      hostSessionsDefault: data.hostSessionsDefault ?? true,
      desired: data.desired,
      applied: data.applied,
      controller: data.controller,
    }
    if (data.activeLoopSandboxes !== undefined) state.activeLoopSandboxes = data.activeLoopSandboxes
    return state
  })
}

const hostSandboxSetOutputSchema = z.object({ revision: z.string() })

export function readForgeHostSandboxSetOutput<P>(payload: P): ForgeHostSandboxSetOutput {
  return readForgeRpcResult(payload, 'host sandbox result', (value) => {
    const parsed = hostSandboxSetOutputSchema.safeParse(value)
    return parsed.success ? { revision: parsed.data.revision } : null
  })
}

const autoApproveStateSchema = z.object({
  enabled: z.boolean(),
  inherited: z.boolean().optional(),
  ownerSessionId: optionalStringFieldSchema,
})

type ForgeAutoApproveActiveState = { enabled: boolean; ownerSessionId?: string; inherited: boolean }

export function readForgeAutoApproveState<P>(payload: P): ForgeAutoApproveState {
  return readForgeRpcResult(payload, 'auto-approve state', (value) => {
    const parsed = autoApproveStateSchema.safeParse(value)
    if (!parsed.success) return null
    const data = parsed.data
    const state: ForgeAutoApproveActiveState = { enabled: data.enabled, inherited: data.inherited === true }
    if (data.ownerSessionId !== undefined) state.ownerSessionId = data.ownerSessionId
    return state
  })
}

const worktreesOutputSchema = z.object({
  root: z.string(),
  dirs: z.array(z.string()),
})

export function readForgeWorktrees<P>(payload: P): ForgeWorktreesOutput {
  return readForgeRpcResult(payload, 'worktree list', (value) => {
    const parsed = worktreesOutputSchema.safeParse(value)
    return parsed.success ? { root: parsed.data.root, dirs: parsed.data.dirs } : null
  })
}

const versionOutputSchema = z.object({ version: z.string() })

export function readForgeVersion<P>(payload: P): { version: string } | ForgeRpcError {
  return readForgeRpcResult(payload, 'version', (value) => {
    const parsed = versionOutputSchema.safeParse(value)
    return parsed.success ? { version: parsed.data.version } : null
  })
}

const projectChangedEventSchema = z.object({ projectId: z.string() })

export function readForgeProjectChangedEvent<P>(data: P): ForgeProjectChangedEvent | null {
  const parsed = projectChangedEventSchema.safeParse(data)
  return parsed.success ? { projectId: parsed.data.projectId } : null
}

const autoApproveChangedEventSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
})

export function readForgeAutoApproveChangedEvent<P>(data: P): ForgeAutoApproveChangedEvent | null {
  const parsed = autoApproveChangedEventSchema.safeParse(data)
  return parsed.success ? { projectId: parsed.data.projectId, sessionId: parsed.data.sessionId } : null
}
