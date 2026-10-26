/** The map on disk and in memory: `.laru/map.json`, indexed by node and by direction. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact, MapNode, Relation, Seen, SystemMap } from './model.ts';
import { stateDir, WorkspaceError, type Workspace } from './workspace.ts';

// Known limit: one JSON file, rewritten whole; move to node:sqlite when a map passes ~50 MB.
export const mapFile = (ws: Workspace) => join(stateDir(ws), 'map.json');

export function saveMap(ws: Workspace, map: SystemMap): void {
  mkdirSync(stateDir(ws), { recursive: true });
  writeFileSync(mapFile(ws), JSON.stringify(map));
}

export class Graph {
  readonly nodes = new Map<string, MapNode>();
  readonly out = new Map<string, Fact[]>();
  readonly in = new Map<string, Fact[]>();
  readonly map: SystemMap;
  constructor(map: SystemMap) {
    this.map = map;
    for (const n of map.nodes) this.nodes.set(n.id, n);
    for (const f of map.facts) {
      (this.out.get(f.s) ?? this.out.set(f.s, []).get(f.s)!).push(f);
      (this.in.get(f.o) ?? this.in.set(f.o, []).get(f.o)!).push(f);
    }
  }
  outOf = (id: string) => this.out.get(id) ?? [];
  inOf = (id: string) => this.in.get(id) ?? [];
  ofType = (type: MapNode['type']) => this.map.nodes.filter((n) => n.type === type);
}

export const observedFile = (ws: Workspace) => join(stateDir(ws), 'observed.json');
const OBSERVED_DAYS = 30;

/** What runs saw (calls, reads, writes, uses), written by the runtime after each run; older than 30 days drops out. */
export function loadObserved(ws: Workspace): Array<{ s: string; p: Relation; o: string; seen: Seen }> {
  const f = observedFile(ws);
  if (!existsSync(f)) return [];
  const cutoff = Date.now() - OBSERVED_DAYS * 86400_000;
  return ((JSON.parse(readFileSync(f, 'utf8')) as { facts?: Array<{ s: string; p: Relation; o: string; seen: Seen }> }).facts ?? []).filter((x) => Date.parse(x.seen.at) > cutoff);
}

/** One entry per map file: the daemon serves several workspaces, and switching between them parses nothing again. */
const cached = new Map<string, { mtime: number; obs: number; graph: Graph }>();

/**
 * Loads the map once per process and again only when it or the observed facts change. Observed facts join the
 * extracted ones with origin `observed`; one that repeats an extracted fact marks it seen instead of duplicating it.
 */
export function loadGraph(ws: Workspace): Graph {
  const file = mapFile(ws);
  if (!existsSync(file)) throw new WorkspaceError('there is no map yet: run `laru map`');
  const mtime = statSync(file).mtimeMs;
  const obs = existsSync(observedFile(ws)) ? statSync(observedFile(ws)).mtimeMs : 0;
  const hit = cached.get(file);
  if (hit && hit.mtime === mtime && hit.obs === obs) return hit.graph;
  const map = JSON.parse(readFileSync(file, 'utf8')) as SystemMap;
  // A map written before detectors version 4 says «default <value>»; it is served as it lies until the next refresh, so it is cleaned here.
  for (const f of map.facts) if (f.p === 'reads-var' && f.note?.startsWith('default ')) f.note = 'has a default';
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const o of loadObserved(ws)) {
    if (!ids.has(o.s) || !ids.has(o.o)) continue;
    const same = map.facts.find((f) => f.s === o.s && f.p === o.p && f.o === o.o);
    if (same) same.seen = o.seen;
    else map.facts.push({ s: o.s, p: o.p, o: o.o, origin: 'observed', seen: o.seen });
  }
  const graph = new Graph(map);
  cached.set(file, { mtime, obs, graph });
  return graph;
}
