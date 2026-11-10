import { EventEmitter } from 'node:events';
import { LoxoneClient, LoxoneControl } from './loxoneClient';
import { diffMappings, discover, DiscoveryIssue, KIND_BY_TYPE, mergeMappings, MappingDiff, SyncKind } from './discovery';

/*
  Lutron <-> Loxone state sync.

  Mapping: discovered from "[<HUB>:<id>]" tags in Loxone block names (see discovery.ts),
  merged with static entries (Pico/keypad buttons, legacy devMapper). Rebuilt on every
  structure load and swapped atomically.

  Directions, both over the one Miniserver websocket:
    Lutron -> Loxone: a Lutron level change is sent to the mapped block if its state differs.
    Loxone -> Lutron: a mapped block's state change (Dimmer position, Switch active) is sent
                      to Lutron if the Lutron level differs. The HTTP API (virtual outputs)
                      keeps working too.
  On startup / reconnect / rescan a reconcile makes Loxone match Lutron (Lutron is the truth).

  Loop protection:
    1. state compare: never send a value the other side already has (± tolerance)
    2. origin tags: every value we send is remembered; when the other side reports it back
       it is recognised as ours and not reflected
    3. hold: after one side originates a change for a device, the other direction waits
       until it settles, so a moving slider is never overwritten by a lagging report
    4. circuit breaker: too many syncs of one device in a window pauses that device
*/

export interface DeviceMapping {
  /** 1 = output level. For keypads / picos: the button component number. */
  action: number;
  /** Loxone control uuid (uuidAction; a state uuid of the control also works) */
  uuid: string;
  name?: string;
  /**
   * default: inferred from the Loxone block type. level: push the level. switch: on/off.
   * shade: position, inverted. direct: on button press send `command` (e.g. PulseUp).
   */
  type?: 'default' | 'level' | 'switch' | 'shade' | 'direct';
  mult?: number;
  /** direct: command to send. level/shade: optional template, e.g. "ManualPosition/{value}" */
  command?: string;
  /** level is sent as 100 - level (default for shades: Lutron 100 = open, Loxone 100 = closed) */
  invert?: boolean;
  source?: 'discovered' | 'static';
}

export type DeviceMap = Record<string | number, DeviceMapping[]>;

export interface SyncOptions {
  /** wait for Lutron to settle (fades, paddle holds) before sending to Loxone */
  settleMs?: number;
  /** wait for Loxone to settle (slider drags) before sending to Lutron */
  loxoneSettleMs?: number;
  /** after one side originates a change, the other direction is held this long */
  holdMs?: number;
  /** a report matching what we sent within this window is our own echo */
  echoMs?: number;
  reconcileSec?: number;
  /** level difference (0-100) that counts as in sync */
  tolerance?: number;
  /**
   * Shades move for tens of seconds and a Jalousie press briefly targets the end stop
   * (fully open/closed) until the button is released. Wait this long for a stable target
   * before sending, so a press and release becomes one command with the final position.
   */
  shadeSettleMs?: number;
  /** level difference that counts as in sync for shades (Loxone simulates travel, it drifts) */
  shadeTolerance?: number;
  breakerMax?: number;
  breakerWindowMs?: number;
  breakerCooldownMs?: number;
  /** tag of this hub in Loxone block names, e.g. RA2 -> "[RA2:4]". Default env LUTRON_HUB_TAG. */
  hubTag?: string;
  /** how often to check whether the structure changed. Default env DISCOVERY_INTERVAL_SEC or daily. */
  discoveryIntervalSec?: number;
  /** follow Loxone block state changes and set Lutron (no virtual outputs needed) */
  loxoneToLutron?: boolean;
}

export interface LutronSide extends EventEmitter {
  connected: boolean;
  levels: Map<number, number>;
  query(id: number): Promise<number | undefined>;
  setLevel(id: number, level: number): Promise<void>;
}

export interface LoxoneSide extends EventEmitter {
  connected: boolean;
  values: Map<string, number>;
  structure: any;
  findControl(uuid: string): LoxoneControl | undefined;
  command(uuid: string, cmd: string): Promise<unknown>;
  checkStructureVersion(force?: boolean): Promise<boolean>;
  start(): Promise<void>;
}

