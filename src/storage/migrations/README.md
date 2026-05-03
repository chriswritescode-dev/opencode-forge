# Storage Migrations

This directory contains SQL migrations for the Forge storage schema.

## Evolution Rules

1. **Scalar fields → columns**: When a field becomes frequently accessed or filtered, promote it from JSON blobs to a dedicated column.
2. **No new JSON blob columns**: New tables should have explicit columns for queryable fields. JSON is only used for opaque payloads that are never filtered (e.g., `data` in `tui_preferences`).
3. **Add fields when needed, not speculatively**: Add columns only when a use case requires them. Avoid preemptive denormalization.
4. **Foreign keys with cascade**: Use FK constraints with `ON DELETE CASCADE` to ensure cleanup propagates correctly.
5. **Indexes for query patterns**: Add indexes matching actual query patterns (branch-scoped, status-scoped, etc.).

## Migration ID Scheme

- Existing migrations: `001` (legacy schema)
- New typed tables: `100`–`103` (Phase 1 of storage-repos overhaul)
- Cleanup migrations: `105+` (e.g., dropping legacy tables)

## Migrations

- `100_create_loops.sql`: Typed `loops` table replacing `loop:*` KV keys
- `101_create_loop_large_fields.sql`: Sibling table for large text fields (`prompt`, `last_audit_result`)
- `102_create_plans.sql`: Plans table supporting both session-staged and loop-bound plans
- `103_create_review_findings.sql`: Write-once review findings with branch field
- `105_create_tui_preferences.sql`: TUI preferences table for recent models and execution preferences
- `106_drop_project_kv.sql`: Drops legacy `project_kv` table

## Breaking Changes

### v0.2.0 — KV → Typed Repos

Migration 106 drops the `project_kv` table. All data in the KV store is lost on upgrade. This is intentional — the typed schema replaces JSON-blob storage with real SQL schema and indexes. See release notes for details.
