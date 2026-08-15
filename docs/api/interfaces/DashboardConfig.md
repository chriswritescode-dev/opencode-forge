[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:231](https://github.com/chriswritescode-dev/opencode-forge/blob/656873914b8ea5b100c4de54d84950e6c289f8bb/src/types.ts#L231)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:233](https://github.com/chriswritescode-dev/opencode-forge/blob/656873914b8ea5b100c4de54d84950e6c289f8bb/src/types.ts#L233)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:235](https://github.com/chriswritescode-dev/opencode-forge/blob/656873914b8ea5b100c4de54d84950e6c289f8bb/src/types.ts#L235)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
