## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Execute the Plan

Run `execute-plan` with:
- plan: Optional full implementation plan. If omitted, Forge reads the captured plan for the current session.
- title: Required short descriptive title.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- hostSessionId: Optional host session ID for post-completion redirect.
- mode: Optional execution mode. `loop` (default) runs the iterative loop in an isolated git worktree. `new-session` launches the plan in a fresh standalone session running the code agent (no worktree, no loop).

In the default `loop` mode, execution always runs in an isolated git worktree. Docker sandboxing is used automatically when configured and available. In `new-session` mode, the plan runs in a normal session with no worktree or sandbox.
Use `loop-status` to check progress or `loop-cancel` to stop.

$ARGUMENTS
