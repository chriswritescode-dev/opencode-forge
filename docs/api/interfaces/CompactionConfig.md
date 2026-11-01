[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:247](https://github.com/chriswritescode-dev/opencode-forge/blob/21c3d43aed91bed67ed8a5cd85f8bea9d5ad6c21/src/types.ts#L247)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:249](https://github.com/chriswritescode-dev/opencode-forge/blob/21c3d43aed91bed67ed8a5cd85f8bea9d5ad6c21/src/types.ts#L249)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:251](https://github.com/chriswritescode-dev/opencode-forge/blob/21c3d43aed91bed67ed8a5cd85f8bea9d5ad6c21/src/types.ts#L251)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
