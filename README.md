# tcpsh-mcp — MCP Server for TCP Connection Management

> MCP server for **[tcpsh](https://github.com/nchgroup/tcpsh)** — the interactive TCP connection manager.

MCP server exposing 13 tools for interactive TCP connection management: open listeners, interact with sessions, forward ports, proxy traffic, and run local commands — all from any MCP-compatible AI host (Claude Desktop, VS Code Copilot, etc.).

---

## Installation

This server is installed on demand from GitHub — no npm registry required.

Add to your MCP host configuration:

```json
{
  "mcpServers": {
    "tcpsh": {
      "command": "npx",
      "args": ["-y", "github:nchgroup/tcpsh-mcp"]
    }
  }
}
```

`npx -y github:nchgroup/tcpsh-mcp` clones the repository, runs `npm install`, and executes the `bin` entry — no manual setup required.

### Requirements

- Node.js ≥ 18.0.0
- Internet access on first run (GitHub clone + npm install)

---

## Tools

| # | Tool | Description |
|---|---|---|
| 1 | `open_port` | Open a TCP listener |
| 2 | `close_port` | Close a listener and its sessions |
| 3 | `list_ports` | List open ports and session counts |
| 4 | `list_sessions` | List active sessions with traffic counters |
| 5 | `send_to_session` | Send data to a TCP session |
| 6 | `read_from_session` | Read buffered data from a TCP session |
| 7 | `kill_session` | Terminate a session (FIN or RST) |
| 8 | `session_info` | Detailed info about a session |
| 9 | `add_forward` | Start a transparent TCP forward |
| 10 | `add_proxy` | Start a TCP proxy with traffic logging |
| 11 | `list_forwards` | List active forwards and proxies |
| 12 | `remove_forward` | Stop a forward or proxy |
| 13 | `exec_local` | Run a shell command on the local machine |

---

## Tool Reference

### `open_port`
```
port   (number, required)  TCP port to listen on
host   (string, optional)  Bind address — default: 0.0.0.0
```

### `close_port`
```
port   (number, required)  Port to close (closes all its sessions too)
```

### `send_to_session`
```
port   (number, required)  Port the session belongs to
idx    (number, optional)  Session index, 1-based — default: 1
data   (string, required)  Raw data to send (no newline added automatically)
```

### `read_from_session`
```
port   (number, required)  Port the session belongs to
idx    (number, optional)  Session index — default: 1
```
Drains the internal RX buffer. Call again to receive subsequent data.

### `kill_session`
```
port   (number, required)  Port the session belongs to
idx    (number, optional)  Session index — default: 1
force  (boolean, optional) true = RST (immediate), false = FIN (graceful) — default: false
```

### `add_forward`
```
local_port   (number, required)  Local port to listen on
remote_host  (string, required)  Destination host
remote_port  (number, required)  Destination port
```

### `add_proxy`
```
local_port   (number, required)  Local port to listen on
remote_host  (string, required)  Destination host
remote_port  (number, required)  Destination port
log_file     (string, optional)  Path to write hex traffic log
```

### `exec_local`
```
command  (string, required)  Shell command executed via sh -c
```

---

## Example Prompts

**Open a reverse shell catcher:**
> "Open port 4444 and wait for a connection"

**Read shell output:**
> "Read the output from the session on port 4444"

**Send a command to a session:**
> "Send the command 'id\n' to port 4444"

**Set up port forwarding:**
> "Forward local port 8080 to 10.0.0.1:80"

**Intercept HTTP traffic:**
> "Start a proxy on port 8080 pointing to 10.0.0.1:80, log to /tmp/http.log"

**Run a local network scan:**
> "Run nmap -sV localhost and return the output"

---

## Remote Mode

tcpsh-mcp can delegate all TCP management to a remote **tcpsh server** instead of
running a local in-process manager.  This is useful when:

- the AIhost is sandboxed and cannot open TCP ports directly
- you want state to persist even if the MCP process restarts
- multiple AI sessions should share the same network state

### Prerequisites

Start a `tcpsh` server on the target machine:

```bash
tcpsh --server 0.0.0.0:9000
```

The token printed at startup encrypts all traffic with **ChaCha20-Poly1305**.

### Enable remote mode

Pass two environment variables when starting the MCP server.  Example MCP host
configuration:

```json
{
  "mcpServers": {
    "tcpsh-remote": {
      "command": "npx",
      "args": ["-y", "github:nchgroup/tcpsh-mcp"],
      "env": {
        "TCPSH_SERVER": "127.0.0.1:9000",
        "TCPSH_TOKEN": "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"
      }
    }
  }
}
```

Or on the command line:

```bash
TCPSH_SERVER=127.0.0.1:9000 TCPSH_TOKEN=<TOKEN> node src/index.js
```

### What works remotely

| Tool | Remote support |
|---|---|
| `open_port` … `remove_forward` (12 tools) | ✅ Delegated to tcpsh server |
| `exec_local` | ⚠️ Always runs locally (on the MCP server host) |

When neither `TCPSH_SERVER` nor `TCPSH_TOKEN` is set, tcpsh-mcp falls back to its
built-in in-process TCP manager (default behaviour).

---

## Architecture

```
tcpsh-mcp/
├── package.json            bin entry + @modelcontextprotocol/sdk dep
└── src/
    ├── index.js            McpServer + StdioServerTransport + tool registration
    │                       (selects TcpManager or RemoteTcpManager at startup)
    ├── tcp-manager.js      Local TCP state: listeners, sessions, RX buffers, forwards, proxies
    ├── remote-manager.js   Remote mode: encrypted ChaCha20-Poly1305 frames over TCP
    └── tools.js            13 tool definitions (inputSchema + handlers)
```

- **Transport**: stdio — compatible with all MCP hosts
- **State**: in-process (default) or on the remote tcpsh server (remote mode)
- **RX buffer**: received data is buffered per session and drained on `read_from_session`
- **SDK**: `@modelcontextprotocol/sdk` v1.x (stable)

---

## Manual Testing

Send raw JSON-RPC to the server's stdin:

```bash
# Start the server
node src/index.js

# In another terminal / via pipe:
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node src/index.js
```

---

## Related Projects

- [`tcpsh`](https://github.com/nchgroup/tcpsh) — Go implementation (REPL binary) — the project this MCP wraps
- [`tcpsh-mcp`](https://github.com/nchgroup/tcpsh-mcp) — this repository

---

## License

MIT
