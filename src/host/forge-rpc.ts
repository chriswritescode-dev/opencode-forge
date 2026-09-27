import type { Rpc } from '@opencode/plugin/rpc'
import { FORGE_PLUGIN_ID } from '../constants/plugin'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import type {
  SessionSandboxAppliedState,
  SessionSandboxControllerState,
  SessionSandboxDesiredState,
} from '../storage/repos/session-sandbox-preferences-repo'
import type { LoopSandboxSettings, SandboxResources } from '../types'
import { isRecord } from '../utils/is-record'
import { TOAST_VARIANTS, type ToastVariant } from '../utils/toast'
import type { LoopInfo } from '../utils/tui-models'

export type ForgeToastInput = {
  title?: string
  message: string
  variant?: ToastVariant
  duration?: number
}

export type ForgeToastEvent = ForgeToastInput & { projectId: string }

/** Server push: the project's loop rows changed and the TUI must re-read them. */
export type ForgeLoopsChangedEvent = { projectId: string }

/** Server push: one session's per-session auto-approve flag changed. */
export type ForgeAutoApproveChangedEvent = { projectId: string; sessionId: string }

/** Server push: the project's host-sandbox desired/applied/controller state changed. */
export type ForgeHostSandboxChangedEvent = { projectId: string }

/** Host-neutral push event the server publishes to the TUI through the RPC registration. */
export type ForgeTuiEvent =
  | { type: 'loopsChanged'; projectId: string }
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
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  /** Maximum loop iterations for a loop launch; omitted falls back to the server's `loop.defaultMaxIterations`. */
  maxIterations?: number
  /** Per-loop sandbox overrides; omitted fields fall back to the `sandbox` config. */
  sandbox?: LoopSandboxSettings
}

export type ForgeExecutePlanOutput =
  | { sessionId: string; loopName?: string; worktreeDir?: string; workspaceId?: string }
  | { error: string }

/**
 * Server-side defaults the execution dialog shows for loop settings. `available` is false when the
 * server has no usable sandbox, so the per-loop sandbox rows are hidden.
 */
export interface ForgeLoopDefaults {
  maxIterations: number
  sandbox: {
    available: boolean
    resources: Required<SandboxResources>
  }
}

export type ForgeLoopDefaultsOutput = ForgeLoopDefaults | ForgeRpcError

export type ForgeAutoApproveState =
  | { enabled: boolean; ownerSessionId?: string; inherited: boolean }
  | { error: string }

export type ForgeRpcError = { error: string }

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
  /** Force-restart an active loop. Omitted by old TUIs, which the server treats as `true`. */
  force?: boolean
  /** Optimistic precondition: the loop's `startedAt` as seen when the dialog was opened. */
  expectedStartedAt?: string
}

export type ForgeLoopRestartOutput = { sessionId: string } | ForgeRpcError

/**
 * Host sandbox preference as seen by the server. `configEnabled` is the server's
 * `sandbox.enabled`; when false the server never reconciles a request, so the TUI
 * hides the indicator and refuses the toggle.
 */
export interface ForgeHostSandboxState {
  configEnabled: boolean
  desired: SessionSandboxDesiredState | null
  applied: SessionSandboxAppliedState | null
  controller: SessionSandboxControllerState | null
  activeLoopSandboxes?: Record<string, boolean>
}

export const FORGE_HOST_SANDBOX_DISABLED_ERROR = 'Host sandbox is disabled by config (sandbox.enabled: false)'

export type ForgeHostSandboxStateOutput = ForgeHostSandboxState | ForgeRpcError

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

const SANDBOX_SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    resources: SANDBOX_RESOURCES_SCHEMA,
  },
  additionalProperties: false,
} as const

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const

const OBJECT = { type: 'object' } as const

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
        },
        required: ['sessionId', 'enabled'],
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
      schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
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
      schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition

