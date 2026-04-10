/**
 * tcp-manager.js
 * Self-contained TCP state: listeners, sessions, forwards, proxies, RX buffers.
 * No external tcpsh dependency — standalone for npx delivery.
 */

import net from 'net';
import os from 'os';
import { createWriteStream } from 'fs';
import { EventEmitter } from 'events';

/**
 * Resolves a bind address: returns the host as-is if it is an IP or empty,
 * otherwise treats it as a network interface name (e.g. "tun0") and returns
 * its first IPv4 address.
 * @param {string} host
 * @returns {string}
 */
function resolveHost(host) {
    if (!host || host === '0.0.0.0') return host;
    // Already an IP?
    if (net.isIP(host)) return host;
    // Try interface lookup
    const ifaces = os.networkInterfaces();
    const addrs = ifaces[host];
    if (!addrs) throw new Error(`Unknown host or interface: "${host}"`);
    const entry = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (!entry) throw new Error(`Interface "${host}" has no IPv4 address`);
    return entry.address;
}

// ── Session ──────────────────────────────────────────────────────────────────

let _nextId = 1;

class Session {
    constructor(socket, port) {
        this.id = _nextId++;
        this.port = port;
        this.socket = socket;
        this.remote = `${socket.remoteAddress}:${socket.remotePort}`;
        this.state = 'active';
        this.bytesTX = 0;
        this.bytesRX = 0;
        this.createdAt = new Date().toISOString();
    }

    write(data) {
        if (this.state === 'dead') return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.socket.write(buf);
        this.bytesTX += buf.length;
    }

    close() { this.state = 'dead'; try { this.socket.end(); } catch { /**/ } }
    forceClose() { this.state = 'dead'; try { this.socket.destroy(); } catch { /**/ } }
}

// ── Forwarder ─────────────────────────────────────────────────────────────────

class Forwarder {
    constructor(localPort, remoteHost, remotePort, dialTimeout = 10000) {
        this.localPort = localPort;
        this.remoteHost = remoteHost;
        this.remotePort = remotePort;
        this.dialTimeout = dialTimeout;
        this.bytesTX = 0;
        this.bytesRX = 0;
        this._server = null;
    }

    start() {
        this._server = net.createServer(client => {
            const remote = net.createConnection({
                host: this.remoteHost, port: this.remotePort, timeout: this.dialTimeout,
            });
            remote.once('timeout', () => remote.destroy(new Error('dial timeout')));

            client.on('data', c => { this.bytesTX += c.length; remote.write(c); });
            remote.on('data', c => { this.bytesRX += c.length; client.write(c); });

            const cleanup = () => {
                try { client.destroy(); } catch { /**/ }
                try { remote.destroy(); } catch { /**/ }
            };
            client.on('close', cleanup); remote.on('close', cleanup);
            client.on('error', cleanup); remote.on('error', cleanup);
        });
        return new Promise((res, rej) => {
            this._server.listen(this.localPort, '0.0.0.0', res);
            this._server.once('error', rej);
        });
    }

    close() {
        return new Promise(res => { if (!this._server) return res(); this._server.close(res); });
    }
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

class Proxy {
    constructor(localPort, remoteHost, remotePort, logFile = null, dialTimeout = 10000) {
        this.localPort = localPort;
        this.remoteHost = remoteHost;
        this.remotePort = remotePort;
        this.dialTimeout = dialTimeout;
        this.bytesTX = 0;
        this.bytesRX = 0;
        this._logStream = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
        this._server = null;
    }

    _log(tag, data) {
        if (!this._logStream) return;
        const ts = new Date().toISOString();
        const hex = Buffer.isBuffer(data) ? data.toString('hex') : Buffer.from(data).toString('hex');
        this._logStream.write(`[${ts}] [${tag}] ${hex}\n`);
    }

    setLogFile(path) {
        if (this._logStream) this._logStream.end();
        this._logStream = createWriteStream(path, { flags: 'a' });
    }

    start() {
        this._server = net.createServer(client => {
            const remote = net.createConnection({
                host: this.remoteHost, port: this.remotePort, timeout: this.dialTimeout,
            });
            remote.once('timeout', () => remote.destroy(new Error('dial timeout')));

            client.on('data', c => { this.bytesTX += c.length; this._log('TX', c); remote.write(c); });
            remote.on('data', c => { this.bytesRX += c.length; this._log('RX', c); client.write(c); });

            const cleanup = () => {
                try { client.destroy(); } catch { /**/ }
                try { remote.destroy(); } catch { /**/ }
            };
            client.on('close', cleanup); remote.on('close', cleanup);
            client.on('error', cleanup); remote.on('error', cleanup);
        });
        return new Promise((res, rej) => {
            this._server.listen(this.localPort, '0.0.0.0', res);
            this._server.once('error', rej);
        });
    }

    close() {
        if (this._logStream) { this._logStream.end(); this._logStream = null; }
        return new Promise(res => { if (!this._server) return res(); this._server.close(res); });
    }
}

// ── TcpManager ───────────────────────────────────────────────────────────────

export class TcpManager extends EventEmitter {
    /** @type {Map<number, net.Server>}         port → raw server */
    #servers = new Map();
    /** @type {Map<number, Session[]>}          port → sessions */
    #sessions = new Map();
    /** @type {Map<number, string[]>}           sessionId → RX line buffer */
    #rxBuf = new Map();
    /** @type {Map<number, {type, instance, remote, logFile?}>} lport → entry */
    #forwards = new Map();

    // ── Listener management ─────────────────────────────────────────────────

