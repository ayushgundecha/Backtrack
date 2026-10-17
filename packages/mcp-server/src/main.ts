/**
 * stdio entry point. Configured entirely by environment variables, so an MCP client config only
 * needs `command` and `env`: FALKORDB_HOST/PORT/USERNAME/PASSWORD and BACKTRACK_TENANT.
 */
import { closeDb, createToolRegistry, ensureTenant, openTenant } from '@backtrack/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const tenant = process.env.BACKTRACK_TENANT?.trim() || 'demo';
const g = openTenant(tenant);
await ensureTenant(g);

const server = createServer({ g, registry: createToolRegistry() });
await server.connect(new StdioServerTransport());
// stdout carries the protocol; anything for a human goes to stderr.
console.error(`[backtrack-mcp] serving graph bt:${tenant} over stdio`);

const shutdown = async () => {
  await server.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
