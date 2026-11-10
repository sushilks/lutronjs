import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LoxoneWS, DeviceMap } from '../loxoneWSUtil';
import { indexStructure, LoxoneControl } from '../loxoneClient';

/*
  A fake Miniserver built from a structure shaped like a real LoxAPP3.json (Lighting
  Controller circuits as sub-controls, Switch whose active state == uuidAction, an
  UpDownDigital blind without states). Commands change states and stream them back
  like the binary status updates do, so both sync directions run for real.
*/

function structure(lastModified: string, closetTag = '[RA2:4]') {
  return {
    lastModified,
    controls: {
      'lc-1': {
        name: 'Master Bedroom', type: 'LightControllerV2', uuidAction: 'lc-1', states: { activeMoods: 'lc-1-moods' },
        subControls: {
          'lc-1/AI1': { name: 'Main [RA2:5]', type: 'Dimmer', uuidAction: 'lc-1/AI1', states: { position: 's-main', min: 's-min', max: 's-max' } },
          'lc-1/AI3': { name: `Closet ${closetTag}`, type: 'Dimmer', uuidAction: 'lc-1/AI3', states: { position: 's-closet' } },
        },
      },
      'sw-1': { name: 'FrontDriveway [RA2:13]', type: 'Switch', uuidAction: 'sw-1', states: { active: 'sw-1' } },
      'sw-2': { name: 'Porch [CA:13]', type: 'Switch', uuidAction: 'sw-2', states: { active: 'sw-2' } },
      'blind-1': { name: 'Bedroom Blind', type: 'UpDownDigital', uuidAction: 'blind-1' },
      'jal-1': { name: 'Shade [RA2:40]', type: 'Jalousie', uuidAction: 'jal-1', states: { position: 's-jal', targetPosition: 's-jal-t' } },
    },
  };
}

class FakeLutron extends EventEmitter {
  connected = true;
  levels = new Map<number, number>();
  sets: Array<[number, number]> = [];
  reportDelayMs = 0;
  async query(id: number) { return this.levels.get(id); }
  /** what the hub does: apply the level and report it back */
  async setLevel(id: number, level: number) {
    this.sets.push([id, level]);
    setTimeout(() => this.wallPress(id, level), this.reportDelayMs);
  }
  wallPress(id: number, level: number) {
    this.levels.set(id, level);
    this.emit('output', id, level);
  }
}

class FakeMiniserver extends EventEmitter {
  connected = true;
  values = new Map<string, number>();
  commands: Array<[string, string]> = [];
  structure: any;
  pending: any;
  controls = new Map<string, LoxoneControl>();
  /** a block's output wired to a virtual output calling lutronjs over HTTP */
  virtualOutputs = new Map<string, (value: number) => void>();
  /** like a real dimmer that reports integers */
  roundDimmers = false;

  constructor(s: any) { super(); this.pending = s; }
  async start() {}
  findControl(uuid: string) { return this.controls.get(uuid); }
  load() {
    this.structure = this.pending;
    this.controls = indexStructure(this.structure);
    this.emit('structure', this.structure);
  }
  async checkStructureVersion(force = false) {
    if (!force && this.pending.lastModified === this.structure.lastModified) return false;
    this.load();
    return true;
  }
  /** the state a block reports */
  private stateOf(uuid: string) {
    const c = this.controls.get(uuid)!;
    return (c.states.position ?? c.states.active) as string;
  }
  set(stateUuid: string, value: number) {
    const previous = this.values.get(stateUuid);
    if (previous === value) return;
    this.values.set(stateUuid, value);
    setImmediate(() => {
      this.emit('values', [{ uuid: stateUuid, value, previous }]);
      const ctrl = this.controls.get(stateUuid);
      this.virtualOutputs.get(ctrl?.uuidAction ?? '')?.(value);
    });
  }
  async command(uuid: string, cmd: string) {
    this.commands.push([uuid, cmd]);
    const c = this.controls.get(uuid);
    if (!c || c.uuidAction !== uuid) throw new Error(`commands must go to a uuidAction, got ${uuid}`);
    if (c.type === 'Switch') this.set(this.stateOf(uuid), cmd === 'on' ? 1 : 0);
    else if (c.type === 'Dimmer') this.set(this.stateOf(uuid), this.roundDimmers ? Math.round(parseFloat(cmd)) : parseFloat(cmd));
    else if (c.type === 'Jalousie') {
      assert.match(cmd, /^ManualPosition\/\d+(\.\d+)?$/);
      this.jalousieTo(uuid, parseFloat(cmd.split('/')[1]) / 100);
    }
    return {};
  }
  /** like the real block: target jumps, position animates over the travel time */
  jalousieTo(uuid: string, target: number, steps = 5) {
    const c = this.controls.get(uuid)!;
    const from = this.values.get(c.states.position as string) ?? 0;
    this.set(c.states.targetPosition as string, target);
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => this.set(c.states.position as string, from + ((target - from) * i) / steps), i * 15);
    }
  }
  /** someone uses the Loxone app */
  user(uuid: string, value: number) { this.set(this.stateOf(uuid), value); }
}

