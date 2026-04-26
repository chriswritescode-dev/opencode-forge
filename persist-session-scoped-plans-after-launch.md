# Persist Session-Scoped Plans After Launch

## Objective
Stop deleting session-scoped plans after they are launched/executed. The architect session's plan is a useful artifact: users want to re-launch with a different mode, retry after failure, inspect the plan during/after execution, and reference it in conversation. Today every execution path eagerly deletes it, destroying that context.

After this change, the session-scoped plan row in the `plans` table survives launch in all paths. Loop launches continue to copy the plan into `loop_large_fields.prompt` (the execution store), so both stores hold the content independently. Explicit user-driven deletion (API endpoint, `tui-plan-store.deletePlan`) remains intact.

## Loop Name
plan-persist

## Key Context

### Storage model
- `plans` table — `src/storage/migrations/102_create_plans.sql`
  - Mutually exclusive scoping via CHECK constraint: a row is either `session_id`-scoped or `loop_name`-scoped, never both
  - Unique on `(project_id, session_id)` and `(project_id, loop_name)`
- `loop_large_fields.prompt` — execution-time store for loop-bound plans, written by `loopService.setState`

### Existing repo API (no schema or interface changes needed)
- `src/storage/repos/plans-repo.ts:11-20` — `PlansRepo` interface
- `writeForSession`, `getForSession`, `deleteForSession` — session-scoped CRUD
- `writeForLoop`, `getForLoop`, `deleteForLoop` — loop-scoped CRUD
- `promote(projectId, sessionId, loopName)` — moves a plan from session to loop scope (will become unused after this change but is retained)

### Six deletion sites to remove
| # | File | Line | Path |
|---|------|------|------|
| 1 | `src/tools/plan-execute.ts` | 28 | `plan-execute` tool |
| 2 | `src/tools/plan-approval.ts` | 74 | Approval → "Execute here" |
| 3 | `src/tools/plan-approval.ts` | 115 | Approval → "New session" |
| 4 | `src/tools/plan-approval.ts` | 192 | Approval → "Loop" / "Loop (worktree)" |
| 5 | `src/tools/loop.ts` | 225 | `loop` tool source cleanup (`sourcePlanSessionID`) |
| 6 | `src/utils/tui-client.ts` | 187 | TUI remote client conditional DELETE |

### Paths that MUST remain intact
- `src/api/handlers/plans.ts:104-121` — explicit user-driven `handleDeleteSessionPlan` / `handleDeleteLoopPlan`
- `src/utils/tui-plan-store.ts:123-149` — `deletePlan` utility (explicit API)
- `src/storage/sweep.ts:23-41` — TTL-based cleanup of expired loop-bound plans (does NOT touch session-scoped plans)
- `plansRepo.deleteForSession` / `deleteForLoop` — keep on the repo for the explicit-delete callers above

## Decisions
1. **Keep both session and loop copies after loop launch.** Loop launches already copy the plan into `loop_large_fields.prompt` via `loopService.setState`. We stop the corresponding session-scoped delete; both stores hold the content independently.
2. **Do not change `promote()` semantics.** It is no longer called from execution paths after this change but stays on the repo for any future explicit-promotion flows. Schema CHECK constraints are not touched.
3. **Stop the TUI client's auto-delete.** `tui-client.ts:187` will no longer send DELETE after `new-session`/`loop`/`loop-worktree` execute calls. This keeps tool-layer and TUI behavior consistent.
4. **`plan-execute` becomes idempotent.** The plan is read but not deleted; calling `plan-execute` again on the same session re-launches with the same plan. Useful for retry-after-failure.
5. **Loop tool stops accepting/honoring `sourcePlanSessionID` for deletion.** The parameter (if it represents only "which session draft to delete") becomes effectively dead. We leave the parameter in the signature for now (no caller changes) but no-op the deletion. A follow-up could remove it entirely.

## Conventions
- TypeScript strict mode; existing `src/tools/*.ts` use the `tool({ description, args, execute })` factory
- Tests live in `test/` mirroring `src/` paths and use Vitest (`pnpm test` / `vitest run <path>`)
- SQL migrations in `src/storage/migrations/` are append-only — no migration needed here
- No new comments; preserve existing comments
- Use `pnpm` for any package operations

## Phases

### Phase 1 — Stop deletion in `plan-execute` tool
**File:** `src/tools/plan-execute.ts`

**Edit:** Remove the `plansRepo.deleteForSession(projectId, context.sessionID)` call at line 28. The plan should be read but the row preserved.

**Before (lines ~21-29):**
```typescript
let planText = args.plan
if (!planText) {
  const planRow = plansRepo.getForSession(projectId, context.sessionID)
  if (!planRow) {
    return 'No plan found...'
  }
  planText = planRow.content
  plansRepo.deleteForSession(projectId, context.sessionID)
}
```

