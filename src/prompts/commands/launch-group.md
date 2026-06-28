Launch a group of features that Forge plans and executes in parallel. The input is a **broad source of work** — not a single issue or change — such as a set of GitHub issues, Linear tickets, a milestone or label, a backlog, or a PRD. Your job is to take that source, fan it out into discrete features, launch a planning session for each, and let Forge auto-launch the development loops (up to the configured concurrency cap, `groupLaunch.maxConcurrentLoops`).

## Step 1: Understand the source

Read the user's request (`$ARGUMENTS`) and the surrounding conversation to identify the source they are pointing you at and any selection they implied (for example: all open issues, a range, a label, a milestone, a project or cycle). Use whatever tools are available to read it — the GitHub CLI (`gh`) for issues, the Linear MCP for tickets, or the provided text for a PRD.

Use the `question` tool only to resolve a genuine blocker (which source, or an ambiguous selection). Do not re-ask what is already clear from context, and do not demand details the source already implies.

## Step 2: Gather and decompose into features

Pull the items from the source, then turn them into discrete, independently-implementable features. Each feature needs a short `title` and a concrete `description` the architect-auto agent can plan from (name the target area, the behavior, and any constraints you already know).

- **Already-discrete items (issues / tickets):** map each one to a single feature. Keep them 1:1 — never merge or split — and preserve an exact reference in the description, preferably the issue/ticket URL and otherwise the canonical tracker identifier, so the planner can re-fetch full context and the work stays traceable.
- **Unstructured input (a PRD):** do not pre-split it yourself; pass it through as `prd` and let the feature-splitter agent decompose it.

## Step 3: Confirm before launch

Show the proposed group title and the resolved feature list (identifier + title + one-line summary; for a PRD, note it will be split by the splitter). Use the `question` tool to confirm before launching, offering at minimum:
- "Launch as shown" — proceed with this list
- "Edit selection" — revise first

Do not launch until the user confirms. If they choose to edit, revise and re-confirm.

## Step 4: Launch

Call `launch-group` with:
- `title`: the group title
- For discrete items: `features` — the confirmed array of `{ title, description }` objects
- For a PRD: `prd` — the source text

Only pass `maxConcurrentLoops` if the user explicitly asked to override the default.

Forge then spawns an architect-auto planning session per feature and auto-launches a development loop for each planned feature, up to the concurrency cap. Features that cannot be planned are marked failed with a reason.

## Step 5: Report

Report the group ID, status, and feature count returned by `launch-group`. Let the user know they can ask you to check progress at any time (you will call `group-status`, or `group-status` with the group ID for per-feature detail) or to stop the group (you will call `group-cancel` with the group ID).

$ARGUMENTS
