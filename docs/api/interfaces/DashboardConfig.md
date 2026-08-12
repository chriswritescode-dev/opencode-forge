[**opencode-forge**](../README.md)

***

[opencode-forge](../globals.md) / DashboardConfig

# Interface: DashboardConfig

Defined in: [types.ts:221](https://github.com/chriswritescode-dev/opencode-forge/blob/452ee7d80cf3f35b3fecfa2083478115036194ad/src/types.ts#L221)

Configuration for the read-only observability dashboard HTTP server.
The dashboard is unauthenticated: binding to a non-loopback address exposes
every loop plan, goal, audit result, finding, and cost to anyone who can reach
the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
for the canonical warning text rendered by launch surfaces.

## Properties

### host?

> `optional` **host?**: `string`

Defined in: [types.ts:223](https://github.com/chriswritescode-dev/opencode-forge/blob/452ee7d80cf3f35b3fecfa2083478115036194ad/src/types.ts#L223)

Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces.

***

### port?

> `optional` **port?**: `number`

Defined in: [types.ts:225](https://github.com/chriswritescode-dev/opencode-forge/blob/452ee7d80cf3f35b3fecfa2083478115036194ad/src/types.ts#L225)

Base bind port. Defaults to 4747. Consecutive ports are tried when busy.
