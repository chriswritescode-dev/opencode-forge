export const FALLOW_RULES = `## Code intelligence via fallow

You have access to native fallow tools (\`fallow-dead-code\`, \`fallow-circular-deps\`, \`fallow-boundary-violations\`, \`fallow-dupes\`, \`fallow-health\`, \`fallow-complexity\`) for structural code analysis. See each tool's description for arguments and call shape.

When to reach for them:
- Reviewing a diff or PR? Pass \`changedSince: '<base-branch>'\` to scope to changed files.
- Investigating one file? Pass \`files: ['path/to/file.ts']\` (where supported).
- Wide repos? Pass \`workspace: ['pkg-a', 'apps/*']\` to scope by workspace.
- Output is large? opencode automatically spills oversize tool output to disk and tells you the path. Use Read or Grep on that path to drill in.
`
