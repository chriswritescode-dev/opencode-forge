[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:201](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L201)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:203](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L203)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:205](https://github.com/chriswritescode-dev/opencode-forge/blob/bae347e91d162356f5d88217fa4b5258e5c999ac/src/types.ts#L205)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
