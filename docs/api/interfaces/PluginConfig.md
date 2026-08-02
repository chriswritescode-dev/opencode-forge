[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:254](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L254)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:286](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L286)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:272](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L272)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:266](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L266)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:270](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L270)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:260](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L260)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:280](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L280)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:284](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L284)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:256](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L256)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:264](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L264)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:268](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L268)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:276](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L276)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:258](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L258)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:274](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L274)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:262](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L262)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:278](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L278)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:288](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L288)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:282](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L282)

TUI display configuration.
