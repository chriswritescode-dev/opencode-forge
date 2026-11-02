# Dashboard

Forge's dashboard is a full-screen TUI surface for watching loops, findings, and plans across every project that has Forge data. It is one of the TUI's own routes, not a service: there is no bind address, no HTTP endpoints, no separate process, no browser surface, and no LAN exposure.

Every value comes from the Forge server plugin over the TUI's `FORGE_RPC` contract: `dashboardSummary`, `loopDetail`, `projectFindings`, `amendmentDiff`, `sessionPlan` (with the project id, when reading another project's stored plan), and `planDelete`. The TUI holds no Forge database, so the dashboard also works when the TUI is attached to a remote OpenCode server running Forge.

## Opening the dashboard

Run `Open dashboard` from the command palette (group **Forge**; description "Open the Forge dashboard: loops, findings and plans across all projects"), or use the optional `tui.keybinds.dashboard` binding when one is configured. That binding has no default: when it is empty the command is registered without a shortcut.

Opening records the current TUI route, and when the current session's directory resolves to a project, pre-selects that project. `esc` at the top level — with nothing open or selected — returns to the recorded route.

## Views

Long lists stay bounded: Loops and each Plans block render at most 200 rows, and Findings at most 300, with a "narrow the search to see more" hint when a list is cut off. There is no show-all toggle; search and the status filter are how a list is narrowed.

### Project list

The first view lists one row per project with Forge data: the union of loop projects and projects with unexecuted plans. A row shows the shortest path label that is unique among projects, the running-loop count, the loop, unexecuted-plan, and bug counts, and the project directory (or the project id when it has no directory).

`/` focuses the search. It matches project paths and labels, loop names and branches, and unexecuted plan titles. A project whose own path or label matches keeps all of its rows; otherwise only its matching loops and plans are kept, and a project with nothing left drops out.

`enter` on a project opens its three sections, each with a count that matches the rows the section lists after the current search: **Loops** counts the matching loops, and **Plans** the matching unexecuted plans plus the matching loops that have a plan. **Findings** shows the project's bug count as `Findings (N bugs)`, because the section body lists bugs and warnings from the on-demand findings read, which may not be loaded yet.

### Loops

Each row shows the loop status, name, current phase (`—` once the loop has completed), an iteration meter, a 1-based section meter (`—` when the loop has no sections), the bug count, cost, duration, and last activity.

- `s` cycles the sort: recent (server order), cost, duration, findings (bug count).
- `f` cycles the status filter: all, running, completed, cancelled, errored, stalled.

### Findings

Findings are grouped per loop in the server's summary order. Each group is headed by the loop name and its finding count, and each finding shows its file and line, description, and scenario when one was recorded. Bugs render `✖`, warnings render `▲`; loops without findings are omitted. `enter` on a group opens that loop.

### Plans

The Plans section lists unexecuted session-scoped plans authored by `plan-write` first, each with its title, age, and character count, followed by executed plans — the loops that have a plan. `enter` on an unexecuted plan shows its stored markdown, fetched on demand. `enter` on an executed plan opens that loop on its Plan tab. Deleting an unexecuted plan is covered under [Deleting plans](#deleting-plans).

### Loop page

`enter` on a loop opens its page. The header shows the status, name, current phase while the loop runs, duration, cost, iteration and section meters (the section meter's label and fill both use the 1-based section number), bug and warning counts, the execution and auditor models (the auditor appends its fallback index when it is non-zero), branch, sandbox on/off, audit and error counts, and any termination reason.

The tabs are Overview, Timeline, Sections (only when the loop has sections), Findings, Plan (only when the loop has a plan), and Usage.

- **Overview:** a phase bar and legend with each phase's duration and percentage, a plan-adjusted callout when the loop's plan was amended, the post-action report (falling back to the completion summary), and the last audit result.
- **Timeline:** a text state-machine diagram of coding → auditing → post_action with per-edge traversal counts and the current phase highlighted while the loop runs, the phase bar and legend, the most recent transitions, and a merged timeline of transitions and plan amendments.
- **Sections:** the section list with each section's status, an `adjusted` marker when the plan changed it, duration, and attempt count; `enter` expands its captured done/deviations/follow-ups and stored section plan.
- **Findings:** the current findings grouped by section, with severity.
- **Plan:** the stored plan markdown and its amendments; `j`/`k` selects an amendment, `enter` loads and expands its before/after diff.
- **Usage:** totals (cost, tokens, message count), then role-split bars, token-composition bars, and cost-by-model bars.

## Key bindings

Dashboard page:

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move the selection |
| `enter` | Open the selected row |
| `/` | Focus the search |
| `esc` | Blur the search, else close an open plan, else deselect the project, else return to the previous route |
| `tab` / `shift+tab` | Cycle sections |
| `1`-`3` | Jump to Loops, Findings, Plans |
| `s` | Cycle the sort (Loops only) |
| `f` | Cycle the status filter (Loops only) |
| `d` | Delete the selected unexecuted plan (Plans only) |
| `r` | Refresh everything the current page shows |

While the search is focused, the move, open, section, sort, filter, delete, and refresh keys are disabled; `esc` blurs the search.

Loop page:

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Cycle tabs |
| `↑` / `↓` | Scroll one line |
| `pgup` / `pgdn` | Scroll one viewport |
| `j` / `k` | Move the selection in Sections and Plan |
| `enter` | Toggle a section's details or an amendment diff |
| `r` | Refresh everything the current page shows |
| `esc` | Return to the dashboard |

## Live updates

The dashboard never polls. It refetches when the server pushes `loopsChanged` or `plansChanged` for a project, and re-reads everything after the event stream reconnects. While no dashboard page is mounted, those pushes only mark cached state stale, so a closed dashboard never fetches.

Those events come only from Forge plugin instances loaded in the same OpenCode server process. A change written by another OpenCode process that shares the same Forge database is not pushed: it appears after reopening the dashboard or after pressing `r`, which refreshes everything the current page shows.

## Deleting plans

Only unexecuted session-scoped plans can be deleted, from the Plans section with `d`. The TUI opens the plan, asks for confirmation naming it and stating that the deletion cannot be undone, then sends `planDelete`. A cancelled or failed delete leaves the plan open (a failure also shows an error toast); a successful delete closes it and refreshes the summary. Executed plans have no delete action.

## Removed: the former standalone dashboard

Forge previously shipped the dashboard as a separate standalone server. That server, its separate start script, its HTTP endpoints, and the `dashboard` config block (`dashboard.host` / `dashboard.port`) are gone; the dashboard exists only as the TUI surface described above. A leftover `dashboard` key in `forge-config.jsonc` is ignored rather than rejected, because the config loader does not validate unknown top-level keys.

See also: [Configuration → TUI](configuration.md#tui), [TUI](tui.md), [Loop System](loop-system.md).
