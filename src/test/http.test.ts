import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { createApp, LutronLike } from '../lutronServer';

test('HTTP API keeps the routes Loxone virtual outputs use', async () => {
  const sets: Array<[number, number]> = [];
  const lutron: LutronLike = {
    connected: true,
    levels: new Map([[5, 0]]),
    async query(id) { return this.levels.get(id); },
    async setLevel(id, v) { sets.push([id, v]); this.levels.set(id, v); },
  };
  const server = createApp(lutron, null).listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal(await (await fetch(`${base}/v0/device/5/value/20`, { method: 'PUT' })).text(), 'ok');
  assert.deepEqual(await (await fetch(`${base}/v0/device/5`)).json(), { deviceId: '5', value: 20 });
  await fetch(`${base}/v0/toggle/5`, { method: 'PUT' });
  assert.deepEqual(sets, [[5, 20], [5, 0]]);
  assert.deepEqual(await (await fetch(`${base}/v0/status/all`)).json(), { 5: 0 });
  assert.equal((await fetch(`${base}/v0/device/5/value/200`, { method: 'PUT' })).status, 400);
  assert.equal((await fetch(`${base}/v0/device/abc`)).status, 400);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  server.close();
});
