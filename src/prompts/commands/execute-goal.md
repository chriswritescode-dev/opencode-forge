## Step 1: Validate the Goal

`$ARGUMENTS` must contain the non-empty goal text the user wants executed directly. If it is blank or only whitespace, ask the user to restate the goal and stop.

Do NOT create a plan, decompose the goal into sections, or ask for approval. The goal is implemented directly.

## Step 2: Start the Goal Loop

Call the `execute-goal` tool with the full goal text:
- goal: Required. The exact goal from `$ARGUMENTS`.
- title: Optional short title. Derived from the goal when omitted.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- maxIterations: Optional maximum loop iterations. Defaults to the plugin config `loop.defaultMaxIterations`.

This warps your current session into an isolated Forge worktree, registers it as the loop executor, and starts the watchdog. No new session is created and no initial prompt is sent by the loop runner — you keep running in this session.

## Step 3: Implement the Goal Directly

Implement the goal in this now-warped session:
- Edit files, write/update tests, and run the project's verification (lint/typecheck/tests) before finishing.
- Reuse existing helpers and patterns; keep changes scoped to what the goal requires.
- Do NOT call `execute-plan`, `launch-group`, the `question` tool, or any plan/approval flow.

## Step 4: Let the Loop Drive Audits

When you go idle, the loop runner automatically starts a fresh auditor session against your worktree and returns review findings to this same session on the next iteration. Keep addressing every finding the auditor reports — both goal-completeness gaps and code defects — until an auditor pass leaves zero open findings, which completes the loop.

Use `loop-status` to inspect progress or `loop-cancel` to stop early. Both work for goal loops exactly as they do for plan loops.

$ARGUMENTS
