Plan a multi-chunk goal. Resolve its tasks, save the ordered goal, then plan chunk 1 so the user can launch it as a loop.

Input: $ARGUMENTS

## Step 1: Objective

The objective is the input above. If it is empty, ask the user for the objective and stop until they provide one.

## Step 2: Resolve the work

If the objective refers to tickets, issues, or tasks in a tracker (GitHub issues, Linear, Jira, or similar), or to a selection such as "tasks 1-10" or "all remaining tickets", list and read them with the tools already available in this session (for example `gh issue list` / `gh issue view`, or the tracker's MCP tools). This is strictly read-only: never comment on, assign, label, transition, close, or otherwise modify a ticket. If the tracker cannot be reached with the available tools, ask the user for the task details instead of guessing.

For an objective with no tracker, break it into an ordered list of large, coherent chunks of work.

## Step 3: Order the tasks

Order the tasks for execution, dependencies first. Each task becomes its own chunk (one loop per task). Combine two tickets into one task only when they cannot be implemented separately, and list both refs in that task.

## Step 4: Save the goal

Call `goal-write` with:
- `title`: a short title for the goal.
- `objective`: the objective verbatim, plus any scope you clarified with the user.
- `tasks`: the ordered list. For each task set `ref` to the ticket identifier when one exists, `title`, and `details` to a self-contained summary of the task including its acceptance criteria.

Pass `maxChunks` only when the user asked for a limit.

## Step 5: Plan chunk 1

Plan ONLY the first task as a detailed loop plan with `plan-write` / `plan-edit`, following your normal plan schema. Name the goal and the task ref in the Objective. Do not plan later tasks — they are planned automatically after each chunk completes, against the code produced by the previous chunks.

## Step 6: Conclude

Summarize the task list and the chunk-1 plan. Tell the user that launching this plan as a Loop starts the goal: later chunks are planned and launched automatically, each on its own branch stacked on the previous chunk, reusing the same models and sandbox settings, and each chunk still runs the configured post-completion action.
