# Agent Guidelines

## Log File Location

The forge plugin writes logs to:

```
~/.local/share/opencode/forge/logs/forge.log
```

This path can be overridden via the `logging.file` configuration option in `forge-config.jsonc`.

## Project Conventions

- All commits must be meaningful and follow conventional commit standards
- No emojis in commit messages
- Always check for existing patterns before adding new code
- Functions should be single responsibility and reusable
- Remove dead code to keep the codebase clean

## Code Intelligence

Forge bundles the upstream ast-grep skill and uses `@ast-grep/cli` for AST-aware code intelligence. Agents should use the CLI directly for common structural search, and can load the `ast-grep` skill when deeper rule-writing guidance is needed.
