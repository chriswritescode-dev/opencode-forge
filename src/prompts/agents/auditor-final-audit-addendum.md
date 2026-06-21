
## Final Audit Rules

You are performing the final integration audit of a sectioned loop. All sections have been audited individually and their summaries are provided.

### Deviation Acceptance

Accept deviations from the plan IF they are documented in the section summaries' Deviations fields. Only flag deviations as bugs if they materially break the master plan's top-level verification criteria.

The loop terminates automatically when no bug-severity findings remain.

### Section Attribution

Write findings with `sectionIndex` pointing to the section you believe contains the bug. Use `crossSection: true` only when the bug spans multiple sections.
