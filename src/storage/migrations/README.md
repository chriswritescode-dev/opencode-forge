# Storage Migrations

This directory contains SQL migrations for the Forge storage schema. The canonical, ordered registration of every migration (and the runtime logic that decides whether each one needs to run) lives in [`index.ts`](./index.ts); this README intentionally avoids duplicating that list so it cannot go stale.

## Evolution Rules

1. **Scalar fields → columns**: When a field becomes frequently accessed or filtered, promote it from JSON blobs to a dedicated column.
2. **No new JSON blob columns**: New tables should have explicit columns for queryable fields. JSON is only used for opaque payloads that are never filtered (e.g., `data` in `tui_preferences`).
3. **Add fields when needed, not speculatively**: Add columns only when a use case requires them. Avoid preemptive denormalization.
4. **Foreign keys with cascade**: Use FK constraints with `ON DELETE CASCADE` to ensure cleanup propagates correctly.
5. **Indexes for query patterns**: Add indexes matching actual query patterns (loop-scoped, status-scoped, etc.).

## Migration ID Scheme

Migrations are numbered three-digit SQL files, applied in lexicographic order. New migrations append at the next free number. To check the current head, list files in this directory or read `MIGRATIONS` in `index.ts`.

## Adding a Migration

1. Create `NNN_short_name.sql` in this directory with the schema change.
2. Append a new entry to the `MIGRATIONS` array in `index.ts` with a matching id, description, and runner.
3. The runner is expected to be idempotent (check columns/tables before applying) so re-runs are safe.
4. Update any affected repository in `src/storage/repos/` and add a test if behavior changes.
