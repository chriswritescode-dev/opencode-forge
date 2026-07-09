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

A completed loop's worktree is cleaned up, so the worktree directory no longer exists. The work is preserved on a local git branch that is never deleted. To inspect or switch to it, use the branch `forge/<loop-name>` (the loop name is slugified: lowercased with non-alphanumeric characters replaced by hyphens). Check out that branch directly rather than trying to `cd` into the pruned worktree path.

$ARGUMENTS
