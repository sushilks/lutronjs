import type { DeviceMapping } from './loxoneWSUtil';

/*
  Auto-discovery of the Lutron <-> Loxone mapping from the Loxone structure file.

  Tag convention, in the Loxone block name (LoxAPP3.json exposes no description
  field, checked against a real 17.x structure file):
      "Closet [RA2:4]"   -> Lutron integration id 4 on the hub tagged RA2
  Works for top level blocks and sub-controls (Lighting Controller circuits).
*/

export type SyncKind = 'level' | 'switch' | 'shade';

export const KIND_BY_TYPE: Record<string, SyncKind> = {
  Dimmer: 'level',
  EIBDimmer: 'level',
  // analog virtual input shown in the app, 0-100 like the Lutron level
  Slider: 'level',
  Switch: 'switch',
  Pushbutton: 'switch',
  Jalousie: 'shade',
};

export type TagResult =
  | { ok: true; hub: string; id: number }
  | { ok: false; hub: string; text: string };

/** Tags in a name. Tag-like text for any hub that doesn't parse is reported as malformed. */
export function parseTags(name: string): TagResult[] {
  const out: TagResult[] = [];
  for (const m of name.matchAll(/\[([^\][]*)(\]|$)/g)) {
    const body = m[1].trim();
    const closed = m[2] === ']';
    const good = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(\d+)$/.exec(body);
    if (closed && good && parseInt(good[2], 10) > 0) {
      out.push({ ok: true, hub: good[1].toUpperCase(), id: parseInt(good[2], 10) });
      continue;
    }
    // only complain about things that look like a hub tag
    const hub = /^([A-Za-z][A-Za-z0-9_]*)/.exec(body);
    if (hub && (body.includes(':') || /[\s-]\s*\d/.test(body) || !closed)) out.push({ ok: false, hub: hub[1].toUpperCase(), text: m[0] });
  }
  return out;
}

export function stripTags(name: string): string {
  return name.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();
}

export interface DiscoveryIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface DiscoveryResult {
  mappings: Map<number, DeviceMapping[]>;
  issues: DiscoveryIssue[];
  /** tagged blocks for other hubs, only counted */
  otherHubs: number;
}

interface Candidate { id: number; uuid: string; name: string; type: string; kind?: SyncKind }

export function discover(structure: any, hubTag: string): DiscoveryResult {
  const hub = hubTag.toUpperCase();
  const issues: DiscoveryIssue[] = [];
  const found: Candidate[] = [];
  let otherHubs = 0;

  const visit = (ctrl: any, key: string, parentName?: string) => {
    const name: string = ctrl?.name ?? '';
    const label = parentName ? `"${parentName} / ${name}"` : `"${name}"`;
    const tags = parseTags(name);
    const mine = tags.filter((t) => t.hub === hub);
    otherHubs += tags.some((t) => t.hub !== hub && t.ok) ? 1 : 0;
    for (const t of mine) {
      if (!t.ok) issues.push({ level: 'error', message: `malformed tag ${t.text} on ${label}, expected [${hub}:<lutronId>]` });
    }
    const ok = mine.filter((t): t is Extract<TagResult, { ok: true }> => t.ok);
    if (ok.length > 1) {
      issues.push({ level: 'error', message: `${label} has ${ok.length} ${hub} tags, one block can map to one Lutron id; skipped` });
    } else if (ok.length === 1) {
      const kind = KIND_BY_TYPE[ctrl.type];
      if (!kind) {
        issues.push({ level: 'warning', message: `${label} is a ${ctrl.type}, which can't be state-synced; skipped (use a button mapping for Pico/keypad control)` });
      } else {
        found.push({ id: ok[0].id, uuid: ctrl.uuidAction ?? key, name: (parentName ? `${parentName} / ` : '') + stripTags(name), type: ctrl.type, kind });
      }
    }
    for (const [subKey, sub] of Object.entries<any>(ctrl?.subControls ?? {})) visit(sub, subKey, stripTags(name));
  };
  for (const [key, ctrl] of Object.entries<any>(structure?.controls ?? {})) visit(ctrl, key);

  const byId = new Map<number, Candidate[]>();
  for (const c of found) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  const mappings = new Map<number, DeviceMapping[]>();
  for (const [id, cands] of byId) {
    if (cands.length > 1) {
      issues.push({ level: 'error', message: `Lutron ${hub}:${id} is tagged on ${cands.length} blocks (${cands.map((c) => `"${c.name}"`).join(', ')}); none of them synced until fixed` });
      continue;
    }
    const c = cands[0];
    mappings.set(id, [{
      action: 1, uuid: c.uuid, name: c.name, type: c.kind === 'switch' ? 'switch' : c.kind === 'shade' ? 'shade' : 'level',
      ...(c.kind === 'shade' ? { invert: true } : {}),
      source: 'discovered',
    }]);
  }
  return { mappings, issues, otherHubs };
}

const key = (id: number, m: DeviceMapping) => `${id}:${m.action}`;

/** Static entries (buttons, legacy devMapper) plus discovered ones; discovered wins per (id, action). */
export function mergeMappings(staticMap: Map<number, DeviceMapping[]>, discovered: Map<number, DeviceMapping[]>,
                              sameControl: (a: string, b: string) => boolean) {
  const merged = new Map<number, DeviceMapping[]>();
  const conflicts: string[] = [];
  const taken = new Set<string>();
  for (const [id, maps] of discovered) {
    merged.set(id, [...maps]);
    for (const m of maps) taken.add(key(id, m));
  }
  for (const [id, maps] of staticMap) {
    for (const m of maps) {
      if (taken.has(key(id, m))) {
        const d = discovered.get(id)!.find((x) => x.action === m.action)!;
        if (!sameControl(d.uuid, m.uuid)) {
          conflicts.push(`static mapping ${id}:${m.action} -> ${m.name ?? m.uuid} overridden by discovered "${d.name}"`);
        }
        continue;
      }
      merged.set(id, [...(merged.get(id) ?? []), { ...m, source: m.source ?? 'static' }]);
    }
  }
  return { merged, conflicts };
}

export interface MappingDiff { added: string[]; removed: string[]; changed: string[] }

export function diffMappings(before: Map<number, DeviceMapping[]>, after: Map<number, DeviceMapping[]>): MappingDiff {
  const flat = (m: Map<number, DeviceMapping[]>) => {
    const out = new Map<string, DeviceMapping>();
    for (const [id, maps] of m) for (const x of maps) out.set(key(id, x), x);
    return out;
  };
  const describe = (k: string, m: DeviceMapping) =>
    `${k} -> "${m.name ?? m.uuid}" (${m.type ?? 'default'}${m.command ? ' ' + m.command : ''}, ${m.source ?? 'static'})`;
  const a = flat(before), b = flat(after);
  const diff: MappingDiff = { added: [], removed: [], changed: [] };
  for (const [k, m] of b) {
    const old = a.get(k);
    if (!old) diff.added.push(describe(k, m));
    else if (old.uuid !== m.uuid || old.type !== m.type || old.command !== m.command || old.source !== m.source) {
      diff.changed.push(`${describe(k, old)}  =>  ${describe(k, m)}`);
    }
  }
  for (const [k, m] of a) if (!b.has(k)) diff.removed.push(describe(k, m));
  return diff;
}
