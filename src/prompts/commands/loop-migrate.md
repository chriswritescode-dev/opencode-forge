## Step 1: Identify the Loop

Run `loop-status` to see all active loops if you don't know the name.

## Step 2: Migrate the Loop

Run `loop-migrate` with:
- name: The worktree name of the loop to migrate
- remote: The configured remote to migrate to (the `remotes[].name` values in the plugin config)

## Step 3: Report the Migration

Confirm the loop was migrated: report the remote loop name and remote session id, and note that the local loop is stopped as migrated and cannot be restarted here.

$ARGUMENTS
