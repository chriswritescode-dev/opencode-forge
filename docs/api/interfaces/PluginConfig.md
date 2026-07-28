[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:230](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L230)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:260](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L260)

Per-agent configuration overrides.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:242](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L242)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:246](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L246)

Default reasoning/thinking variant for the auditor model.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:236](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L236)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:254](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L254)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dashboard?

> `optional` **dashboard?**: `DashboardConfig`

Defined in: [types.ts:258](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L258)

Dashboard HTTP server bind configuration.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:232](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L232)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:240](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L240)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:244](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L244)

Default reasoning/thinking variant for the execution model.

***

### groupLaunch?

> `optional` **groupLaunch?**: `GroupLaunchConfig`

Defined in: [types.ts:250](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L250)

Group launch configuration.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:234](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L234)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:248](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L248)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:238](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L238)

Message transformation for architect agent.

***

### remotes?

> `optional` **remotes?**: `RemoteServerConfig`[]

Defined in: [types.ts:252](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L252)

Remote opencode servers available as loop launch targets.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:262](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L262)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:256](https://github.com/chriswritescode-dev/opencode-forge/blob/01335e2b80ea22458844eeefc0db99bb749b1be5/src/types.ts#L256)

TUI display configuration.
