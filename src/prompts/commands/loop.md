## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Execute the Loop

Run `loop` with:
- plan: Optional full implementation plan. If omitted, Forge reads the captured plan for the current session.
- title: Required short descriptive title.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- hostSessionId: Optional host session ID for post-completion redirect.

The loop always runs in an isolated git worktree. Docker sandboxing is used automatically when configured and available.
Use `loop-status` to check progress or `loop-cancel` to stop.

$ARGUMENTS
