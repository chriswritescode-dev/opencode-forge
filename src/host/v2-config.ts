import type { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import type { AgentConfig } from '../agents'
import { DEFAULT_AGENT, USER_REPLACEABLE_AGENTS, type PluginCommand } from '../config'
import { toV2PermissionMap } from '../client/v2-adapter'
import { parseModelString } from '../utils/model-fallback'
import type { ForgeCore } from './forge-core'

type V2AgentEditor = Parameters<Parameters<Plugin.Context['agent']['transform']>[0]>[0]
type V2AgentInfo = Parameters<V2AgentEditor['update']>[1] extends (agent: infer Info) => void ? Info : never
type V2AgentModel = NonNullable<V2AgentInfo['model']>

export interface ForgeConfigMaps {
  agent: Record<string, AgentConfig>
  command: Record<string, PluginCommand>
}

type ForgeConfigDocument = Parameters<ForgeCore['applyConfig']>[0]

const agentConfigSchema = z.looseObject({
  description: z.string().optional(),
  model: z.string().default(''),
  prompt: z.string().optional(),
  mode: z.enum(['primary', 'subagent', 'all']).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  variant: z.string().optional(),
  temperature: z.number().optional(),
  steps: z.number().optional(),
  hidden: z.boolean().optional(),
  color: z.string().optional(),
  permission: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])).optional(),
})

const pluginCommandSchema = z.looseObject({
  template: z.string(),
  description: z.string(),
  agent: z.string(),
  subtask: z.boolean(),
})

const agentConfigMapSchema = z.record(z.string(), agentConfigSchema.optional().catch(undefined))
const pluginCommandMapSchema = z.record(z.string(), pluginCommandSchema.optional().catch(undefined))

function withoutInvalidEntries<T>(entries: Record<string, T | undefined>) {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([name, entry]) => (entry === undefined ? [] : [[name, entry] as const])),
  )
}

const brandedStringSchema = z.string()

const modelIdSchema = z.custom<V2AgentModel['id']>((value) => brandedStringSchema.safeParse(value).success)
const providerIdSchema = z.custom<V2AgentModel['providerID']>((value) => brandedStringSchema.safeParse(value).success)
const modelVariantSchema = z.custom<NonNullable<V2AgentModel['variant']>>(
  (value) => brandedStringSchema.safeParse(value).success,
)

export async function resolveForgeConfigMaps(
  applyConfig: ForgeCore['applyConfig'],
  overrides?: ForgeConfigDocument,
): Promise<ForgeConfigMaps> {
  const cfg: ForgeConfigDocument = { ...overrides }
  await applyConfig(cfg)
  const agent = agentConfigMapSchema.safeParse(cfg.agent)
  const command = pluginCommandMapSchema.safeParse(cfg.command)
  return {
    agent: agent.success ? withoutInvalidEntries(agent.data) : {},
    command: command.success ? withoutInvalidEntries(command.data) : {},
  }
}

function applyV2AgentConfig(agent: V2AgentInfo, cfg: AgentConfig): void {
  if (cfg.prompt !== undefined) agent.system = cfg.prompt
  if (cfg.description !== undefined) agent.description = cfg.description
  if (cfg.mode !== undefined) agent.mode = cfg.mode
  if (cfg.hidden !== undefined) agent.hidden = cfg.hidden
  if (cfg.color !== undefined) agent.color = cfg.color
  if (cfg.steps !== undefined) agent.steps = cfg.steps
  const model = parseModelString(cfg.model)
  if (model) {
    const assignment: V2AgentModel = {
      id: modelIdSchema.parse(model.modelID),
      providerID: providerIdSchema.parse(model.providerID),
    }
    if (cfg.variant) assignment.variant = modelVariantSchema.parse(cfg.variant)
    agent.model = assignment
  }
  if (cfg.temperature !== undefined) agent.request.body.temperature = cfg.temperature
  agent.permissions.push(...toV2PermissionMap(cfg.permission))
}

export function registerForgeAgentsV2(
  ctx: Pick<Plugin.Context, 'agent'>,
  cfgAgent: Record<string, AgentConfig>,
) {
  return ctx.agent.transform((editor) => {
    for (const [id, cfg] of Object.entries(cfgAgent)) {
      if (USER_REPLACEABLE_AGENTS.includes(id) && editor.get(id) !== undefined) {
        editor.update(id, (agent) => agent.permissions.push(...toV2PermissionMap(cfg.permission)))
        continue
      }
      editor.update(id, (agent) => applyV2AgentConfig(agent, cfg))
    }
    editor.default(DEFAULT_AGENT)
  })
}

function substituteArguments(template: string, input: string): string {
  return template.replaceAll('$ARGUMENTS', () => input)
}

async function restoreCommandAgent(
  ctx: Pick<Plugin.Context, 'session'>,
  sessionID: string,
  commandAgent: string,
  previous: string,
): Promise<void> {
  try {
    await ctx.session.wait({ sessionID })
    const info = await ctx.session.get({ sessionID })
    if (info.agent === commandAgent) {
      await ctx.session.switchAgent({ sessionID, agent: previous })
    }
  } catch (err) {
    console.error('[forge] Failed to restore session agent after command', err)
  }
}

export function registerForgeCommandsV2(
  ctx: Pick<Plugin.Context, 'session' | 'command'>,
  cfgCommand: Record<string, PluginCommand>,
) {
  return ctx.command.transform((editor) => {
    for (const [name, command] of Object.entries(cfgCommand)) {
      editor.add({
        name,
        description: command.description,
        execute: async (input) => {
          const commandAgent = command.agent
          let previous: string | undefined
          if (commandAgent) {
            try {
              previous = (await ctx.session.get({ sessionID: input.sessionID })).agent
            } catch (err) {
              console.error('[forge] Failed to read session agent before command', err)
            }
            if (previous !== commandAgent) {
              await ctx.session.switchAgent({ sessionID: input.sessionID, agent: commandAgent })
            }
          }
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: substituteArguments(command.template, input.prompt.text),
            files: input.prompt.files,
            delivery: input.delivery,
          })
          if (commandAgent && previous !== undefined && previous !== commandAgent) {
            void restoreCommandAgent(ctx, input.sessionID, commandAgent, previous)
          }
        },
      })
    }
  })
}
