import { z } from 'zod'
import type { PluginConfig, LoopPermissionRuleConfig, LoopPermissionsConfig, LoopSessionReuseConfig } from '../types'
import type { LoopHandoffPhase } from '../loop/handoff'

export const DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT = 50

export const DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT = 50

export type LoopSessionReuseRole = 'code' | 'auditor'

export const CODE_GRAPH_LINK_NAME = '.codegraph'

export type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

export const MAX_TOTAL_SECTIONS = 24

export const PLAN_AUTHORING_TOOL_NAMES = ['plan-write', 'plan-edit'] as const

export const SHARED_STRUCTURAL_DENY_PERMISSIONS = [
  ...PLAN_AUTHORING_TOOL_NAMES,
  'execute-plan',
  'question',
  'loop-cancel',
  'loop-status',
] as const

export const LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS = ['review-write', 'review-delete'] as const

export const AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS = ['edit', 'write'] as const

export const LOOP_HANDOFF_TOOL_NAME = 'loop-handoff'
export const LOOP_COMPLETE_TOOL_NAME = 'loop-complete'
export const LOOP_PHASE_TOOL_NAMES = [LOOP_HANDOFF_TOOL_NAME, LOOP_COMPLETE_TOOL_NAME] as const
export type LoopPhaseToolName = (typeof LOOP_PHASE_TOOL_NAMES)[number]

export const AUDIT_SESSION_DENIED_TOOL_NAMES = [
  ...AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  ...SHARED_STRUCTURAL_DENY_PERMISSIONS,
  LOOP_COMPLETE_TOOL_NAME,
] as const

export const FORGE_MANAGED_PERMISSIONS: ReadonlySet<string> = new Set([
  '*',
  'external_directory',
  ...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  ...AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  ...SHARED_STRUCTURAL_DENY_PERMISSIONS,
  ...LOOP_PHASE_TOOL_NAMES,
])

export const FORGE_REQUIRED_PERMISSIONS: ReadonlySet<string> = new Set([
  'review-read',
  'plan-read',
  'section-read',
  'plan-adjust',
  'bash',
  'read',
])

function denyRulesFor(names: readonly string[]): PermissionRule[] {
  return names.map((permission) => ({ permission, pattern: '*', action: 'deny' as const }))
}

const loopPermissionEntryObjectSchema = z.looseObject({
  permission: z.string(),
  pattern: z.string().optional(),
})

function parseLoopPermissionEntry(index: number, raw: LoopPermissionRuleConfig, warnings: string[]): PermissionRule | null {
  const drop = (): null => {
    warnings.push(`loop.permissions.deny[${index}] is ignored: expected a tool name or { permission, pattern }`)
    return null
  }

  const asString = z.string().safeParse(raw)
  if (asString.success) {
    const permission = asString.data.trim()
    if (!permission) return drop()
    return { permission, pattern: '*', action: 'deny' }
  }

  const asObject = loopPermissionEntryObjectSchema.safeParse(raw)
  if (asObject.success) {
    const permission = asObject.data.permission.trim()
    if (!permission) return drop()
    const pattern = asObject.data.pattern?.trim() ?? ''
    return { permission, pattern: pattern || '*', action: 'deny' }
  }

  return drop()
}

const loopPermissionsInputSchema = z.looseObject({
  deny: z.unknown().optional(),
  allow: z.unknown().optional(),
})

export interface ParsedLoopPermissionRules {
  rules: PermissionRule[]
  warnings: string[]
}

export function parseLoopPermissionRules(raw: LoopPermissionsConfig | null | undefined): ParsedLoopPermissionRules {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { rules: [], warnings }

  const input = loopPermissionsInputSchema.safeParse(raw)
  if (!input.success) {
    warnings.push('loop.permissions is ignored: expected an object with a "deny" array')
    return { rules: [], warnings }
  }

  const rules: PermissionRule[] = []
  const seen = new Set<string>()

  if (input.data.allow !== undefined) {
    warnings.push('loop.permissions.allow is ignored: only deny entries are supported')
  }

  if (input.data.deny !== undefined) {
    if (!Array.isArray(raw.deny)) {
      warnings.push('loop.permissions.deny is ignored: expected an array')
    } else {
      for (let i = 0; i < raw.deny.length; i++) {
        const rule = parseLoopPermissionEntry(i, raw.deny[i], warnings)
        if (!rule) continue
        if (rule.pattern === '*' && FORGE_REQUIRED_PERMISSIONS.has(rule.permission)) {
          warnings.push(
            `loop.permissions.deny entry "${rule.permission}" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead`,
          )
          continue
        }
        if (FORGE_MANAGED_PERMISSIONS.has(rule.permission)) {
          const suffix =
            rule.permission === 'external_directory'
              ? ' — loops allow external directories; sandbox mounts are the boundary (add read-only mounts with loop.allowExternalDirectories)'
              : ''
          warnings.push(
            `loop.permissions.deny entry "${rule.permission}" is ignored: Forge manages this permission for every loop and audit session${suffix}`,
          )
          continue
        }
        const signature = `${rule.permission}|${rule.pattern}|${rule.action}`
        if (seen.has(signature)) continue
        seen.add(signature)
        rules.push(rule)
      }
    }
  }

  return { rules, warnings }
}

