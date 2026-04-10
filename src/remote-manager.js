/**
 * remote-manager.js — RemoteTcpManager
 *
 * Drop-in replacement for TcpManager that delegates all operations to a
 * running tcpsh --server instance over an encrypted TCP connection.
 *
 * Encryption:  ChaCha20-Poly1305
 * Key:         SHA-256(token)
 * Frame:       [4-byte BE length][12-byte nonce][ciphertext + 16-byte AEAD tag]
 *
 * Usage:
 *   const mgr = new RemoteTcpManager('127.0.0.1:9000', 'mytoken...');
 *   await mgr.connect();
 *   // All methods now delegate to the tcpsh server.
 */

import net from 'net';
import crypto from 'crypto';

// ── Constants ──────────────────────────────────────────────────────────────

const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const LEN_FIELD = 4;
const MAX_FRAME = 4 * 1024 * 1024;

// ── Key derivation ─────────────────────────────────────────────────────────

function tokenToKey(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest();
}

// ── Frame encode/decode ────────────────────────────────────────────────────

function encodeFrame(key, plaintext) {
    const nonce = crypto.randomBytes(NONCE_SIZE);
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_SIZE });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([nonce, ct, tag]);
    const hdr = Buffer.allocUnsafe(LEN_FIELD);
    hdr.writeUInt32BE(payload.length, 0);
    return Buffer.concat([hdr, payload]);
}

function decodeFrame(key, frame) {
    // frame = nonce(12) + ciphertext + tag(16)
    if (frame.length < NONCE_SIZE + TAG_SIZE) throw new Error('Frame too short');
    const nonce = frame.slice(0, NONCE_SIZE);
    const tag = frame.slice(frame.length - TAG_SIZE);
    const ct = frame.slice(NONCE_SIZE, frame.length - TAG_SIZE);
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_SIZE });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── RemoteTcpManager ──────────────────────────────────────────────────────

export class RemoteTcpManager {
    #addr;
    #key;
    #socket = null;
    #recvBuf = Buffer.alloc(0);
    #pendingQueue = [];   // { resolve, reject }
    #connected = false;

    constructor(addr, token) {
        this.#addr = addr;
        this.#key = tokenToKey(token);
    }

    // ── Connection lifecycle ───────────────────────────────────────────────

