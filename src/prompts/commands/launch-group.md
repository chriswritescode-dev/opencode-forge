Launch a group of features that Forge plans and executes in parallel. Each feature gets its own architect-auto planning session and its own development loop, run up to the configured concurrency cap (`groupLaunch.maxConcurrentLoops`).

## Step 1: Understand What the User Wants

Read what the user already wrote in their request (`$ARGUMENTS`) and the surrounding conversation. Treat it as the source description (the "what we want to build"). Do not re-ask for information that is already clear from context.

Only use the `question` tool to resolve genuine ambiguities that block decomposition — for example: conflicting requirements, an unclear target area of the codebase, or whether two related items are one feature or two. Never ask via plain text; always use the `question` tool. Skip questions entirely when the intent is already clear.

## Step 2: Decompose Into Features

Break the description into discrete, independently-implementable features. Each feature must be:
- Self-contained enough to plan and build on its own
- Scoped so its loop will not collide with sibling features where avoidable

For each feature produce a `title` (short) and a `description` (a concrete brief the architect-auto agent can plan from — name the target area, the behavior, and any constraints you already know).

If the work is genuinely a single feature, produce a one-item list. That is fine.

## Step 3: Confirm Before Launch

Show the proposed feature list (titles + one-line summaries) and a proposed group title. Use the `question` tool to confirm before launching, offering at minimum:
- "Launch as shown" — proceed with this list
- "Edit features" — revise the list first

Do not launch until the user confirms. If they choose to edit, revise and re-confirm.

## Step 4: Launch

Call `launch-group` with:
- `title`: the group title
- `features`: the confirmed array of `{ title, description }` objects

Pass the explicit `features` list (not `prd`) so the list you confirmed is exactly what runs. Only pass `maxConcurrentLoops` if the user explicitly asked to override the default.

Forge then spawns an architect-auto planning session per feature and launches a development loop for each planned feature, up to the concurrency cap. Features that cannot be planned are marked failed with a reason.

## Step 5: Report

Report the group ID, status, and feature count returned by `launch-group`. Tell the user to run `group-status` to monitor progress, `group-status <groupId>` for per-feature detail, and `group-cancel <groupId>` to stop.

$ARGUMENTS
