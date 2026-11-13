import { z } from 'zod'
import { readSandboxOverrides } from '../sandbox/loop-settings'
import type { SandboxOverrides } from '../types'

export interface SessionSandboxDesiredState {
  version: 1
  revision: string
  enabled: boolean
  sessionId: string | null
  requestedAt: number
  overrides?: SandboxOverrides
}

export interface SessionSandboxAppliedState {
  version: 1
  revision: string
  enabled: boolean
  sessionId: string | null
  error: string | null
  appliedAt: number
  overrides?: SandboxOverrides
}

export interface SessionSandboxControllerState {
  version: 1
  phase: 'loading' | 'ready' | 'failed'
  revision: string | null
  sessionId: string | null
}

function withOverrides<T extends object>(state: T, overrides: SandboxOverrides | undefined): T & { overrides?: SandboxOverrides } {
  return overrides ? { ...state, overrides } : state
}

const nonBlankString = z.string().refine((value) => value.trim().length > 0)

export const desiredStateSchema = z
  .object({
    version: z.literal(1),
    revision: nonBlankString,
    enabled: z.boolean(),
    sessionId: nonBlankString.nullable(),
    requestedAt: z.number(),
    overrides: z.unknown().optional(),
  })
  .transform(({ overrides, ...state }) => withOverrides(state, readSandboxOverrides(overrides)))

export const appliedStateSchema = z
  .object({
    version: z.literal(1),
    revision: nonBlankString,
    enabled: z.boolean(),
    sessionId: nonBlankString.nullable(),
    error: z.string().nullable(),
    appliedAt: z.number(),
    overrides: z.unknown().optional(),
  })
  .transform(({ overrides, ...state }) => withOverrides(state, readSandboxOverrides(overrides)))

export const controllerStateSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['loading', 'ready', 'failed']),
  revision: nonBlankString.nullable(),
  sessionId: nonBlankString.nullable(),
})