**After:**
```typescript
let planText = args.plan
if (!planText) {
  const planRow = plansRepo.getForSession(projectId, context.sessionID)
  if (!planRow) {
    return 'No plan found...'
  }
  planText = planRow.content
}
```

**Acceptance criteria:**
- `plansRepo.deleteForSession` is no longer referenced in `src/tools/plan-execute.ts`
- After `plan-execute` runs, `plansRepo.getForSession(projectId, sessionID)` still returns the same plan row
- A second invocation of `plan-execute` on the same session re-reads and re-launches with the same plan

### Phase 2 — Stop deletion in plan approval flow (all four branches)
**File:** `src/tools/plan-approval.ts`

**Edits:**
1. Line ~74 ("Execute here" branch): remove `plansRepo.deleteForSession(projectId, input.sessionID)`
2. Line ~115 ("New session" branch, inside `v2.session.create(...).then(...)`): remove `plansRepo.deleteForSession(projectId, input.sessionID)`
3. Line ~181-192 ("Loop" / "Loop (worktree)" branch, inside `setupLoop(...).then(...)`): remove the `plansRepo.deleteForSession(projectId, input.sessionID)` call. The surrounding success/failure branching can be simplified — there's no longer a reason to gate behavior on `isSuccess` for plan retention (plan is always retained). Preserve any logging/return-value handling unrelated to deletion.

**Example "Loop" branch after edit:**
```typescript
setupLoop(ctx, {
  prompt: planText,
  ...
}).then((result) => {
  // No plan deletion: the session-scoped plan persists for re-launch/retry.
  // Loop execution copy lives in loop_large_fields.prompt independently.
})
```
(Existing comment preserved if present; otherwise no new comments per conventions.)

**Acceptance criteria:**
- `plansRepo.deleteForSession` is no longer referenced in `src/tools/plan-approval.ts`
- After each of the four approval paths runs, the session-scoped plan row remains in the `plans` table
- The "Loop" path still calls `setupLoop` and propagates its result/error as before

### Phase 3 — Stop source-plan deletion in `loop` tool
**File:** `src/tools/loop.ts`

**Edit:** Remove the `if (options.sourcePlanSessionID) { plansRepo.deleteForSession(projectId, options.sourcePlanSessionID) }` block at lines ~222-226 (inside `setupLoop`). Leave the `sourcePlanSessionID` field on the options type and parameter wiring untouched so existing callers still type-check; it simply has no deletion side-effect anymore.

**Before:**
```typescript
// Plan is persisted into loop_large_fields.prompt by loopService.setState below.
// Clean up the draft entry in the plans table if a sourcePlanSessionID was passed.
if (options.sourcePlanSessionID) {
  plansRepo.deleteForSession(projectId, options.sourcePlanSessionID)
}
```

**After:** Block removed entirely (including the two existing comments, since they describe the deleted behavior).

**Acceptance criteria:**
- `plansRepo.deleteForSession` is no longer referenced in `src/tools/loop.ts`
- Loop creation still writes the prompt into `loop_large_fields.prompt` via `loopService.setState`
- Calling `loop` from a session that has a session-scoped plan leaves that plan row in place

### Phase 4 — Stop TUI client auto-delete
**File:** `src/utils/tui-client.ts`

**Edit:** Remove the conditional `DELETE` request at lines ~184-189.

