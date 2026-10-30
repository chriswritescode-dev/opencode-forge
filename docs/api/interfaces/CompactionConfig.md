[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / CompactionConfig

# Interface: CompactionConfig

Defined in: [types.ts:224](https://github.com/chriswritescode-dev/opencode-forge/blob/6948a9431015c31b20e3e304995ffc9bc9082045/src/types.ts#L224)

Configuration for session compaction behavior.

## Properties

### customPrompt?

> `optional` **customPrompt?**: `boolean`

Defined in: [types.ts:226](https://github.com/chriswritescode-dev/opencode-forge/blob/6948a9431015c31b20e3e304995ffc9bc9082045/src/types.ts#L226)

Use a custom compaction prompt.

***

### maxContextTokens?

> `optional` **maxContextTokens?**: `number`

Defined in: [types.ts:228](https://github.com/chriswritescode-dev/opencode-forge/blob/6948a9431015c31b20e3e304995ffc9bc9082045/src/types.ts#L228)

Maximum context tokens for compaction. Currently unused by Forge's compaction hook, which reads only `customPrompt`.
