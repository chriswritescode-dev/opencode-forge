[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:317](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L317)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:345](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L345)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:335](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L335)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:329](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L329)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:333](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L333)

Default reasoning/thinking variant for the auditor model.

***

### autoApprove?

> `optional` **autoApprove?**: `AutoApproveConfig`

Defined in: [types.ts:351](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L351)

Policy applied while auto-approve is on for a session.

***

### codeGraph?

> `optional` **codeGraph?**: `CodeGraphConfig`

Defined in: [types.ts:349](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L349)

Code-graph (`codegraph`) installation and loop integration.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:323](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L323)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:339](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L339)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:343](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L343)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:319](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L319)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:327](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L327)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:331](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L331)

Default reasoning/thinking variant for the execution model.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:321](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L321)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:337](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L337)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:325](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L325)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:347](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L347)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:341](https://github.com/chriswritescode-dev/opencode-forge/blob/7b6d10be8be1268ffede2ca2882ec310ee23deb8/src/types.ts#L341)

TUI display configuration.