type Kind = SyncKind | 'button';

interface Resolved {
  id: number;
  m: DeviceMapping;
  kind: Kind;
  ctrl?: LoxoneControl;
  stateUuid?: string;
}

interface Active {
  byId: Map<number, DeviceMapping[]>;
  resolved: Map<number, Resolved[]>;
  byState: Map<string, Resolved[]>;
}

const RELEASE = 4;
// Jalousie: follow where it is going (targetPosition), not the animated travel (position)
const PRIMARY_STATE: Record<SyncKind, string[]> = { level: ['position', 'value'], switch: ['active'], shade: ['targetPosition', 'position'] };

function fmt(v: number) { return String(Math.round(v * 100) / 100); }
function clamp(v: number) { return Math.min(100, Math.max(0, Math.round(v * 100) / 100)); }

function toMap(devMap: DeviceMap): Map<number, DeviceMapping[]> {
  return new Map(Object.entries(devMap).map(([k, v]) => [parseInt(k, 10), v.map((m) => ({ ...m, source: m.source ?? 'static' as const }))]));
}

export class LoxoneWS {
  private readonly client: LoxoneSide;
  private readonly staticMap: Map<number, DeviceMapping[]>;
  private readonly opts: Required<SyncOptions>;
  private active: Active;
  private lutron?: LutronSide;
  private debug = false;
  private loxonePushTimers = new Map<number, NodeJS.Timeout>();
  private lutronSetTimers = new Map<number, NodeJS.Timeout>();
  /** id -> until: Lutron -> Loxone pushes held (a Loxone originated change is in flight) */
  private loxonePushHold = new Map<number, number>();
  /** id -> until: Loxone -> Lutron sets held (a Lutron originated change is in flight) */
  private lutronSetHold = new Map<number, number>();
  /** what we last sent to Lutron, to recognise its report as ours */
  private expectLutron = new Map<number, { level: number; at: number }>();
  /** state uuid -> what we last sent to Loxone (in Lutron units) */
  private expectLoxone = new Map<string, { level: number; at: number }>();
  private lastPush = new Map<number, { level: number; at: number }>();
  private breaker = new Map<number, { times: number[]; trippedUntil: number }>();
  private reconcileTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;
  private reconciling = false;
  private lastDiscovery?: { at: string; reason: string; structure?: string; issues: DiscoveryIssue[]; diff: MappingDiff };

  constructor(host: string, username: string, password: string, devMap: DeviceMap,
              opts: SyncOptions & { client?: LoxoneSide } = {}) {
    this.client = opts.client ?? new LoxoneClient({ host, username, password });
    this.staticMap = toMap(devMap);
    const envInterval = parseInt(process.env.DISCOVERY_INTERVAL_SEC ?? '', 10);
    this.opts = {
      settleMs: 750, loxoneSettleMs: 300, holdMs: 2500, echoMs: 4000, reconcileSec: 300, tolerance: 1,
      shadeSettleMs: 1500, shadeTolerance: 2,
      breakerMax: 20, breakerWindowMs: 60_000, breakerCooldownMs: 300_000,
      hubTag: process.env.LUTRON_HUB_TAG ?? '',
      discoveryIntervalSec: isNaN(envInterval) ? 86_400 : envInterval,
      loxoneToLutron: true,
      ...opts,
    };
    this.active = this.resolve(this.staticMap);
    if (!this.opts.hubTag) console.log('Sync: LUTRON_HUB_TAG not set, discovery disabled, using static mappings only');
    this.client.on('structure', () => this.rebuild('structure loaded'));
    this.client.on('connected', () => this.reconcile());
    this.client.on('values', (t: Array<{ uuid: string; value: number; previous?: number }>) => this.onLoxoneValues(t));
  }

  public getWS() { return this.client; }
  public setDebug(b: boolean) { this.debug = b; }

