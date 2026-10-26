/**
 * Derived diagrams: nobody writes them, so they cannot go stale. The C4 context and containers, the physical ER, the
 * topology of an environment, the dependency map and the landscape of processes are all read from the map and the
 * documentation. A model leaves here without positions; the engine places and paints it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emptyModel, type DiagramEdge, type DiagramKind, type DiagramModel, type DiagramNode } from '@laru/diagrams';
import type { Graph } from '../graph.ts';
import type { MapNode } from '../model.ts';
import type { Workspace } from '../workspace.ts';
import type { Row } from './piece.ts';
import { RELATIONS, type Piece } from './piece.ts';
import { isContainer } from './standard.ts';
import type { Knowledge } from './store.ts';

export interface DerivedInfo { id: string; kind: DiagramKind; title: string }
export type EnvMembers = Array<{ env: string; services: string[] }>;

const safe = (s: string) => 'n_' + s.replace(/[^a-zA-Z0-9]+/g, '_');
const TECH: Record<string, string> = { spring: 'Java, Spring Boot', quarkus: 'Java, Quarkus', node: 'Node.js', web: 'Web, navegador', mobile: 'App móvil', docker: 'Docker' };
const T = (ws: Workspace, es: string, en: string) => (ws.docsLanguage === 'es' ? es : en);

/** What a store speaks, from its image: the protocol on the arrow that reaches it. */
export function protocolOf(n: MapNode): string {
  const image = String(n.attrs?.image ?? '').toLowerCase();
  if (/kafka|redpanda/.test(image) || n.kind === 'queue' && !/rabbit/.test(image)) return 'Kafka';
  if (/rabbit/.test(image)) return 'AMQP';
  if (/redis|valkey/.test(image)) return 'Redis';
  if (/mongo/.test(image)) return 'MongoDB';
  if (/minio|s3|localstack/.test(image) || n.kind === 'file') return 'S3';
  if (/postgres|mysql|maria|mssql|oracle/.test(image) || n.kind === 'relational') return 'SQL';
  // A container we run for the application speaks its own protocol, not HTTP (ClamAV listens on 3310).
  const ports = (n.attrs?.ports as Array<{ container: number }> | undefined) ?? [];
  if (ports.length && !ports.some((p) => [80, 443, 8080, 8000, 3000].includes(p.container))) return 'TCP';
  return n.type === 'external' ? 'HTTP' : 'TCP';
}
const imageTech = (n: MapNode) => String(n.attrs?.image ?? '').replace(/^.*\//, '') || undefined;

/** The (service → service) pairs that call each other, from direct calls and through endpoints, in order of first sight. */
function servicePairs(g: Graph): Array<[string, string]> {
  const seen = new Set<string>(), out: Array<[string, string]> = [];
  const add = (a: string | undefined, b: string | undefined) => { if (a && b && a !== b && !seen.has(`${a}>${b}`)) { seen.add(`${a}>${b}`); out.push([a, b]); } };
  for (const f of g.map.facts) {
    if (f.p === 'calls') {
      const to = g.nodes.get(f.o);
      add(f.s, to?.type === 'service' ? to.id : to?.type === 'endpoint' ? to.service : undefined);
    } else if (f.p === 'forwards-to') add(g.nodes.get(f.s)?.service, g.nodes.get(f.o)?.service);
  }
  return out.filter(([a, b]) => g.nodes.get(a)?.type === 'service' && g.nodes.get(b)?.type === 'service');
}

/** What a service does to a store: the verb on the arrow. */
function verbFor(g: Graph, ws: Workspace, svc: string, ds: MapNode): string {
  if (protocolOf(ds) === 'Kafka' || protocolOf(ds) === 'AMQP') {
    const topics = new Set(g.outOf(ds.id).filter((f) => f.p === 'contains').map((f) => f.o));
    const out = g.outOf(svc).filter((f) => topics.has(f.o));
    const pub = out.some((f) => f.p === 'publishes'), con = out.some((f) => f.p === 'consumes');
    return pub && con ? T(ws, 'Publica y consume', 'Publishes and consumes') : pub ? T(ws, 'Publica', 'Publishes') : con ? T(ws, 'Consume', 'Consumes') : T(ws, 'Usa', 'Uses');
  }
  const tables = new Set(g.outOf(ds.id).filter((f) => f.p === 'contains').map((f) => f.o));
  const t = g.outOf(svc).filter((f) => tables.has(f.o));
  const reads = t.some((f) => f.p === 'reads'), writes = t.some((f) => f.p === 'writes' || f.p === 'maps-table');
  return reads && writes ? T(ws, 'Lee y escribe', 'Reads and writes') : writes ? T(ws, 'Escribe', 'Writes') : reads ? T(ws, 'Lee', 'Reads') : T(ws, 'Usa', 'Uses');
}

const person = (ws: Workspace, id = 'user', name?: string): DiagramNode => ({ id, shape: 'Person', name: name ?? T(ws, 'Usuario', 'User'), description: T(ws, 'Quien usa la aplicación', 'Who uses the application'), x: 0, y: 0 });

export function deriveContainers(ws: Workspace, g: Graph): DiagramModel {
  const m = emptyModel('c4-container', T(ws, `${ws.title}, contenedores`, `${ws.title}, containers`));
  m.direction = 'LR';
  const inside = safe('system');
  const services = g.ofType('service'), stores = g.ofType('datastore'), externals = g.ofType('external');
  m.nodes.push({ id: inside, shape: 'Container_Boundary', name: ws.title, x: 0, y: 0 });
  for (const s of services) m.nodes.push({ id: safe(s.id), shape: 'Container', name: s.name, technology: TECH[String(s.attrs?.tech ?? '')] ?? String(s.attrs?.tech ?? ''), description: undefined, ref: s.id, parent: inside, x: 0, y: 0 });
  for (const d of stores) m.nodes.push({ id: safe(d.id), shape: protocolOf(d) === 'Kafka' || protocolOf(d) === 'AMQP' ? 'ContainerQueue' : 'ContainerDb', name: d.name, technology: imageTech(d) ?? protocolOf(d), ref: d.id, parent: inside, x: 0, y: 0 });
  for (const e of externals) m.nodes.push({ id: safe(e.id), shape: 'System_Ext', name: e.name, technology: imageTech(e), description: T(ws, 'Sistema fuera de la aplicación', 'System outside the application'), ref: e.id, x: 0, y: 0 });
  const edge = (a: string, b: string, label: string, technology?: string) => m.edges.push({ id: `e${m.edges.length + 1}`, from: safe(a), to: safe(b), label, technology } as DiagramEdge);
  const fronts = services.filter((s) => s.attrs?.tech === 'web' || s.attrs?.tech === 'mobile');
  if (fronts.length) m.nodes.push(person(ws));
  for (const f of fronts) { edge('user', f.id, T(ws, 'Usa', 'Uses'), f.attrs?.tech === 'mobile' ? 'App' : 'HTTPS'); m.edges[m.edges.length - 1].from = 'user'; }
  for (const [a, b] of servicePairs(g)) edge(a, b, T(ws, 'Llama', 'Calls'), 'HTTP');
  for (const f of g.map.facts) {
    if (f.p !== 'uses') continue;
    const to = g.nodes.get(f.o), from = g.nodes.get(f.s);
    if (from?.type !== 'service' || !to) continue;
    edge(from.id, to.id, to.type === 'datastore' ? verbFor(g, ws, from.id, to) : T(ws, 'Usa', 'Uses'), protocolOf(to));
  }
  // One arrow per pair and protocol: the facts repeat per file.
  const seen = new Set<string>();
  m.edges = m.edges.filter((e) => { const k = `${e.from}>${e.to}>${e.technology}`; if (seen.has(k)) return false; seen.add(k); return true; });
  m.edges.forEach((e, i) => { e.id = `e${i + 1}`; });
  return m;
}

export function deriveContext(ws: Workspace, k: Knowledge, g: Graph): DiagramModel {
  const m = emptyModel('c4-context', T(ws, `${ws.title}, contexto`, `${ws.title}, context`));
  m.direction = 'LR';
  m.nodes.push({ id: 'system', shape: 'System', name: ws.title, description: k.pieces.find((p) => p.type === 'application')?.summary, ref: k.pieces.find((p) => p.type === 'application')?.id, x: 0, y: 0 });
  const app = k.pieces.find((p) => p.type === 'application');
  const actors = ((app?.fields.users ?? []) as Row[]).map((r) => ({ name: r.actor, need: r.need })).filter((a) => a.name).slice(0, 5);
  for (const [i, a] of (actors.length ? actors : [{ name: T(ws, 'Usuario', 'User'), need: '' }]).entries()) {
    m.nodes.push({ ...person(ws, `person${i}`, a.name), description: a.need || undefined });
    m.edges.push({ id: `p${i}`, from: `person${i}`, to: 'system', label: T(ws, 'Usa', 'Uses') });
  }
  for (const e of g.ofType('external')) {
    m.nodes.push({ id: safe(e.id), shape: 'System_Ext', name: e.name, description: T(ws, 'Sistema fuera de la aplicación', 'System outside the application'), ref: e.id, x: 0, y: 0 });
    m.edges.push({ id: `x${m.edges.length}`, from: 'system', to: safe(e.id), label: T(ws, 'Usa', 'Uses'), technology: protocolOf(e) });
  }
  return m;
}

/** A table as the DDL names it: `schema.name` (the map's name already is, unless the schema was unknown). */
const qualified = (t: MapNode) => (t.name.includes('.') || !t.attrs?.schema ? t.name : `${t.attrs.schema}.${t.name}`);

/** A table of the repositories' own DDL: its columns (name, type, key) and the tables its columns reference. */
export interface DdlTable { columns: string[]; refs: Array<{ column: string; table: string }> }

/**
 * Every `CREATE TABLE schema.name (…)` in the checkouts' .sql files, read as text: the columns and the foreign keys the
 * extraction does not keep. Tables are keyed as the map names them (`schema.name`).
 */
export function readDdl(ws: Workspace): Map<string, DdlTable> {
  const out = new Map<string, DdlTable>();
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const n of readdirSync(dir)) {
      if (/^(node_modules|target|build|dist|\.git)$/.test(n)) continue;
      const f = join(dir, n);
      const st = statSync(f);
      if (st.isDirectory()) walk(f, depth + 1);
      else if (/\.sql$/i.test(n) && st.size < 2_000_000) {
        const text = readFileSync(f, 'utf8').replace(/--[^\n]*/g, '');
        for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*?)\n?\)\s*;/gi)) {
          const name = m[1].replace(/"/g, ''), t: DdlTable = { columns: [], refs: [] };
          for (const line of m[2].split(/,\s*\n|\n/).map((l) => l.trim().replace(/,$/, '')).filter(Boolean)) {
            const col = /^([a-z_][\w]*)\s+([A-Za-z][\w() ,]*?)(?:\s+(?:not\s+null|primary|default|references|unique|check)\b.*)?$/i.exec(line);
            if (!col || /^(primary|foreign|constraint|unique|check|index|key)$/i.test(col[1])) continue;
            const ref = /references\s+([\w."]+)/i.exec(line);
            t.columns.push(`${col[1]} ${col[2].trim().toUpperCase().replace(/TIMESTAMP WITH(?:OUT)? TIME ZONE/, 'TIMESTAMPTZ').replace(/CHARACTER VARYING/, 'VARCHAR')}${/primary\s+key/i.test(line) ? ' PK' : ref ? ' FK' : ''}`);
            if (ref) t.refs.push({ column: col[1], table: ref[1].replace(/"/g, '') });
          }
          out.set(name, t);
        }
      }
    }
  };
  for (const dir of Object.values(ws.checkouts ?? {})) { try { if (dir && existsSync(dir)) walk(dir, 0); } catch { /* an unreadable folder has no DDL */ } }
  return out;
}

/**
 * The physical model: every table the code has, or (with a piece) only the tables the entities of the data models in
 * or under that piece name, so a model's page draws its own tables and not the whole system's.
 */
export function deriveEr(ws: Workspace, g: Graph, k?: Knowledge, owner?: string): DiagramModel {
  const piece = owner ? k?.byId.get(owner) : undefined;
  const under = (x: { parent?: string | null }) => { for (let c = k?.byId.get(x.parent ?? ''); c; c = k?.byId.get(c.parent ?? '')) if (c.id === owner) return true; return false; };
  const tables = piece && k ? new Set(k.pieces.filter((x) => x.type === 'data-model' && (x.id === owner || under(x))).flatMap((x) => ((x.fields.entities ?? []) as Array<Record<string, unknown>>).flatMap((e) => (e.table ? [`tbl:${e.table}`] : [])))) : undefined;
  const ddl = readDdl(ws);
  const m = emptyModel('data-model', piece ? T(ws, `${piece.title}, modelo físico`, `${piece.title}, physical model`) : T(ws, `${ws.title}, modelo físico`, `${ws.title}, physical model`));
  for (const t of g.ofType('table').filter((x) => !tables || tables.has(x.id))) {
    const writers = g.inOf(t.id).filter((f) => f.p === 'writes' || f.p === 'maps-table').map((f) => g.nodes.get(f.s)?.name).filter(Boolean);
    m.nodes.push({ id: safe(t.id), shape: 'entity', name: t.name, description: [t.attrs?.schema ? `schema ${t.attrs.schema}` : '', writers.length ? T(ws, `la escribe ${[...new Set(writers)].join(', ')}`, `written by ${[...new Set(writers)].join(', ')}`) : ''].filter(Boolean).join(' · ') || undefined, attributes: ddl.get(qualified(t))?.columns ?? [`schema ${t.attrs?.schema ?? 'public'}`], ref: [...new Set(g.inOf(t.id).map((f) => f.s))].find((s) => g.nodes.get(s)?.type === 'datastore'), x: 0, y: 0 });
  }
  // the foreign keys between the tables drawn
  const drawn = new Map(g.ofType('table').filter((x) => m.nodes.some((n) => n.id === safe(x.id))).map((x) => [qualified(x), safe(x.id)]));
  for (const [name, id] of drawn) for (const r of ddl.get(name)?.refs ?? []) { const to = drawn.get(r.table); if (to) m.edges.push({ id: `fk${m.edges.length}`, from: id, to, label: r.column }); }
  return m;
}

export function deriveDependencies(ws: Workspace, g: Graph): DiagramModel {
  const m = emptyModel('dependency', T(ws, `${ws.title}, dependencias`, `${ws.title}, dependencies`));
  m.direction = 'LR';
  const groups: Array<[string, string, MapNode[]]> = [['services', T(ws, 'Servicios', 'Services'), g.ofType('service')], ['stores', T(ws, 'Almacenes', 'Stores'), g.ofType('datastore')], ['externals', T(ws, 'Externos', 'External'), g.ofType('external')]];
  for (const [id, name, list] of groups) {
    if (!list.length) continue;
    m.nodes.push({ id: `g_${id}`, shape: 'group', name, x: 0, y: 0 });
    for (const n of list) m.nodes.push({ id: safe(n.id), shape: n.type === 'datastore' ? 'store' : 'container', name: n.name, ref: n.id, parent: `g_${id}`, x: 0, y: 0 });
  }
  const seen = new Set<string>();
  const add = (a: string, b: string, label?: string) => { const k = `${a}>${b}`; if (!seen.has(k)) { seen.add(k); m.edges.push({ id: `e${m.edges.length + 1}`, from: safe(a), to: safe(b), label }); } };
  for (const [a, b] of servicePairs(g)) add(a, b);
  for (const f of g.map.facts) if (f.p === 'uses' && g.nodes.get(f.s)?.type === 'service' && g.nodes.has(f.o)) add(f.s, f.o);
  return m;
}

export function deriveProcesses(ws: Workspace, k: Knowledge): DiagramModel {
  const m = emptyModel('process-landscape', T(ws, `${ws.title}, procesos`, `${ws.title}, processes`));
  m.direction = 'TD';
  const procs = k.pieces.filter((p) => p.type === 'process');
  const app = k.pieces.find((p) => p.type === 'application');
  if (app) m.nodes.push({ id: safe(app.id), shape: 'group', name: app.title, ref: app.id, x: 0, y: 0 });
  for (const p of procs) {
    const parent = p.parent && procs.some((x) => x.id === p.parent) ? safe(p.parent) : app ? safe(app.id) : undefined;
    m.nodes.push({ id: safe(p.id), shape: 'rect', name: p.title, description: p.summary, ref: p.id, parent, x: 0, y: 0 });
  }
  return m;
}

/** Every reference a piece makes to another piece, with the word it used: a relation, a link field, a `[[id]]`. */
export function relationsOf(k: Knowledge, p: Piece): Array<{ to: string; label: string }> {
  const out: Array<{ to: string; label: string }> = [];
  const add = (id: unknown, label: string) => { if (typeof id === 'string' && id !== p.id && k.byId.has(id) && !out.some((o) => o.to === id && o.label === label)) out.push({ to: id, label }); };
  for (const r of RELATIONS) for (const id of p.relations?.[r] ?? []) add(id, r);
  for (const [key, v] of Object.entries(p.meta ?? {})) for (const id of ([] as string[]).concat(v)) add(id, key);
  const walk = (v: unknown, label: string) => {
    if (typeof v === 'string') { add(v, label); for (const m of v.matchAll(/\[\[([^\]]+)\]\]/g)) add(m[1], 'refiere'); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, label));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, label));
  };
  for (const [name, v] of Object.entries(p.fields)) walk(v, name === 'decisions' ? 'decided_by' : 'refiere');
  return out;
}

