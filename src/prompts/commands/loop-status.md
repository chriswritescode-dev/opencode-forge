Check the status of all loops.

## Step 1: List Active Loops

Run `loop-status` with no arguments to list all active loops for the current project.

## Step 2: Get Detailed Status

For each active loop found, run `loop-status` with the loop name to get detailed status. Token counts, iterations, last output.

## Step 3: Report

Present a summary showing:
- Total number of active loops
- For each loop: name, status, and any additional details

If no loops are active, report that there are no active loops.

## Accessing a Completed Loop's Work

Loop completion depends on the loop's execution location, which `loop-status <name>` reports:

- **Worktree loops** (`worktree: true`, e.g. `/execute-plan` `mode: loop`, `/execute-goal`): the worktree is cleaned up on completion, so the worktree directory no longer exists. The work is preserved only on a local git branch named `forge/<loop-name>` (the loop name is slugified: lowercased with non-alphanumeric characters replaced by hyphens) that is never deleted. Inspect or switch to that branch directly rather than trying to `cd` into the pruned worktree path.
- **Project-directory goal loops** (`worktree: false`, e.g. `/execute-plan` `mode='new-session'`): the loop ran directly in the project directory — there is no worktree and no `forge/<loop-name>` branch. The completed work is whatever the executor left in the working tree of the project directory (commit it yourself if you want to preserve it). Reopen the loop's last session from the session list to revisit the changes.

$ARGUMENTS
