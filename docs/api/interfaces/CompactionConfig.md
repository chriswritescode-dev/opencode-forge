[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:237](https://github.com/chriswritescode-dev/opencode-forge/blob/6b1f613c4dc439ac331661226605cc656b514c13/src/types.ts#L237)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:239](https://github.com/chriswritescode-dev/opencode-forge/blob/6b1f613c4dc439ac331661226605cc656b514c13/src/types.ts#L239)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:241](https://github.com/chriswritescode-dev/opencode-forge/blob/6b1f613c4dc439ac331661226605cc656b514c13/src/types.ts#L241)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
