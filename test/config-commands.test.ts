import { describe, test, expect } from 'vitest'
import { createConfigHandler } from '../src/config'
import { buildAgents } from '../src/agents'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

describe('createConfigHandler commands', () => {
  test('registers bundled command templates via loadPrompt', async () => {
    const configHandler = createConfigHandler(buildAgents())
    const config: Record<string, unknown> = {}

    await configHandler(config)

    const commands = config.command as Record<string, Record<string, unknown>>

    const review = commands.review
    expect(review).toBeDefined()
    expect(review.template).toContain('code reviewer')
    expect(review.agent).toBe('auditor')
    expect(review.subtask).toBe(true)

    const reviewPlan = commands['review-plan']
    expect(reviewPlan).toBeDefined()
    expect(reviewPlan.template).toContain('reviewing a completed implementation')
    expect(reviewPlan.agent).toBe('auditor')
    expect(reviewPlan.subtask).toBe(true)

    const executePlan = commands['execute-plan']
    expect(executePlan).toBeDefined()
    expect(executePlan.template).toContain('Execute the Plan')
    expect(executePlan.agent).toBe('code')
    expect(executePlan.subtask).toBe(false)

    const executeGoal = commands['execute-goal']
    expect(executeGoal).toBeDefined()
    expect(executeGoal.template).toContain('$ARGUMENTS')
    expect(executeGoal.template).toContain('execute-goal')
    expect(executeGoal.template).toContain('new dedicated code session')
    expect(executeGoal.template).toContain('surrounding conversation')
    expect(executeGoal.template).toContain('self-contained implementation request')
    expect(executeGoal.template).toContain('does not inherit this conversation')
    expect(executeGoal.template).toContain('scope is ambiguous')
    expect(executeGoal.template).toContain('`question` tool')
    expect(executeGoal.agent).toBe('code')
    expect(executeGoal.subtask).toBe(false)

    const launchGroup = commands['launch-group']
    expect(launchGroup).toBeDefined()
    expect(launchGroup.template).toContain('launch-group')
    expect(launchGroup.template).toContain('smallest independently reviewable plan/PR')
    expect(launchGroup.template).toContain('Incidental same-file edits are not enough to group')
    expect(launchGroup.template).not.toContain('never merge or split')
    expect(launchGroup.agent).toBe('code')
    expect(launchGroup.subtask).toBe(false)

    const loopStatus = commands['loop-status']
    expect(loopStatus).toBeDefined()
    expect(loopStatus.template).toContain('Check the status')
    expect(loopStatus.agent).toBe('code')
    // Completed-work guidance is conditional on loop type (auditor issue #6):
    // worktree-backed loops preserve the `forge/<loop-name>` branch; no-worktree
    // goal loops have neither worktree nor preserved branch, so the prompt must
    // distinguish them rather than implying every completed loop had a worktree.
    expect(loopStatus.template).toContain('Worktree loops')
    expect(loopStatus.template).toContain('Project-directory goal loops')
    expect(loopStatus.template).toContain('forge/<loop-name>')
    expect(loopStatus.template).toContain('no worktree')
    // The unconditional "completed loop's worktree is cleaned up" phrasing
    // applying to ALL loops is gone.
    expect(loopStatus.template).not.toMatch(/^A completed loop's worktree is cleaned up, so the worktree directory no longer exists\.$/m)

    const loopCancel = commands['loop-cancel']
    expect(loopCancel).toBeDefined()
    expect(loopCancel.template).toContain('Identify the Loop')
    expect(loopCancel.template).toContain('loop name')
    expect(loopCancel.agent).toBe('code')
    // Auditor issue #7: the identifier is the loop name, not the worktree
    // name, and worktree cleanup guidance is conditional on worktree-backed
    // loops so cancelling a no-worktree loop never implies a worktree exists.
    expect(loopCancel.template).not.toContain('worktree name of the loop')
    expect(loopCancel.template).toContain('no worktree')
  })

  test('user command template overrides via promptsDir', async () => {
    const tmpDir = '/tmp/forge-commands-test-' + Date.now()
    const commandsDir = join(tmpDir, 'commands')
    mkdirSync(commandsDir, { recursive: true })
    writeFileSync(join(commandsDir, 'review.md'), 'CUSTOM REVIEW')

    try {
      const configHandler = createConfigHandler(buildAgents(tmpDir), undefined, tmpDir)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const commands = config.command as Record<string, Record<string, unknown>>
      expect(commands.review.template).toBe('CUSTOM REVIEW')
      expect(commands['review-plan'].template).toContain('reviewing a completed implementation')
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    }
  })
})
