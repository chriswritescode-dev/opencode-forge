[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:306](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L306)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:334](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L334)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:324](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L324)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:318](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L318)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:322](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L322)

Default reasoning/thinking variant for the auditor model.

***

### autoApprove?

> `optional` **autoApprove?**: `AutoApproveConfig`

Defined in: [types.ts:338](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L338)

Policy applied while auto-approve is on for a session.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:312](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L312)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:328](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L328)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:332](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L332)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:308](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L308)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:316](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L316)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:320](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L320)

Default reasoning/thinking variant for the execution model.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:310](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L310)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:326](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L326)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:314](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L314)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:336](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L336)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:330](https://github.com/chriswritescode-dev/opencode-forge/blob/08c36050c2048fca972f428740ce1914ed6a7c10/src/types.ts#L330)

TUI display configuration.
