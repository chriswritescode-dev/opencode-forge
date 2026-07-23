## Step 1: Identify the Loop

Run `loop-status` to see all active loops if you don't know the name.

## Step 2: Cancel the Loop

Run `loop-cancel` with:
- name: The loop name to cancel (optional if only one active loop is running)

## Step 3: Verify Cancellation

Confirm the loop was cancelled. Worktree-backed loops (e.g. `/execute-plan` `mode: loop`, `/execute-goal`, reported by `loop-status` with a `Worktree:` line) clean up their worktree on cancellation when `cleanupWorktree` is configured; project-directory goal loops (e.g. `/execute-plan` `mode='new-session'`, reported by `loop-status` with a `Directory:` line instead of `Worktree:`) have no worktree, so there is nothing to clean up.

$ARGUMENTS
