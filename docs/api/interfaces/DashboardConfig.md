[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:261](https://github.com/chriswritescode-dev/opencode-forge/blob/922f6a3ab7ff6c2e56bbb878cd5cebb484b8629d/src/types.ts#L261)

Configuration for the database-backed observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:263](https://github.com/chriswritescode-dev/opencode-forge/blob/922f6a3ab7ff6c2e56bbb878cd5cebb484b8629d/src/types.ts#L263)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:265](https://github.com/chriswritescode-dev/opencode-forge/blob/922f6a3ab7ff6c2e56bbb878cd5cebb484b8629d/src/types.ts#L265)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
