-- Migration 116: Drop HTTP control plane tables (bus-RPC migration)
-- The HTTP control plane was replaced by the bus-RPC protocol.
-- These tables are no longer needed as forge instances communicate via tui.command.execute events.

DROP TABLE IF EXISTS api_registry;
DROP TABLE IF EXISTS api_coordinators;
DROP TABLE IF EXISTS api_project_instances;
