import type { Rpc } from '@opencode/plugin/rpc'
import { FORGE_PLUGIN_ID } from '../constants/plugin'
import { TOAST_VARIANTS, type ToastVariant } from '../utils/toast'

export type ForgeToastInput = {
  title?: string
  message: string
  variant?: ToastVariant
  duration?: number
}

export type ForgeToastEvent = ForgeToastInput & { projectId: string }

export const FORGE_RPC = {
  id: FORGE_PLUGIN_ID,
  methods: {},
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
