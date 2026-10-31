[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:239](https://github.com/chriswritescode-dev/opencode-forge/blob/cef628ccd725937d70add57582faba532e9ba1d8/src/types.ts#L239)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:241](https://github.com/chriswritescode-dev/opencode-forge/blob/cef628ccd725937d70add57582faba532e9ba1d8/src/types.ts#L241)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:243](https://github.com/chriswritescode-dev/opencode-forge/blob/cef628ccd725937d70add57582faba532e9ba1d8/src/types.ts#L243)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
