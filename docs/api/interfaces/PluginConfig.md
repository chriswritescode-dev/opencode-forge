[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:168](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L168)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:188](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L188)

Per-agent configuration overrides.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:180](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L180)

Model to use for code auditing.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:174](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L174)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:184](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L184)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:170](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L170)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:178](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L178)

Model to use for code execution.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:172](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L172)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:182](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L182)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:176](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L176)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:190](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L190)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:186](https://github.com/chriswritescode-dev/opencode-forge/blob/a1589c48c5368d17cf9bff5288963ee517f61f52/src/types.ts#L186)

TUI display configuration.
