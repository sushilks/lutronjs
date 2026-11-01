import fs from 'node:fs';
import path from 'node:path';
import { DeviceMap, LoxoneWS, SyncOptions } from './loxoneWSUtil';

/*
  Loxone sync is enabled by either
   - LOXONE_HOST / LOXONE_USERNAME / LOXONE_PASSWORD (+ LUTRON_HUB_TAG for discovery),
     optionally with LOXONE_CONFIG pointing at a small JSON file for button mappings
     and sync options, see config.example.json
   - LOXONE_CONFIG pointing at a legacy JS module exporting
     `new LoxoneWS(host, user, pass, devMapper)` or any object with devUpdate().
  The env variables override the "loxone" section of the JSON file.
*/

export interface JsonConfig {
  loxone?: { host?: string; username?: string; password?: string };
  sync?: SyncOptions;
  /** static mappings, merged with discovered ones (discovered win) */
  devices?: DeviceMap;
  /** same as devices, for Pico / keypad button mappings */
  buttons?: DeviceMap;
}

export interface LegacySink {
  connect?: () => unknown;
  devUpdate: (id: number, action: number, value: number) => unknown;
}

export type LoxoneSync = LoxoneWS | LegacySink | null;

export function isSyncEngine(s: LoxoneSync): s is LoxoneWS {
  return !!s && typeof (s as LoxoneWS).attachLutron === 'function';
}

export function fromJson(cfg: JsonConfig, env: NodeJS.ProcessEnv = process.env): LoxoneWS | null {
  const host = env.LOXONE_HOST ?? cfg.loxone?.host;
  const username = env.LOXONE_USERNAME ?? cfg.loxone?.username;
  const password = env.LOXONE_PASSWORD ?? cfg.loxone?.password;
  if (!host || !username || !password) {
    console.log('Config: no Loxone host/username/password, Loxone sync disabled');
    return null;
  }
  const devices: DeviceMap = { ...(cfg.devices ?? {}) };
  for (const [id, maps] of Object.entries(cfg.buttons ?? {})) {
    devices[id] = [...(devices[id] ?? []), ...maps.map((m) => ({ type: 'direct' as const, ...m }))];
  }
  return new LoxoneWS(host, username, password, devices, cfg.sync);
}

export function loadLoxoneSync(file = process.env.LOXONE_CONFIG): LoxoneSync {
  if (!file) return fromJson({});
  const abs = path.resolve(file);
  console.log(`Config: loading ${abs}`);
  if (abs.endsWith('.json')) {
    return fromJson(JSON.parse(fs.readFileSync(abs, 'utf8')));
  }
  const mod = require(abs);
  if (isSyncEngine(mod)) return mod;
  if (mod && typeof mod.devUpdate === 'function') {
    console.log('Config: legacy config without sync engine, events are only passed to devUpdate()');
    return mod;
  }
  throw new Error(`${abs} does not export a LoxoneWS instance or a devUpdate() function`);
}
