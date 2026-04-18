[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:194](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L194)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:216](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L216)

Per-agent configuration overrides.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:206](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L206)

Model to use for code auditing.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:200](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L200)

Compaction behavior configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:196](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L196)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:212](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L212)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 604800000 (7 days).

***

### defaultKvTtlMs?

> `optional` **defaultKvTtlMs?**: `number`

Defined in: [types.ts:212](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L212)

@deprecated Use `completedLoopTtlMs` instead. Default TTL for KV entries in milliseconds.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:204](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L204)

Model to use for code execution.

***

### graph?

> `optional` **graph?**: `GraphConfig`

Defined in: [types.ts:220](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L220)

Graph indexing configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:198](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L198)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:208](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L208)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:202](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L202)

Message transformation for architect agent.

***

### ~~ralph?~~

> `optional` **ralph?**: `LoopConfig`

Defined in: [types.ts:210](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L210)

#### Deprecated

Use `loop` instead

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:218](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L218)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:214](https://github.com/chriswritescode-dev/opencode-forge/blob/6db8e4a6ec8811794b8bc2667f3f22f569a5ce99/src/types.ts#L214)

TUI display configuration.
