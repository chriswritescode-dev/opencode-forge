[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:223](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L223)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:255](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L255)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: `string`[]

Defined in: [types.ts:241](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L241)

Ordered "provider/model" entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop; variants are **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:235](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L235)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:239](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L239)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:229](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L229)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:249](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L249)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: [`DashboardConfig`](DashboardConfig.md)

Defined in: [types.ts:253](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L253)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:225](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L225)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:233](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L233)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:237](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L237)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:245](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L245)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:227](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L227)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:243](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L243)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:231](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L231)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:247](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L247)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:257](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L257)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:251](https://github.com/chriswritescode-dev/opencode-forge/blob/69298c7174999585054d057751054e338fb60412/src/types.ts#L251)

TUI display configuration.
