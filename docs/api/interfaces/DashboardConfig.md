[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:276](https://github.com/chriswritescode-dev/opencode-forge/blob/ba0d5fce1f02f357d216ef34bfe71ddc86a75382/src/types.ts#L276)

Configuration for the database-backed observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:278](https://github.com/chriswritescode-dev/opencode-forge/blob/ba0d5fce1f02f357d216ef34bfe71ddc86a75382/src/types.ts#L278)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:280](https://github.com/chriswritescode-dev/opencode-forge/blob/ba0d5fce1f02f357d216ef34bfe71ddc86a75382/src/types.ts#L280)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
