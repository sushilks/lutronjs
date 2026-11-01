import express, { Request, Response } from 'express';
import { LutronTelnet } from './lutronTelnet';
import { isSyncEngine, loadLoxoneSync, LoxoneSync } from './config';

export interface LutronLike {
  connected: boolean;
  levels: Map<number, number>;
  query(id: number): Promise<number | undefined>;
  setLevel(id: number, level: number): Promise<void>;
}

function parseId(req: Request, res: Response): number | undefined {
  const id = parseInt(String(req.params.deviceid), 10);
  if (isNaN(id) || id < 0) {
    res.status(400).send('invalid device id');
    return undefined;
  }
  return id;
}

export function createApp(lutron: LutronLike, sync: LoxoneSync) {
  const engine = isSyncEngine(sync) ? sync : null;
  const app = express();

  app.get('/v0/device/:deviceid', async (req, res) => {
    const id = parseId(req, res);
    if (id === undefined) return;
    const value = await lutron.query(id);
    const result = { deviceId: String(id), value: value ?? null };
    console.log(`HTTP: GET device ${id} -> ${JSON.stringify(result)}`);
    res.status(200).json(result);
  });

  app.put('/v0/device/:deviceid/value/:value', async (req, res) => {
    const id = parseId(req, res);
    if (id === undefined) return;
    const value = parseFloat(String(req.params.value));
    if (isNaN(value) || value < 0 || value > 100) {
      res.status(400).send('value must be 0-100');
      return;
    }
    console.log(`HTTP: PUT device ${id} = ${value}`);
    if (!engine || engine.beforeLutronSet(id, value)) await lutron.setLevel(id, value);
    res.status(200).send('ok');
  });

  app.put('/v0/toggle/:deviceid', async (req, res) => {
    const id = parseId(req, res);
    if (id === undefined) return;
    console.log(`HTTP: PUT toggle ${id}`);
    if (!engine || engine.beforeLutronToggle(id)) {
      const current = lutron.levels.has(id) ? lutron.levels.get(id) : await lutron.query(id);
      await lutron.setLevel(id, current !== undefined && current > 0 ? 0 : 100);
    }
    res.status(200).send('ok');
  });

  app.get('/v0/status/all', (_req, res) => {
    res.status(200).json(Object.fromEntries(lutron.levels));
  });

  app.get('/v0/sync', (_req, res) => {
    if (!engine) {
      res.status(404).json({ error: 'Loxone sync not configured' });
      return;
    }
    res.status(200).json(engine.status());
  });

  app.post('/v0/sync/reconcile', async (_req, res) => {
    if (!engine) {
      res.status(404).json({ error: 'Loxone sync not configured' });
      return;
    }
    await engine.reconcile();
    res.status(200).json(engine.status());
  });

  app.post('/v0/sync/rescan', async (_req, res) => {
    if (!engine) {
      res.status(404).json({ error: 'Loxone sync not configured' });
      return;
    }
    const result = await engine.rescan(true);
    res.status(200).json({ ...result, status: engine.status() });
  });

  app.get('/healthz', (_req, res) => {
    const body = {
      lutron: lutron.connected,
      loxone: engine ? engine.getWS().connected : 'disabled',
    };
    res.status(lutron.connected ? 200 : 503).json(body);
  });

  return app;
}

async function main() {
  const port = parseInt(process.env.LUTRON_SERVER_PORT ?? '8082', 10);
  const host = process.env.LUTRON_SERVER_IP ?? '127.0.0.1';
  const lutron = new LutronTelnet({
    host,
    port: parseInt(process.env.LUTRON_TELNET_PORT ?? '23', 10),
    username: process.env.LUTRON_USERNAME ?? 'lutron',
    password: process.env.LUTRON_PASSWORD ?? 'integration',
  });
  const sync = loadLoxoneSync();
  if (isSyncEngine(sync)) {
    sync.attachLutron(lutron);
  } else if (sync) {
    lutron.on('output', (id: number, level: number) => sync.devUpdate(id, 1, level));
    lutron.on('device', (id: number, component: number, action: number) => sync.devUpdate(id, component, action));
  }
  sync?.connect?.();

  const app = createApp(lutron, sync);
  app.listen(port, () => console.log(`HTTP: listening on port ${port}`));
  // Serve right away: /healthz reports 503 until the hub session is up.
  await lutron.start();

  const shutdown = () => {
    lutron.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
