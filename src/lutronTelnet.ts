import net from 'node:net';
import { EventEmitter } from 'node:events';

/*
  Lutron integration protocol (RA2 Select / Caseta Pro), line based over telnet.
    # = SET, ? = GET, ~ = event / response
    ~OUTPUT,<id>,1,<level>              zone level (dimmer / switch / shade), 0-100
    ~DEVICE,<id>,<component>,<action>   keypad / pico button, action 3=press 4=release
  The hub prints a "GNET> " prompt without a newline, so it usually prefixes the next line.
*/

export const OUTPUT_ACTION_LEVEL = 1;

export type LutronEvent =
  | { kind: 'output'; id: number; action: number; value: number }
  | { kind: 'device'; id: number; component: number; action: number };

export function parseLutronLine(raw: string): LutronEvent | null {
  const line = raw.replace(/^(\s*GNET>\s*)+/, '').trim();
  if (!line.startsWith('~')) return null;
  const parts = line.substring(1).split(',');
  if (parts.length < 4) return null;
  const id = parseInt(parts[1], 10);
  const a = parseInt(parts[2], 10);
  const v = parseFloat(parts[3]);
  if (isNaN(id) || isNaN(a) || isNaN(v)) return null;
  if (parts[0] === 'OUTPUT') return { kind: 'output', id, action: a, value: v };
  if (parts[0] === 'DEVICE') return { kind: 'device', id, component: a, action: v };
  return null;
}

export interface LutronTelnetOptions {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  keepaliveMs?: number;
  queryTimeoutMs?: number;
}

/**
 * Persistent telnet session to a Lutron hub. Reconnects with backoff, detects
 * dead sessions with a keepalive watchdog and keeps a cache of every output
 * level seen.
 *
 * Events: 'connected', 'disconnected', 'output' (id, level), 'device' (id, component, action)
 */
export class LutronTelnet extends EventEmitter {
  public readonly levels = new Map<number, number>();
  public connected = false;

  private readonly opts: Required<LutronTelnetOptions>;
  private socket?: net.Socket;
  private buffer = '';
  private loggedIn = false;
  private stopped = false;
  private backoffMs = 1000;
  private lastRx = 0;
  private keepaliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private pendingQueries = new Map<number, { promise: Promise<number | undefined>; resolve: (v: number | undefined) => void }>();

  constructor(opts: LutronTelnetOptions) {
    super();
    this.opts = {
      port: 23,
      username: 'lutron',
      password: 'integration',
      keepaliveMs: 60_000,
      queryTimeoutMs: 2_000,
      ...opts,
    };
  }

  /** Resolves once the first session is logged in; keeps retrying until then. */
  public start(): Promise<void> {
    this.stopped = false;
    const first = new Promise<void>((resolve) => this.once('connected', () => resolve()));
    this.connect();
    return first;
  }

  public stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepaliveTimer);
    this.socket?.destroy();
  }

  public async setLevel(id: number, level: number, fadeSec?: number) {
    let cmd = `#OUTPUT,${id},${OUTPUT_ACTION_LEVEL},${level}`;
    if (fadeSec !== undefined) cmd += `,${fadeSec}`;
    this.send(cmd);
  }

  /** Ask the hub for the current level; falls back to the cached level on timeout. */
  public query(id: number): Promise<number | undefined> {
    const pending = this.pendingQueries.get(id);
    if (pending) return pending.promise;
    let resolve!: (v: number | undefined) => void;
    const promise = new Promise<number | undefined>((r) => { resolve = r; });
    this.pendingQueries.set(id, { promise, resolve });
    const timer = setTimeout(() => this.resolveQuery(id, this.levels.get(id)), this.opts.queryTimeoutMs);
    promise.finally(() => clearTimeout(timer));
    if (!this.send(`?OUTPUT,${id},${OUTPUT_ACTION_LEVEL}`)) this.resolveQuery(id, this.levels.get(id));
    return promise;
  }

  private resolveQuery(id: number, value: number | undefined) {
    const pending = this.pendingQueries.get(id);
    if (!pending) return;
    this.pendingQueries.delete(id);
    pending.resolve(value);
  }

  private send(line: string): boolean {
    if (!this.socket || !this.loggedIn) {
      console.log(`Lutron: not connected, dropping "${line}"`);
      return false;
    }
    console.log(`Lutron: >> ${line}`);
    this.socket.write(line + '\r\n');
    return true;
  }

  private connect() {
    const { host, port } = this.opts;
    console.log(`Lutron: connecting to ${host}:${port}`);
    this.buffer = '';
    this.loggedIn = false;
    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setKeepAlive(true, 30_000);
    socket.setEncoding('utf8');
    socket.setTimeout(15_000, () => {
      if (!this.loggedIn) socket.destroy(new Error('login timed out'));
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => console.log(`Lutron: socket error: ${err.message}`));
    socket.on('close', () => this.onClose(socket));
  }

  private onClose(socket: net.Socket) {
    if (socket !== this.socket) return;
    clearInterval(this.keepaliveTimer);
    this.socket = undefined;
    const wasConnected = this.connected;
    this.connected = false;
    this.loggedIn = false;
    for (const id of [...this.pendingQueries.keys()]) this.resolveQuery(id, this.levels.get(id));
    if (wasConnected) this.emit('disconnected');
    if (this.stopped) return;
    console.log(`Lutron: connection closed, reconnecting in ${this.backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private onData(chunk: string) {
    this.lastRx = Date.now();
    this.buffer += chunk;
    if (!this.loggedIn) {
      this.handleLogin();
      if (!this.loggedIn) return;
    }
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLogin() {
    const socket = this.socket!;
    if (/login incorrect/i.test(this.buffer)) {
      console.log('Lutron: login rejected, check integration username/password');
      socket.destroy();
    } else if (/login:\s*$/i.test(this.buffer)) {
      this.buffer = '';
      socket.write(this.opts.username + '\r\n');
    } else if (/password:\s*$/i.test(this.buffer)) {
      this.buffer = '';
      socket.write(this.opts.password + '\r\n');
    } else if (/GNET>/.test(this.buffer)) {
      this.buffer = '';
      this.loggedIn = true;
      this.connected = true;
      this.backoffMs = 1000;
      socket.setTimeout(0);
      this.startKeepalive();
      console.log('Lutron: logged in');
      this.emit('connected');
    }
  }

  // An empty line makes the hub answer with a fresh prompt; if nothing comes
  // back for two intervals the session is dead even though TCP may not know it.
  private startKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastRx > 2 * this.opts.keepaliveMs) {
        console.log('Lutron: keepalive timed out, dropping session');
        this.socket?.destroy();
        return;
      }
      this.socket?.write('\r\n');
    }, this.opts.keepaliveMs);
  }

  private handleLine(line: string) {
    if (line.replace(/GNET>/g, '').trim() === '') return;
    console.log(`Lutron: << ${line.trim()}`);
    const evt = parseLutronLine(line);
    if (!evt) return;
    if (evt.kind === 'output') {
      if (evt.action !== OUTPUT_ACTION_LEVEL) return;
      this.levels.set(evt.id, evt.value);
      this.resolveQuery(evt.id, evt.value);
      this.emit('output', evt.id, evt.value);
    } else {
      this.emit('device', evt.id, evt.component, evt.action);
    }
  }
}
