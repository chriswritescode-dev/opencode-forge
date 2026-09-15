# Dashboard

Forge includes an observability Dashboard — a standalone Bun HTTP server (`src/dashboard/`) that serves a SolidJS single-page app at `GET /` and JSON state at `GET /api/data`. Launch it from the TUI command palette (`Open dashboard`) or via `pnpm dashboard` (source checkouts only).

By default it binds loopback only. On a loopback bind it can send messages to the live loop session and edit the loop's persisted model columns; on a non-loopback bind every mutating route is disabled and the dashboard is strictly read-only. Set `dashboard.host` / `dashboard.port` in `forge-config.jsonc` to expose it on a LAN or VPN — see [Configuration → Dashboard](configuration.md#dashboard).

> **The dashboard has no authentication.** A non-loopback bind exposes every loop plan, goal, audit result, finding, and session cost to anyone who can reach the port, so it must be protected at the network layer with a firewall, a private LAN, or a VPN.

See also: [Configuration](configuration.md#dashboard), [TUI](tui.md), [Loop System](loop-system.md).

## Views

The dashboard is a **repo shell**: pick a repository, then move between its **Loops**, **Groups**, **Findings**, and **Plans** sections. The section nav sits directly beneath the app bar and the Loops-only filter bar beneath it, so switching sections never moves the nav. Loop detail opens as tabs (overview, timeline, sections, findings, plan, usage, and live while the loop is running), with live polled state on a 5 s interval. The loop header's **Plan adjusted** callout jumps to the Plan tab with the newest amendment's diff expanded and scrolled into view. The repo menu lists only repositories with at least one loop; a project discovered only from feature groups or unexecuted plans has no `projectDir` to label it with, so the repo index lists the ones that still hold unexecuted plans under a single, collapsed-by-default **Unofficial projects** section instead — one block per project, each with its unexecuted plans inline. The **Plans** section groups a repo's plans into two labeled blocks: **Unexecuted** — session-scoped plans authored by `plan-write` that no loop has executed yet, listed above the loop plans — and **Executed**, the plans of loops that have run. Selecting an unexecuted plan opens its full stored markdown, fetched on demand; on a loopback bind each unexecuted plan can also be deleted (`bun scripts/cleanup-plans.ts` bulk-purges old session plans from a source checkout).

Deep links use the hash:

| Hash | Opens |
| --- | --- |
| `#<projectId>` | The repo's Loops section |
| `#<projectId>/loops` \| `/groups` \| `/findings` \| `/plans` | That repo section |
| `#<projectId>/groups/<groupId>` | A feature group's detail view |
| `#<projectId>/loop/<loopName>[/<tab>]` | A loop, optionally on a given tab |
| `?status=running,errored&q=<text>` | Appended to any of the above to preserve filters |

`loops`, `groups`, `findings`, and `plans` are reserved as the second segment, so a loop with one of those names must be addressed as `#<projectId>/loop/<loopName>`.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | HTML page (inlined SolidJS app) |
| `GET /api/data` | JSON snapshot of Forge loop/project state. Accepts optional `project` and `loop` query parameters (`/api/data?project=<projectId>&loop=<loopName>`) to scope the payload: per-loop text (`plan`, `goal`, `lastAuditResult`, `postActionReport`, `sections`, `amendments`) is materialised only for the scoped loop, and `findings` rows, `usage`, and `transitions` only for the scoped project. `unexecutedPlans` rows ship for the scoped project and, when the payload is unscoped, for projects with no loops (the repo index's unofficial-projects section). `duration`, `hasPlan`, `sectionCount`, `bugCount`, and `unexecutedPlanCount` are always populated so the repo index, tab set, and section/bug counts render correctly while detail is in flight. |
| `GET /api/loop/stream` | Server-sent events for the live loop session |
| `POST /api/loop/message` | Send a message to the live loop session (loopback bind only) |
| `GET /api/models` | Model list for the dashboard's model pickers |
| `POST /api/loop/models` | Update the loop's persisted execution/auditor model (loopback bind only) |
| `GET /api/amendment` | Fetch a plan amendment's before/after detail |
| `GET /api/plan` | Fetch a session-scoped plan's stored content (`/api/plan?project=<projectId>&session=<sessionId>`), used by the Plans section for unexecuted plan bodies |
| `POST /api/plan/delete` | Delete an unexecuted session-scoped plan (`{projectId, sessionId}`; loopback bind only) |

All other non-GET paths return 404. Every mutating route is gated on a loopback bind.

In the browser, the loop table, repo findings list, plans list, unexecuted plans list, and loop picker cap their rendered rows behind a "Showing N of M" affordance (a "Show all" toggle expands the loop table, findings, plans, and unexecuted plans lists).
