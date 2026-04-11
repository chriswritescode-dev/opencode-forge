export const LOOP_PERMISSION_RULESET = [
  { permission: '*', pattern: '*', action: 'allow' as const },
  { permission: 'external_directory', pattern: '*', action: 'deny' as const },
  { permission: 'bash', pattern: 'git push *', action: 'deny' as const },
]
