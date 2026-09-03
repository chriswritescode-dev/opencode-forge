[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:225](https://github.com/chriswritescode-dev/opencode-forge/blob/de5f48e9cdfb630dd2d5275361e34f2dbbea5aa1/src/types.ts#L225)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:227](https://github.com/chriswritescode-dev/opencode-forge/blob/de5f48e9cdfb630dd2d5275361e34f2dbbea5aa1/src/types.ts#L227)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:229](https://github.com/chriswritescode-dev/opencode-forge/blob/de5f48e9cdfb630dd2d5275361e34f2dbbea5aa1/src/types.ts#L229)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