const buttons: DeviceMap = {
  24: [{ action: 2, uuid: 'blind-1', type: 'direct', command: 'PulseUp' },
       { action: 4, uuid: 'blind-1', type: 'direct', command: 'PulseDown' }],
};

const opts = { settleMs: 20, loxoneSettleMs: 10, shadeSettleMs: 100, shadeTolerance: 2, holdMs: 60, echoMs: 150, reconcileSec: 0, tolerance: 1,
               breakerMax: 5, breakerWindowMs: 1000, breakerCooldownMs: 5000, hubTag: 'RA2', discoveryIntervalSec: 0 };

let lutron: FakeLutron;
let ms: FakeMiniserver;
let sync: LoxoneWS;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(devices: DeviceMap = buttons, extra = {}) {
  lutron = new FakeLutron();
  ms = new FakeMiniserver(structure('v1'));
  sync = new LoxoneWS('h', 'u', 'p', devices, { ...opts, ...extra, client: ms });
  sync.attachLutron(lutron);
  // initial status dump arrives before 'connected' and must not drive Lutron
  ms.connected = false;
  ms.load();
  for (const [u, v] of [['s-main', 0], ['s-closet', 0], ['sw-1', 0], ['s-jal', 1], ['s-jal-t', 1]] as const) ms.set(u, v);
  for (const id of [4, 5, 13, 40]) lutron.levels.set(id, id === 40 ? 0 : 0);
}
async function connect() {
  await wait(5);
  ms.connected = true;
  ms.emit('connected');
  await wait(20);
}

// The HTTP routes, as lutronServer wires them
function httpSet(id: number, v: number) {
  if (sync.beforeLutronSet(id, v)) lutron.setLevel(id, v);
}
function httpToggle(id: number) {
  if (sync.beforeLutronToggle(id)) lutron.setLevel(id, (lutron.levels.get(id) ?? 0) > 0 ? 0 : 100);
}

beforeEach(async () => { setup(); await connect(); });
afterEach(() => { lutron.removeAllListeners(); ms.removeAllListeners(); });

test('initial status dump and connect do not touch Lutron', async () => {
  assert.deepEqual(lutron.sets, []);
  assert.deepEqual(ms.commands, []);
});

test('discovered mapping covers LC circuits and switches for this hub only', () => {
  const st = sync.status();
  const byId = Object.fromEntries(st.devices.map((d) => [`${d.lutronId}:${d.action}`, d]));
  assert.equal(byId['4:1'].uuid, 'lc-1/AI3');
  assert.equal(byId['4:1'].kind, 'level');
  assert.equal(byId['4:1'].source, 'discovered');
  assert.equal(byId['5:1'].name, 'Master Bedroom / Main');
  assert.equal(byId['13:1'].uuid, 'sw-1', 'CA:13 on the other hub ignored');
  assert.equal(byId['13:1'].kind, 'switch');
  assert.equal(byId['40:1'].kind, 'shade');
  assert.equal(byId['24:2'].source, 'static');
});

