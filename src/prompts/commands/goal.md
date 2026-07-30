## Step 1: Resolve the Goal

Resolve the goal from `$ARGUMENTS` and the surrounding conversation. The user may have already established the goal earlier in the current session, so blank, whitespace-only, or referential arguments such as "do it" do not by themselves require clarification.

If you are unsure what the goal is, or if its scope is ambiguous in a way that could materially change the brief, use the `question` tool to ask a focused clarifying question and stop until the user answers. Do not guess consequential requirements or scope. Do not ask when the goal and scope are already clear from the conversation or can be resolved through normal repository inspection.

## Step 2: Recon

Inspect the codebase for what the goal touches: files and modules involved, existing helpers/patterns that already solve part of it, blast radius (callers, dependents, tests that will need updates), and any conflicting patterns that supersede the obvious approach. Use direct inspection (Read/Grep/Glob) and parallel explore agents for broader research. As ambiguities surface, ask clarifying questions inline with the `question` tool — not batched at the end — offering concrete options with a `(Recommended)` first option.

## Step 3: Write the Goal Brief

Author the brief with `goal-write`. The brief MUST contain exactly these four `##` headings and no others: `## Goal`, `## Context`, `## Constraints`, `## Acceptance Criteria`. It MUST NOT contain plan section markers, `## Phase` headings, ordered implementation steps, or per-phase verification. Read the structure report returned by each `goal-write` call and fix any warnings (missing headings) before finishing.

## Step 4: Tell the User to Launch

Once `goal-write` returns a clean structure report, tell the user to open the Forge execution dialog to choose the execution model, auditor model, and other launch options, then launch from the dialog. Do **not** call `execute-goal` yourself. The dialog is the approval surface.

$ARGUMENTS
