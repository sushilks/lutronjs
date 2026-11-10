# lutronjs

Bridge between Lutron **RA2 Select** / **Caseta Smart Bridge Pro** hubs (telnet integration protocol)
and a **Loxone** Miniserver, with two-way state sync. Loxone Config is the single source of truth
for the mapping: you tag Loxone blocks with the Lutron ID they control, and lutronjs finds them.

Run one instance per hub.

## Loxone setup

1. **Tag the block** that represents each Lutron load. Put `[<HUB>:<lutronId>]` in the block name:

   | Lutron load | Loxone block | Example name |
   | --- | --- | --- |
   | dimmer | Lighting Controller circuit, Dimmer / EIB Dimmer block, or Slider (analog virtual input) | `Closet [RA2:4]` |
   | switch | Switch block (or a switch circuit, or Pushbutton) | `FrontDriveway [RA2:13]` |
   | shade | Jalousie block | `Bedroom Shade [CA:40]` |

   `HUB` is the `LUTRON_HUB_TAG` of the instance (e.g. `RA2`, `CA`). Lutron integration IDs are in the
   Lutron app (Settings → Advanced → Integration → Send Integration Report) or in the lutronjs log
   when you use the device (`~OUTPUT,4,1,100.00` is ID 4).

   The tag has to be in the name: LoxAPP3.json doesn't export the block description. The tag
   therefore also shows in the Loxone app.

2. **Make sure the block is shown in the user interface**, because only visible blocks have states lutronjs can follow.
3. **Create a Loxone user** for lutronjs that has access to those blocks and to the app / web interface.
4. **Save to the Miniserver.** lutronjs reconnects after the restart and picks up the new mapping.

Virtual Outputs are **not needed** anymore. lutronjs follows block states over the websocket and
sets Lutron directly. If some still exist they keep working and don't cause loops, but you can delete them.

Blocks that can't hold a state (e.g. `UpDownDigital` blinds driven by a Pico) can't be discovered.
Map Pico / keypad buttons to them in the button file (see below).

Check what a hub will map before deploying, read-only:

```sh
npm run discover -- --hub RA2 --file "<Loxone Config backup>/web/data/LoxAPP3.json"
LOXONE_HOST=<ms> LOXONE_USERNAME=<u> LOXONE_PASSWORD=<p> npm run discover -- --hub RA2
```

## How sync works

Lutron is the source of truth for the loads. lutronjs mirrors both sides: Lutron levels from the
telnet event stream, and Loxone block states from the Miniserver's status updates.

- **Lutron → Loxone**: a Lutron change (wall switch, Pico, Lutron app, scene) is sent to the tagged
  block if the block shows something else.
- **Loxone → Lutron**: a tagged block's state change (Dimmer position, Switch active) is sent to
  Lutron if the Lutron level differs.
- **Reconcile**: runs on every (re)connect and every `reconcileSec`, and makes Loxone match Lutron.

Loops (Lutron → Loxone → Lutron → …) are prevented by four layers:

| Layer | What it does |
| --- | --- |
| State compare | A value the other side already has (± `tolerance`) is never sent. |
| Origin tags | Every value lutronjs sends is remembered. When the other side reports it back within `echoMs`, it's recognized as ours and not reflected. Virtual output calls right after a push are dropped the same way. |
| Hold | After one side originates a change for a device, the other direction waits `holdMs`. A moving slider is never overwritten by a lagging report. |
| Shade settling | Shades wait `shadeSettleMs` (1.5 s) for a stable target and use `shadeTolerance` (2 %). Pressing a Jalousie arrow in the Loxone app briefly targets the end stop; only the position where it ends up is sent to Lutron. |
| Circuit breaker | More than `breakerMax` syncs of one device in `breakerWindowMs` pauses that device and logs `LOOP DETECTED`. |

### Mapping changes

The mapping is rebuilt whenever the structure file is loaded:
- on every Loxone (re)connect, which includes the Miniserver restart after a Loxone Config save
- when a periodic check finds a new structure version (`DISCOVERY_INTERVAL_SEC`, default daily)
- on `POST /v0/sync/rescan`

Each rebuild logs a diff (`Discovery: + / - / ~`) and flags problems:
- malformed tags (`[RA2:abc]`, `[RA2 4]`)
- one Lutron ID tagged on two blocks: neither is synced until fixed
- several tags on one block
- tagged blocks of an unsupported type

