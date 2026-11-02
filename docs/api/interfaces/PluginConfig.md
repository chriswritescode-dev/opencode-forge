[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / PluginConfig

# Interface: PluginConfig

Defined in: [types.ts:303](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L303)

Complete plugin configuration for opencode-forge.

## Properties

### agents?

> `optional` **agents?**: `Record`\<`string`, `AgentOverrideConfig`\>

Defined in: [types.ts:329](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L329)

Per-agent configuration overrides.

***

### auditorFallbackModels?

> `optional` **auditorFallbackModels?**: (`string` \| `AuditorFallbackModel`)[]

Defined in: [types.ts:321](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L321)

Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries.

***

### auditorModel?

> `optional` **auditorModel?**: `string`

Defined in: [types.ts:315](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L315)

Model to use for code auditing.

***

### auditorVariant?

> `optional` **auditorVariant?**: `string`

Defined in: [types.ts:319](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L319)

Default reasoning/thinking variant for the auditor model.

***

### autoApprove?

> `optional` **autoApprove?**: `AutoApproveConfig`

Defined in: [types.ts:335](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L335)

Policy applied while auto-approve is on for a session.

***

### codeGraph?

> `optional` **codeGraph?**: `CodeGraphConfig`

Defined in: [types.ts:333](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L333)

Code-graph (`codegraph`) installation and loop integration.

***

### compaction?

> `optional` **compaction?**: [`CompactionConfig`](CompactionConfig.md)

Defined in: [types.ts:309](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L309)

Compaction behavior configuration.

***

### completedLoopTtlMs?

> `optional` **completedLoopTtlMs?**: `number`

Defined in: [types.ts:325](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L325)

TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days.

***

### dataDir?

> `optional` **dataDir?**: `string`

Defined in: [types.ts:305](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L305)

Custom data directory for plugin storage. Defaults to platform data dir.

***

### executionModel?

> `optional` **executionModel?**: `string`

Defined in: [types.ts:313](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L313)

Model to use for code execution.

***

### executionVariant?

> `optional` **executionVariant?**: `string`

Defined in: [types.ts:317](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L317)

Default reasoning/thinking variant for the execution model.

***

### logging?

> `optional` **logging?**: `LoggingConfig`

Defined in: [types.ts:307](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L307)

Logging configuration.

***

### loop?

> `optional` **loop?**: `LoopConfig`

Defined in: [types.ts:323](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L323)

Loop behavior configuration.

***

### messagesTransform?

> `optional` **messagesTransform?**: `MessagesTransformConfig`

Defined in: [types.ts:311](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L311)

Message transformation for architect agent.

***

### sandbox?

> `optional` **sandbox?**: `SandboxConfig`

Defined in: [types.ts:331](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L331)

Sandbox execution configuration.

***

### tui?

> `optional` **tui?**: `TuiConfig`

Defined in: [types.ts:327](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L327)

TUI display configuration.