const MAX_RELATED = 16;
/** The graph of relations between pieces: all of it, or what is within `hops` of one piece. Containment is the tree, not an edge. */
export function deriveRelations(ws: Workspace, k: Knowledge, center?: string, hops = 2): DiagramModel {
  const m = emptyModel('application-landscape', center ? T(ws, `Relaciones de ${k.byId.get(center)?.title ?? center}`, `Relations of ${k.byId.get(center)?.title ?? center}`) : T(ws, `${ws.title}, relaciones`, `${ws.title}, relations`));
  m.direction = 'LR';
  const edges = k.pieces.flatMap((p) => relationsOf(k, p).map((r) => ({ from: p.id, ...r })));
  let keep = new Set(k.pieces.map((p) => p.id));
  if (center) {
    // One hop in full, the second as far as the drawing stays readable (and fast): the best-connected first.
    keep = new Set([center]);
    const degree = new Map<string, number>();
    for (const e of edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
    for (let i = 0; i < hops; i++) {
      const next = new Set<string>();
      for (const e of edges) { if (keep.has(e.from) && !keep.has(e.to)) next.add(e.to); if (keep.has(e.to) && !keep.has(e.from)) next.add(e.from); }
      const room = i === 0 ? next.size : Math.max(0, MAX_RELATED - keep.size);
      for (const id of [...next].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)).slice(0, room)) keep.add(id);
    }
  } else {
    const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
    // Flows and scenarios hang off everything they touch and turn the whole into a ball of wool: they are drawn in their own graph.
    keep = new Set([...keep].filter((id) => linked.has(id) && !['flow', 'scenario'].includes(k.byId.get(id)!.type)));
  }
  for (const id of keep) {
    const p = k.byId.get(id)!;
    m.nodes.push({ id: safe(id), shape: p.type === 'datastore' ? 'store' : isContainer(p.type) ? 'container' : 'facet', name: p.title, technology: p.type, ref: id, emphasis: id === center, x: 0, y: 0 });
  }
  // One arrow per pair: the words that join them go on it together.
  const pair = new Map<string, string[]>();
  for (const e of edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    const key = `${e.from}>${e.to}`;
    (pair.get(key) ?? pair.set(key, []).get(key)!).push(e.label);
  }
  for (const [key, labels] of pair) {
    const [from, to] = key.split('>');
    const distinct = [...new Set(labels)];
    m.edges.push({ id: `e${m.edges.length + 1}`, from: safe(from), to: safe(to), label: distinct.length > 2 ? `${distinct.slice(0, 2).join(', ')}…` : distinct.join(', ') });
  }
  return m;
}