The new mapping is swapped in atomically, then a reconcile runs.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `LUTRON_SERVER_IP` | `127.0.0.1` | hub address |
| `LUTRON_SERVER_PORT` | `8082` | HTTP port |
| `LUTRON_TELNET_PORT` / `LUTRON_USERNAME` / `LUTRON_PASSWORD` | `23` / `lutron` / `integration` | telnet integration login |
| `LUTRON_HUB_TAG` | unset (no discovery) | this hub's tag in Loxone block names, e.g. `RA2` |
| `LOXONE_HOST` / `LOXONE_USERNAME` / `LOXONE_PASSWORD` | unset (no sync) | Miniserver login, e.g. from a k8s Secret |
| `DISCOVERY_INTERVAL_SEC` | `86400` | how often to check for a new structure version (0 = only on reconnect) |
| `LOXONE_CONFIG` | unset | optional JSON file for button mappings and sync options (or a legacy JS config) |

### Button file

Pico and keypad buttons belong to the Pico's own Lutron ID, not to a block. Map them in a small
JSON file, see [cfg.example/buttons.json](cfg.example/buttons.json):

```json
{ "buttons": { "24": [ { "action": 2, "uuid": "<block uuid>", "command": "PulseUp" },
                       { "action": 4, "uuid": "<block uuid>", "command": "PulseDown" } ] } }
```

`action` is the button number (Pico: 2 top, 3 middle, 4 bottom, 5 raise, 6 lower). The command is sent
once per press. Find a block's uuid with `npm run discover` or `npm run watch`.

The file can also have a `devices` section with static level mappings, and legacy JS configs
(`new LoxoneWS(host, user, password, devMapper)`) still load. Both are merged with the discovered mapping.
When both map the same Lutron ID, the discovered entry wins and the conflict is logged.

Static entry fields: `action`, `uuid`, `name`, `type`, `mult`, `invert`, `command`:
- `type` is `default` (inferred from the block), `level`, `switch`, `shade` or `direct`.
- `command` is a template for levels, such as `manualPosition/{value}`.

## HTTP API

| | |
| --- | --- |
| `GET /v0/device/<id>` | `{"deviceId":"2","value":100}` (queries the hub) |
| `PUT /v0/device/<id>/value/<0-100>` | set level |
| `PUT /v0/toggle/<id>` | 0 ↔ 100 |
| `GET /v0/status/all` | every level seen so far: `{"2":100,"15":0}` |
| `GET /v0/sync` | live mapping with `source` (discovered/static), both sides' levels, in sync, breaker, last discovery diff and issues |
| `POST /v0/sync/rescan` | reload the structure now, rebuild the mapping, reconcile |
| `POST /v0/sync/reconcile` | run a reconcile now |
| `GET /healthz` | 200 when the hub session is up, 503 otherwise |

## Develop

```sh
npm install
npm test                    # build + unit tests (discovery, loop simulations, protocols)
HUB=ra2 npm run discover    # read-only: log in, show what this hub maps
HUB=ra2 npm run watch       # read-only: print Loxone changes + uuids
HUB=ra2 npm run server      # full sync (stop any other instance for this hub first)
```

All site specific settings live in `cfg/`, which is git-ignored. Start from the templates:

```sh
cp -r cfg.example cfg       # then edit the files in cfg/
```

| File | Contents |
| --- | --- |
| `cfg/loxone.env` | Miniserver address and the Loxone login, shared by all hubs |
| `cfg/<hub>.env` | one per hub: hub IP, HTTP port, `LUTRON_HUB_TAG`, optional `LOXONE_CONFIG` |
| `cfg/buttons.json` | optional Pico / keypad button mappings |
| `cfg/build.env` | `IMAGE` to build and push, optional `PLATFORM` |

`HUB=<name>` picks `cfg/<name>.env`. Real environment variables override the files.

Requires Node 22.4+ (uses the built-in WebSocket client).

## Container

```sh
docker/build_lutronjs <tag>   # builds and pushes $IMAGE:<tag>, IMAGE / PLATFORM from cfg/build.env
```

The container is configured with the same environment variables. For example on Kubernetes, one
Deployment per hub:

```yaml
strategy:
  type: Recreate            # never two instances against one hub
...
env:
  - { name: LUTRON_SERVER_IP, value: "<hub ip>" }
  - { name: LUTRON_SERVER_PORT, value: "8084" }
  - { name: LUTRON_HUB_TAG, value: "RA2" }
  - { name: LOXONE_HOST, value: "<miniserver ip>" }
  - { name: LOXONE_USERNAME, valueFrom: { secretKeyRef: { name: loxone-lutronjs, key: username } } }
  - { name: LOXONE_PASSWORD, valueFrom: { secretKeyRef: { name: loxone-lutronjs, key: password } } }
  - { name: LOXONE_CONFIG, value: "/etc/lutronjs/buttons.json" }   # optional
readinessProbe:
  httpGet: { path: /healthz, port: 8084 }
```

The image keeps `/root/lutronjs/build/loxoneWSUtil.js`, so existing ConfigMaps that `require` it keep working.