  public async connect() {
    this.client.start().catch((e) => console.log(`Loxone: ${e.message}`));
    clearInterval(this.reconcileTimer);
    clearInterval(this.discoveryTimer);
    if (this.opts.reconcileSec > 0) {
      this.reconcileTimer = setInterval(() => this.reconcile(), this.opts.reconcileSec * 1000);
    }
    if (this.opts.hubTag && this.opts.discoveryIntervalSec > 0) {
      this.discoveryTimer = setInterval(() => {
        this.rescan(false).catch((e) => console.log(`Sync: periodic rescan failed: ${e.message}`));
      }, this.opts.discoveryIntervalSec * 1000);
    }
  }

  public attachLutron(lutron: LutronSide) {
    this.lutron = lutron;
    lutron.on('output', (id: number, level: number) => this.devUpdate(id, 1, level));
    lutron.on('device', (id: number, component: number, action: number) => this.devUpdate(id, component, action));
    lutron.on('connected', () => setTimeout(() => this.reconcile(), 2000));
  }

  /** Lutron event entry point (same signature as the original implementation). */
  public devUpdate(id: number, action: number, val: number) {
    const resolved = this.active.resolved.get(id);
    if (!resolved) return;
    if (action === 1 && resolved.some((r) => r.kind !== 'button')) this.onLutronOutput(id, val);
    // Buttons send press then release; fire once, on press.
    if (val === RELEASE) return;
    for (const r of resolved) {
      if (r.kind !== 'button' || r.m.action !== action || !r.m.command) continue;
      console.log(`Sync: button ${id}:${action} -> ${r.m.name ?? r.m.uuid} ${r.m.command}`);
      this.send(r, r.m.command);
    }
  }

  /** HTTP API (virtual output) is about to set a Lutron level. Returns false to drop an echo. */
  public beforeLutronSet(id: number, level: number): boolean {
    const now = Date.now();
    this.loxonePushHold.set(id, now + this.opts.holdMs);
    const pushed = this.lastPush.get(id);
    const current = this.lutron?.levels.get(id);
    if (pushed && now - pushed.at < this.opts.echoMs && current !== undefined
        && Math.abs(current - level) <= this.opts.tolerance) {
      console.log(`Sync: ${id} set ${level} is an echo of our push, Lutron already at ${current}, ignoring`);
      return false;
    }
    this.expectLutron.set(id, { level, at: now });
    return true;
  }

  /** Toggles are not idempotent, so any toggle right after we pushed the device is an echo. */
  public beforeLutronToggle(id: number): boolean {
    const now = Date.now();
    this.loxonePushHold.set(id, now + this.opts.holdMs);
    const pushed = this.lastPush.get(id);
    if (pushed && now - pushed.at < this.opts.echoMs) {
      console.log(`Sync: ${id} toggle ${now - pushed.at}ms after our push, treating as echo, ignoring`);
      return false;
    }
    return true;
  }

  /** Make Loxone match Lutron for every synced device. */
  public async reconcile() {
    if (this.reconciling || !this.lutron?.connected || !this.client.connected) return;
    this.reconciling = true;
    try {
      for (const [id, resolved] of this.active.resolved) {
        if (!resolved.some((r) => r.kind !== 'button')) continue;
        await this.lutron.query(id);
        if (this.isHeld(this.loxonePushHold, id)) continue;
        await this.pushToLoxone(id, 'reconcile');
      }
    } catch (e: any) {
      console.log(`Sync: reconcile failed: ${e.message}`);
    } finally {
      this.reconciling = false;
    }
  }

  /** Re-read the structure (if its version changed, or always with force), rebuild, reconcile. */
  public async rescan(force: boolean) {
    const changed = await this.client.checkStructureVersion(force);
    if (changed) await this.reconcile();
    return { changed, discovery: this.lastDiscovery ?? null };
  }

