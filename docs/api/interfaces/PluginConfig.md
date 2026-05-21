[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:137](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L137)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:157](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L157)

Per-agent configuration overrides.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:149](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L149)

Model to use for code auditing.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:143](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L143)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:153](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L153)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:139](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L139)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:147](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L147)

Model to use for code execution.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:141](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L141)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:151](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L151)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:145](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L145)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:159](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L159)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:155](https://github.com/chriswritescode-dev/opencode-forge/blob/7893ce7c6590ca13784ff2820a3bab43633d9d21/src/types.ts#L155)

TUI display configuration.