    openPort(port, host = '0.0.0.0') {
        if (this.#servers.has(port)) throw new Error(`Port ${port} is already open`);
        const bindHost = resolveHost(host);

        const server = net.createServer(socket => {
            const sess = new Session(socket, port);
            if (!this.#sessions.has(port)) this.#sessions.set(port, []);
            this.#sessions.get(port).push(sess);
            this.#rxBuf.set(sess.id, []);

            this.emit('connection', { id: sess.id, port, remote: sess.remote });

            socket.on('data', chunk => {
                sess.bytesRX += chunk.length;
                const lines = chunk.toString();
                const buf = this.#rxBuf.get(sess.id);
                if (buf !== undefined) buf.push(lines);
                this.emit('data', { sessionId: sess.id, data: lines });
            });

            socket.on('close', () => {
                sess.state = 'dead';
                this.emit('sessionClose', { sessionId: sess.id, port, remote: sess.remote });
            });

            socket.on('error', () => { sess.state = 'dead'; });
        });

        server.on('error', err => this.emit('error', { port, message: err.message }));

        return new Promise((res, rej) => {
            server.listen(port, bindHost, () => {
                this.#servers.set(port, server);
                res(`${bindHost || '0.0.0.0'}:${port}`);
            });
            server.once('error', rej);
        });
    }

    closePort(port) {
        const server = this.#servers.get(port);
        if (!server) throw new Error(`Port ${port} is not open`);

        const sessions = this.#sessions.get(port) ?? [];
        for (const s of sessions) s.forceClose();
        this.#sessions.delete(port);

        return new Promise(res => {
            this.#servers.delete(port);
            server.close(res);
        });
    }

    openPorts() {
        return [...this.#servers.keys()].map(port => ({
            port,
            sessions: (this.#sessions.get(port) ?? []).filter(s => s.state !== 'dead').length,
        }));
    }

    // ── Session management ──────────────────────────────────────────────────

    #resolveSession(port, idx = 1) {
        const list = (this.#sessions.get(port) ?? []).filter(s => s.state !== 'dead');
        if (!list.length) throw new Error(`No active sessions on port ${port}`);
        if (idx < 1 || idx > list.length) throw new Error(`Session index ${idx} out of range (1-${list.length})`);
        return list[idx - 1];
    }

    listSessions() {
        const result = [];
        for (const [port, sessions] of this.#sessions) {
            for (const s of sessions) {
                if (s.state !== 'dead') {
                    result.push({
                        id: s.id, port, remote: s.remote,
                        state: s.state, bytesTX: s.bytesTX, bytesRX: s.bytesRX,
                        createdAt: s.createdAt,
                    });
                }
            }
        }
        return result;
    }

    sendToSession(port, idx, data) {
        const sess = this.#resolveSession(port, idx);
        sess.write(data);
        return { sessionId: sess.id, bytesSent: Buffer.byteLength(data) };
    }

    readFromSession(port, idx) {
        const sess = this.#resolveSession(port, idx);
        const buf = this.#rxBuf.get(sess.id) ?? [];
        const data = buf.join('');
        this.#rxBuf.set(sess.id, []);   // drain buffer
        return { sessionId: sess.id, data };
    }

    killSession(port, idx, force = false) {
        const sess = this.#resolveSession(port, idx);
        if (force) sess.forceClose(); else sess.close();
        return { sessionId: sess.id, method: force ? 'RST' : 'FIN' };
    }

    sessionInfo(port, idx) {
        const sess = this.#resolveSession(port, idx);
        return {
            id: sess.id, port, remote: sess.remote,
            state: sess.state, bytesTX: sess.bytesTX, bytesRX: sess.bytesRX,
            createdAt: sess.createdAt,
        };
    }

    // ── Forward / Proxy management ──────────────────────────────────────────

    async addForward(localPort, remoteHost, remotePort, dialTimeout = 10000) {
        if (this.#forwards.has(localPort) || this.#servers.has(localPort))
            throw new Error(`Port ${localPort} already in use`);
        const fwd = new Forwarder(localPort, remoteHost, remotePort, dialTimeout);
        await fwd.start();
        this.#forwards.set(localPort, { type: 'fwd', instance: fwd, remote: `${remoteHost}:${remotePort}` });
    }

    async addProxy(localPort, remoteHost, remotePort, logFile = null, dialTimeout = 10000) {
        if (this.#forwards.has(localPort) || this.#servers.has(localPort))
            throw new Error(`Port ${localPort} already in use`);
        const proxy = new Proxy(localPort, remoteHost, remotePort, logFile, dialTimeout);
        await proxy.start();
        this.#forwards.set(localPort, { type: 'proxy', instance: proxy, remote: `${remoteHost}:${remotePort}`, logFile });
    }

    async removeForward(localPort) {
        const entry = this.#forwards.get(localPort);
        if (!entry) throw new Error(`No forward on port ${localPort}`);
        await entry.instance.close();
        this.#forwards.delete(localPort);
    }

    listForwards() {
        return [...this.#forwards.entries()].map(([lport, e]) => ({
            localPort: lport,
            type: e.type,
            remote: e.remote,
            logFile: e.logFile ?? null,
            bytesTX: e.instance.bytesTX,
            bytesRX: e.instance.bytesRX,
        }));
    }

    // ── Teardown ─────────────────────────────────────────────────────────────

    async closeAll() {
        for (const port of [...this.#servers.keys()]) await this.closePort(port).catch(() => { });
        for (const lport of [...this.#forwards.keys()]) await this.removeForward(lport).catch(() => { });
    }
}
