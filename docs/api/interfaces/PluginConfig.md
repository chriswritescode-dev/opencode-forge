[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:255](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L255)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:287](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L287)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:273](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L273)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:267](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L267)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:271](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L271)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:261](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L261)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:281](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L281)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:285](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L285)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:257](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L257)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:265](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L265)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:269](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L269)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:277](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L277)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:259](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L259)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:275](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L275)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:263](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L263)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:279](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L279)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:289](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L289)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:283](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L283)

TUI display configuration.
