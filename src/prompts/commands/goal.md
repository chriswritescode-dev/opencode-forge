Plan a multi-chunk goal. Resolve its tasks, save the ordered goal, then plan chunk 1 so the user can launch it as a loop.

Input: $ARGUMENTS

## Step 1: Objective

The objective is the input above. If it is empty, ask the user for the objective and stop until they provide one.

## Step 2: Resolve the work

If the objective refers to tickets, issues, or tasks in a tracker (GitHub issues, Linear, Jira, or similar), or to a selection such as "tasks 1-10" or "all remaining tickets", list and read them with the tools already available in this session (for example `gh issue list` / `gh issue view`, or the tracker's MCP tools). This is strictly read-only: never comment on, assign, label, transition, close, or otherwise modify a ticket. If the tracker cannot be reached with the available tools, ask the user for the task details instead of guessing.

For an objective with no tracker, break it into an ordered list of large, coherent chunks of work.

## Step 3: Settle the route

The objective is the fixed outcome. Research the repository against the objective and resolved tasks, then settle the route with grouped `question` rounds exactly as your planning workflow's Narrow step describes, until every route decision is settled — especially decisions that span chunks, such as shared owners, data and interface shapes, conventions, and task boundaries. Later chunks are planned without you, so every route decision they depend on must be decided now. These rounds also cover chunk 1; in Step 6 ask another round only for a route decision specific to chunk 1 that this step did not settle.

## Step 4: Order the tasks

Order the tasks for execution, dependencies first. Each task becomes its own chunk (one loop per task). Combine two tickets into one task only when they cannot be implemented separately, and list both refs in that task.

## Step 5: Save the goal

Call `goal-write` with:
- `title`: a short title for the goal.
- `objective`: the objective verbatim, followed by a `Route decisions:` list of every route decision settled in Step 3.
- `tasks`: the ordered list. For each task set `ref` to the ticket identifier when one exists, `title`, and `details` to a self-contained summary of the task including its acceptance criteria and the route decisions that apply to that task.

Pass `maxChunks` only when the user asked for a limit.

## Step 6: Plan chunk 1

Plan ONLY the first task as a detailed loop plan with `plan-write` / `plan-edit`, following your normal plan schema. Name the goal and the task ref in the Objective. Do not plan later tasks — they are planned automatically after each chunk completes, against the code produced by the previous chunks.

## Step 7: Conclude

Summarize the task list and the chunk-1 plan. Tell the user that launching this plan as a Loop starts the goal: later chunks are planned and launched automatically, each on its own branch stacked on the previous chunk, reusing the same models and sandbox settings, and each chunk still runs the configured post-completion action.