export function resolveLoopPermissionRules(config: PluginConfig | undefined): PermissionRule[] {
  return parseLoopPermissionRules(config?.loop?.permissions).rules
}

export function resolveLoopPermissionOptions(config: PluginConfig | undefined): LoopPermissionRulesetOptions {
  return {
    extraRules: resolveLoopPermissionRules(config),
    denyCodeGraphMcp: isCodeGraphEnabled(config),
  }
}

export function collectLoopPermissionConfigWarnings(config: PluginConfig | undefined): string[] {
  return parseLoopPermissionRules(config?.loop?.permissions).warnings
}

export function resolveLoopAllowedDirectories(config: PluginConfig | undefined): string[] {
  return config?.loop?.allowExternalDirectories ?? []
}

export interface ParsedSessionReuseConfig {
  coderContextPercent: number
  auditorContextPercent: number
  warnings: string[]
}

function parseSessionReusePercent(
  raw: number | undefined,
  key: string,
  fallback: number,
  warnings: string[],
): number {
  if (raw === undefined) return fallback
  const parsed = z.number().min(0).max(100).safeParse(raw)
  if (parsed.success) return parsed.data
  warnings.push(`${key} is ignored: expected a finite number between 0 and 100, using the default ${fallback}`)
  return fallback
}

const sessionReuseInputSchema = z.looseObject({
  coderContextPercent: z.unknown().optional(),
  auditorContextPercent: z.unknown().optional(),
})

export function parseSessionReuseConfig(raw: LoopSessionReuseConfig | null | undefined): ParsedSessionReuseConfig {
  const warnings: string[] = []
  const defaults = {
    coderContextPercent: DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT,
    auditorContextPercent: DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT,
  }
  if (raw === undefined || raw === null) return { ...defaults, warnings }
  if (!sessionReuseInputSchema.safeParse(raw).success) {
    warnings.push('loop.sessionReuse is ignored: expected an object with "coderContextPercent" and "auditorContextPercent"')
    return { ...defaults, warnings }
  }
  return {
    coderContextPercent: parseSessionReusePercent(
      raw.coderContextPercent,
      'loop.sessionReuse.coderContextPercent',
      defaults.coderContextPercent,
      warnings,
    ),
    auditorContextPercent: parseSessionReusePercent(
      raw.auditorContextPercent,
      'loop.sessionReuse.auditorContextPercent',
      defaults.auditorContextPercent,
      warnings,
    ),
    warnings,
  }
}

export function resolveSessionReuseContextPercent(
  config: PluginConfig | undefined,
  role: LoopSessionReuseRole,
): number {
  const parsed = parseSessionReuseConfig(config?.loop?.sessionReuse)
  return role === 'auditor' ? parsed.auditorContextPercent : parsed.coderContextPercent
}

export function collectSessionReuseConfigWarnings(config: PluginConfig | undefined): string[] {
  return parseSessionReuseConfig(config?.loop?.sessionReuse).warnings
}

export function isCodeGraphEnabled(config: PluginConfig | undefined): boolean {
  return config?.codeGraph?.enabled !== false
}

export const CODE_GRAPH_MCP_PERMISSION = 'codegraph_*'

export interface LoopPermissionRulesetOptions {
  extraRules?: PermissionRule[]
  denyCodeGraphMcp?: boolean
}

function codeGraphMcpDenyRules(options: LoopPermissionRulesetOptions): PermissionRule[] {
  return options.denyCodeGraphMcp ? denyRulesFor([CODE_GRAPH_MCP_PERMISSION]) : []
}

function buildWorktreePermissionRuleset(
  options: LoopPermissionRulesetOptions,
  deniedPhaseTool: LoopPhaseToolName,
): PermissionRule[] {
  const rules: PermissionRule[] = []

  rules.push({ permission: '*', pattern: '*', action: 'allow' })

  rules.push(...(options.extraRules ?? []))

  rules.push(...denyRulesFor([...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS, ...SHARED_STRUCTURAL_DENY_PERMISSIONS, deniedPhaseTool]))
  rules.push(...codeGraphMcpDenyRules(options))

  return rules
}

export function buildPermissionRulesetForPhase(
  phase: LoopHandoffPhase,
  options: LoopPermissionRulesetOptions = {},
): PermissionRule[] {
  return buildWorktreePermissionRuleset(
    options,
    phase === 'post_action' ? LOOP_HANDOFF_TOOL_NAME : LOOP_COMPLETE_TOOL_NAME,
  )
}

export function buildLoopPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  return buildPermissionRulesetForPhase('coding', options)
}

export function buildPostActionPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  return buildPermissionRulesetForPhase('post_action', options)
}

export function buildAuditSessionPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'allow' },
    ...(options.extraRules ?? []),
    ...denyRulesFor(AUDIT_SESSION_DENIED_TOOL_NAMES),
    ...codeGraphMcpDenyRules(options),
  ]
  return rules
}
