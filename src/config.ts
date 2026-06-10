import type { AgentRole, AgentDefinition, AgentConfig } from './agents'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_REVIEW = readFileSync(join(__dirname, 'command/template/review.txt'), 'utf-8')

const PROMPT_REVIEW_PLAN = `You are reviewing a completed implementation against its original plan.

Input: $ARGUMENTS

## Step 1: Find the Plan and Implementation

Use the input to determine what to review:
- If the user provided a loop name, call \`plan-read\` with \`loop_name\` for that loop.
- If the user provided plan text, treat it as the plan and inspect the current working tree implementation.
- Otherwise, call \`plan-read\` with no arguments to load the current session plan.

If no plan is found using the above rules:
- Call \`plan-read\` with \`recent: true\` to list recent project plans.
- If the user's words include a feature name, branch clue, or domain term, call \`plan-read\` with \`recent: true\` and \`pattern\` using that term.
- If multiple plausible plans exist, ask the user to choose.

Do not use loop management tools.

## Step 2: Gather Implementation Evidence

Review the implementation that corresponds to the plan:
- Inspect diffs, changed files, and relevant tests for the selected loop or current working tree.
- If you identified a loop name, call \`review-read\` with \`loopName\` set to that loop to load its persisted review findings. Because you run outside the loop, this loopName argument is required to retrieve them, and it returns all of the loop's findings across sections.
- Read the full files needed to verify behavior, not just diffs.
- Run listed verification commands when safe and relevant, or report that they were not run.
- Check existing patterns before claiming a mismatch.

## Step 3: Review Criteria

Focus on plan compliance and implementation quality:
- Every acceptance criterion is satisfied by code, tests, or documented behavior
- Required tests and validation commands exist and pass
- The implementation matches the plan's intended scope without unrelated changes
- Deviations from the plan are documented and technically justified
- Edge cases, migrations, compatibility, and rollback concerns from the plan are handled
- The implementation follows existing architecture, naming, and domain patterns
- No duplicated abstractions, dead code, or unnecessary complexity was introduced

## Output

Return a concise implementation review:

### Verdict
Complete | Needs fixes | Needs clarification

### Blocking Issues
List unmet acceptance criteria, failed verification, or bugs that should be fixed, including any unresolved bug-severity findings returned by \`review-read\`. Reference plan lines or loop names when available.

### Deviations
List implementation deviations from the plan and whether each is acceptable.

### Verification
List commands run and results, or commands that still need to be run.

### Suggested Follow-ups
List non-blocking improvements or cleanup.
`

const REPLACED_BUILTIN_AGENTS = ['build', 'plan']

const PLUGIN_COMMANDS: Record<string, { template: string; description: string; agent: string; subtask: boolean }> = {
  review: {
    description: 'Run a code review.',
    agent: 'auditor',
    subtask: true,
    template: PROMPT_REVIEW,
  },
  'review-plan': {
    description: 'Review a completed implementation against its original plan.',
    agent: 'auditor',
    subtask: true,
    template: PROMPT_REVIEW_PLAN,
  },
  loop: {
    description: 'Start an iterative development loop in a worktree',
    agent: 'code',
    subtask: false,
    template: `## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Execute the Loop

Run \`loop\` with:
- plan: Optional full implementation plan. If omitted, Forge reads the captured plan for the current session.
- title: Required short descriptive title.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- hostSessionId: Optional host session ID for post-completion redirect.

The loop always runs in an isolated git worktree. Docker sandboxing is used automatically when configured and available.
Use \`loop-status\` to check progress or \`loop-cancel\` to stop.

$ARGUMENTS`,
  },
  'loop-status': {
    description: 'Check status of all active loops',
    agent: 'code',
    subtask: false,
    template: `Check the status of all loops.

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
  agentOverrides?: Record<string, { temperature?: number }>
) {
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
              delete mergedPermission[tool]
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

    config.agent = mergedAgents
    config.default_agent = 'code'
    config.permission = {
      ...((config.permission as Record<string, unknown> | undefined) ?? {}),
      sh: 'deny',
    }

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
