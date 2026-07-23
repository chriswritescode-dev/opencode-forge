## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Choose the Execution Mode

Unless the user already named a mode in their request, use the `question` tool to let them pick how to run the plan. Never ask via plain text. Offer these options:
- "Loop (Recommended)" — Run the iterative development loop in an isolated git worktree. Docker sandboxing is used automatically when configured and available. Maps to `mode: loop`.
- "New session" — Run the plan as an audited goal-style loop in a fresh session in the project directory, with no worktree or sandbox. The auditor validates each coding pass and the loop continues until the audit is clear; tracked by `loop-status` and `loop-cancel`. Falls back to a plain standalone session when loops are disabled or the project has no commit. Maps to `mode: new-session`.

If the user already specified a mode, skip the question and use it. Do not re-ask once a choice is made.

## Step 3: Execute the Plan

Run `execute-plan` with:
- plan: Optional full implementation plan. If omitted, Forge reads the captured plan for the current session.
- title: Required short descriptive title.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- hostSessionId: Optional host session ID for post-completion redirect. Applies only to `loop` mode, where the TUI redirects back to this session after worktree teardown. Ignored in `new-session` mode: the audited session always attributes its host metadata to the invoking session and never redirects.
- mode: The mode selected in Step 2 — `loop` or `new-session`.

In `loop` mode, execution always runs in an isolated git worktree. Docker sandboxing is used automatically when configured and available. In `new-session` mode, the plan runs as an audited goal-style loop in the project directory, with no worktree or sandbox; the auditor validates each coding pass and the loop continues until the audit is clear. When loops are disabled or the project has no commit, `new-session` falls back to a plain standalone one-shot session.

When an audited loop is launched (either mode), track or stop it with `loop-status` (progress) and `loop-cancel` (stop). The one-shot fallback above is not tracked or cancellable through those tools — do not recommend them when execution fell back to a standalone session.

$ARGUMENTS
