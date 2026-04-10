/**
 * tools.js
 * 13 MCP tool definitions and their handlers, wired to a TcpManager instance.
 */

import { execFile } from 'child_process';

// ── Local exec helper ──────────────────────────────────────────────────────

function execLocal(cmd) {
    return new Promise(resolve => {
        execFile('bash', ['-c', cmd], { timeout: 30000 }, (err, stdout, stderr) => {
            resolve((stdout || '') + (stderr || ''));
        });
    });
}

// ── Tool definitions ────────────────────────────────────────────────────────

/** @param {import('./tcp-manager.js').TcpManager} mgr */
export function buildTools(mgr) {
    return [
        // ── 1. open_port ──────────────────────────────────────────────────────
        {
            name: 'open_port',
            description: 'Open a TCP listener on the specified port and wait for incoming connections.',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'number', description: 'TCP port to listen on (1-65535)' },
                    host: { type: 'string', description: 'Bind address (default: 0.0.0.0)', default: '0.0.0.0' },
                },
                required: ['port'],
            },
            handler: async ({ port, host = '0.0.0.0' }) => {
                await mgr.openPort(port, host);
                return `Listening on ${host}:${port}`;
            },
        },

        // ── 2. close_port ─────────────────────────────────────────────────────
        {
            name: 'close_port',
            description: 'Close a TCP listener and all its active sessions.',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'number', description: 'Port to close' },
                },
                required: ['port'],
            },
            handler: async ({ port }) => {
                await mgr.closePort(port);
                return `Port ${port} closed`;
            },
        },

        // ── 3. list_ports ─────────────────────────────────────────────────────
        {
            name: 'list_ports',
            description: 'List all open TCP listener ports and their active session count.',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                const ports = mgr.openPorts();
                if (!ports.length) return 'No open ports';
                return ports.map(p => `  :${p.port}  sessions: ${p.sessions}`).join('\n');
            },
        },

        // ── 4. list_sessions ──────────────────────────────────────────────────
        {
            name: 'list_sessions',
            description: 'List all active TCP sessions with ID, port, remote address, state and traffic counters.',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                const sessions = mgr.listSessions();
                if (!sessions.length) return 'No active sessions';
                return sessions
                    .map(s =>
                        `  #${s.id}  :${s.port}  ${s.remote}  [${s.state}]  TX:${s.bytesTX}B  RX:${s.bytesRX}B`
                    )
                    .join('\n');
            },
        },

        // ── 5. send_to_session ────────────────────────────────────────────────
        {
            name: 'send_to_session',
            description: 'Send data to an active TCP session. Use idx to select when multiple sessions share a port.',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'number', description: 'Port the session belongs to' },
                    idx: { type: 'number', description: 'Session index (1-based, default 1)', default: 1 },
                    data: { type: 'string', description: 'Data to send (a newline is NOT appended automatically)' },
                },
                required: ['port', 'data'],
            },
            handler: async ({ port, idx = 1, data }) => {
                const result = mgr.sendToSession(port, idx, data);
                return `Sent ${result.bytesSent} bytes to session ${result.sessionId}`;
            },
        },

        // ── 6. read_from_session ──────────────────────────────────────────────
        {
            name: 'read_from_session',
            description: 'Read and drain buffered data received from a TCP session since the last read.',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'number', description: 'Port the session belongs to' },
                    idx: { type: 'number', description: 'Session index (1-based, default 1)', default: 1 },
                },
                required: ['port'],
            },
            handler: async ({ port, idx = 1 }) => {
                const result = mgr.readFromSession(port, idx);
                if (!result.data) return `(no data buffered for session ${result.sessionId})`;
                return result.data;
            },
        },

        // ── 7. kill_session ───────────────────────────────────────────────────
        {
            name: 'kill_session',
            description: 'Terminate a TCP session. force=false sends FIN (graceful), force=true sends RST (immediate).',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'number', description: 'Port the session belongs to' },
                    idx: { type: 'number', description: 'Session index (1-based, default 1)', default: 1 },
                    force: { type: 'boolean', description: 'true = RST (force), false = FIN (graceful)', default: false },
                },
                required: ['port'],
            },
            handler: async ({ port, idx = 1, force = false }) => {
                const result = mgr.killSession(port, idx, force);
                return `Session ${result.sessionId} terminated (${result.method})`;
            },
        },

        // ── 8. session_info ───────────────────────────────────────────────────
        {
            name: 'session_info',
            description: 'Show detailed information about a specific TCP session.',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'number', description: 'Port the session belongs to' },
                    idx: { type: 'number', description: 'Session index (1-based, default 1)', default: 1 },
                },
                required: ['port'],
            },
            handler: async ({ port, idx = 1 }) => {
                const s = mgr.sessionInfo(port, idx);
                return [
                    `ID:        ${s.id}`,
                    `Port:      ${s.port}`,
                    `Remote:    ${s.remote}`,
                    `State:     ${s.state}`,
                    `TX:        ${s.bytesTX} bytes`,
                    `RX:        ${s.bytesRX} bytes`,
                    `Connected: ${s.createdAt}`,
                ].join('\n');
            },
        },

        // ── 9. add_forward ────────────────────────────────────────────────────
        {
            name: 'add_forward',
            description: 'Start a transparent TCP forward: all traffic on local_port is piped to remote_host:remote_port without modification.',
            inputSchema: {
                type: 'object',
                properties: {
                    local_port: { type: 'number', description: 'Local port to listen on' },
                    remote_host: { type: 'string', description: 'Remote host to forward to' },
                    remote_port: { type: 'number', description: 'Remote port to forward to' },
                },
                required: ['local_port', 'remote_host', 'remote_port'],
            },
            handler: async ({ local_port, remote_host, remote_port }) => {
                await mgr.addForward(local_port, remote_host, remote_port);
                return `Forward  :${local_port}  ──►  ${remote_host}:${remote_port}`;
            },
        },

        // ── 10. add_proxy ─────────────────────────────────────────────────────
        {
            name: 'add_proxy',
            description: 'Start a TCP proxy that forwards and logs all traffic (hex). Optionally write logs to a file.',
            inputSchema: {
                type: 'object',
                properties: {
                    local_port: { type: 'number', description: 'Local port to listen on' },
                    remote_host: { type: 'string', description: 'Remote host to proxy to' },
                    remote_port: { type: 'number', description: 'Remote port to proxy to' },
                    log_file: { type: 'string', description: 'Optional path to write hex traffic log' },
                },
                required: ['local_port', 'remote_host', 'remote_port'],
            },
            handler: async ({ local_port, remote_host, remote_port, log_file = null }) => {
                await mgr.addProxy(local_port, remote_host, remote_port, log_file);
                return `Proxy    :${local_port}  ──►  ${remote_host}:${remote_port}${log_file ? `  log→${log_file}` : ''}`;
            },
        },

        // ── 11. list_forwards ─────────────────────────────────────────────────
        {
            name: 'list_forwards',
            description: 'List all active TCP forwards and proxies with their traffic counters.',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                const entries = mgr.listForwards();
                if (!entries.length) return 'No active forwards or proxies';
                return entries
                    .map(e =>
                        `  [${e.type}] :${e.localPort}  ──►  ${e.remote}  TX:${e.bytesTX}B  RX:${e.bytesRX}B` +
                        (e.logFile ? `  log:${e.logFile}` : '')
                    )
                    .join('\n');
            },
        },

        // ── 12. remove_forward ────────────────────────────────────────────────
        {
            name: 'remove_forward',
            description: 'Stop and remove a TCP forward or proxy.',
            inputSchema: {
                type: 'object',
                properties: {
                    local_port: { type: 'number', description: 'Local port of the forward/proxy to remove' },
                },
                required: ['local_port'],
            },
            handler: async ({ local_port }) => {
                await mgr.removeForward(local_port);
                return `Forward :${local_port} removed`;
            },
        },

        // ── 13. exec_local ────────────────────────────────────────────────────
        {
            name: 'exec_local',
            description: 'Execute a shell command on the local machine and return combined stdout+stderr.',
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute (passed to sh -c)' },
                },
                required: ['command'],
            },
            handler: async ({ command }) => {
                const output = await execLocal(command);
                return output || '(no output)';
            },
        },
    ];
}
