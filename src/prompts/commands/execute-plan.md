## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Execute the Plan

Run `execute-plan` directly — do not use the `question` tool to pick a mode. Default to `mode: loop`, which runs the iterative development loop in an isolated git worktree with `msb` microVM sandboxing used automatically when configured and available. Use `mode: new-session` only when the user explicitly asked to launch the plan in a fresh standalone session with no worktree or sandbox.

Args:
- plan: Optional full implementation plan. If omitted, Forge reads the captured plan for the current session.
- title: Required short descriptive title.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- mode: The execution mode — `loop` (default) or `new-session`.

Use `loop-status` to check progress or `loop-cancel` to stop.

$ARGUMENTS
