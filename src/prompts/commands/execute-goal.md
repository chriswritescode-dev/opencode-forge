## Step 1: Validate the Goal

Resolve the goal from `$ARGUMENTS` and the surrounding conversation. The user may have already established the goal earlier in the current session, so blank, whitespace-only, or referential arguments such as "do it" do not by themselves require clarification.

If you are unsure what the goal is, or if its scope is ambiguous in a way that could materially change the implementation, use the `question` tool to ask a focused clarifying question and stop until the user answers. Do not guess consequential requirements or scope. Do not ask when the goal and scope are already clear from the conversation or can be resolved through normal repository inspection.

Turn the resolved goal into a self-contained implementation request. Include the relevant requirements, constraints, file or issue references, and acceptance criteria already established in the conversation, but do not invent details or include unrelated context. When newer instructions conflict with earlier ones, follow the user's latest explicit instruction.

Do NOT create a plan, decompose the goal into sections, or ask for approval. The goal is implemented directly by the loop.

## Step 2: Start the Goal Loop

Call the `execute-goal` tool with the full, self-contained goal text:
- goal: Required. The complete resolved goal, not necessarily the literal `$ARGUMENTS`. The new dedicated session does not inherit this conversation, so expand blank or referential arguments with the necessary context established above.
- title: Optional short title. Derived from the goal when omitted.
- loopName: Optional loop name. Forge slugifies it and auto-increments on collision.
- maxIterations: Optional maximum loop iterations. Defaults to the plugin config `loop.defaultMaxIterations`.

This creates an isolated Forge worktree and a new dedicated code session inside it, sends the goal as that session's initial prompt, and starts the watchdog. Docker sandboxing is used automatically when configured and available.

## Step 3: You Are Done

The new session implements the goal — NOT this session. Do not edit files, run builds, or attempt the goal here. Just confirm to the user that the goal loop has been launched.

The loop automatically audits the work when the session goes idle and rotates in fresh code sessions until an auditor pass leaves zero open findings, which completes the loop.

Use `loop-status` to inspect progress or `loop-cancel` to stop early. Both work for goal loops exactly as they do for plan loops.

$ARGUMENTS
