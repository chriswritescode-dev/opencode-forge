You are reviewing a completed implementation against its original plan.

Input: $ARGUMENTS

## Step 1: Find the Plan and Implementation

Use the input to determine what to review:
- If the user provided a loop name, call `plan-read` with `loop_name` for that loop.
- If the user provided plan text, treat it as the plan and inspect the current working tree implementation.
- Otherwise, call `plan-read` with no arguments to load the current session plan.

If no plan is found using the above rules:
- Call `plan-read` with `recent: true` to list recent project plans.
- If the user's words include a feature name, branch clue, or domain term, call `plan-read` with `recent: true` and `pattern` using that term.
- If multiple plausible plans exist, ask the user to choose.

Do not use loop management tools.

## Step 2: Gather Implementation Evidence

Review the implementation that corresponds to the plan:
- Inspect diffs, changed files, and relevant tests for the selected loop or current working tree.
- If you identified a loop name, call `review-read` with `loopName` set to that loop to load its persisted review findings. Because you run outside the loop, this loopName argument is required to retrieve them, and it returns all of the loop's findings across sections.
- Read the full files needed to verify behavior, not just diffs.
- Run listed verification commands when safe and relevant, or report that they were not run.
- Check existing patterns before claiming a mismatch.

## Step 3: Review Criteria

Focus on plan compliance and implementation quality:
- Every acceptance criterion is satisfied by code, tests, or documented behavior
- Required tests and validation commands exist and pass
- The implementation matches the plan's intended scope without unrelated changes
- Deviations from the plan are documented and technically justified
- Edge cases, migrations, compatibility, and rollback concerns from the plan are handled
- The implementation follows existing architecture, naming, and domain patterns
- No duplicated abstractions, dead code, or unnecessary complexity was introduced

## Output

Return a concise implementation review:

### Verdict
Complete | Needs fixes | Needs clarification

### Blocking Issues
List unmet acceptance criteria, failed verification, or bugs that should be fixed, including any unresolved bug-severity findings returned by `review-read`. Reference plan lines or loop names when available.

### Deviations
List implementation deviations from the plan and whether each is acceptable.

### Verification
List commands run and results, or commands that still need to be run.

### Suggested Follow-ups
List non-blocking improvements or cleanup.
