[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:235](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L235)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:267](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L267)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:253](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L253)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:247](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L247)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:251](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L251)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:241](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L241)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:261](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L261)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:265](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L265)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:237](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L237)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:245](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L245)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:249](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L249)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:257](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L257)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:239](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L239)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:255](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L255)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:243](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L243)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:259](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L259)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:269](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L269)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:263](https://github.com/chriswritescode-dev/opencode-forge/blob/79dcf380c47722522908f4164395a5204e7b1330/src/types.ts#L263)

TUI display configuration.
