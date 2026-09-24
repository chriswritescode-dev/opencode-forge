import type { Rpc } from '@opencode/plugin/rpc'
import { FORGE_PLUGIN_ID } from '../constants/plugin'
import { isRecord } from '../utils/is-record'
import { TOAST_VARIANTS, type ToastVariant } from '../utils/toast'

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

const OPTIONAL_STRING = { type: 'string' } as const

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