test('wall press: pushed to Loxone once, Loxone state change is not reflected back', async () => {
  lutron.wallPress(4, 75);
  await wait(300);
  assert.deepEqual(ms.commands, [['lc-1/AI3', '75']]);
  assert.deepEqual(lutron.sets, []);
});

test('fractional Lutron levels vs integer Loxone dimmer do not ping-pong', async () => {
  ms.roundDimmers = true;
  lutron.wallPress(4, 33.33);
  await wait(300);
  assert.equal(ms.commands.length, 1);
  assert.deepEqual(lutron.sets, []);
});

test('Loxone app change goes to Lutron directly, and its echo is not pushed back', async () => {
  ms.user('lc-1/AI3', 60);
  await wait(300);
  assert.deepEqual(lutron.sets, [[4, 60]]);
  assert.deepEqual(ms.commands, []);
});

test('Loxone switch on/off maps to Lutron 100/0', async () => {
  ms.user('sw-1', 1);
  await wait(200);
  ms.user('sw-1', 0);
  await wait(200);
  assert.deepEqual(lutron.sets, [[13, 100], [13, 0]]);
  assert.deepEqual(ms.commands, []);
});

test('slider drag in Loxone with a lagging hub ends at the final value, nothing bounced back', async () => {
  lutron.reportDelayMs = 40;
  for (const v of [20, 40, 60, 80]) { ms.user('lc-1/AI3', v); await wait(5); }
  await wait(400);
  assert.equal(lutron.levels.get(4), 80);
  assert.deepEqual(lutron.sets.at(-1), [4, 80]);
  assert.ok(lutron.sets.length <= 2, `debounced: ${JSON.stringify(lutron.sets)}`);
  assert.deepEqual(ms.commands, []);
});

test('virtual outputs still wired (HTTP) alongside the websocket path do not loop', async () => {
  ms.virtualOutputs.set('lc-1/AI3', (v) => httpSet(4, v));
  ms.virtualOutputs.set('sw-1', () => httpToggle(13)); // worst case: toggle-wired
  lutron.wallPress(4, 50);
  lutron.wallPress(13, 100);
  await wait(400);
  assert.deepEqual(ms.commands.sort(), [['lc-1/AI3', '50'], ['sw-1', 'on']]);
  assert.deepEqual(lutron.sets, []);
  assert.equal(lutron.levels.get(13), 100);
});

test('circuit breaker stops a loop no echo check can recognise', async () => {
  // misconfigured virtual output with the wrong scale: 80 -> 1 -> 80 -> 1 ...
  ms.virtualOutputs.set('lc-1/AI3', (v) => lutron.setLevel(4, v > 1 ? 1 : 80));
  lutron.wallPress(4, 80);
  await wait(1200);
  const n = ms.commands.length + lutron.sets.length;
  await wait(300);
  assert.equal(ms.commands.length + lutron.sets.length, n, 'loop stopped');
  assert.equal(sync.status().devices.find((d) => d.lutronId === 4)!.breakerTripped, true);
});

test('pico buttons from the static button map fire once per press', async () => {
  lutron.emit('device', 24, 2, 3);
  lutron.emit('device', 24, 2, 4);
  lutron.emit('device', 24, 4, 3);
  lutron.emit('device', 24, 4, 4);
  await wait(10);
  assert.deepEqual(ms.commands, [['blind-1', 'PulseUp'], ['blind-1', 'PulseDown']]);
});

test('reconcile makes Loxone match Lutron, only where it drifted', async () => {
  lutron.levels.set(4, 50);
  await sync.reconcile();
  assert.deepEqual(ms.commands, [['lc-1/AI3', '50']]);
});

test('shade: Lutron -> Jalousie ManualPosition, inverted, travel animation not reflected', async () => {
  lutron.wallPress(40, 100); // Lutron fully open
  await wait(300);
  assert.deepEqual(ms.commands, [['jal-1', 'ManualPosition/0']]);
  assert.deepEqual(lutron.sets, [], 'animated position must not drive Lutron');
});

test('shade: Jalousie target (app or automatic shading) -> Lutron once, not every animation step', async () => {
  ms.jalousieTo('jal-1', 0.25); // Loxone sends it 25% down
  await wait(300);
  assert.deepEqual(lutron.sets, [[40, 75]]);
  assert.deepEqual(ms.commands, [], 'Lutron echo not pushed back');
});

