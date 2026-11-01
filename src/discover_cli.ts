import fs from 'node:fs';
import { discover } from './discovery';
import { LoxoneClient } from './loxoneClient';

/*
  Dry run of tag discovery: shows what a hub would map, never sends commands.
    npm run discover -- --hub RA2 --file "<backup>/web/data/LoxAPP3.json"
    LOXONE_HOST=.. LOXONE_USERNAME=.. LOXONE_PASSWORD=.. npm run discover -- --hub RA2
*/

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hub = arg('hub') ?? process.env.LUTRON_HUB_TAG;
const file = arg('file');
if (!hub) {
  console.error('usage: discover --hub <RA2|CA> [--file LoxAPP3.json]  (or set LUTRON_HUB_TAG)');
  process.exit(1);
}

function report(structure: any) {
  console.log(`structure ${structure.lastModified}, hub tag ${hub}\n`);
  const d = discover(structure, hub!);
  for (const [id, maps] of [...d.mappings].sort((a, b) => a[0] - b[0])) {
    for (const m of maps) console.log(`  ${String(id).padStart(4)}  ${m.type!.padEnd(6)}  ${m.name}  (${m.uuid})`);
  }
  if (!d.mappings.size) console.log(`  no blocks tagged [${hub}:<id>] yet`);
  if (d.otherHubs) console.log(`\n  ${d.otherHubs} blocks tagged for other hubs`);
  for (const i of d.issues) console.log(`  ${i.level.toUpperCase()}: ${i.message}`);
}

if (file) {
  report(JSON.parse(fs.readFileSync(file, 'utf8')));
} else {
  const { LOXONE_HOST: host, LOXONE_USERNAME: username, LOXONE_PASSWORD: password } = process.env;
  if (!host || !username || !password) {
    console.error('give --file, or set LOXONE_HOST, LOXONE_USERNAME and LOXONE_PASSWORD');
    process.exit(1);
  }
  const client = new LoxoneClient({ host, username, password });
  client.once('structure', (s) => {
    report(s);
    client.stop();
    process.exit(0);
  });
  client.once('handshakeFailed', (e: Error) => {
    console.error(`\nLogin to ${host} as "${username}" failed: ${e.message}`);
    if (/getjwt.*401/.test(e.message)) {
      console.error('The Miniserver rejected the password, or the user may not have app / web interface access.');
    } else if (/getkey2/.test(e.message)) {
      console.error('Check the user name.');
    }
    process.exit(1);
  });
  setTimeout(() => {
    console.error('could not load the structure within 20s (login rejected? see log above)');
    process.exit(1);
  }, 20_000);
  client.start();
}
