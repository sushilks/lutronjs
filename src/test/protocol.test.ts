import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { LutronTelnet, parseLutronLine } from '../lutronTelnet';
import { indexStructure, LoxoneClient, parseLL, parseTextTable, parseValueTable, readUuid } from '../loxoneClient';

test('parseLutronLine handles prompts and event types', () => {
  assert.deepEqual(parseLutronLine('GNET> ~OUTPUT,12,1,75.00'), { kind: 'output', id: 12, action: 1, value: 75 });
  assert.deepEqual(parseLutronLine('GNET> GNET> ~DEVICE,30,2,3'), { kind: 'device', id: 30, component: 2, action: 3 });
  assert.equal(parseLutronLine('~ERROR,6'), null);
  assert.equal(parseLutronLine('#OUTPUT,1,1,5'), null);
  assert.equal(parseLutronLine('garbage'), null);
});

/** A tiny Lutron hub: login prompts, then batches events into single writes. */
function fakeHub() {
  const received: string[] = [];
  let sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.setEncoding('utf8');
    s.write('login: ');
    let state = 'user', buf = '';
    s.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.substring(0, i);
        buf = buf.substring(i + 2);
        if (state === 'user') { state = 'pass'; s.write('password: '); continue; }
        if (state === 'pass') { state = 'in'; s.write('\r\nGNET> '); continue; }
        received.push(line);
        const q = /^\?OUTPUT,(\d+),1$/.exec(line);
        if (q) s.write(`~OUTPUT,${q[1]},1,42.00\r\nGNET> `);
        else s.write('GNET> ');
      }
    });
  });
  return { server, received, get sockets() { return sockets; }, reset() { sockets = []; } };
}

test('telnet client logs in, parses batched/partial events, queries, reconnects', async () => {
  const hub = fakeHub();
  hub.server.listen(0);
  await once(hub.server, 'listening');
  const port = (hub.server.address() as net.AddressInfo).port;
  const lutron = new LutronTelnet({ host: '127.0.0.1', port, keepaliveMs: 60_000 });
  const outputs: Array<[number, number]> = [];
  const buttons: Array<[number, number, number]> = [];
  lutron.on('output', (id, v) => outputs.push([id, v]));
  lutron.on('device', (id, c, a) => buttons.push([id, c, a]));
  await lutron.start();
  assert.equal(lutron.connected, true);

  // several events in one chunk, one split across chunks, prompt prefixes
  const s = hub.sockets[0];
  s.write('~OUTPUT,1,1,100.00\r\nGNET> ~OUTPUT,2,1,50.00\r\n~DEV');
  await new Promise((r) => setTimeout(r, 20));
  s.write('ICE,30,2,3\r\nGNET> ');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(outputs, [[1, 100], [2, 50]]);
  assert.deepEqual(buttons, [[30, 2, 3]]);

  assert.equal(await lutron.query(7), 42);
  await lutron.setLevel(7, 10);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(hub.received.includes('#OUTPUT,7,1,10'));

  // hub drops the session -> client reconnects by itself
  hub.reset();
  s.destroy();
  await once(lutron, 'connected');
  assert.equal(lutron.connected, true);
  lutron.stop();
  hub.server.close();
});

test('loxone uuid and event tables decode', () => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(0x12345678, 0);
  buf.writeUInt16LE(0x9abc, 4);
  buf.writeUInt16LE(0xdef0, 6);
  Buffer.from('0011223344556677', 'hex').copy(buf, 8);
  buf.writeDoubleLE(37.5, 16);
  assert.equal(readUuid(buf, 0), '12345678-9abc-def0-0011223344556677');
  assert.deepEqual(parseValueTable(buf), [{ uuid: '12345678-9abc-def0-0011223344556677', value: 37.5 }]);

  const t = Buffer.alloc(36 + 8);
  buf.copy(t, 0, 0, 16);
  t.writeUInt32LE(5, 32);
  t.write('hello', 36);
  assert.deepEqual(parseTextTable(t), [{ uuid: '12345678-9abc-def0-0011223344556677', text: 'hello' }]);
});

test('parseLL handles both Code spellings and JSON string values', () => {
  assert.deepEqual(parseLL('{"LL":{"control":"x","value":"{\'a\':1}","Code":"200"}}').code, 200);
  assert.deepEqual(parseLL('{"LL":{"control":"x","value":"{\\"key\\":\\"ab\\"}","code":"401"}}'),
    { control: 'x', value: { key: 'ab' }, code: 401 });
});

test('indexStructure resolves controls, subcontrols and state uuids', () => {
  const idx = indexStructure({ controls: {
    'p-1': { name: 'Lights', type: 'LightControllerV2', uuidAction: 'p-1', states: { activeMoods: 's-0' },
      subControls: { 'p-1/AI1': { name: 'Ceiling', type: 'Dimmer', uuidAction: 'p-1/AI1', states: { position: 's-1' } } } },
  } });
  assert.equal(idx.get('p-1/AI1')!.type, 'Dimmer');
  assert.equal(idx.get('s-1')!.name, 'Ceiling');
  assert.equal(idx.get('s-1')!.parent, 'p-1');
  assert.equal(idx.get('s-0')!.name, 'Lights');
});

test('loxone client keeps retrying when the Miniserver is down (error without close)', async () => {
  const c = new LoxoneClient({ host: '127.0.0.1:9', username: 'u', password: 'p', minBackoffMs: 30 });
  const delays: number[] = [];
  c.on('reconnecting', (d: number) => delays.push(d));
  c.start();
  await new Promise((r) => setTimeout(r, 600));
  c.stop();
  assert.ok(delays.length >= 3, `retried ${delays.length} times`);
  assert.deepEqual(delays.slice(0, 3), [30, 60, 120], 'backoff doubles');
});