    async connect() {
        if (this.#connected) return;

        const [host, portStr] = this.#addr.split(':');
        const port = parseInt(portStr, 10);

        await new Promise((res, rej) => {
            const sock = net.createConnection({ host, port });
            sock.once('connect', () => {
                this.#socket = sock;
                this._setupSocket(sock);
                // Perform handshake.
                this._sendFrame('HELLO');
                // Wait for READY.
                this.#pendingQueue.push({
                    resolve: (msg) => {
                        if (msg !== 'READY') throw new Error(`Unexpected handshake reply: ${msg}`);
                        this.#connected = true;
                        res();
                    },
                    reject: rej,
                });
            });
            sock.once('error', rej);
        });
    }

    _setupSocket(sock) {
        sock.on('data', chunk => {
            this.#recvBuf = Buffer.concat([this.#recvBuf, chunk]);
            this._processBuffer();
        });
        sock.on('close', () => {
            this.#connected = false;
            // Reject all pending commands.
            for (const p of this.#pendingQueue) p.reject(new Error('Remote server disconnected'));
            this.#pendingQueue = [];
        });
        sock.on('error', err => {
            for (const p of this.#pendingQueue) p.reject(err);
            this.#pendingQueue = [];
        });
    }

    _processBuffer() {
        while (this.#recvBuf.length >= LEN_FIELD) {
            const frameLen = this.#recvBuf.readUInt32BE(0);
            if (frameLen > MAX_FRAME) throw new Error(`Frame too large: ${frameLen}`);
            if (this.#recvBuf.length < LEN_FIELD + frameLen) break;

            const frame = this.#recvBuf.slice(LEN_FIELD, LEN_FIELD + frameLen);
            this.#recvBuf = this.#recvBuf.slice(LEN_FIELD + frameLen);

            const plain = decodeFrame(this.#key, frame);
            const text = plain.toString('utf8');

            // Unsolicited event (no pending command)? Emit to stderr as info.
            if (this.#pendingQueue.length === 0) {
                process.stderr.write(`[tcpsh-server] ${text}\n`);
                continue;
            }
            const { resolve } = this.#pendingQueue.shift();
            resolve(text);
        }
    }

    _sendFrame(text) {
        if (!this.#socket) throw new Error('Not connected to server');
        const buf = encodeFrame(this.#key, Buffer.from(text, 'utf8'));
        this.#socket.write(buf);
    }

    async _sendCommand(line) {
        await this.connect();
        return new Promise((resolve, reject) => {
            this.#pendingQueue.push({ resolve, reject });
            this._sendFrame(line);
        });
    }

    // ── TcpManager-compatible API ─────────────────────────────────────────

    async openPort(port, host = '0.0.0.0') {
        const cmd = host && host !== '0.0.0.0' ? `open ${port} ${host}` : `open ${port}`;
        return this._sendCommand(cmd);
    }

    async closePort(port) {
        return this._sendCommand(`close ${port}`);
    }

    async openPorts() {
        const text = await this._sendCommand('list ports');
        // Parse text lines like "  :4444  sessions: 2"
        return text.split('\n')
            .map(l => l.trim())
            .filter(l => l.startsWith(':'))
            .map(l => {
                const m = l.match(/:(\d+)\s+sessions:\s*(\d+)/);
                return m ? { port: parseInt(m[1], 10), sessions: parseInt(m[2], 10) } : null;
            })
            .filter(Boolean);
    }

    async listSessions() {
        const text = await this._sendCommand('list conn');
        // Parse text rows from views.RenderSessions — best-effort.
        return text.split('\n')
            .map(l => l.trim())
            .filter(l => /^\d+/.test(l))
            .map(l => {
                const parts = l.split(/\s{2,}/);
                return {
                    id: parseInt(parts[0], 10),
                    port: parts[1] ? parseInt(parts[1], 10) : null,
                    remote: parts[2] ?? '',
                    state: parts[3] ?? '',
                    bytesTX: 0, bytesRX: 0,
                    createdAt: null,
                };
            });
    }

    async sendToSession(port, idx = 1, data) {
        const text = await this._sendCommand(`send ${port}:${idx} ${data}`);
        return { bytesSent: Buffer.byteLength(data), sessionId: null, text };
    }

    async readFromSession(port, idx = 1) {
        const text = await this._sendCommand(`read ${port}:${idx}`);
        const empty = text.startsWith('(no data');
        return { sessionId: null, data: empty ? '' : text };
    }

    async killSession(port, idx = 1, force = false) {
        const flag = force ? ' -f' : '';
        const text = await this._sendCommand(`kill${flag} ${port}:${idx}`);
        return { sessionId: null, method: force ? 'RST' : 'FIN', text };
    }

    async sessionInfo(port, idx = 1) {
        return this._sendCommand(`info ${port}:${idx}`);
    }

    async addForward(localPort, remoteHost, remotePort) {
        return this._sendCommand(`fwd ${localPort} ${remoteHost}:${remotePort}`);
    }

    async addProxy(localPort, remoteHost, remotePort, logFile = null) {
        const cmd = logFile
            ? `proxy ${localPort} ${remoteHost}:${remotePort} ${logFile}`
            : `proxy ${localPort} ${remoteHost}:${remotePort}`;
        return this._sendCommand(cmd);
    }

    async listForwards() {
        return this._sendCommand('list fwd');
    }

    async removeForward(localPort) {
        // Try fwd close first, then proxy close.
        return this._sendCommand(`fwd close ${localPort}`).catch(() =>
            this._sendCommand(`proxy close ${localPort}`)
        );
    }

    // closeAll disconnects the client — the server keeps all state alive.
    async closeAll() {
        if (this.#socket) {
            this.#socket.destroy();
            this.#socket = null;
        }
        this.#connected = false;
    }
}
