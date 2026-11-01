import fs from 'node:fs';
import { LoxoneClient } from './loxoneClient';

/*
  Prints Loxone state changes with control names, to find the uuid to put in the
  device map. Uses LOXONE_HOST/LOXONE_USERNAME/LOXONE_PASSWORD or the "loxone"
  section of the JSON file in LOXONE_CONFIG. Read only, never sends commands.
*/

const file = process.env.LOXONE_CONFIG;
const cfg = file?.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8')).loxone ?? {} : {};
const host = process.env.LOXONE_HOST ?? cfg.host;
const username = process.env.LOXONE_USERNAME ?? cfg.username;
const password = process.env.LOXONE_PASSWORD ?? cfg.password;
if (!host || !username || !password) {
  console.error('set LOXONE_HOST, LOXONE_USERNAME and LOXONE_PASSWORD (or a JSON LOXONE_CONFIG)');
  process.exit(1);
}

const client = new LoxoneClient({ host, username, password });
let ready = false;
client.on('connected', () => {
  ready = true;
  console.log('Watching for changes, operate a control in the Loxone app...');
});
client.on('values', (table: Array<{ uuid: string; value: number }>) => {
  if (!ready) return; // skip the initial full dump
  for (const { uuid, value } of table) {
    const ctrl = client.findControl(uuid);
    if (!ctrl) continue;
    const state = Object.entries(ctrl.states).find(([, u]) => u === uuid)?.[0] ?? '?';
    console.log(`${ctrl.name} (${ctrl.type}) uuid=${ctrl.uuidAction} state ${state}=${value}`);
  }
});
client.start();