test('rescan only reloads on a version change, logs the diff and swaps the mapping', async () => {
  assert.equal((await sync.rescan(false)).changed, false);
  ms.pending = structure('v2', '[RA2:6]'); // block re-tagged in Loxone Config
  lutron.levels.set(6, 30);
  const r = await sync.rescan(false);
  assert.equal(r.changed, true);
  assert.deepEqual(r.discovery!.diff.removed.map((s) => s.split(' ')[0]), ['4:1']);
  assert.deepEqual(r.discovery!.diff.added.map((s) => s.split(' ')[0]), ['6:1']);
  assert.equal(sync.status().devices.find((d) => d.lutronId === 4), undefined);
  assert.deepEqual(ms.commands, [['lc-1/AI3', '30']], 'reconciled after rescan');
  lutron.wallPress(4, 90); // old id is no longer synced
  await wait(100);
  assert.equal(ms.commands.length, 1);
});

test('static entries merge with discovered ones, discovered win, conflicts reported', async () => {
  setup({
    ...buttons,
    4: [{ action: 1, uuid: 'sw-1', name: 'stale' }],          // conflicts with discovered Closet
    5: [{ action: 1, uuid: 's-main', name: 'same block' }],   // a state uuid of the same block: no conflict
    7: [{ action: 1, uuid: 'sw-1', name: 'legacy only' }],
  });
  await connect();
  const st = sync.status();
  const four = st.devices.filter((d) => d.lutronId === 4);
  assert.equal(four.length, 1);
  assert.equal(four[0].source, 'discovered');
  assert.equal(st.devices.find((d) => d.lutronId === 7)!.source, 'static');
  const msgs = st.discovery!.issues.map((i) => i.message);
  assert.ok(msgs.some((m) => m.includes('4:1') && m.includes('overridden')));
  assert.ok(!msgs.some((m) => m.includes('5:1')));
});

test('legacy static mapping by state uuid sends commands to the uuidAction', async () => {
  setup({ 9: [{ action: 1, uuid: 's-closet', type: 'default', mult: 1 }] }, { hubTag: '' });
  await connect();
  lutron.wallPress(9, 40);
  await wait(100);
  assert.deepEqual(ms.commands, [['lc-1/AI3', '40']]);
});

// Replays a real log: pressing the arrow of an Automatic Shading block in the Loxone app sets
// the target to the end stop while pressed and to the reached position on release (~350 ms).
// Forwarding both made the real shade start a full travel and reverse: a wiggle, then a loop.
test('shade: press-and-release in the Loxone app sends only the final position', async () => {
  // shade at rest, fully closed on both sides (Loxone 1 = closed, Lutron 0 = closed)
  ms.set('s-jal-t', 0);       // pressed "up": target fully open
  await wait(35);
  ms.set('s-jal-t', 0.9);     // released: 10 % open
  await wait(250);
  ms.set('s-jal-t', 0);       // pressed again
  await wait(35);
  ms.set('s-jal-t', 0.8);     // released: 20 % open
  await wait(300);
  assert.deepEqual(lutron.sets, [[40, 10], [40, 20]], 'the end-stop target must never reach Lutron');
  assert.deepEqual(ms.commands, [], 'nothing pushed back to Loxone');
  assert.equal(sync.status().devices.find((d) => d.lutronId === 40)!.breakerTripped, false);
});

test('shade: a target that stays at the end stop (full close/open) is still sent', async () => {
  lutron.levels.set(40, 50);
  ms.set('s-jal-t', 0.5);     // at rest half way, matches Lutron: nothing to send
  await wait(250);
  ms.set('s-jal-t', 1);       // fully closed and stays there
  await wait(250);
  assert.deepEqual(lutron.sets, [[40, 0]]);
});

test('shade: differences within the shade tolerance are not sent', async () => {
  lutron.levels.set(40, 21);
  ms.set('s-jal-t', 0.8);     // Loxone simulation says 20 %, real shade is at 21 %
  await wait(250);
  assert.deepEqual(lutron.sets, []);
});
