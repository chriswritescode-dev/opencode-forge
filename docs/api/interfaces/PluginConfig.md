[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:264](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L264)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:294](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L294)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:282](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L282)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:276](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L276)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:280](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L280)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:270](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L270)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:288](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L288)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:292](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L292)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:266](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L266)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:274](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L274)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:278](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L278)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:286](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L286)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:268](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L268)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:284](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L284)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:272](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L272)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:296](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L296)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:290](https://github.com/chriswritescode-dev/opencode-forge/blob/b08b04a0bb3be68829f56adc26d093c0909e478c/src/types.ts#L290)

TUI display configuration.