**Before:**
```typescript
if (req.mode === 'new-session' || req.mode === 'loop' || req.mode === 'loop-worktree') {
  try {
    await request(`${projectPath}/plans/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  } catch { /* ignore */ }
}
```

**After:** Block removed entirely.

**Acceptance criteria:**
- No `request(..., { method: 'DELETE' })` for `/plans/session/...` remains in `tui-client.ts` after a successful execute
- The explicit `plan.delete(sessionId)` method on the client (defined around line 42-58) remains and continues to send DELETE — it is the user-driven delete path

### Phase 5 — Update existing tests that assert deletion
**Files:**
- `test/plan-approval.test.ts`
- `test/plan-execute.test.ts` (if it exists; otherwise add — see Phase 6)
- `test/loop.test.ts` (only if it asserts `sourcePlanSessionID` deletion)
- Any tui-client tests under `test/` that assert the auto-DELETE call

**Edits:** For each test that currently asserts "plan row is gone after execute/approve/loop":
- Flip the assertion to "plan row still exists with the same content"
- Keep the rest of the test setup/structure intact

**Discovery step (allowed in read-only):** Use `Grep` for the patterns `deleteForSession`, `getForSession.*toBeNull`, `getForSession.*toBeUndefined`, `plan.*delete`, and the four execution mode strings to enumerate exact tests needing flips.

**Acceptance criteria:**
- All previously-passing tests continue to pass after assertion flips
- No test asserts that a plan is deleted as a side-effect of any of the six execution paths above

### Phase 6 — Add persistence-focused tests
**Files (create or extend):**
- `test/plan-execute.test.ts` — covers `plan-execute` tool
- `test/plan-approval.test.ts` — extend with persistence cases for all four approval modes
- `test/loop.test.ts` — extend with persistence after `setupLoop` with `sourcePlanSessionID`
- `test/tui-client.test.ts` (or equivalent) — assert no DELETE request is sent during `execute()` for any mode

**Test cases to add (each must actually invoke the code path):**
1. **`plan-execute` persistence:** Write a plan via `plansRepo.writeForSession`, invoke the `plan-execute` tool, then assert `plansRepo.getForSession(...)` returns the same content
2. **`plan-execute` idempotent re-launch:** Same as above, then invoke `plan-execute` again and assert it succeeds and content is unchanged
3. **Approval "Execute here" persistence:** Drive the approval handler with the "Execute here" label and assert the plan row survives
4. **Approval "New session" persistence:** Same with "New session" (mock `v2.session.create` to resolve successfully); assert plan survives in the originating session
5. **Approval "Loop" persistence (success):** Drive with "Loop", mock `setupLoop` to return success; assert plan survives in the originating session AND that `loopsRepo.getLarge(projectId, loopName).prompt` contains the plan
6. **Approval "Loop" persistence (failure):** Drive with "Loop", mock `setupLoop` to return failure; assert plan still survives (no regression — was already preserved on failure, but now also on success)
7. **`loop` tool with `sourcePlanSessionID`:** Pass a `sourcePlanSessionID` whose session has a plan; invoke `setupLoop`; assert the source plan row still exists
8. **TUI client no auto-DELETE:** Invoke `tuiClient.plan.execute(...)` with each of `new-session`, `loop`, `loop-worktree`, `execute-here`; assert no `DELETE /plans/session/...` request was made (use a request spy/mock)
9. **Explicit delete still works:** Call `plansRepo.deleteForSession` directly (or `tuiClient.plan.delete(sessionId)`) and assert the row is removed — guards against accidentally breaking the explicit-delete API

**Acceptance criteria:**
- All nine test cases above are added, each exercising the real code path (not just stubbed)
- `vitest run test/plan-execute.test.ts test/plan-approval.test.ts test/loop.test.ts` passes
- The TUI client test asserts via mock/spy that zero DELETE requests are made for the four execute modes

### Phase 7 — Type-check and grep audit
**Steps:**
1. Run `pnpm tsc --noEmit` — no new type errors
2. Run `pnpm lint` — no new lint errors
3. Grep audit: `rg "deleteForSession" src/tools src/utils` should return only:
   - `src/utils/tui-plan-store.ts` (explicit delete utility)
   - No matches in `src/tools/plan-execute.ts`, `src/tools/plan-approval.ts`, `src/tools/loop.ts`, `src/utils/tui-client.ts`
4. Grep audit: `rg "method: 'DELETE'" src/utils/tui-client.ts` should return only the explicit `plan.delete(...)` method (around lines 42-58), not the post-execute block

**Acceptance criteria:**
- All grep audits return the expected (limited) set of matches
- `pnpm tsc --noEmit` exits 0
- `pnpm lint` exits 0

## Verification

1. `pnpm tsc --noEmit` — no type errors
2. `pnpm lint` — no lint errors
3. `vitest run test/plan-execute.test.ts test/plan-approval.test.ts test/loop.test.ts` — all targeted tests pass, including the nine new persistence tests from Phase 6
4. `vitest run test/tui-client.test.ts` (or wherever TUI client tests live) — TUI auto-DELETE removal test passes
5. **File assertions:**
   - `src/tools/plan-execute.ts` no longer contains `plansRepo.deleteForSession`
   - `src/tools/plan-approval.ts` no longer contains `plansRepo.deleteForSession`
   - `src/tools/loop.ts` no longer contains `plansRepo.deleteForSession` and no longer contains the `sourcePlanSessionID` deletion block
   - `src/utils/tui-client.ts` no longer contains the `if (req.mode === 'new-session' || req.mode === 'loop' || req.mode === 'loop-worktree')` DELETE block
6. **Behavioral assertions (covered by Phase 6 tests):**
   - After any of the six execution paths runs successfully, `plansRepo.getForSession(projectId, sessionID)` returns the same plan content that existed before launch
   - `plansRepo.deleteForSession` directly invoked still removes the row (explicit-delete API intact)
   - Loop launches still populate `loop_large_fields.prompt` with the plan content
