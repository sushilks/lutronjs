import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffMappings, discover, mergeMappings, parseTags, stripTags } from '../discovery';
import { DeviceMapping } from '../loxoneWSUtil';

test('parseTags: valid tags, case, spacing, multiple', () => {
  assert.deepEqual(parseTags('Closet [RA2:4]'), [{ ok: true, hub: 'RA2', id: 4 }]);
  assert.deepEqual(parseTags('Driveway [ca : 13]'), [{ ok: true, hub: 'CA', id: 13 }]);
  assert.deepEqual(parseTags('Both [RA2:4] [CA:9]').map((t) => t.ok && t.id), [4, 9]);
  assert.deepEqual(parseTags('Plain name'), []);
  assert.deepEqual(parseTags('Dining [Upstairs]'), [], 'non-tag brackets are ignored');
});

test('parseTags: malformed tags are reported', () => {
  for (const name of ['X [RA2:abc]', 'X [RA2 4]', 'X [RA2-4]', 'X [RA2:4', 'X [RA2:0]', 'X [RA2:]']) {
    const t = parseTags(name);
    assert.equal(t.length, 1, name);
    assert.equal(t[0].ok, false, name);
    assert.equal(t[0].hub, 'RA2', name);
  }
});

test('stripTags', () => {
  assert.equal(stripTags('Closet [RA2:4]'), 'Closet');
  assert.equal(stripTags('[RA2:4] Closet'), 'Closet');
});

const S = {
  controls: {
    lc: { name: 'Kitchen', type: 'LightControllerV2', uuidAction: 'lc', states: {}, subControls: {
      'lc/AI1': { name: 'Island [RA2:10]', type: 'Dimmer', uuidAction: 'lc/AI1', states: { position: 'p1' } },
      'lc/AI2': { name: 'Color [RA2:11]', type: 'ColorPickerV2', uuidAction: 'lc/AI2', states: {} },
    } },
    a: { name: 'Porch [RA2:12]', type: 'Switch', uuidAction: 'a', states: { active: 'a' } },
    b: { name: 'Bell [RA2:13]', type: 'Pushbutton', uuidAction: 'b', states: { active: 'b' } },
    c: { name: 'Shade [RA2:14]', type: 'Jalousie', uuidAction: 'c', states: { position: 'cp' } },
    d: { name: 'Hall dim [RA2:15]', type: 'EIBDimmer', uuidAction: 'd', states: { position: 'dp' } },
    k: { name: 'Chandelier [RA2:17]', type: 'Slider', uuidAction: 'k', states: { value: 'k' } },
    e: { name: 'Blind [RA2:16]', type: 'UpDownDigital', uuidAction: 'e' },
    f: { name: 'Copy 1 [RA2:20]', type: 'Switch', uuidAction: 'f', states: { active: 'f' } },
    g: { name: 'Copy 2 [RA2:20]', type: 'Switch', uuidAction: 'g', states: { active: 'g' } },
    h: { name: 'Double [RA2:21][RA2:22]', type: 'Switch', uuidAction: 'h', states: { active: 'h' } },
    i: { name: 'Typo [RA2:x1]', type: 'Switch', uuidAction: 'i', states: { active: 'i' } },
    j: { name: 'Other hub [CA:10]', type: 'Switch', uuidAction: 'j', states: { active: 'j' } },
  },
};

test('discover: type inference, sub-controls, other hubs', () => {
  const d = discover(S, 'ra2');
  const kind = (id: number) => d.mappings.get(id)?.[0].type;
  assert.equal(kind(10), 'level');
  assert.equal(d.mappings.get(10)![0].uuid, 'lc/AI1');
  assert.equal(d.mappings.get(10)![0].name, 'Kitchen / Island');
  assert.equal(kind(12), 'switch');
  assert.equal(kind(13), 'switch');
  assert.equal(kind(14), 'shade');
  assert.equal(d.mappings.get(14)![0].invert, true);
  assert.equal(kind(15), 'level');
  assert.equal(kind(17), 'level');
  assert.equal(d.otherHubs, 1);
  assert.ok(d.mappings.get(10)![0].source === 'discovered');
});

test('discover: unsupported types, duplicates, double tags and typos are flagged and skipped', () => {
  const d = discover(S, 'RA2');
  for (const id of [11, 16, 20, 21, 22]) assert.equal(d.mappings.has(id), false, `id ${id}`);
  const msg = d.issues.map((i) => `${i.level}: ${i.message}`).join('\n');
  assert.match(msg, /warning: "Kitchen \/ Color \[RA2:11\]" is a ColorPickerV2/);
  assert.match(msg, /warning: "Blind \[RA2:16\]" is a UpDownDigital/);
  assert.match(msg, /error: Lutron RA2:20 is tagged on 2 blocks/);
  assert.match(msg, /error: "Double \[RA2:21\]\[RA2:22\]" has 2 RA2 tags/);
  assert.match(msg, /error: malformed tag \[RA2:x1\]/);
  assert.equal(d.issues.filter((i) => i.message.includes('CA')).length, 0, "other hub's tags are not our problem");
});

test('mergeMappings: discovered wins, same-block duplicates are silent, buttons kept', () => {
  const m = (uuid: string, extra: Partial<DeviceMapping> = {}): DeviceMapping => ({ action: 1, uuid, ...extra });
  const discovered = new Map([[1, [m('A', { source: 'discovered' })]], [2, [m('B', { source: 'discovered' })]]]);
  const stat = new Map([
    [1, [m('X'), m('BTN', { action: 2, type: 'direct', command: 'PulseUp' })]],
    [2, [m('B-state')]],
    [3, [m('C')]],
  ]);
  const same = (a: string, b: string) => a.split('-')[0] === b.split('-')[0];
  const { merged, conflicts } = mergeMappings(stat, discovered, same);
  assert.deepEqual(merged.get(1)!.map((x) => [x.uuid, x.source]), [['A', 'discovered'], ['BTN', 'static']]);
  assert.deepEqual(merged.get(2)!.map((x) => x.uuid), ['B']);
  assert.deepEqual(merged.get(3)!.map((x) => [x.uuid, x.source]), [['C', 'static']]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /1:1 -> X overridden/);
});

test('diffMappings: added, removed, changed', () => {
  const before = new Map<number, DeviceMapping[]>([[1, [{ action: 1, uuid: 'a' }]], [2, [{ action: 1, uuid: 'b' }]]]);
  const after = new Map<number, DeviceMapping[]>([[1, [{ action: 1, uuid: 'a2' }]], [3, [{ action: 1, uuid: 'c' }]]]);
  const d = diffMappings(before, after);
  assert.equal(d.added.length, 1);
  assert.match(d.added[0], /^3:1/);
  assert.equal(d.removed.length, 1);
  assert.match(d.removed[0], /^2:1/);
  assert.equal(d.changed.length, 1);
  assert.match(d.changed[0], /^1:1 -> "a".*=>.*"a2"/);
  assert.deepEqual(diffMappings(after, after), { added: [], removed: [], changed: [] });
});
