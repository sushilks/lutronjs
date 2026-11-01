import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/*
  Minimal Loxone Miniserver websocket client (firmware 10+, tested against 17.x).
  Auth: RSA key exchange -> encrypted getkey2 / getjwt using the hashAlg the
  Miniserver asks for (SHA1 on old firmware, SHA256 on current firmware).
  After auth the structure file is loaded and binary status updates enabled,
  so `values` mirrors every state uuid of the Miniserver.
*/

export interface LoxoneControl {
  uuidAction: string;
  name: string;
  type: string;
  states: Record<string, string | string[]>;
  details?: Record<string, unknown>;
  parent?: string;
}

export interface LLResponse {
  control: string;
  value: any;
  code: number;
}

export interface LoxoneClientOptions {
  host: string;
  username: string;
  password: string;
  keepaliveMs?: number;
  requestTimeoutMs?: number;
  clientInfo?: string;
  /** first reconnect delay, doubles up to 60s */
  minBackoffMs?: number;
}

const MSG_TEXT = 0, MSG_FILE = 1, MSG_VALUES = 2, MSG_TEXTS = 3, MSG_OUT_OF_SERVICE = 5, MSG_KEEPALIVE = 6;

/** Loxone binary uuid: uint32 LE, uint16 LE, uint16 LE, 8 bytes -> "xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxxxxxx" */
export function readUuid(buf: Buffer, offset: number): string {
  const d1 = buf.readUInt32LE(offset).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(offset + 4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(offset + 6).toString(16).padStart(4, '0');
  const d4 = buf.subarray(offset + 8, offset + 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}`;
}

export function parseValueTable(buf: Buffer): Array<{ uuid: string; value: number }> {
  const out = [];
  for (let off = 0; off + 24 <= buf.length; off += 24) {
    out.push({ uuid: readUuid(buf, off), value: buf.readDoubleLE(off + 16) });
  }
  return out;
}

export function parseTextTable(buf: Buffer): Array<{ uuid: string; text: string }> {
  const out = [];
  let off = 0;
  while (off + 36 <= buf.length) {
    const uuid = readUuid(buf, off);
    const len = buf.readUInt32LE(off + 32);
    out.push({ uuid, text: buf.toString('utf8', off + 36, off + 36 + len) });
    off += 36 + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

export function parseLL(text: string): LLResponse {
  const ll = JSON.parse(text).LL;
  let value = ll.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* plain string value */ }
  }
  return { control: ll.control, value, code: parseInt(ll.Code ?? ll.code, 10) };
}

/** Index every control and sub-control by its uuidAction and by each of its state uuids. */
export function indexStructure(structure: any): Map<string, LoxoneControl> {
  const index = new Map<string, LoxoneControl>();
  const add = (key: string, ctrl: any, parent?: string) => {
    const c: LoxoneControl = { uuidAction: ctrl.uuidAction ?? key, name: ctrl.name, type: ctrl.type, states: ctrl.states ?? {}, details: ctrl.details, parent };
    index.set(key, c);
    index.set(c.uuidAction, c);
    for (const s of Object.values(c.states)) {
      for (const u of Array.isArray(s) ? s : [s]) if (!index.has(u)) index.set(u, c);
    }
    for (const [subKey, sub] of Object.entries<any>(ctrl.subControls ?? {})) add(subKey, sub, c.uuidAction);
  };
  for (const [key, ctrl] of Object.entries<any>(structure?.controls ?? {})) add(key, ctrl);
  return index;
}

/**
 * Events: 'connected', 'disconnected', 'handshakeFailed' (Error), 'structure' (LoxAPP3.json), 'values' ([{uuid, value, previous}]),
 * 'texts' ([{uuid, text}])
 */
export class LoxoneClient extends EventEmitter {
  public readonly values = new Map<string, number>();
  public controls = new Map<string, LoxoneControl>();
  public structure: any;
  public connected = false;

  private readonly opts: Required<LoxoneClientOptions>;
  private ws?: WebSocket;
  private stopped = false;
  private backoffMs = 2000;
  private nextPayload?: number;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private keepaliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private lastKeepalive = 0;
  private authFailed = false;
  private dropped = new WeakSet<WebSocket>();
  // encryption session for the current socket
  private aesKey = Buffer.alloc(0);
  private aesIv = Buffer.alloc(0);
  private salt = '';
  private saltUses = 0;
  private hashAlg = 'SHA1';
  private token?: { token: string; validUntil: number };
  private readonly clientUuid = crypto.randomUUID();

  constructor(opts: LoxoneClientOptions) {
    super();
    this.opts = { keepaliveMs: 60_000, requestTimeoutMs: 10_000, clientInfo: 'lutronjs', minBackoffMs: 2000, ...opts };
    this.backoffMs = this.opts.minBackoffMs;
  }

  public start(): Promise<void> {
    this.stopped = false;
    const first = new Promise<void>((resolve) => this.once('connected', () => resolve()));
    this.connect();
    return first;
  }

  public stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    clearInterval(this.keepaliveTimer);
    this.ws?.close();
  }

  /**
   * Reload the structure file if the Miniserver reports a different version
   * (or always, with force). Returns true when it was reloaded.
   */
  public async checkStructureVersion(force = false): Promise<boolean> {
    if (!this.connected) return false;
    if (!force) {
      const r = await this.request('jdev/sps/LoxAPPversion3');
      if (String(r.value) === String(this.structure?.lastModified)) return false;
      console.log(`Loxone: structure version changed ${this.structure?.lastModified} -> ${r.value}`);
    }
    await this.loadStructure();
    return true;
  }

  private async loadStructure() {
    const r = await this.request('data/LoxAPP3.json');
    this.structure = r.value;
    this.controls = indexStructure(r.value);
    console.log(`Loxone: structure ${r.value?.lastModified} loaded, ${Object.keys(r.value?.controls ?? {}).length} controls`);
    this.emit('structure', r.value);
  }

  public findControl(uuid: string): LoxoneControl | undefined {
    return this.controls.get(uuid);
  }

  /** Send a control command, e.g. command(uuid, '42') or command(uuid, 'on'). */
  public async command(uuid: string, cmd: string): Promise<LLResponse> {
    const r = await this.request(`jdev/sps/io/${uuid}/${cmd}`);
    if (r.code !== 200) throw new Error(`Loxone rejected ${uuid}/${cmd}: code ${r.code}`);
    return r;
  }

  private connect() {
    const url = `ws://${this.opts.host}/ws/rfc6455`;
    console.log(`Loxone: connecting to ${url}`);
    this.nextPayload = undefined;
    const ws = new WebSocket(url, 'remotecontrol');
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.handshake().catch((e) => {
        console.log(`Loxone: handshake failed: ${e.message ?? e}`);
        // Wrong credentials: back off hard, the Miniserver locks out repeated failed logins.
        if (/code 40[13]/.test(String(e.message))) this.authFailed = true;
        this.emit('handshakeFailed', e);
        this.drop(ws, 'handshake failed');
      });
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    // A connection that fails before opening only fires 'error', never 'close'.
    ws.onerror = () => this.drop(ws, 'websocket error');
    ws.onclose = () => this.drop(ws, 'connection closed');
  }

  /** Tear down a socket and schedule a reconnect, once per socket whatever the cause. */
  private drop(ws: WebSocket, reason: string) {
    if (this.dropped.has(ws)) return;
    this.dropped.add(ws);
    try { ws.close(); } catch { /* already closing */ }
    if (ws !== this.ws) return;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.refreshTimer);
    this.ws = undefined;
    this.pending?.reject(new Error('connection closed'));
    this.pending = undefined;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.emit('disconnected');
    if (this.stopped) return;
    const delay = this.authFailed ? 300_000 : this.backoffMs;
    this.authFailed = false;
    console.log(`Loxone: ${reason}, reconnecting in ${delay / 1000}s`);
    this.emit('reconnecting', delay);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  private async handshake() {
    await this.keyExchange();
    await this.authenticate();
    console.log(`Loxone: authenticated as ${this.opts.username} (${this.hashAlg})`);
    await this.loadStructure();
    // The initial status table arrives right after this response.
    const initial = new Promise<void>((resolve) => this.once('values', () => resolve()));
    await this.request('jdev/sps/enablebinstatusupdate');
    await Promise.race([initial, new Promise((r) => setTimeout(r, 5000))]);
    this.backoffMs = this.opts.minBackoffMs;
    this.startKeepalive();
    this.scheduleTokenRefresh();
    this.connected = true;
    this.emit('connected');
  }

  private async keyExchange() {
    const res = await fetch(`http://${this.opts.host}/jdev/sys/getPublicKey`);
    const pem = parseLL(await res.text()).value as string;
    const key = pem
      .replace(/CERTIFICATE/g, 'PUBLIC KEY')
      .replace(/^(-+BEGIN PUBLIC KEY-+)(\w)/, '$1\n$2')
      .replace(/(-+END PUBLIC KEY-+)/, '\n$1');
    this.aesKey = crypto.randomBytes(32);
    this.aesIv = crypto.randomBytes(16);
    this.salt = '';
    const session = crypto.publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(`${this.aesKey.toString('hex')}:${this.aesIv.toString('hex')}`),
    );
    const r = await this.request(`jdev/sys/keyexchange/${session.toString('base64')}`);
    if (r.code !== 200) throw new Error(`keyexchange failed: code ${r.code}`);
  }

  // Same salt for the whole session, rotated with nextSalt after a while.
  private encrypt(cmd: string): string {
    let prefix: string;
    if (!this.salt) {
      this.salt = crypto.randomBytes(16).toString('hex');
      this.saltUses = 0;
      prefix = `salt/${this.salt}`;
    } else if (++this.saltUses >= 20) {
      const next = crypto.randomBytes(16).toString('hex');
      prefix = `nextSalt/${this.salt}/${next}`;
      this.salt = next;
      this.saltUses = 0;
    } else {
      prefix = `salt/${this.salt}`;
    }
    const cipher = crypto.createCipheriv('aes-256-cbc', this.aesKey, this.aesIv);
    const enc = Buffer.concat([cipher.update(`${prefix}/${cmd}\0`, 'utf8'), cipher.final()]);
    return `jdev/sys/enc/${encodeURIComponent(enc.toString('base64'))}`;
  }

  private hmac(key: string, data: string): string {
    const alg = this.hashAlg.toLowerCase();
    return crypto.createHmac(alg, Buffer.from(key, 'hex')).update(data).digest('hex');
  }

  private async authenticate() {
    const user = this.opts.username;
    const k = await this.request(this.encrypt(`jdev/sys/getkey2/${encodeURIComponent(user)}`));
    if (k.code !== 200) throw new Error(`getkey2 failed: code ${k.code} (unknown user?)`);
    this.hashAlg = k.value.hashAlg ?? 'SHA1';
    const pwHash = crypto.createHash(this.hashAlg.toLowerCase())
      .update(`${this.opts.password}:${k.value.salt}`).digest('hex').toUpperCase();
    const hash = this.hmac(k.value.key, `${user}:${pwHash}`);
    // permission 4 = app token (long lived)
    const t = await this.request(this.encrypt(
      `jdev/sys/getjwt/${hash}/${encodeURIComponent(user)}/4/${this.clientUuid}/${this.opts.clientInfo}`));
    if (t.code !== 200) throw new Error(`getjwt failed: code ${t.code} (bad password or user lacks rights?)`);
    this.token = { token: t.value.token, validUntil: t.value.validUntil };
  }

  // validUntil is seconds since 2009-01-01; refresh a day before expiry.
  private scheduleTokenRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.token) return;
    const expires = Date.UTC(2009, 0, 1) + this.token.validUntil * 1000;
    const delay = Math.min(Math.max(expires - Date.now() - 86_400_000, 60_000), 2 ** 31 - 1);
    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch((e) => {
        if (this.ws) this.drop(this.ws, `token refresh failed (${e.message})`);
      });
    }, delay);
  }

  private async refreshToken() {
    const k = await this.request(this.encrypt('jdev/sys/getkey'));
    const hash = this.hmac(k.value, this.token!.token);
    const r = await this.request(this.encrypt(`jdev/sys/refreshjwt/${hash}/${encodeURIComponent(this.opts.username)}`));
    if (r.code !== 200) throw new Error(`code ${r.code}`);
    this.token = { token: r.value.token ?? this.token!.token, validUntil: r.value.validUntil };
    console.log('Loxone: token refreshed');
    this.scheduleTokenRefresh();
  }

  private startKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.lastKeepalive = Date.now();
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastKeepalive > 2.5 * this.opts.keepaliveMs) {
        if (this.ws) this.drop(this.ws, 'keepalive timed out');
        return;
      }
      this.ws?.send('keepalive');
    }, this.opts.keepaliveMs);
  }

  /** One request in flight at a time; the Miniserver answers in order. */
  private request(cmd: string): Promise<LLResponse> {
    const run = () => new Promise<LLResponse>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error(`timeout waiting for ${cmd.substring(0, 40)}`));
      }, this.opts.requestTimeoutMs);
      this.pending = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
      };
      this.ws.send(cmd);
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private settle(r: LLResponse) {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve(r);
  }

  private onMessage(data: ArrayBuffer | string) {
    if (this.nextPayload === undefined) {
      if (typeof data === 'string') return; // stray text without header
      const hdr = Buffer.from(data);
      if (hdr.length !== 8 || hdr[0] !== 0x03) return;
      const id = hdr[1];
      const estimated = (hdr[2] & 0x80) !== 0;
      if (id === MSG_KEEPALIVE) { this.lastKeepalive = Date.now(); return; }
      if (id === MSG_OUT_OF_SERVICE) {
        // it restarts (e.g. after a Loxone Config save); give it a moment before the first retry
        console.log('Loxone: Miniserver going out of service');
        this.backoffMs = Math.max(this.backoffMs, 5000);
        return;
      }
      if (estimated) return; // the exact header follows
      this.nextPayload = id;
      return;
    }
    const type = this.nextPayload;
    this.nextPayload = undefined;
    this.lastKeepalive = Date.now();
    try {
      if (type === MSG_TEXT) {
        this.settle(parseLL(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')));
      } else if (type === MSG_FILE) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        this.settle({ control: 'file', value: JSON.parse(text), code: 200 });
      } else if (type === MSG_VALUES && typeof data !== 'string') {
        const table = parseValueTable(Buffer.from(data)).map((e) => ({ ...e, previous: this.values.get(e.uuid) }));
        for (const { uuid, value } of table) this.values.set(uuid, value);
        this.emit('values', table);
      } else if (type === MSG_TEXTS && typeof data !== 'string') {
        this.emit('texts', parseTextTable(Buffer.from(data)));
      }
    } catch (e: any) {
      console.log(`Loxone: failed to handle message type ${type}: ${e.message}`);
      if (type === MSG_TEXT || type === MSG_FILE) this.pending?.reject(e);
    }
  }
}
