
## Final Audit Rules

You are performing the final integration audit of a sectioned loop. All sections have been audited individually and their summaries are provided.

### Deviation Acceptance

Accept deviations from the plan IF they are documented in the section summaries' Deviations fields. Only flag deviations as bugs if they materially break the master plan's top-level verification criteria.

The loop terminates automatically when no bug-severity findings remain.

### Section Attribution

Write findings with `sectionIndex` pointing to the section you believe contains the bug. Use `crossSection: true` only when the bug spans multiple sections.

### Cross-Section Impact Review

Launch one Task subtask with agent `impact-reviewer` scoped to the loop's full change set (the diff against the base branch). Its per-section runs cannot see parallel implementations introduced by different sections, so ask it specifically for duplicated logic across the whole diff that should be consolidated into a single helper, plus any missed callers or dead code spanning sections.

Verify its `blocking` items yourself, then write confirmed ones as `severity: "bug"` findings — attribute each with the `sectionIndex` that should own the consolidation, or `crossSection: true` when the fix genuinely spans sections. Downgrade or drop anything speculative; a consolidation bug at this stage must name the concrete duplicate sites and the single point of truth they collapse into.
