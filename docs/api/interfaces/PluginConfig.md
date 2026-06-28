[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:214](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L214)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:236](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L236)

Per-agent configuration overrides.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:226](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L226)

Model to use for code auditing.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:220](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L220)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:230](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L230)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:216](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L216)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:224](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L224)

Model to use for code execution.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:218](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L218)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:228](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L228)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:222](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L222)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:238](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L238)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:232](https://github.com/chriswritescode-dev/opencode-forge/blob/7dda0a6dac066c72b6e45aff076d8e5c7e38f51f/src/types.ts#L232)

TUI display configuration.
