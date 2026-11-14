import { z } from 'zod'
import { readSandboxOverrides } from '../sandbox/loop-settings'
import type { SandboxOverrides } from '../types'

export interface SessionSandboxDesiredState {
  version: 2
  revision: string
  sessions: Record<string, boolean>
  requestedAt: number
  overrides?: SandboxOverrides
}

export interface SessionSandboxAppliedState {
  version: 2
  revision: string
  running: boolean
  error: string | null
  appliedAt: number
  overrides?: SandboxOverrides
}

export interface SessionSandboxControllerState {
  version: 1
  phase: 'loading' | 'ready' | 'failed'
  revision: string | null
}

function withOverrides<T extends object>(state: T, overrides: SandboxOverrides | undefined): T & { overrides?: SandboxOverrides } {
  return overrides ? { ...state, overrides } : state
}

const nonBlankString = z.string().refine((value) => value.trim().length > 0)

const desiredStateV2Schema = z.object({
  version: z.literal(2),
  revision: nonBlankString,
  sessions: z.record(nonBlankString, z.boolean()),
  requestedAt: z.number(),
  overrides: z.unknown().optional(),
})

const legacyDesiredStateSchema = z
  .object({
    version: z.literal(1),
    revision: nonBlankString,
    enabled: z.boolean(),
    sessionId: nonBlankString.nullable(),
    requestedAt: z.number(),
    overrides: z.unknown().optional(),
  })
  .transform(({ enabled, sessionId, ...state }) => ({
    ...state,
    version: 2 as const,
    sessions: sessionId ? { [sessionId]: enabled } : {},
  }))

export const desiredStateSchema = z
  .union([desiredStateV2Schema, legacyDesiredStateSchema])
  .transform(({ overrides, ...state }): SessionSandboxDesiredState => withOverrides(state, readSandboxOverrides(overrides)))

export const appliedStateSchema = z
  .object({
    version: z.literal(2),
    revision: nonBlankString,
    running: z.boolean(),
    error: z.string().nullable(),
    appliedAt: z.number(),
    overrides: z.unknown().optional(),
  })
  .transform(({ overrides, ...state }): SessionSandboxAppliedState => withOverrides(state, readSandboxOverrides(overrides)))

export const controllerStateSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['loading', 'ready', 'failed']),
  revision: nonBlankString.nullable(),
})

export function isHostSandboxWanted(desired: SessionSandboxDesiredState | null, hostSessionsDefault: boolean): boolean {
  return hostSessionsDefault || Object.values(desired?.sessions ?? {}).some(Boolean)
}