export function deriveTopology(ws: Workspace, g: Graph, env: string, services: string[]): DiagramModel {
  const m = emptyModel('environment-map', T(ws, `${env}, topología`, `${env}, topology`));
  m.direction = 'LR';
  const frame = safe(`env_${env}`);
  m.nodes.push({ id: frame, shape: 'group', name: env, x: 0, y: 0 });
  const present = new Map<string, MapNode>();
  for (const name of services) { const n = g.nodes.get(`svc:${name}`) ?? g.nodes.get(`ds:${name}`) ?? g.nodes.get(`ext:${name}`); if (n) present.set(n.id, n); }
  for (const n of present.values()) {
    const ports = (n.attrs?.ports as Array<{ host?: number; container: number }> | undefined)?.map((p) => (p.host ? `${p.host}→${p.container}` : String(p.container))).join(', ');
    m.nodes.push({ id: safe(n.id), shape: 'rect', name: n.name, technology: ports || imageTech(n), ref: n.id, parent: frame, x: 0, y: 0 });
  }
  const seen = new Set<string>();
  const add = (a: string, b: string) => { if (present.has(a) && present.has(b) && a !== b && !seen.has(`${a}>${b}`)) { seen.add(`${a}>${b}`); m.edges.push({ id: `e${m.edges.length + 1}`, from: safe(a), to: safe(b) }); } };
  for (const [a, b] of servicePairs(g)) add(a, b);
  for (const f of g.map.facts) if (f.p === 'uses') add(f.s, f.o);
  return m;
}

