import type { Rpc } from '@opencode/plugin/rpc'
import { FORGE_PLUGIN_ID } from '../constants/plugin'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import type {
  SessionSandboxAppliedState,
  SessionSandboxControllerState,
  SessionSandboxDesiredState,
} from '../storage/repos/session-sandbox-preferences-repo'
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
}

export type ForgeExecutePlanOutput =
  | { sessionId: string; loopName?: string; worktreeDir?: string; workspaceId?: string }
  | { error: string }

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

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const

const OBJECT = { type: 'object' } as const

const LOOPS_OUTPUT = {
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
      output: LOOPS_OUTPUT,
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
  },
} as const satisfies Rpc.PortableDefinition

export function readForgeExecutePlanOutput(value: unknown): ForgeExecutePlanOutput {
  if (!isRecord(value)) return { error: 'Forge returned an invalid plan execution result' }
  if (typeof value.error === 'string') return { error: value.error }
  if (typeof value.sessionId !== 'string') return { error: 'Forge returned no session for the plan execution' }
  const optional = (key: 'loopName' | 'worktreeDir' | 'workspaceId') =>
    typeof value[key] === 'string' ? { [key]: value[key] as string } : {}
  return { sessionId: value.sessionId, ...optional('loopName'), ...optional('worktreeDir'), ...optional('workspaceId') }
}

function readLoopRows<T>(value: unknown, label: string, isRow: (row: Record<string, unknown>) => boolean): { loops: T[] } | ForgeRpcError {
  if (!isRecord(value)) return { error: `Forge returned an invalid ${label}` }
  if (typeof value.error === 'string') return { error: value.error }
  if (!Array.isArray(value.loops) || !value.loops.every((row) => isRecord(row) && isRow(row))) {
    return { error: `Forge returned an invalid ${label}` }
  }
  return { loops: value.loops as T[] }
}

export function readForgeLoops(value: unknown): ForgeLoopsOutput {
  return readLoopRows<LoopInfo>(value, 'loop list', (row) =>
    typeof row.name === 'string' && typeof row.status === 'string' && typeof row.restartable === 'boolean')
}

export function readForgeLoopSidebar(value: unknown): ForgeLoopSidebarOutput {
  return readLoopRows<LoopSidebarRow>(value, 'loop sidebar', (row) =>
    typeof row.loopName === 'string'
    && typeof row.status === 'string'
    && typeof row.iteration === 'number'
    && typeof row.maxIterations === 'number')
}

/**
 * JSON form of an RPC result. OpenCode validates handler output before
 * serializing it and rejects `undefined` ("Expected JSON value"), which optional
 * fields such as `LoopInfo.auditorVariant` carry; a JSON round trip drops them.
 */
export function toForgeRpcJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Wire form of a session plan: the RPC schema has no null, so an absent plan is omitted. */
export function writeForgeSessionPlan(plan: string | null): { plan?: string } {
  return plan === null ? {} : { plan }
}

export function readForgeSessionPlan(value: unknown): ForgeSessionPlanOutput {
  if (!isRecord(value)) return { error: 'Forge returned an invalid session plan' }
  if (typeof value.error === 'string') return { error: value.error }
  return { plan: typeof value.plan === 'string' ? value.plan : null }
}

export function readForgeLoopRestartOutput(value: unknown): ForgeLoopRestartOutput {
  if (!isRecord(value)) return { error: 'Forge returned an invalid loop restart result' }
  if (typeof value.error === 'string') return { error: value.error }
  if (typeof value.sessionId !== 'string') return { error: 'Loop restart completed without a session' }
  return { sessionId: value.sessionId }
}

/** Wire form of a host sandbox state: the RPC schema has no null, so null rows are omitted. */
export function writeForgeHostSandboxState(state: ForgeHostSandboxState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([, entry]) => entry !== null && entry !== undefined))
}

export function readForgeHostSandboxState(value: unknown): ForgeHostSandboxStateOutput {
  if (!isRecord(value)) return { error: 'Forge returned an invalid host sandbox state' }
  if (typeof value.error === 'string') return { error: value.error }
  if (typeof value.configEnabled !== 'boolean') return { error: 'Forge returned an invalid host sandbox state' }
  const row = <T>(key: 'desired' | 'applied' | 'controller', field: 'revision' | 'phase'): T | null => {
    const entry = value[key]
    return isRecord(entry) && typeof entry[field] === 'string' ? entry as T : null
  }
  const loops = value.activeLoopSandboxes
  return {
    configEnabled: value.configEnabled,
    desired: row<SessionSandboxDesiredState>('desired', 'revision'),
    applied: row<SessionSandboxAppliedState>('applied', 'revision'),
    controller: row<SessionSandboxControllerState>('controller', 'phase'),
    ...(isRecord(loops) && Object.values(loops).every((entry) => typeof entry === 'boolean')
      ? { activeLoopSandboxes: loops as Record<string, boolean> }
      : {}),
  }
}

export function readForgeHostSandboxSetOutput(value: unknown): ForgeHostSandboxSetOutput {
  if (!isRecord(value)) return { error: 'Forge returned an invalid host sandbox result' }
  if (typeof value.error === 'string') return { error: value.error }
  if (typeof value.revision !== 'string') return { error: 'Forge returned an invalid host sandbox result' }
  return { revision: value.revision }
}

export function readForgeAutoApproveState(value: unknown): ForgeAutoApproveState {
  if (!isRecord(value)) return { error: 'Forge returned an invalid auto-approve state' }
  if (typeof value.error === 'string') return { error: value.error }
  if (typeof value.enabled !== 'boolean') return { error: 'Forge returned an invalid auto-approve state' }
  return {
    enabled: value.enabled,
    inherited: value.inherited === true,
    ...(typeof value.ownerSessionId === 'string' ? { ownerSessionId: value.ownerSessionId } : {}),
  }
}

export function readForgeWorktrees(value: unknown): ForgeWorktreesOutput {
  if (!isRecord(value)) return { error: 'Forge returned an invalid worktree list' }
  if (typeof value.error === 'string') return { error: value.error }
  if (typeof value.root !== 'string') return { error: 'Forge returned an invalid worktree list' }
  if (!Array.isArray(value.dirs) || !value.dirs.every((dir) => typeof dir === 'string')) {
    return { error: 'Forge returned an invalid worktree list' }
  }
  return { root: value.root, dirs: value.dirs as string[] }
}
