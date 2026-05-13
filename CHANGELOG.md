# Changelog

## Next

### Changed

- Replaced custom `forge-worktree` workspace adapter with opencode's builtin `worktree` workspace type to fix red-dot/disconnected status in the TUI. Old `forge-worktree` workspace rows in the local DB must be deleted manually.
- Renamed auto-generated git branches to `opencode/<loopName>` (with `-2`, `-3`, ... suffixes on conflict) at loop completion for better discoverability.
