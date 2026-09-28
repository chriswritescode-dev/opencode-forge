[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:260](https://github.com/chriswritescode-dev/opencode-forge/blob/f29ed22f7baa6e0bf1f82cbbb1b48b00ce6ce776/src/types.ts#L260)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:262](https://github.com/chriswritescode-dev/opencode-forge/blob/f29ed22f7baa6e0bf1f82cbbb1b48b00ce6ce776/src/types.ts#L262)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:264](https://github.com/chriswritescode-dev/opencode-forge/blob/f29ed22f7baa6e0bf1f82cbbb1b48b00ce6ce776/src/types.ts#L264)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
