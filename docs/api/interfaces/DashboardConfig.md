[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:200](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L200)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:202](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L202)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:204](https://github.com/chriswritescode-dev/opencode-forge/blob/4781cfd6d6b1994ce6d5de8e795c35f0499fd5fe/src/types.ts#L204)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
