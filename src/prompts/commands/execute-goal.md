## Step 1: Validate the Goal

`$ARGUMENTS` must contain the non-empty goal text the user wants executed directly. If it is blank or only whitespace, ask the user to restate the goal and stop.

Do NOT create a plan, decompose the goal into sections, or ask for approval. The goal is implemented directly by the loop.

## Step 2: Start the Goal Loop

Call the `execute-goal` tool with the full goal text:
- goal: Required. The exact goal from `$ARGUMENTS`.
- title: Optional short title. Derived from the goal when omitted.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- maxIterations: Optional maximum loop iterations. Defaults to the plugin config `loop.defaultMaxIterations`.

This creates an isolated Forge worktree and a new dedicated code session inside it, sends the goal as that session's initial prompt, and starts the watchdog. Docker sandboxing is used automatically when configured and available.

## Step 3: You Are Done

The new session implements the goal — NOT this session. Do not edit files, run builds, or attempt the goal here. Just confirm to the user that the goal loop has been launched.

The loop automatically audits the work when the session goes idle and rotates in fresh code sessions until an auditor pass leaves zero open findings, which completes the loop.

Use `loop-status` to inspect progress or `loop-cancel` to stop early. Both work for goal loops exactly as they do for plan loops.

$ARGUMENTS
