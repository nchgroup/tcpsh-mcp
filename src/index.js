#!/usr/bin/env node
/**
 * index.js — tcpsh MCP server
 *
 * Transport: stdio (compatible with any MCP host via npx)
 *
 * Config snippet:
 *   {
 *     "mcpServers": {
 *       "tcpsh": {
 *         "command": "npx",
 *         "args": ["-y", "github:YOUR_USER/tcpsh-mcp"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TcpManager } from './tcp-manager.js';
import { RemoteTcpManager } from './remote-manager.js';
import { buildTools } from './tools.js';
import { z } from 'zod';

// ── Bootstrap ─────────────────────────────────────────────────────────────

// Remote mode: if both TCPSH_SERVER and TCPSH_TOKEN are set, delegate all
// TCP operations to a running tcpsh --server instance.  Otherwise fall back
// to the standalone TcpManager (original behaviour, unchanged).
let mgr;
if (process.env.TCPSH_SERVER && process.env.TCPSH_TOKEN) {
    mgr = new RemoteTcpManager(process.env.TCPSH_SERVER, process.env.TCPSH_TOKEN);
    // Connect eagerly so any auth error surfaces at startup.
    await mgr.connect().catch(err => {
        process.stderr.write(`[tcpsh-mcp] Failed to connect to ${process.env.TCPSH_SERVER}: ${err.message}\n`);
        process.exit(1);
    });
    process.stderr.write(`[tcpsh-mcp] Remote mode: connected to ${process.env.TCPSH_SERVER}\n`);
} else {
    mgr = new TcpManager();
}
const server = new McpServer({ name: 'tcpsh', version: '1.0.0' });

// ── Register tools ────────────────────────────────────────────────────────

for (const tool of buildTools(mgr)) {
    // McpServer.tool(name, description, zodShape, handler)
    // We convert inputSchema → zod at registration time.
    server.tool(
        tool.name,
        tool.description,
        jsonSchemaToZod(tool.inputSchema),
        async (args) => {
            try {
                const text = await tool.handler(args);
                return { content: [{ type: 'text', text: String(text) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );
}

// ── Start ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
async function shutdown() {
    await mgr.closeAll();
    await server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Minimal JSON Schema → zod shape converter.
 * Only handles the subset used in tools.js (object with string/number/boolean properties).
 * McpServer.tool() accepts a plain object of zod schemas as its third argument.
 */
function jsonSchemaToZod(schema) {
    if (!schema || schema.type !== 'object') return {};
    const shape = {};
    const required = new Set(schema.required ?? []);
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        let fieldSchema;
        switch (prop.type) {
            case 'number': fieldSchema = z.number(); break;
            case 'boolean': fieldSchema = z.boolean(); break;
            default: fieldSchema = z.string(); break;
        }
        if (prop.description) fieldSchema = fieldSchema.describe(prop.description);
        if (!required.has(key)) fieldSchema = fieldSchema.optional();
        shape[key] = fieldSchema;
    }
    return shape;
}
