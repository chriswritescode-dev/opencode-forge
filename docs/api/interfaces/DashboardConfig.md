[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:284](https://github.com/chriswritescode-dev/opencode-forge/blob/21c3d43aed91bed67ed8a5cd85f8bea9d5ad6c21/src/types.ts#L284)

Configuration for the database-backed observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:286](https://github.com/chriswritescode-dev/opencode-forge/blob/21c3d43aed91bed67ed8a5cd85f8bea9d5ad6c21/src/types.ts#L286)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:288](https://github.com/chriswritescode-dev/opencode-forge/blob/21c3d43aed91bed67ed8a5cd85f8bea9d5ad6c21/src/types.ts#L288)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
