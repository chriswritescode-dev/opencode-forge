[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:279](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L279)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:311](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L311)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:297](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L297)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:291](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L291)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:295](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L295)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:285](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L285)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:305](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L305)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:309](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L309)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:281](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L281)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:289](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L289)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:293](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L293)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:301](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L301)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:283](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L283)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:299](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L299)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:287](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L287)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:303](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L303)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:313](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L313)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:307](https://github.com/chriswritescode-dev/opencode-forge/blob/dc0dfab121ce8e8b3901dbd0f2cb4632f5f3e52c/src/types.ts#L307)

TUI display configuration.
