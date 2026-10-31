[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:239](https://github.com/chriswritescode-dev/opencode-forge/blob/b7b4f751bdab75d495a91a3c62c340dbe661acdd/src/types.ts#L239)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:241](https://github.com/chriswritescode-dev/opencode-forge/blob/b7b4f751bdab75d495a91a3c62c340dbe661acdd/src/types.ts#L241)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:243](https://github.com/chriswritescode-dev/opencode-forge/blob/b7b4f751bdab75d495a91a3c62c340dbe661acdd/src/types.ts#L243)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
