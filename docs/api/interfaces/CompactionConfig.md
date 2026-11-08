[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:252](https://github.com/chriswritescode-dev/opencode-forge/blob/5559adfab8ced7f228f5b9ea29c2f7022e65ce01/src/types.ts#L252)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:254](https://github.com/chriswritescode-dev/opencode-forge/blob/5559adfab8ced7f228f5b9ea29c2f7022e65ce01/src/types.ts#L254)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:256](https://github.com/chriswritescode-dev/opencode-forge/blob/5559adfab8ced7f228f5b9ea29c2f7022e65ce01/src/types.ts#L256)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