  public status() {
    const out = [];
    for (const [id, resolved] of this.active.resolved) {
      for (const r of resolved) {
        const level = this.lutron?.levels.get(id);
        const lox = this.loxoneLevel(r);
        const b = this.breaker.get(id);
        out.push({
          lutronId: id, action: r.m.action, source: r.m.source ?? 'static', kind: r.kind,
          name: r.m.name ?? null, uuid: r.ctrl?.uuidAction ?? r.m.uuid,
          loxoneControl: r.ctrl ? `${r.ctrl.name} (${r.ctrl.type})` : null,
          command: r.m.command ?? null,
          lutronLevel: level ?? null,
          loxoneLevel: lox ?? null,
          inSync: r.kind === 'button' || level === undefined || lox === undefined ? null : this.near(r, level, lox),
          lastPush: this.lastPush.get(id) ?? null,
          breakerTripped: !!b && b.trippedUntil > Date.now(),
        });
      }
    }
    return {
      lutronConnected: !!this.lutron?.connected,
      loxoneConnected: this.client.connected,
      hubTag: this.opts.hubTag || null,
      discovery: this.lastDiscovery ?? null,
      devices: out,
    };
  }

  // ---- mapping ----

  private kindOf(m: DeviceMapping, ctrl?: LoxoneControl): Kind {
    if (m.type === 'direct') return 'button';
    if (m.type === 'level' || m.type === 'switch' || m.type === 'shade') return m.type;
    return (ctrl && KIND_BY_TYPE[ctrl.type]) || 'level';
  }

  private resolve(byId: Map<number, DeviceMapping[]>): Active {
    const resolved = new Map<number, Resolved[]>();
    const byState = new Map<string, Resolved[]>();
    for (const [id, maps] of byId) {
      const list: Resolved[] = [];
      for (const m of maps) {
        const ctrl = this.client.findControl(m.uuid);
        const kind = this.kindOf(m, ctrl);
        let stateUuid: string | undefined;
        if (kind !== 'button' && ctrl) {
          for (const n of PRIMARY_STATE[kind]) {
            const s = ctrl.states[n];
            if (typeof s === 'string') { stateUuid = s; break; }
          }
        }
        const r: Resolved = { id, m, kind, ctrl, stateUuid };
        list.push(r);
        if (stateUuid) byState.set(stateUuid, [...(byState.get(stateUuid) ?? []), r]);
      }
      resolved.set(id, list);
    }
    return { byId, resolved, byState };
  }

