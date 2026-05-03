import type { AgentRole, AgentDefinition, AgentConfig } from './agents'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_REVIEW = readFileSync(join(__dirname, 'command/template/review.txt'), 'utf-8')


const REPLACED_BUILTIN_AGENTS = ['build', 'plan']

const ENHANCED_BUILTIN_AGENTS: Record<string, { permission: Record<string, string>; prompt?: string }> = {
  explore: {
    permission: {
      'graph-query': 'allow',
      'graph-symbols': 'allow',
      'graph-analyze': 'allow',
    },
    prompt: `# Graph-first discovery hierarchy
You have access to four graph tools: graph-status, graph-query, graph-symbols, and graph-analyze. Use whichever graph tool best fits the question — these prompts prioritize graph usage without constraining which graph tool you use.

1. **File-level topology**: Use graph-query for structural questions: top_files (most important files), file_symbols (what symbols live in a file), file_deps (what a file depends on), file_dependents (what depends on a file), cochanges (files that change together), blast_radius (impact analysis), packages (external package usage).
2. **Symbol lookup**: Use graph-symbols for symbol-level queries: find (locate a symbol), search (search by pattern), signature (get symbol signature), callers (who calls this), callees (what this calls).
3. **Code quality analysis**: Use graph-analyze for structural quality insights: unused_exports (exported but never imported), duplication (duplicate code structures), near_duplicates (near-duplicate code patterns).
4. **Direct inspection**: Use Read to inspect the narrowed files directly.
5. **Fallback**: Use Glob/Grep only for literal filename/content searches or when the graph cannot answer the question.

## General guidelines
- When exploring the codebase, prefer the Task tool to reduce context usage.
- Call multiple tools in a single response when they are independent. Batch tool calls for performance.
- Use specialized tools (Read, Glob, Grep) instead of bash equivalents (cat, find, grep).
`,
  },
}

const PLUGIN_COMMANDS: Record<string, { template: string; description: string; agent: string; subtask: boolean }> = {
  review: {
    description: 'Run a code review.',
    agent: 'auditor',
    subtask: true,
    template: PROMPT_REVIEW,
  },
  loop: {
    description: 'Start an iterative development loop in a worktree',
    agent: 'code',
    subtask: false,
    template: `## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Choose Execution Mode

Decide whether to run in:
- Worktree mode (isolated git worktree) for safe experimentation
- In-place mode (current directory) for quick iterations

## Step 3: Execute the Loop

Run \`loop\` with:
- plan: The full implementation plan
- title: A short descriptive title
- worktree: true for worktree mode, false for in-place

The loop will automatically continue through iterations until complete.
Use \`loop-status\` to check progress or \`loop-cancel\` to stop.

$ARGUMENTS`,
  },
  'loop-status': {
    description: 'Check status of all active loops',
    agent: 'code',
    subtask: false,
    template: `Check the status of all memory loops.

## Step 1: List Active Loops

Run \`loop-status\` with no arguments to list all active loops for the current project.

## Step 2: Get Detailed Status

For each active loop found, run \`loop-status\` with the loop name to get detailed status. Token counts, iterations, last output.

## Step 3: Report

Present a summary showing:
- Total number of active loops
- For each loop: name, status, and any additional details

If no loops are active, report that there are no active loops.

$ARGUMENTS`,
  },
  'loop-cancel': {
    description: 'Cancel the active loop',
    agent: 'code',
    subtask: false,
    template: `## Step 1: Identify the Loop

Run \`loop-status\` to see all active loops if you don't know the name.

## Step 2: Cancel the Loop

Run \`loop-cancel\` with:
- name: The worktree name of the loop to cancel (optional if only one active)

## Step 3: Verify Cancellation

Confirm the loop was cancelled and check if worktree cleanup is needed.

$ARGUMENTS`,
  },
}

