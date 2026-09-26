[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:269](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L269)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:299](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L299)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:287](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L287)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:281](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L281)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:285](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L285)

Default reasoning/thinking variant for the auditor model.

***

### autoApprove?

> `optional` **autoApprove?**: `AutoApproveConfig`

Defined in: [types.ts:303](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L303)

Policy applied while auto-approve is on for a session.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:275](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L275)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:293](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L293)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:297](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L297)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:271](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L271)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:279](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L279)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:283](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L283)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:291](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L291)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:273](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L273)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:289](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L289)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:277](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L277)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:301](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L301)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:295](https://github.com/chriswritescode-dev/opencode-forge/blob/41c98063e503ee8e60fd795551a1110e45f428d1/src/types.ts#L295)

TUI display configuration.