/** Envelope every TUI-side reader returns: a validated result or a server-reported error. */
type ForgeRpcResult<T> = T | ForgeRpcError

/**
 * Shared envelope handling for the TUI-side Forge RPC readers. A non-record payload
 * and a `null` from `parse` both become the same invalid-result error, while a
 * server-reported `{ error }` passes through unchanged.
 */
function readForgeRpcResult<T>(
  value: unknown,
  label: string,
  parse: (record: Record<string, unknown>) => T | ForgeRpcError | null,
): ForgeRpcResult<T> {
  if (!isRecord(value)) return { error: `Forge returned an invalid ${label}` }
  if (typeof value.error === 'string') return { error: value.error }
  return parse(value) ?? { error: `Forge returned an invalid ${label}` }
}

export function readForgeExecutePlanOutput(value: unknown): ForgeExecutePlanOutput {
  return readForgeRpcResult(value, 'plan execution result', (record) => {
    if (typeof record.sessionId !== 'string') return { error: 'Forge returned no session for the plan execution' }
    const optional = (key: 'loopName' | 'worktreeDir' | 'workspaceId') =>
      typeof record[key] === 'string' ? { [key]: record[key] as string } : {}
    return { sessionId: record.sessionId, ...optional('loopName'), ...optional('worktreeDir'), ...optional('workspaceId') }
  })
}

function readLoopRows<T>(value: unknown, label: string, isRow: (row: Record<string, unknown>) => boolean): { loops: T[] } | ForgeRpcError {
  return readForgeRpcResult(value, label, (record) =>
    !Array.isArray(record.loops) || !record.loops.every((row) => isRecord(row) && isRow(row))
      ? null
      : { loops: record.loops as T[] })
}

export function readForgeLoops(value: unknown): ForgeLoopsOutput {
  return readLoopRows<LoopInfo>(value, 'loop list', (row) =>
    typeof row.name === 'string'
    && typeof row.status === 'string'
    && typeof row.phase === 'string'
    && typeof row.iteration === 'number'
    && typeof row.maxIterations === 'number'
    && typeof row.sessionId === 'string'
    && typeof row.restartable === 'boolean'
    && typeof row.restartRequiresForce === 'boolean'
    && typeof row.startedAt === 'string')
}

export function readForgeLoopSidebar(value: unknown): ForgeLoopSidebarOutput {
  return readLoopRows<LoopSidebarRow>(value, 'loop sidebar', (row) =>
    typeof row.loopName === 'string'
    && typeof row.status === 'string'
    && typeof row.iteration === 'number'
    && typeof row.maxIterations === 'number'
    && typeof row.startedAt === 'number'
    && typeof row.phase === 'string'
    && typeof row.phaseStartedAt === 'number'
    && typeof row.currentSectionIndex === 'number'
    && typeof row.totalSections === 'number')
}

export function readForgeLoopDefaults(value: unknown): ForgeLoopDefaultsOutput {
  return readForgeRpcResult(value, 'loop defaults', (record) => {
    if (typeof record.maxIterations !== 'number' || !Number.isInteger(record.maxIterations)) return null
    const sandbox = record.sandbox
    if (!isRecord(sandbox) || typeof sandbox.available !== 'boolean') return null
    const resources = sandbox.resources
    if (!isRecord(resources)) return null
    const fields = ['memory', 'cpus', 'dockerDisk', 'cacheDisk'] as const
    if (!fields.every((field) => typeof resources[field] === 'string')) return null
    return {
      maxIterations: record.maxIterations,
      sandbox: {
        available: sandbox.available,
        resources: {
          memory: resources.memory as string,
          cpus: resources.cpus as string,
          dockerDisk: resources.dockerDisk as string,
          cacheDisk: resources.cacheDisk as string,
        },
      },
    }
  })
}