/** The derived diagrams a workspace has, without drawing them. */
export function derivedList(ws: Workspace, g: Graph | null, k: Knowledge, envs: EnvMembers): DerivedInfo[] {
  const out: DerivedInfo[] = [];
  if (g?.ofType('service').length) out.push({ id: 'c4-context', kind: 'c4-context', title: T(ws, 'Contexto (C4 nivel 1)', 'Context (C4 level 1)') }, { id: 'c4-container', kind: 'c4-container', title: T(ws, 'Contenedores (C4 nivel 2)', 'Containers (C4 level 2)') });
  if (g?.ofType('table').length) out.push({ id: 'er', kind: 'data-model', title: T(ws, 'Modelo físico (ER)', 'Physical model (ER)') });
  if (g?.ofType('service').length) out.push({ id: 'dependencies', kind: 'dependency', title: T(ws, 'Mapa de dependencias', 'Dependency map') });
  if (k.pieces.some((p) => relationsOf(k, p).length)) out.push({ id: 'relations', kind: 'application-landscape', title: T(ws, 'Grafo de relaciones', 'Relations graph') });
  if (k.pieces.some((p) => p.type === 'process')) out.push({ id: 'processes', kind: 'process-landscape', title: T(ws, 'Paisaje de procesos', 'Process landscape') });
  for (const e of envs) out.push({ id: `topology:${e.env}`, kind: 'environment-map', title: T(ws, `Topología de ${e.env}`, `Topology of ${e.env}`) });
  return out;
}

export function deriveDiagram(ws: Workspace, g: Graph | null, k: Knowledge, envs: EnvMembers, id: string): DiagramModel | null {
  if (id === 'processes') return deriveProcesses(ws, k);
  if (id === 'relations') return deriveRelations(ws, k);
  if (id.startsWith('relations:')) return k.byId.has(id.slice(10)) ? deriveRelations(ws, k, id.slice(10)) : null;
  if (!g) return null;
  if (id === 'c4-context') return deriveContext(ws, k, g);
  if (id === 'c4-container') return deriveContainers(ws, g);
  if (id === 'er') return deriveEr(ws, g);
  if (id.startsWith('er:')) return k.byId.has(id.slice(3)) ? deriveEr(ws, g, k, id.slice(3)) : null;
  if (id === 'dependencies') return deriveDependencies(ws, g);
  if (id.startsWith('topology:')) { const e = envs.find((x) => x.env === id.slice(9)); return e ? deriveTopology(ws, g, e.env, e.services) : null; }
  return null;
}
