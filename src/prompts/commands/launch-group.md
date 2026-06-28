Launch a group of features that Forge plans and executes in parallel. The input is a **broad source of work** — not a single issue or change — such as a set of GitHub issues, Linear tickets, a milestone or label, a backlog, a PRD, or other implementation documentation. Your job is to take that source, group it into implementation-coherent features, launch a planning session for each, and let Forge auto-launch the development loops (up to the configured concurrency cap, `groupLaunch.maxConcurrentLoops`).

## Step 1: Understand the source

Read the user's request (`$ARGUMENTS`) and the surrounding conversation to identify the source they are pointing you at and any selection they implied (for example: all open issues, a range, a label, a milestone, a project or cycle). Use whatever tools are available to read it — the GitHub CLI (`gh`) for issues, the Linear MCP for tickets, or the provided text for a PRD.

Use the `question` tool only to resolve a genuine blocker (which source, or an ambiguous selection). Do not re-ask what is already clear from context, and do not demand details the source already implies.

## Step 2: Gather and decompose into features

Pull the items from the source, then turn them into implementation-coherent features. Each feature needs a short `title` and a concrete `description` the architect-auto agent can plan from (name the target area, the behavior, source references, and any constraints you already know).

- **Already-discrete items (issues / tickets):** start from one source item per feature, then look for non-trivial implementation coupling before launch. Prefer the smallest independently reviewable plan/PR. Group multiple items only when they must be changed together or would otherwise duplicate design/refactor work, conflict on a shared data model/API contract/state machine, require one migration, or create merge-conflict-heavy edits. Incidental same-file edits are not enough to group. Preserve every exact issue/ticket reference in a combined description, preferably URLs and otherwise canonical tracker identifiers, so the planner can re-fetch full context and the work stays traceable.
- **Unstructured input (a PRD or other documentation):** do not pre-split it yourself; pass it through as `prd` and let the feature-splitter agent decompose it with the same small-PR-first grouping rule.
- Do not split tightly-coupled behavior just because the source lists it as separate bullets. Do not group unrelated or merely adjacent work just to reduce loop count; grouping is only for real coupling, unavoidable sequencing, or shared architectural changes.

## Step 3: Confirm before launch

Show the proposed group title and the resolved feature list (identifiers + title + one-line summary; for a PRD, note it will be split by the splitter and grouped by overlapping implementation areas). Use the `question` tool to confirm before launching, offering at minimum:
- "Launch as shown" — proceed with this list
- "Edit selection" — revise first

Do not launch until the user confirms. If they choose to edit, revise and re-confirm.

## Step 4: Launch

Call `launch-group` with:
- `title`: the group title
- For discrete items: `features` — the confirmed array of `{ title, description }` objects
- For a PRD: `prd` — the source text

Only pass `maxConcurrentLoops` if the user explicitly asked to override the default.

Forge then spawns an architect-auto planning session per grouped feature and auto-launches a development loop for each planned feature, up to the concurrency cap. Features that cannot be planned are marked failed with a reason.

## Step 5: Report

Report the group ID, status, and feature count returned by `launch-group`. Let the user know they can ask you to check progress at any time (you will call `group-status`, or `group-status` with the group ID for per-feature detail) or to stop the group (you will call `group-cancel` with the group ID).

$ARGUMENTS
