[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:278](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L278)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:310](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L310)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:296](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L296)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:290](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L290)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:294](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L294)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:284](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L284)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:304](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L304)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:308](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L308)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:280](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L280)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:288](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L288)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:292](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L292)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:300](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L300)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:282](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L282)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:298](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L298)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:286](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L286)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:302](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L302)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:312](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L312)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:306](https://github.com/chriswritescode-dev/opencode-forge/blob/53f50fe5eb66473d6a437eb28c168c9033d7a9c5/src/types.ts#L306)

TUI display configuration.
