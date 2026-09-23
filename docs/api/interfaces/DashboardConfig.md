[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [src/types.ts:224](https://github.com/chriswritescode-dev/opencode-forge/blob/bd70c38745ad9789adde336ed1c037b62504e5a2/src/types.ts#L224)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [src/types.ts:226](https://github.com/chriswritescode-dev/opencode-forge/blob/bd70c38745ad9789adde336ed1c037b62504e5a2/src/types.ts#L226)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [src/types.ts:228](https://github.com/chriswritescode-dev/opencode-forge/blob/bd70c38745ad9789adde336ed1c037b62504e5a2/src/types.ts#L228)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
