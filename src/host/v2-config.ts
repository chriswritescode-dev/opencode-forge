import type { Plugin } from '@opencode/plugin'
import type { AgentConfig } from '../agents'
import { DEFAULT_AGENT, type PluginCommand } from '../config'
import { toV2PermissionMap } from '../client/v2-adapter'
import { parseModelString } from '../utils/model-fallback'
import type { ForgeCore } from './forge-core'

type V2AgentEditor = Parameters<Parameters<Plugin.Context['agent']['transform']>[0]>[0]
type V2AgentInfo = Parameters<V2AgentEditor['update']>[1] extends (agent: infer Info) => void ? Info : never

export interface ForgeConfigMaps {
  agent: Record<string, AgentConfig>
  command: Record<string, PluginCommand>
}

export async function resolveForgeConfigMaps(
  applyConfig: ForgeCore['applyConfig'],
  overrides?: Record<string, unknown>,
): Promise<ForgeConfigMaps> {
  const cfg: Record<string, unknown> = { ...overrides }
  await applyConfig(cfg)
  return {
    agent: (cfg.agent ?? {}) as Record<string, AgentConfig>,
    command: (cfg.command ?? {}) as Record<string, PluginCommand>,
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
    agent.model = {
      id: model.modelID,
      providerID: model.providerID,
      ...(cfg.variant ? { variant: cfg.variant } : {}),
    } as unknown as NonNullable<V2AgentInfo['model']>
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
