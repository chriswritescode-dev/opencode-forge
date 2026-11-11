[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:261](https://github.com/chriswritescode-dev/opencode-forge/blob/32dbaf30ad58e54053f28f4c8d0419c4a62cb42c/src/types.ts#L261)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:263](https://github.com/chriswritescode-dev/opencode-forge/blob/32dbaf30ad58e54053f28f4c8d0419c4a62cb42c/src/types.ts#L263)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:265](https://github.com/chriswritescode-dev/opencode-forge/blob/32dbaf30ad58e54053f28f4c8d0419c4a62cb42c/src/types.ts#L265)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
