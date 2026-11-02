[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:250](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L250)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:252](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L252)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:254](https://github.com/chriswritescode-dev/opencode-forge/blob/7091c92b2efeea0898b3cb3c74018039cb098634/src/types.ts#L254)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
