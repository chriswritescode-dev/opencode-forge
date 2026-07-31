[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:188](https://github.com/chriswritescode-dev/opencode-forge/blob/38879e2bc68410e9a5393f2d5a51dfb71d7d90f1/src/types.ts#L188)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:190](https://github.com/chriswritescode-dev/opencode-forge/blob/38879e2bc68410e9a5393f2d5a51dfb71d7d90f1/src/types.ts#L190)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:192](https://github.com/chriswritescode-dev/opencode-forge/blob/38879e2bc68410e9a5393f2d5a51dfb71d7d90f1/src/types.ts#L192)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