export function createConfigHandler(
  agents: Record<AgentRole, AgentDefinition>,
  agentOverrides?: Record<string, { temperature?: number }>,
  options?: { graphEnabled?: boolean }
) {
  const graphEnabled = options?.graphEnabled ?? true
  return async (config: Record<string, unknown>) => {
    const effectiveAgents = { ...agents }
    if (agentOverrides) {
      for (const [name, overrides] of Object.entries(agentOverrides)) {
        const role = Object.keys(effectiveAgents).find(
          (r) => effectiveAgents[r as AgentRole].displayName === name
        ) as AgentRole | undefined
        if (role) {
          effectiveAgents[role] = { ...effectiveAgents[role], ...overrides }
        }
      }
    }
    const agentConfigs = createAgentConfigs(effectiveAgents)

    const userAgentConfigs = config.agent as Record<string, AgentConfig> | undefined
    const mergedAgents = { ...agentConfigs }

    if (userAgentConfigs) {
      for (const [name, userConfig] of Object.entries(userAgentConfigs)) {
        if (mergedAgents[name]) {
          const existing = mergedAgents[name]
          const mergedTools = { ...(existing?.tools ?? {}), ...(userConfig.tools ?? {}) }
          const existingPermission = (existing?.permission as Record<string, unknown> | undefined) ?? {}
          const mergedPermission = {
            ...existingPermission,
            ...((userConfig.permission as Record<string, unknown> | undefined) ?? {}),
          }
          if (userConfig.tools) {
            for (const [tool, enabled] of Object.entries(userConfig.tools)) {
              mergedPermission[tool] = enabled ? 'allow' : 'deny'
            }
          }
          for (const [tool, enabled] of Object.entries(existing?.tools ?? {})) {
            if (enabled === false && existingPermission[tool] === 'deny') {
              mergedTools[tool] = false
              mergedPermission[tool] = 'deny'
            }
          }
          mergedAgents[name] = {
            ...existing,
            ...userConfig,
            ...(Object.keys(mergedTools).length ? { tools: mergedTools } : {}),
            ...(Object.keys(mergedPermission).length ? { permission: mergedPermission } : {}),
          }
        } else {
          mergedAgents[name] = userConfig
        }
      }
    }

    for (const name of REPLACED_BUILTIN_AGENTS) {
      mergedAgents[name] = { ...mergedAgents[name], hidden: true }
    }

    if (graphEnabled) {
      for (const [name, enhancement] of Object.entries(ENHANCED_BUILTIN_AGENTS)) {
        const existing = mergedAgents[name] as AgentConfig | undefined
        const existingPermission = (existing?.permission ?? {}) as Record<string, unknown>
        const existingPrompt = existing?.prompt ?? ''
        const newPrompt = enhancement.prompt
          ? existingPrompt
            ? `${existingPrompt}\n\n${enhancement.prompt}`
            : enhancement.prompt
          : existingPrompt
        mergedAgents[name] = {
          ...existing,
          permission: { ...existingPermission, ...enhancement.permission },
          prompt: newPrompt,
        } as AgentConfig
      }
    }

    config.agent = mergedAgents
    config.default_agent = 'code'

    const userCommands = config.command as Record<string, unknown> | undefined
    const mergedCommands: Record<string, unknown> = { ...PLUGIN_COMMANDS }

    if (userCommands) {
      for (const [name, userCommand] of Object.entries(userCommands)) {
        mergedCommands[name] = userCommand
      }
    }

    config.command = mergedCommands
  }
}

function createAgentConfigs(agents: Record<AgentRole, AgentDefinition>): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {}

  for (const agent of Object.values(agents)) {
    const tools: Record<string, boolean> = {}
    // Mirror tools.exclude into a permission map. Opencode's agent loader only
    // reads `value.permission` when merging plugin-provided `cfg.agent` entries
    // (see opencode packages/opencode/src/agent/agent.ts). The legacy `tools`
    // map is only normalized via the zod Info transform at parse time, which
    // does not run on config mutated by the plugin config hook. Without this
    // permission mirror, excluded tools remain callable.
    const permission: Record<string, unknown> = {
      ...((agent.permission as Record<string, unknown> | undefined) ?? {}),
    }
    if (agent.tools?.exclude) {
      for (const tool of agent.tools.exclude) {
        tools[tool] = false
        permission[tool] = 'deny'
      }
    }

    result[agent.displayName] = {
      description: agent.description,
      model: agent.defaultModel ?? '',
      prompt: agent.systemPrompt ?? '',
      mode: agent.mode ?? 'subagent',
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      ...(agent.variant ? { variant: agent.variant } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
      ...(agent.hidden ? { hidden: agent.hidden } : {}),
      ...(agent.color ? { color: agent.color } : {}),
      ...(Object.keys(permission).length > 0 ? { permission } : {}),
    }
  }

  return result
}