/**
 * JSON form of an RPC result. OpenCode validates handler output before
 * serializing it and rejects `undefined` ("Expected JSON value"), which optional
 * fields such as `LoopInfo.auditorVariant` carry; a JSON round trip drops them.
 * Top-level `null` properties are dropped too, because the RPC schema has no null,
 * so a result that omits a null row reads the same as an explicit writer's.
 */
export function toForgeRpcJson<T>(value: T): T {
  const source = isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null))
    : value
  return JSON.parse(JSON.stringify(source)) as T
}

export function readForgeSessionPlan(value: unknown): ForgeSessionPlanOutput {
  return readForgeRpcResult(value, 'session plan', (record) => ({
    plan: typeof record.plan === 'string' ? record.plan : null,
  }))
}

export function readForgeLoopRestartOutput(value: unknown): ForgeLoopRestartOutput {
  return readForgeRpcResult(value, 'loop restart result', (record) =>
    typeof record.sessionId === 'string'
      ? { sessionId: record.sessionId }
      : { error: 'Loop restart completed without a session' })
}

export function readForgeHostSandboxState(value: unknown): ForgeHostSandboxStateOutput {
  return readForgeRpcResult(value, 'host sandbox state', (record) => {
    if (typeof record.configEnabled !== 'boolean') return null
    const row = <T>(key: 'desired' | 'applied' | 'controller', field: 'revision' | 'phase'): T | null => {
      const entry = record[key]
      return isRecord(entry) && typeof entry[field] === 'string' ? entry as T : null
    }
    const loops = record.activeLoopSandboxes
    return {
      configEnabled: record.configEnabled,
      desired: row<SessionSandboxDesiredState>('desired', 'revision'),
      applied: row<SessionSandboxAppliedState>('applied', 'revision'),
      controller: row<SessionSandboxControllerState>('controller', 'phase'),
      ...(isRecord(loops) && Object.values(loops).every((entry) => typeof entry === 'boolean')
        ? { activeLoopSandboxes: loops as Record<string, boolean> }
        : {}),
    }
  })
}

export function readForgeHostSandboxSetOutput(value: unknown): ForgeHostSandboxSetOutput {
  return readForgeRpcResult(value, 'host sandbox result', (record) =>
    typeof record.revision === 'string' ? { revision: record.revision } : null)
}

export function readForgeAutoApproveState(value: unknown): ForgeAutoApproveState {
  return readForgeRpcResult(value, 'auto-approve state', (record) => {
    if (typeof record.enabled !== 'boolean') return null
    return {
      enabled: record.enabled,
      inherited: record.inherited === true,
      ...(typeof record.ownerSessionId === 'string' ? { ownerSessionId: record.ownerSessionId } : {}),
    }
  })
}

export function readForgeWorktrees(value: unknown): ForgeWorktreesOutput {
  return readForgeRpcResult(value, 'worktree list', (record) => {
    if (typeof record.root !== 'string') return null
    if (!Array.isArray(record.dirs) || !record.dirs.every((dir) => typeof dir === 'string')) return null
    return { root: record.root, dirs: record.dirs as string[] }
  })
}

export function readForgeVersion(value: unknown): { version: string } | ForgeRpcError {
  return readForgeRpcResult(value, 'version', (record) =>
    typeof record.version === 'string' ? { version: record.version } : null)
}

export function readForgeLoopsChangedEvent(data: Readonly<Record<string, unknown>>): ForgeLoopsChangedEvent | null {
  return typeof data.projectId === 'string' ? { projectId: data.projectId } : null
}

export function readForgeAutoApproveChangedEvent(data: Readonly<Record<string, unknown>>): ForgeAutoApproveChangedEvent | null {
  return typeof data.projectId === 'string' && typeof data.sessionId === 'string'
    ? { projectId: data.projectId, sessionId: data.sessionId }
    : null
}

export function readForgeHostSandboxChangedEvent(data: Readonly<Record<string, unknown>>): ForgeHostSandboxChangedEvent | null {
  return typeof data.projectId === 'string' ? { projectId: data.projectId } : null
}
