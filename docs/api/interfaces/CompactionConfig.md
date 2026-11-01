[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:250](https://github.com/chriswritescode-dev/opencode-forge/blob/4f1a2d390bd7a762845ffdeb60c36117a896e5b1/src/types.ts#L250)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:252](https://github.com/chriswritescode-dev/opencode-forge/blob/4f1a2d390bd7a762845ffdeb60c36117a896e5b1/src/types.ts#L252)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:254](https://github.com/chriswritescode-dev/opencode-forge/blob/4f1a2d390bd7a762845ffdeb60c36117a896e5b1/src/types.ts#L254)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
