## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Choose the Execution Mode

Unless the user already named a mode in their request, use the `question` tool to let them pick how to run the plan. Never ask via plain text. Offer these options:
- "Loop (Recommended)" — Run the iterative development loop in an isolated git worktree. Docker sandboxing is used automatically when configured and available. Maps to `mode: loop`.
- "New session" — Launch the plan in a fresh standalone session running the code agent, with no worktree or sandbox. Maps to `mode: new-session`.

If the user already specified a mode, skip the question and use it. Do not re-ask once a choice is made.

## Step 3: Execute the Plan

Run `execute-plan` with:
- plan: Optional full implementation plan. If omitted, Forge reads the captured plan for the current session.
- title: Required short descriptive title.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- hostSessionId: Optional host session ID for post-completion redirect.
- mode: The mode selected in Step 2 — `loop` or `new-session`.

In `loop` mode, execution always runs in an isolated git worktree. Docker sandboxing is used automatically when configured and available. In `new-session` mode, the plan runs in a normal session with no worktree or sandbox.
Use `loop-status` to check progress or `loop-cancel` to stop.

$ARGUMENTS
