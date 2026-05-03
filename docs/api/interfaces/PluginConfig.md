[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:127](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L127)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:149](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L149)

Per-agent configuration overrides.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:139](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L139)

Model to use for code auditing.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:133](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L133)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:145](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L145)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:129](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L129)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:137](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L137)

Model to use for code execution.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:131](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L131)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:141](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L141)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:135](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L135)

Message transformation for architect agent.

***

### ~~ralph?~~

> `optional` **ralph?**: `LoopConfig`

Defined in: [types.ts:143](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L143)

#### Deprecated

Use `loop` instead

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:151](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L151)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:147](https://github.com/chriswritescode-dev/opencode-forge/blob/d13f4095482848cf49abc4527575a6abdb330424/src/types.ts#L147)

TUI display configuration.