  private rebuild(reason: string): MappingDiff {
    const issues: DiscoveryIssue[] = [];
    let discovered = new Map<number, DeviceMapping[]>();
    const structure = this.client.structure;
    if (this.opts.hubTag && structure) {
      const d = discover(structure, this.opts.hubTag);
      discovered = d.mappings;
      issues.push(...d.issues);
      console.log(`Discovery [${this.opts.hubTag}]: ${d.mappings.size} tagged blocks for this hub` +
        (d.otherHubs ? `, ${d.otherHubs} for other hubs` : ''));
    }
    const sameControl = (a: string, b: string) =>
      (this.client.findControl(a)?.uuidAction ?? a) === (this.client.findControl(b)?.uuidAction ?? b);
    const { merged, conflicts } = mergeMappings(this.staticMap, discovered, sameControl);
    issues.push(...conflicts.map((message) => ({ level: 'warning' as const, message })));
    const diff = diffMappings(this.active.byId, merged);
    const next = this.resolve(merged);
    if (structure) {
      for (const [id, list] of next.resolved) {
        for (const r of list) {
          if (!r.ctrl) issues.push({ level: 'warning', message: `${r.m.source} mapping ${id}:${r.m.action} -> ${r.m.name ?? r.m.uuid} not found in Loxone structure` });
          else if (r.kind !== 'button' && !r.stateUuid) issues.push({ level: 'warning', message: `${id} -> "${r.ctrl.name}" (${r.ctrl.type}) has no state to follow, Loxone -> Lutron and state compare disabled for it` });
        }
      }
    }
    for (const i of issues) console.log(`Discovery: ${i.level.toUpperCase()} ${i.message}`);
    for (const a of diff.added) console.log(`Discovery: + ${a}`);
    for (const r of diff.removed) console.log(`Discovery: - ${r}`);
    for (const c of diff.changed) console.log(`Discovery: ~ ${c}`);
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) console.log('Discovery: mapping unchanged');
    this.active = next; // atomic swap
    this.lastDiscovery = { at: new Date().toISOString(), reason, structure: structure?.lastModified, issues, diff };
    return diff;
  }

  // ---- conversions (everything compared in Lutron units, 0-100) ----

  private toLoxone(r: Resolved, level: number): string {
    const m = r.m;
    if (r.kind === 'switch') return level > 0 ? 'on' : 'off';
    if (r.kind === 'shade') {
      const pct = m.invert === false ? level : 100 - level;
      // ManualPosition takes 0 (open) .. 100 (closed)
      return (m.command ?? 'ManualPosition/{value}').replace('{value}', fmt(pct));
    }
    const v = (m.invert ? 100 - level : level) * (m.mult ?? 1);
    return m.command ? m.command.replace('{value}', fmt(v)) : fmt(v);
  }

  private fromLoxone(r: Resolved, value: number): number {
    if (r.kind === 'switch') return value > 0 ? 100 : 0;
    if (r.kind === 'shade') return clamp(r.m.invert === false ? value * 100 : 100 - value * 100);
    const l = value / (r.m.mult ?? 1);
    return clamp(r.m.invert ? 100 - l : l);
  }

  private loxoneLevel(r: Resolved): number | undefined {
    const v = r.stateUuid ? this.client.values.get(r.stateUuid) : undefined;
    return v === undefined || r.kind === 'button' ? undefined : this.fromLoxone(r, v);
  }

  private tolerance(r: Resolved) {
    return r.kind === 'shade' ? this.opts.shadeTolerance : this.opts.tolerance;
  }

  private near(r: Resolved, a: number, b: number) {
    if (r.kind === 'switch') return (a > 0) === (b > 0);
    return Math.abs(a - b) <= this.tolerance(r);
  }

  private isShade(id: number) {
    return (this.active.resolved.get(id) ?? []).some((r) => r.kind === 'shade');
  }

  private isHeld(map: Map<number, number>, id: number) { return (map.get(id) ?? 0) > Date.now(); }

  private isOurs(e: { level: number; at: number } | undefined, r: Resolved | null, level: number) {
    if (!e || Date.now() - e.at >= this.opts.echoMs) return false;
    return r ? this.near(r, e.level, level) : Math.abs(e.level - level) <= this.opts.tolerance;
  }

  // ---- Lutron -> Loxone ----

  private onLutronOutput(id: number, level: number) {
    if (this.isOurs(this.expectLutron.get(id), null, level)) {
      if (this.debug) console.log(`Sync: Lutron ${id}=${level} is the result of our set, not reflecting`);
      return;
    }
    this.scheduleLoxonePush(id);
  }

  private scheduleLoxonePush(id: number, delay = this.isShade(id) ? this.opts.shadeSettleMs : this.opts.settleMs) {
    clearTimeout(this.loxonePushTimers.get(id));
    this.loxonePushTimers.set(id, setTimeout(() => {
      this.loxonePushTimers.delete(id);
      const held = (this.loxonePushHold.get(id) ?? 0) - Date.now();
      if (held > 0) return this.scheduleLoxonePush(id, held + 50);
      this.pushToLoxone(id, 'lutron change');
    }, delay));
  }

  private async pushToLoxone(id: number, reason: string) {
    const level = this.lutron?.levels.get(id);
    if (level === undefined) return;
    for (const r of this.active.resolved.get(id) ?? []) {
      if (r.kind === 'button') continue;
      const lox = this.loxoneLevel(r);
      const pushed = this.lastPush.get(id);
      // No mirrored state (control unknown): fall back to what we sent last.
      const inSync = lox !== undefined ? this.near(r, level, lox)
        : pushed !== undefined && Math.abs(pushed.level - level) <= this.tolerance(r);
      if (inSync) {
        if (this.debug) console.log(`Sync: ${id} ${r.m.name ?? ''} already in sync (${level})`);
        continue;
      }
      if (!this.client.connected) continue; // reconcile catches up on reconnect
      if (!this.breakerAllows(id, r.m)) continue;
      const cmd = this.toLoxone(r, level);
      console.log(`Sync: [${reason}] Lutron ${id}=${level} -> Loxone "${r.m.name ?? r.m.uuid}" ${cmd} (was ${lox ?? '?'})`);
      const now = Date.now();
      this.lastPush.set(id, { level, at: now });
      if (r.stateUuid) this.expectLoxone.set(r.stateUuid, { level, at: now });
      this.lutronSetHold.set(id, now + this.opts.holdMs);
      await this.send(r, cmd);
    }
  }

  // ---- Loxone -> Lutron ----

  private onLoxoneValues(table: Array<{ uuid: string; value: number; previous?: number }>) {
    // The full dump right after connecting is not a change; Lutron is the truth then.
    if (!this.client.connected || !this.opts.loxoneToLutron) return;
    for (const { uuid, value, previous } of table) {
      if (previous === undefined || previous === value) continue;
      for (const r of this.active.byState.get(uuid) ?? []) {
        const level = this.fromLoxone(r, value);
        if (this.isOurs(this.expectLoxone.get(uuid), r, level)) {
          if (this.debug) console.log(`Sync: Loxone "${r.m.name}"=${level} is the result of our push, not reflecting`);
          continue;
        }
        this.scheduleLutronSet(r);
      }
    }
  }

  // Every new Loxone value restarts the wait, so only the settled target is sent.
  private scheduleLutronSet(r: Resolved, delay = r.kind === 'shade' ? this.opts.shadeSettleMs : this.opts.loxoneSettleMs) {
    clearTimeout(this.lutronSetTimers.get(r.id));
    this.lutronSetTimers.set(r.id, setTimeout(() => {
      this.lutronSetTimers.delete(r.id);
      const held = (this.lutronSetHold.get(r.id) ?? 0) - Date.now();
      if (held > 0) return this.scheduleLutronSet(r, held + 50);
      this.setLutron(r);
    }, delay));
  }

  private async setLutron(r: Resolved) {
    const level = this.loxoneLevel(r);
    const lutron = this.lutron;
    if (level === undefined || !lutron?.connected) return;
    const current = lutron.levels.get(r.id);
    if (current !== undefined && this.near(r, current, level)) return;
    if (!this.breakerAllows(r.id, r.m)) return;
    console.log(`Sync: [loxone change] Loxone "${r.m.name ?? r.m.uuid}" -> Lutron ${r.id}=${level} (was ${current ?? '?'})`);
    const now = Date.now();
    this.expectLutron.set(r.id, { level, at: now });
    this.loxonePushHold.set(r.id, now + this.opts.holdMs);
    await lutron.setLevel(r.id, level);
  }

  // ---- shared ----

  private breakerAllows(id: number, m: DeviceMapping): boolean {
    const now = Date.now();
    const b = this.breaker.get(id) ?? { times: [], trippedUntil: 0 };
    this.breaker.set(id, b);
    if (b.trippedUntil > now) return false;
    b.times = b.times.filter((t) => now - t < this.opts.breakerWindowMs);
    b.times.push(now);
    if (b.times.length > this.opts.breakerMax) {
      b.trippedUntil = now + this.opts.breakerCooldownMs;
      b.times = [];
      console.log(`Sync: !!! LOOP DETECTED for Lutron ${id} (${m.name ?? m.uuid}): ` +
        `more than ${this.opts.breakerMax} syncs in ${this.opts.breakerWindowMs / 1000}s. ` +
        `Pausing sync for this device for ${this.opts.breakerCooldownMs / 1000}s. ` +
        `Check its Loxone virtual output (toggle endpoint? different scale?).`);
      return false;
    }
    return true;
  }

  private async send(r: Resolved, cmd: string) {
    const uuid = r.ctrl?.uuidAction ?? this.client.findControl(r.m.uuid)?.uuidAction ?? r.m.uuid;
    try {
      await this.client.command(uuid, cmd);
    } catch (e: any) {
      console.log(`Sync: Loxone command ${uuid}/${cmd} failed: ${e.message}`);
    }
  }
}
