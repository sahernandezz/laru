/**
 * What the last run of each flow touched, read from its traces (runtime writes them, core only reads): the services,
 * stores and externals it went through, its topics and tables, the endpoints its traffic reached and what its browser
 * asked for. `impact` picks the flows a change reaches with it, and `context` says which flows go through a thing.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { callKey } from './reach.ts';
import { stateDir, type Workspace } from './workspace.ts';

/**
 * What the last traces say, kept by workspace until the runs index changes: a run appends to it once its traces are
 * written, so the same index means the same traces (read whole, each one, they cost a second in a big workspace).
 */
const lastRead = new Map<string, { at: string; value: unknown }>();
function byIndex<T>(ws: Workspace, name: string, read: () => T): T {
  const idx = join(stateDir(ws), 'runs', 'index.jsonl');
  let at = '-';
  try { const s = statSync(idx); at = `${s.mtimeMs}:${s.size}`; } catch { /* no runs yet */ }
  const key = `${ws.root}\0${name}`, hit = lastRead.get(key);
  if (hit && hit.at === at) return hit.value as T;
  const value = read();
  lastRead.set(key, { at, value });
  return value;
}

export const lastParticipants = (ws: Workspace) => byIndex(ws, 'participants', () => readParticipants(ws));
function readParticipants(ws: Workspace): Map<string, { nodes: string[]; topics: string[]; tables: string[] }> {
  const out = new Map<string, { nodes: string[]; topics: string[]; tables: string[] }>();
  const idx = join(stateDir(ws), 'runs', 'index.jsonl');
  if (!existsSync(idx)) return out;
  const last = new Map<string, string>();
  for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); if (x.status !== 'error') last.set(x.flow, x.run); }
  for (const [flow, run] of last) {
    const f = join(stateDir(ws), 'runs', run, 'flows', flow, 'trace.json');
    if (!existsSync(f)) continue;
    const t = JSON.parse(readFileSync(f, 'utf8')) as { participants: Array<{ node?: string }>; exchanges: Array<{ topic?: string; table?: string }> };
    out.set(flow, { nodes: t.participants.map((p) => p.node).filter((n): n is string => Boolean(n)), topics: [...new Set(t.exchanges.map((e) => e.topic).filter((x): x is string => Boolean(x)))], tables: [...new Set(t.exchanges.map((e) => e.table).filter((x): x is string => Boolean(x)))] });
  }
  return out;
}

/** What each flow's last played run called: the endpoints its traffic reached, and the requests its browser made (`POST /api/x`). */
export const lastExchanges = (ws: Workspace) => byIndex(ws, 'exchanges', () => readExchanges(ws));
function readExchanges(ws: Workspace): Map<string, { endpoints: Set<string>; browser: Set<string> }> {
  const out = new Map<string, { endpoints: Set<string>; browser: Set<string> }>();
  const idx = join(stateDir(ws), 'runs', 'index.jsonl');
  if (!existsSync(idx)) return out;
  const last = new Map<string, string>();
  for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); if (x.status === 'passed' || x.status === 'failed') last.set(x.flow, x.run); }
  for (const [flow, run] of last) {
    const dir = join(stateDir(ws), 'runs', run, 'flows', flow);
    const traces: Array<{ exchanges?: Array<{ from: string; endpoint?: string; method?: string; path?: string; label?: string }> }> = [];
    for (const f of ['trace.json', 'cases.json']) if (existsSync(join(dir, f))) { const t = JSON.parse(readFileSync(join(dir, f), 'utf8')); traces.push(...(Array.isArray(t) ? t : [t])); }
    if (!traces.length) continue;
    const e = { endpoints: new Set<string>(), browser: new Set<string>() };
    for (const t of traces) for (const x of t.exchanges ?? []) {
      if (x.endpoint) e.endpoints.add(x.endpoint);
      const [m, ...rest] = (x.label ?? '').split(' ');
      const method = x.method ?? m, path = x.path ?? rest.join(' ');
      if ((x.from === 'browser' || x.from.startsWith('browser:')) && method && path.startsWith('/')) e.browser.add(callKey(method, path));
    }
    out.set(flow, e);
  }
  return out;
}
