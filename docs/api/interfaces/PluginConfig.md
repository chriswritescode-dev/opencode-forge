[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:298](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L298)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:328](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L328)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:316](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L316)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:310](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L310)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:314](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L314)

Default reasoning/thinking variant for the auditor model.

***

### autoApprove?

> `optional` **autoApprove?**: `AutoApproveConfig`

Defined in: [types.ts:332](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L332)

Policy applied while auto-approve is on for a session.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:304](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L304)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:322](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L322)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:326](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L326)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:300](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L300)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:308](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L308)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:312](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L312)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:320](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L320)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:302](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L302)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:318](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L318)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:306](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L306)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:330](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L330)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:324](https://github.com/chriswritescode-dev/opencode-forge/blob/953bd5f934e3dc184acafb0613c1a2c6d221c1d6/src/types.ts#L324)

TUI display configuration.
