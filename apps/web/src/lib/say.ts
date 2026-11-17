/**
 * What «Paso a paso» and «Cadena» say: one sentence per act, per Secuencia row and for the failure, and why each hop
 * happened. Pure. The map and the knowledge (contracts, data models) only add names; without them a sentence falls
 * back to the code's handler, then to the table. A typed value is never said: marks do not carry it.
 */
import { isBrowser, type Action, type Exchange, type Trace } from '@laru/trace/trace';
import { endpointMatcher } from '@laru/trace/assemble';
import { actorOf, chain as chainOf, isConsume, isHello, isStream, type Act, type Cause, type Chain } from '@laru/trace/chain';
import { endpointOf } from '@laru/trace/summarize';
import type { DocPiece, Fact, MapNode } from '../api.ts';
import { entitiesOf, errorsOf, eventsOf, listed, norm, opsOf } from './contracts.ts';
/** An object key as a request carried it: one with a stray % (the app's own key) is shown as it came, never breaking the narration. */
const decodedPath = (k: string) => { try { return decodeURIComponent(k); } catch { return k; } };
import type { Row, Stop } from './seq.ts';
import { LANG, LOCALE, tr } from './i18n.ts';
import { faultLabel, participantName } from './es.ts';

export type { Stop };
export type SayTrace = Pick<Trace, 'exchanges' | 'steps' | 'participants' | 'failure'> & { actions?: Action[] };

export interface SayCtx {
  trace: SayTrace;
  /** layoutSeq(trace).rows */
  rows: Row[];
  chain: Chain;
  name(id: string): string;
  /** the map endpoint (`ep:svc:METHOD /path`) an http hop reached */
  endpointOf(e: Exchange): string | undefined;
  handler(endpoint: string): string | undefined;
  /** `via proxy /api/`: the path a front passes through to a service as is */
  proxy(from: string, to: string): string | undefined;
  /** the contract operation a service's endpoint implements (`{x}` and `{}` compare) */
  op(service: string, method: string, template: string): { summary?: string; contract: string; errors: Array<{ status: string; when: string }> } | undefined;
  /** a table's entity and the service that owns it: data models, else the map's maps-table */
  entity(table: string): { entity: string; owner?: string } | undefined;
  /** the method that consumes a topic in a service, from the map's consumes fact */
  listener(service: string, topic: string): string | undefined;
  publishers(topic: string): string[];
  /** the contract's payload of a topic, for a publish whose body the trace lacks */
  payload(topic: string): string[] | undefined;
  /** a datastore's kind (relational, file, queue…) */
  storeKind(id: string): string | undefined;
}

/** The context from the trace, its rows and, when there are, the map and the knowledge's pieces. */
export function sayCtx(o: { trace: SayTrace; rows: Row[]; chain?: Chain; map?: { nodes: MapNode[]; facts: Fact[] } | null; pieces?: DocPiece[] }): SayCtx {
  const nodes = o.map?.nodes ?? [], facts = o.map?.facts ?? [], pieces = o.pieces ?? [];
  const match = endpointMatcher(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const names = new Map(o.trace.participants.map((p) => [p.id, participantName(p)]));
  const ops = opsOf(pieces), entities = entitiesOf(pieces), events = eventsOf(pieces);
  const svc = (s: string) => s.replace(/^svc:/, '');
  return {
    trace: o.trace, rows: o.rows, chain: o.chain ?? chainOf(o.trace),
    name: (id) => names.get(id) ?? id,
    endpointOf: (e) => endpointOf(e, match),
    handler: (ep) => { const h = byId.get(ep)?.attrs?.handler; return typeof h === 'string' ? h : undefined; },
    proxy: (from, to) => facts.find((f) => f.p === 'calls' && f.s === `svc:${from}` && f.o.startsWith(`ep:${to}:`) && /via proxy/.test(f.note ?? ''))?.note?.match(/via proxy (\S+)/)?.[1],
    op: (service, method, template) => {
      const x = ops.find((p) => p.service === `svc:${service}` && p.method === method && norm(p.path) === norm(template));
      return x && { summary: x.summary || undefined, contract: x.contract.title, errors: errorsOf(x.contract) };
    },
    entity: (table) => {
      const x = entities.find((en) => en.table?.toLowerCase() === table);
      if (x) return { entity: x.entity, owner: x.owner && svc(x.owner) };
      const f = facts.find((y) => y.p === 'maps-table' && y.o === `tbl:${table}`);
      return f && { entity: f.anchor?.symbol ?? table, owner: svc(f.s) };
    },
    listener: (service, topic) => facts.find((f) => f.p === 'consumes' && f.s === `svc:${service}` && f.o === `topic:${topic}`)?.anchor?.symbol,
    publishers: (topic) => facts.filter((f) => f.p === 'publishes' && f.o === `topic:${topic}`).map((f) => svc(f.s)),
    payload: (topic) => events.find((x) => x.topic === topic && x.payload && /publish/.test(x.direction))?.payload?.split(/\s*,\s*/).filter((w) => /^\w+$/.test(w)),
    storeKind: (id) => byId.get(`ds:${id}`)?.kind,
  };
}

const STATUS: Record<number, string> = {
  200: tr('correcto'), 201: tr('creado'), 202: tr('aceptado'), 204: tr('sin contenido'), 301: tr('redirige'), 302: tr('redirige'), 304: tr('sin cambios'), 400: tr('petición incorrecta'), 401: tr('sin sesión'),
  403: tr('prohibido'), 404: tr('no existe'), 409: tr('conflicto'), 422: tr('no procesable'), 429: tr('demasiadas peticiones'), 500: tr('error interno'), 502: tr('pasarela sin respuesta válida'),
  503: tr('no disponible'), 504: tr('pasarela sin respuesta a tiempo'),
};
/** 201 (creado); a code without a phrase, the number alone. */
export const statusText = (s: number) => (STATUS[s] ? `${s} (${STATUS[s]})` : String(s));
const STATUSY = /status|state|estado/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** ids as their first four characters: 40fd…_informe.pdf */
const short = (s: string) => s.replace(UUID, (u) => `${u.slice(0, 4)}…`);
const json = (s?: string): unknown => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const prim = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const list = (xs: string[]) => new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(xs);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stop = (s: string) => (/[.!?…»]$/.test(s) ? s : `${s}.`);
/** 0:01.730; before the video's first frame (a case's calls can start before it), 0:00.000, as `clock` does */
export const at = (t: number) => { const ms = Math.max(0, Math.round(t)); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
const tpl = (ep: string) => ep.replace(/^ep:[^:]*:/, '');
const evName = (e: Exchange) => e.label.replace(/^evento /, '');
const isPage = (e: Exchange) => e.method === 'GET' && /text\/html/i.test(String(e.resHeaders?.['content-type'] ?? ''));
const AMBIGUOUS = 'publicador ambiguo';

const BY = new WeakMap<Exchange[], Map<string, Exchange>>();
/** The trace's exchanges by id, built once per trace: every sentence of a tree asks for it. */
const by = (ctx: SayCtx) => { let m = BY.get(ctx.trace.exchanges); if (!m) BY.set(ctx.trace.exchanges, (m = new Map(ctx.trace.exchanges.map((e) => [e.id, e])))); return m; };
/** The browser, the test and the host as a sentence names them; a service by its name. */
const who = (ctx: SayCtx, id: string) => (id === 'browser' ? tr('el navegador') : id.startsWith('browser:') ? tr('el navegador de {slice}', { slice: id.slice(8) }) : id === 'runner' ? tr('la prueba') : id === 'host' ? tr('tu máquina') : ctx.name(id));
/** «al navegador», or «al navegador de luis» for another screen of the test. */
const toBrowser = (id: string) => (id === 'browser' ? tr('al navegador') : tr('al navegador de {slice}', { slice: id.slice(8) }));
/** The same, starting a sentence: a service keeps its name as written. */
const Who = (ctx: SayCtx, id: string) => (['runner', 'host'].includes(id) || isBrowser(id) ? cap(who(ctx, id)) : ctx.name(id));
/** The call a request is, as far down as it was forwarded: the deepest forward's endpoint, else its label. */
function deepest(ctx: SayCtx, e: Exchange): Exchange {
  const ex = by(ctx);
  for (let x = e, i = 0; i < 50; i++) {
    const next = (ctx.chain.effects.get(x.id) ?? []).find((id) => ctx.chain.cause.get(id)?.how === 'forward');
    if (!next) return x;
    x = ex.get(next)!;
  }
  return e;
}
/** A call as its endpoint's template; a proxy's wildcard rule (`/api/files/**`) says less than the call's own path. */
const named = (ctx: SayCtx, e: Exchange) => { const ep = ctx.endpointOf(e); return ep && !ep.includes('*') ? tpl(ep) : e.label; };
const what = (ctx: SayCtx, e: Exchange) => { const d = deepest(ctx, e); return named(ctx, d === e || ctx.endpointOf(d) ? d : e); };
const opOf = (ctx: SayCtx, e: Exchange) => { const ep = ctx.endpointOf(e); return ep && e.method ? ctx.op(e.to, e.method, tpl(ep).replace(/^\S+ /, '')) : undefined; };
/** At most 2 status-like fields of an object; for an array, its size and up to 3 distinct status-like values. */
function fields(body: unknown): { n?: number; vals: string[] } {
  const pick = (o: Record<string, unknown>) => Object.entries(o).filter(([k, v]) => STATUSY.test(k) && prim(v)).map(([k, v]) => `${k} ${v}`);
  if (Array.isArray(body)) return { n: body.length, vals: [...new Set(body.flatMap((x) => (obj(x) ? pick(obj(x)!) : [])))].slice(0, 3) };
  return { vals: obj(body) ? pick(obj(body)!).slice(0, 2) : [] };
}

// ---- acts ----

const ROLE: Record<string, [string, string]> = {
  button: [tr('el botón'), tr('un botón sin nombre')], link: [tr('el enlace'), tr('un enlace sin nombre')], textbox: [tr('el campo'), tr('un campo sin nombre')],
  checkbox: [tr('la casilla'), tr('una casilla sin nombre')], tab: [tr('la pestaña'), tr('una pestaña sin nombre')], menuitem: [tr('la opción'), tr('una opción sin nombre')],
};
/**
 * What a locator points at, by its last naming segment: `getByRole('button', { name: 'X' })` and
 * `internal:role=button[name="X"i]` alike; getByLabel and getByPlaceholder are a field; getByText('x') is «x».
 */
export function targetOf(loc?: string): { role?: string; name?: string } {
  if (!loc) return {};
  const un = (s: string) => s.replace(/\\(.)/g, '$1');
  let best: { at: number; role?: string; name?: string } | undefined;
  const seen = (pos: number, role?: string, name?: string) => { if (!best || pos >= best.at) best = { at: pos, role, name: name === undefined ? undefined : un(name) }; };
  for (const m of loc.matchAll(/getBy(Role|Text|Label|Placeholder|Title|AltText|TestId)\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*(?:,\s*\{([^}]*)\})?\s*\)/g)) {
    if (m[1] === 'Role') seen(m.index, m[3], /name:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(m[4] ?? '')?.[2]);
    else seen(m.index, m[1] === 'Label' || m[1] === 'Placeholder' ? 'textbox' : undefined, m[3]);
  }
  for (const m of loc.matchAll(/internal:role=(\w+)(?:\[name="((?:\\.|[^"])*)"[is]?\])?/g)) seen(m.index, m[1], m[2]);
  for (const m of loc.matchAll(/internal:(text|label)="((?:\\.|[^"])*)"[is]?/g)) seen(m.index, m[1] === 'label' ? 'textbox' : undefined, m[2]);
  for (const m of loc.matchAll(/internal:attr=\[placeholder="((?:\\.|[^"])*)"[is]?\]/g)) seen(m.index, 'textbox', m[1]);
  return best ? { role: best.role, name: best.name } : {};
}
const thing = (loc?: string) => {
  const t = targetOf(loc);
  if (t.name) return t.role && ROLE[t.role] ? `${ROLE[t.role][0]} «${t.name}»` : `«${t.name}»`;
  return t.role && ROLE[t.role] ? ROLE[t.role][1] : tr('un elemento sin nombre');
};
/** The file an act picked: its multipart request's first file, else «un fichero». */
function picked(ctx: SayCtx, a: Act): string {
  const ex = by(ctx);
  for (const id of a.roots) {
    const f = (obj(json(ex.get(id)?.req?.text))?.files as Array<{ filename?: string; size?: number }> | undefined)?.[0];
    if (f?.filename) return `${f.filename}${f.size !== undefined ? ` (${f.size} B)` : ''}`;
  }
  return tr('un fichero');
}
/** «de el campo» is «del campo»; in English the preposition the verb asks for (`en`: «in», «over»). */
const de = (o: string, en: string) => (LANG === 'en' ? `${en} ${o}` : o.startsWith('el ') ? `del ${o.slice(3)}` : `de ${o}`);
/** A mark as a verb and what it acts on. */
function markWords(ctx: SayCtx, a: Act, m: Action): [string, string] {
  switch (m.kind) {
    case 'click': return m.target ? [tr('pulsa'), thing(m.target)] : [tr('pulsa'), tr('en un punto de la página')];
    case 'dblclick': return [tr('pulsa dos veces'), thing(m.target)];
    case 'tap': return [tr('toca'), thing(m.target)];
    case 'fill': case 'type': { const t = targetOf(m.target); return [tr('escribe'), t.name ? tr('en «{name}»', { name: t.name }) : tr('en {thing}', { thing: thing(m.target) })]; }
    case 'press': return m.key ? [tr('pulsa la tecla'), m.key] : [tr('pulsa una tecla'), ''];
    case 'check': return [tr('marca'), thing(m.target)];
    case 'uncheck': return [tr('desmarca'), thing(m.target)];
    case 'select': return [tr('elige una opción'), de(thing(m.target), 'in')];
    case 'hover': return [tr('pasa por encima'), de(thing(m.target), 'over')];
    case 'files': return [tr('elige'), picked(ctx, a)];
    case 'navigate': return [tr('abre'), m.path ?? tr('una página')];
    case 'back': return [tr('vuelve'), tr('atrás')];
    case 'reload': return [tr('recarga'), tr('la página')];
    case 'drag': return [tr('arrastra'), thing(m.target)];
  }
}
/** One mark said: «escribe en «Ingresa tu usuario»», «pulsa el botón «Subir»». */
export const markSaid = (m: Action, a: Act, ctx: SayCtx) => markWords(ctx, a, m).filter(Boolean).join(' ');
/** «escribe en «A» y en «B» y pulsa el botón «C»»: consecutive marks with the same verb share it. */
function marksSaid(ctx: SayCtx, a: Act, marks = a.marks): string {
  const parts: Array<[string, string[]]> = [];
  for (const m of marks) {
    const [verb, o] = markWords(ctx, a, m);
    const last = parts.at(-1);
    if (last?.[0] === verb) last[1].push(o); else parts.push([verb, [o]]);
  }
  return list(parts.map(([verb, os]) => [verb, os.filter(Boolean).join(' y ')].filter(Boolean).join(' ')));
}

function sayAct(a: Act, ctx: SayCtx): string {
  const ex = by(ctx);
  const roots = a.roots.map((id) => ex.get(id)!);
  const first = roots.find((r) => !ctx.chain.noise.has(r.id)) ?? roots[0];
  const step = ctx.trace.steps.find((s) => s.n === a.step);
  switch (a.kind) {
    case 'setup': return tr('La prueba prepara datos por la API antes del primer paso: {list}.', { list: list([...new Set(roots.map((r) => what(ctx, r)))]) });
    case 'check': {
      const x = `${what(ctx, first)}${a.n ? ` ×${a.n}` : ''}`;
      return ctx.trace.steps.length ? tr('La prueba comprueba por la API: {x} (no lo hace la persona).', { x }) : tr('El caso llama a la API: {x}.', { x });
    }
    case 'page': return tr('La página pide {what} por su cuenta: la persona no hizo nada en el último segundo.', { what: what(ctx, first) });
    case 'burst': {
      const where = step ? tr(' (paso {n}, «{title}»)', { n: step.n, title: step.title }) : '';
      return isPage(first) ? tr('El navegador abre {path}{where}.', { path: first.path, where }) : tr('El navegador envía {what}{where}.', { what: what(ctx, first), where });
    }
    case 'person': return tr('La persona {marksSaid}.{p1}', { marksSaid: marksSaid(ctx, a), p1: a.roots.length ? '' : tr(' No sale ninguna petición: solo cambia la página.') });
  }
}

/** What an act went through: services, writes by store, objects, topics and who consumed them, notices, failures. */
export function actSummary(a: Act, ctx: SayCtx): string {
  // in the order the chain reaches them: a request before its forward even when both span the same milliseconds, then by time
  const depth = new Map<string, number>();
  const mine = ctx.trace.exchanges.filter((e) => ctx.chain.actOf.get(e.id) === a.id);
  for (const e of mine) { let d = 0; for (let x = ctx.chain.cause.get(e.id)?.parent; x && d < 200; x = ctx.chain.cause.get(x)?.parent) d++; depth.set(e.id, d); }
  mine.sort((x, y) => depth.get(x.id)! - depth.get(y.id)! || x.t0 - y.t0 || (y.t1 ?? y.t0) - (x.t1 ?? x.t0));
  const type = new Map(ctx.trace.participants.map((p) => [p.id, p.type]));
  const services = new Set<string>(), writes = new Map<string, Map<string, number>>(), objects = new Map<string, Map<string, number>>(), topics = new Map<string, Set<string>>(), notices = new Set<string>();
  const count = (m: Map<string, Map<string, number>>, store: string, w: string) => { const s = m.get(store) ?? m.set(store, new Map()).get(store)!; s.set(w, (s.get(w) ?? 0) + 1); };
  for (const e of mine) {
    // who it went through: whom it called, whoever emitted an aviso, and a consumer that took a message
    const actor = e.kind === 'sse' || e.kind === 'http' || e.kind === 'tcp' || isConsume(e) ? e.to : undefined;
    if (actor && type.get(actor) === 'service' && !(e.kind === 'sse' && ctx.chain.cause.get(e.id)?.how === 'relay')) services.add(actor);
    if (e.kind === 'sql' && e.table) {
      const v = e.label.split(' ')[0], ent = ctx.entity(e.table)?.entity;
      if (v === 'INSERT') count(writes, e.to, ent ? `insert:${ent}` : 'insert');
      else if (v === 'UPDATE') count(writes, e.to, 'update');
      else if (v === 'DELETE') count(writes, e.to, 'delete');
    }
    if (e.kind === 'http' && ctx.storeKind(e.to) === 'file') count(objects, e.to, e.reqHeaders?.['x-amz-copy-source'] ? 'copy' : e.method === 'PUT' ? 'put' : e.method === 'DELETE' ? 'delete' : 'read');
    if (e.kind === 'kafka') { const s = topics.get(e.label) ?? topics.set(e.label, new Set()).get(e.label)!; if (isConsume(e)) s.add(e.to); }
    if (e.kind === 'sse' && isBrowser(e.from) && !isHello(e)) notices.add(evName(e));
  }
  // «guarda 2 filas de «Usuario» y 1 de «Fichero»»: «fila» agrees in number, so an entity's gender never has to
  const VERB: Record<string, string> = { insert: tr('guarda'), update: tr('actualiza'), delete: tr('borra'), copy: tr('copia'), put: tr('sube'), read: tr('lee') };
  const counts = (m: Map<string, number>) => {
    const ins = [...m].filter(([w]) => w.startsWith('insert:'));
    const rows = list(ins.map(([w, n], i) => (i ? tr('{n} de «{ent}»', { n, ent: w.slice(7) }) : n === 1 ? tr('1 fila de «{ent}»', { ent: w.slice(7) }) : tr('{n} filas de «{ent}»', { n, ent: w.slice(7) }))));
    return [...m].flatMap(([w, n]) => (!w.startsWith('insert:') ? [`${VERB[w]} ${n}`] : w === ins[0][0] ? [`${VERB.insert} ${rows}`] : [])).join(', ');
  };
  const bad = mine.filter((e) => !e.ok).length;
  return [
    services.size ? tr('Recorre {list}', { list: list([...services]) }) : '',
    ...[...writes].map(([s, m]) => `${s}: ${counts(m)}`), ...[...objects].map(([s, m]) => `${s}: ${counts(m)}`),
    topics.size ? tr('publica {topics}', { topics: [...topics].map(([t, c]) => `${t}${c.size ? ` (→ ${[...c].join(', ')})` : ''}`).join(', ') }) : '',
    notices.size ? tr('llega al navegador: {join}', { join: [...notices].join(', ') }) : '',
    bad === 1 ? tr('1 fallo') : tr('{bad} fallos', { bad }),
  ].filter(Boolean).join(' · ');
}

// ---- rows ----

function faults(e: Exchange, ctx: SayCtx): string[] {
  const from = who(ctx, e.from), to = ctx.name(e.to);
  return (e.fault ?? '').split(', ').filter(Boolean).map((f) => {
    let m: RegExpExecArray | null;
    if ((m = /^latencia \+(\d+) ms inyectada$/.exec(f))) return tr('Laru retrasa esta llamada {p0} ms antes de pasarla a {to}.', { p0: m[1], to });
    if ((m = /^estado (\d+) inyectado$/.exec(f))) return tr('Laru no deja pasar esta llamada y responde {p0} en nombre de {to}.', { p0: m[1], to });
    if (f === 'abortado') return tr('Laru corta la conexión: {from} se queda sin respuesta.', { from });
    if (f === 'sin respuesta') return tr('Laru retiene la llamada sin responder: {from} espera hasta su tiempo límite.', { from });
    if ((m = /^ancho de banda (\d+) B\/s(?: tras (\d+) B)?$/.exec(f))) return tr('Laru limita la respuesta a {p0} B/s{p1}.', { p0: m[1], p1: m[2] ? tr(' a partir del byte {p0}', { p0: m[2] }) : '' });
    return tr('Laru: {fault}.', { fault: faultLabel(f) });
  });
}
function mockSaid(e: Exchange, ctx: SayCtx): string[] {
  if (e.mock === 'sink' || e.mock === 'callback') return []; // a mailbox is said by its own sentence
  return [
    ...(e.mock === 'miss' ? [tr('El mock no tiene respuesta para esto.')] : e.mock ? [tr('Responde el mock de Laru ({mock}), no {name} real.', { mock: e.mock, name: ctx.name(e.to) })] : []),
    ...(e.drift?.length ? [tr('No cumple el contrato del mock: {p0}.', { p0: e.drift[0] })] : []),
  ];
}

/** An object store call (a datastore of kind file, or S3's own headers): what it does with which object. */
function objectSaid(e: Exchange, ctx: SayCtx): string | undefined {
  if (ctx.storeKind(e.to) !== 'file' && !Object.keys(e.reqHeaders ?? {}).some((k) => /^x-amz-(?!target)/i.test(k))) return;
  const from = who(ctx, e.from), to = ctx.name(e.to);
  const [, bucket = '', ...rest] = (e.path ?? '').split('/');
  const key = short(decodedPath(rest.join('/')));
  const copy = e.reqHeaders?.['x-amz-copy-source'];
  if (e.method === 'PUT' && copy) return tr('{from} copia {source} a {bucket}/{key}.', { from, source: short(decodedPath(copy.replace(/^\//, ''))), bucket, key });
  if (!key) return tr('{from} comprueba el bucket {bucket} de {to}.', { from, bucket, to });
  if (e.method === 'PUT') return tr('{from} sube {key} al bucket {bucket} de {to} ({p4} B).', { from, key, bucket, to, p4: e.req?.bytes ?? 0 });
  if (e.method === 'GET' || e.method === 'HEAD') return tr('{from} lee {key} del bucket {bucket} de {to}.', { from, key, bucket, to });
  if (e.method === 'DELETE') return tr('{from} borra {key} del bucket {bucket} de {to}.', { from, key, bucket, to });
}
const DYNAMO: Array<[RegExp, string]> = [[/^(Get|BatchGet|Query|Scan)/, tr('lee de')], [/^(Put|BatchWrite)/, tr('escribe en')], [/^Update/, tr('actualiza en')], [/^Delete/, tr('borra de')], [/^(Execute|BatchExecute)/, tr('ejecuta PartiQL sobre')]];

function httpRequest(e: Exchange, ctx: SayCtx): string {
  const from = who(ctx, e.from), to = ctx.name(e.to);
  if (e.asset) return tr('{asset} {p1} (JS, CSS, imágenes) en {p2} ms.', { asset: e.asset, p1: e.asset === 1 ? tr('recurso estático') : tr('recursos estáticos'), p2: (e.t1 ?? e.t0) - e.t0 });
  if (e.kind === 'ws') return tr('{Who} abre un WebSocket con {to} en {path}.', { Who: Who(ctx, e.from), to, path: e.path });
  if (isStream(e)) return tr('{Who} abre el canal de avisos con {to} (SSE, {path}).', { Who: Who(ctx, e.from), to, path: e.path });
  if (isBrowser(e.from) && isPage(e)) return tr('{cap} pide la página {path} a {to}.', { cap: cap(who(ctx, e.from)), path: e.path, to });
  if (isBrowser(e.from) || e.from === 'runner') {
    const d = deepest(ctx, e), ep = ctx.endpointOf(d), op = opOf(ctx, d), h = ep && ctx.handler(ep);
    return tr('{Who} llama a {what}{p2}. La atiende {name}{p4}.', { Who: Who(ctx, e.from), what: what(ctx, e), p2: op?.summary ? `: «${op.summary}»` : '', name: ctx.name(d.to), p4: h ? ` (${h})` : '' });
  }
  const c = ctx.chain.cause.get(e.id);
  if (c?.how === 'forward') {
    const proxy = ctx.proxy(e.from, e.to);
    if (proxy) return tr('{from} la pasa tal cual a {to} (proxy {proxy}).', { from, to, proxy });
    const rule = ctx.endpointOf(by(ctx).get(c.parent)!), ep = ctx.endpointOf(e), h = ep && ctx.handler(ep);
    return `${[tr('{from} la reenvía a {to}', { from, to }), rule && tr('por la regla {tpl}', { tpl: tpl(rule) }), h && tr('que la atiende con {h}', { h })].filter(Boolean).join(', ')}.`;
  }
  const obj = objectSaid(e, ctx);
  if (obj) return obj;
  const op = /^DynamoDB(?:Streams)?_\d+\.(\w+)$/.exec(e.reqHeaders?.['x-amz-target'] ?? '')?.[1];
  if (op) return tr('{from} {p1} la tabla {p2} de {to} ({op}).', { from, p1: DYNAMO.find(([re]) => re.test(op))?.[1] ?? tr('llama a'), p2: e.table ?? '?', to, op });
  const ep = ctx.endpointOf(e), contract = opOf(ctx, e);
  const service = ctx.trace.participants.find((p) => p.id === e.to)?.type === 'service';
  return tr('{from} llama a {to}: {what}{summary}{missing}.', { from, to, what: ep ? tpl(ep) : e.label, summary: contract?.summary ? ` — «${contract.summary}»` : '', missing: !ep && service ? tr(' ({to} no tiene ese endpoint entre los extraídos del código)', { to }) : '' });
}

function httpResponse(e: Exchange, ctx: SayCtx): string {
  const to = ctx.name(e.to);
  if (e.error) return tr('La llamada falla sin respuesta: {stop}', { stop: stop(e.error) });
  if (e.status === undefined) return tr('{to} no responde.', { to });
  const body = json(e.res?.text);
  if (e.status >= 400 || !e.ok) {
    const b = obj(body), msg = b && ['error', 'message', 'detail', 'title'].map((k) => b[k]).find((v) => typeof v === 'string');
    const op = opOf(ctx, e);
    const err = op?.errors.find((x) => x.status === String(e.status)) ?? op?.errors.find((x) => listed(String(e.status), [x]));
    const hint = !op ? '' : err ? tr(' El contrato «{contract}» lo prevé{p1}.', { contract: op.contract, p1: err.when ? `: «${err.when}»` : '' }) : tr(' El contrato no lo lista entre sus errores.');
    return tr('{to} responde {status}{msg}.{hint}', { to, status: statusText(e.status), msg: msg ? `: «${msg}»` : '', hint });
  }
  const f = fields(body);
  const tail = f.n !== undefined ? tr(', con {n} {p1}{p2}', { n: f.n, p1: f.n === 1 ? tr('elemento') : tr('elementos'), p2: f.vals.length ? `: ${f.vals.join(', ')}` : '' }) : f.vals.length ? tr(', con {list}', { list: list(f.vals) }) : '';
  return tr('{to} responde {statusText} en {p2} ms{tail}.', { to, statusText: statusText(e.status), p2: (e.t1 ?? e.t0) - e.t0, tail });
}

/** An UPDATE's status-like `col = value` pairs; the values only when every placeholder has its parameter. */
function setSaid(text = ''): string | undefined {
  const [stmt, params = ''] = text.split('\n-- ');
  const set = /\bset\s+([\s\S]*?)(?:\s+where\b|$)/i.exec(stmt)?.[1] ?? '';
  const holes = new Set(stmt.match(/\$\d+/g) ?? []);
  const vals = new Map([...params.matchAll(/\$(\d+) = ('(?:[^']|'')*'|NULL|[^,]+)/g)].map((m) => [`$${m[1]}`, m[2]]));
  const whole = holes.size > 0 && vals.size === holes.size && [...holes].every((h) => vals.has(h));
  const pairs = set.split(',').map((p) => /^\s*"?(\w+)"?\s*=\s*(\$\d+|'[^']*'|[\w.]+)/.exec(p)).filter((m): m is RegExpExecArray => Boolean(m && STATUSY.test(m[1])))
    .map(([, col, v]) => (!v.startsWith('$') ? `${col} = ${v}` : whole ? `${col} = ${vals.get(v)}` : col));
  return pairs.length ? list(pairs) : undefined;
}

function sqlRow(e: Exchange, ctx: SayCtx): string {
  const from = who(ctx, e.from), to = ctx.name(e.to);
  if (e.error) return tr('{to} rechaza la sentencia: {stop}', { to, stop: stop(e.error.split('\n')[0]) });
  const verb = e.label.split(' ')[0], t = e.table, ent = t ? ctx.entity(t) : undefined;
  const owner = ent?.owner && ent.owner !== e.from ? tr(', tabla de {owner}', { owner: ent.owner }) : '';
  switch (verb) {
    case 'SELECT': return ent ? tr('{from} lee «{entity}» ({t}{owner}).', { from, entity: ent.entity, t, owner }) : tr('{from} lee de {p1}.', { from, p1: t ?? to });
    case 'INSERT': return tr('{from} guarda una fila nueva{p1} en {p2}{owner}.', { from, p1: ent ? tr(' de «{entity}»', { entity: ent.entity }) : '', p2: t ?? to, owner });
    case 'UPDATE': { const set = setSaid(e.req?.text); return tr('{from} actualiza {what}{set}.', { from, what: ent ? `«${ent.entity}»` : t ?? to, set: set ? tr(' y deja {set}', { set }) : '' }); }
    case 'DELETE': return tr('{from} borra {p1} en {p2}.', { from, p1: ent ? `«${ent.entity}»` : tr('filas'), p2: t ?? to });
    default: return tr('{from} ejecuta {p1} en {to}.', { from, p1: verb || tr('una sentencia'), to });
  }
}

function kafkaRow(e: Exchange, ctx: SayCtx): string {
  if (isConsume(e)) {
    const l = ctx.listener(e.to, e.label);
    const first = (ctx.chain.effects.get(e.id) ?? []).map((id) => by(ctx).get(id)!)[0];
    // its work may start up to TOL_MS before the delivery's time (two clocks): that is at once, never «-1 ms más tarde»
    const late = first ? first.t0 - e.t0 : 0;
    return tr('{name} recibe {label}{p2}. Lo dice el código: la entrega no se ve en la red. {p3}', { name: ctx.name(e.to), label: e.label, p2: l ? tr(' en {l}', { l }) : '', p3: !first ? tr('No se ve que haga nada después en esta prueba.') : late > 0 ? tr('Lo primero que hace después se ve {late} ms más tarde.', { late }) : tr('Lo primero que hace se ve en ese mismo momento.') });
  }
  if (e.from === AMBIGUOUS) { const p = ctx.publishers(e.label); return tr('Alguien publica {label}: el código tiene {length} publicadores ({join}) y la traza no dice cuál.', { label: e.label, length: p.length, join: p.join(', ') }); }
  const body = obj(json(e.req?.text));
  const keys = body ? Object.keys(body) : (ctx.payload(e.label) ?? []);
  const st = body && Object.entries(body).find(([k, v]) => STATUSY.test(k) && prim(v));
  const named = keys.length > 5 ? tr('{join} y {p1} más', { join: keys.slice(0, 4).join(', '), p1: keys.length - 4 }) : list(keys);
  return tr('{name} publica {label} en {name2}{p3}{p4}.', { name: ctx.name(e.from), label: e.label, name2: ctx.name(e.to), p3: keys.length ? `: ${named}` : '', p4: st ? tr(', con {p0} {p1}', { p0: st[0], p1: st[1] }) : '' });
}

function sseRow(e: Exchange, ctx: SayCtx): string {
  const ev = evName(e), relay = ctx.chain.cause.get(e.id)?.how === 'relay';
  // only the hop that opens the channel greets; the ones nearer the browser pass its greeting on
  if (isHello(e)) return relay ? tr('{name} pasa el saludo «{ev}» {p2}.', { name: ctx.name(e.to), ev, p2: isBrowser(e.from) ? toBrowser(e.from) : `a ${ctx.name(e.from)}` }) : tr('Se abre el canal: {name} saluda con «{ev}».', { name: ctx.name(e.to), ev });
  if (isBrowser(e.from)) return tr('El aviso {ev} llega {toBrowser}.', { ev, toBrowser: toBrowser(e.from) });
  if (relay) return tr('{name} pasa el aviso a {name2}.', { name: ctx.name(e.to), name2: ctx.name(e.from) });
  const b = obj(json(e.res?.text)), name = b && ['fileName', 'name', 'title'].map((k) => b[k]).find((v) => typeof v === 'string');
  return tr('{name} envía el aviso {ev} por el canal abierto{p2}.', { name: ctx.name(e.to), ev, p2: name ? `: ${name}` : '' });
}

/** A message a sink kept, or the status call it made about it: said as what it is, and that nothing left the machine. */
function messageRow(e: Exchange, ctx: SayCtx): string | undefined {
  const m = e.msg;
  if (!m) return;
  const from = ctx.name(e.from), to = ctx.name(e.to);
  if (m.cb) return tr('{from} avisa a {to} de que el SMS {p2}{p3}.', { from, to, p2: m.cb === 'delivered' ? tr('se entregó') : m.cb === 'sent' ? tr('salió') : m.cb === 'received' ? tr('llegó desde un teléfono') : tr('quedó {cb}', { cb: m.cb }), p3: e.status ? tr(' ({to} responde {status})', { to, status: e.status }) : '' });
  const sent = m.kind === 'mail' ? tr('un correo a {to}{p1}', { to: m.to, p1: m.subject ? `, «${m.subject}»` : '' }) : tr('un SMS a {to}', { to: m.to });
  return tr('{from} manda {sent}: {p2} y no sale de tu máquina.', { from, sent, p2: e.status && e.status >= 400 ? tr('el buzón responde {status}', { status: e.status }) : tr('queda en el buzón del entorno') });
}

function tcpRow(e: Exchange, ctx: SayCtx): string {
  const said = messageRow(e, ctx);
  if (said) return said;
  const from = ctx.name(e.from), to = ctx.name(e.to), up = e.req?.bytes ?? 0;
  const found = /^stream: (.+) FOUND\.?$/.exec(e.label);
  const scan = tr('{from} manda {up} B a {to} para analizarlo y {to} responde', { from, up, to });
  if (/^stream: OK\.?$/.test(e.label)) return tr('{scan}: limpio.', { scan });
  if (found) return tr('{scan}: infectado ({virus}).', { scan, virus: found[1] });
  if (/ERROR/.test(e.label)) return tr('{scan} con error: {label}.', { scan, label: e.label });
  return tr('{from} abre una conexión con {to}: {up} B enviados, {p3} B recibidos{p4}.', { from, to, up, p3: e.res?.bytes ?? 0, p4: /^\d+ B ↑ \d+ B ↓$/.test(e.label) ? '' : tr('; la respuesta empieza por «{label}»', { label: e.label }) });
}

function sayRow(r: Row, ctx: SayCtx): string {
  const e = r.ex;
  if (e.kind === 'sql') return sqlRow(e, ctx);
  if (e.kind === 'kafka') return kafkaRow(e, ctx);
  if (e.kind === 'sse') return sseRow(e, ctx);
  if (r.reply) return [httpResponse(e, ctx), ...mockSaid(e, ctx)].join(' ');
  const base = e.msg ? messageRow(e, ctx)! : e.kind === 'tcp' ? tcpRow(e, ctx) : httpRequest(e, ctx);
  const silent = e.kind === 'http' && e.t1 === undefined && !e.error && !isStream(e) ? [tr('{name} no responde dentro de la ventana de la prueba.', { name: ctx.name(e.to) })] : [];
  const replies = (e.kind === 'http' || e.kind === 'ws') && !e.asset && e.t1 !== undefined;
  return [base, ...faults(e, ctx), ...(replies ? [] : mockSaid(e, ctx)), ...silent].join(' ');
}

// ---- the failure ----

/** When the failure happened: its failing row, else 300 ms before its step ended (not before the step began). */
function failTime(ctx: SayCtx): number {
  const f = ctx.trace.failure!;
  const row = ctx.rows.filter((r) => r.ex.id === f.exchange).sort((a, b) => Number(b.bad) - Number(a.bad))[0];
  const step = ctx.trace.steps.find((s) => s.n === f.step);
  return row?.t ?? (step ? Math.max(step.t0, step.t1 - 300) : Infinity);
}
function sayFail(ctx: SayCtx): string {
  const f = ctx.trace.failure;
  if (!f) return tr('La prueba no falló.');
  const step = ctx.trace.steps.find((s) => s.n === f.step);
  const lines = [step ? tr('Aquí falla la prueba, en el paso {n} «{title}»: {stop}', { n: step.n, title: step.title, stop: stop(f.message) }) : tr('Aquí falla el caso: {stop}', { stop: stop(f.message) })];
  if (step?.expected) lines.push(tr('Se esperaba: {stop}', { stop: stop(step.expected) }));
  const bad = ctx.rows.filter((r) => r.ex.id === f.exchange).sort((a, b) => Number(b.bad) - Number(a.bad))[0];
  lines.push(bad ? tr('El primer salto que falló: {sayRow}', { sayRow: sayRow(bad, ctx) }) : tr('Ningún salto entre servicios falló: el fallo está en la página.'));
  const t = failTime(ctx);
  const last = ctx.rows.filter((r) => r.t <= t && isBrowser(r.ex.from) && !ctx.chain.noise.has(r.ex.id) && (r.reply || r.ex.kind === 'sse')).at(-1);
  if (last) {
    const fl = fields(json(last.ex.res?.text));
    lines.push(tr('Lo último que recibió el navegador antes del fallo: {p0} ({at}).', { p0: last.ex.kind === 'sse' ? tr('el aviso {evName}', { evName: evName(last.ex) }) : `${what(ctx, last.ex)} → ${last.ex.status ?? last.ex.error}${fl.vals.length ? tr(' con {list}', { list: list(fl.vals) }) : ''}`, at: at(last.t) }));
  }
  return lines.join('\n');
}

/**
 * A hop in a few words, for a row of «Cadena»: what travels (`GET /api/files/stats`, `lee «Fichero»`, `publica file.clean`) and,
 * when the contract names it, what it is for. The whole sentence is the card's.
 */
export function brief(e: Exchange, ctx: SayCtx): { what: string; note?: string } {
  if (e.kind === 'sql') {
    const verb = e.label.split(' ')[0], t = e.table, ent = t ? ctx.entity(t)?.entity : undefined, obj = ent ? `«${ent}»` : t ?? ctx.name(e.to);
    return { what: `${({ SELECT: tr('lee'), INSERT: tr('guarda'), UPDATE: tr('actualiza'), DELETE: tr('borra') } as Record<string, string>)[verb] ?? verb.toLowerCase()} ${obj}` };
  }
  if (e.kind === 'kafka') return { what: `${isConsume(e) ? tr('recibe') : tr('publica')} ${e.label}` };
  if (e.kind === 'sse') return { what: isHello(e) ? tr('saludo «{evName}»', { evName: evName(e) }) : tr('aviso {name}', { name: evName(e) }) };
  if (e.msg) return { what: e.msg.cb ? tr('estado del SMS: {cb}', { cb: e.msg.cb }) : e.msg.kind === 'mail' ? tr('correo a {to}', { to: e.msg.to }) : tr('SMS a {to}', { to: e.msg.to }) };
  if (e.kind === 'tcp') {
    const found = /^stream: (.+) FOUND\.?$/.exec(e.label);
    return { what: /^stream: OK\.?$/.test(e.label) ? tr('analiza: limpio') : found ? tr('analiza: infectado ({p0})', { p0: found[1] }) : e.label };
  }
  if (e.asset) return { what: e.asset === 1 ? tr('1 recurso estático') : tr('{n} recursos estáticos', { n: e.asset }) };
  if (e.kind === 'ws') return { what: `WebSocket ${e.path ?? ''}`.trim() };
  if (isStream(e)) return { what: tr('abre el canal de avisos'), note: e.path };
  if (isBrowser(e.from) && isPage(e)) return { what: tr('página {path}', { path: e.path }) };
  const d = deepest(ctx, e), op = opOf(ctx, d) ?? opOf(ctx, e);
  return { what: what(ctx, e), ...(op?.summary ? { note: op.summary } : {}) };
}

/** The sentence of a stop: an act, a Secuencia row or the failure. */
export function say(s: Stop, ctx: SayCtx): string {
  return s.kind === 'act' ? sayAct(s.act, ctx) : s.kind === 'fail' ? sayFail(ctx) : ctx.rows[s.i] ? sayRow(ctx.rows[s.i], ctx) : '';
}

// ---- causes ----

const CERTAINTY = { sure: tr('seguro'), inferred: tr('deducido'), possible: tr('posible') };
/** «seguro», «deducido», «posible · también encaja en: GET /api/files/stats, GET /api/files/folders» */
export function chip(c: Cause, ctx: SayCtx): string {
  const ex = by(ctx);
  return c.certainty === 'possible' && c.alt?.length ? tr('posible · también encaja en: {join}', { join: c.alt.map((id) => (ex.get(id) ? named(ctx, ex.get(id)!) : id)).join(', ') }) : CERTAINTY[c.certainty];
}

function reason(c: Cause, ctx: SayCtx): string {
  const ex = by(ctx), w = c.why;
  if (!w) return '';
  if (w.by === 'shape') {
    const anchor = ex.get(w.like), under = anchor && ex.get(ctx.chain.cause.get(anchor.id)?.parent ?? '');
    return tr(' · misma sentencia que en {p0}{p1}', { p0: under ? named(ctx, under) : '?', p1: anchor ? ` (${at(anchor.t0)})` : '' });
  }
  if (w.by === 'id') return tr(' · por el identificador {slice}…, que solo trae {p1}', { slice: w.id.slice(0, 4), p1: ex.get(c.parent) ? named(ctx, ex.get(c.parent)!) : c.parent });
  if (w.by === 'write') return tr(' · una lectura (GET) no escribe');
  const [store, pid] = w.conn.split('#');
  return tr(' · misma conexión a {store} (pid {pid})', { store, pid });
}

/** «Lo provocó»: why this exchange happened, with the reason an ambiguous link was narrowed; for a root, its act. */
export function sayCause(e: Exchange, ctx: SayCtx): string {
  const c = ctx.chain.cause.get(e.id);
  if (!c) return rootSaid(e, ctx);
  const p = by(ctx).get(c.parent)!;
  const s = {
    forward: () => tr('La misma petición, reenviada por {who}', { who: who(ctx, e.from) }),
    message: () => tr('La entrega del mensaje que publicó {name} (mismo tema, partición y offset)', { name: ctx.name(p.from) }),
    relay: () => tr('El mismo aviso, un tramo antes'),
    stream: () => (c.certainty === 'sure' ? tr('La apertura del canal') : tr('La apertura del canal de {name}: su fila sale al cerrarse y no se cerró en la prueba', { name: ctx.name(e.from) })),
    inside: () => tr('Ocurre mientras {name} atendía {named}', { name: ctx.name(p.to), named: named(ctx, p) }),
    consume: () => tr('{name} lo hace al procesar {label}', { name: ctx.name(p.to), label: p.label }),
    reaction: () => tr('La página reacciona al aviso {evName} que acaba de llegar', { evName: evName(p) }),
    callback: () => tr('El aviso de estado del SMS que {name} mandó antes ({label})', { name: ctx.name(p.from), label: p.label }),
  }[c.how]();
  return `${s}${reason(c, ctx)}.`;
}

function rootSaid(e: Exchange, ctx: SayCtx): string {
  const a = ctx.chain.acts.find((x) => x.roots.includes(e.id));
  const orphan = ctx.chain.orphans.find((o) => o.id === e.id);
  if (orphan || !a) return orphan ? sayOrphan(orphan, ctx) : '';
  switch (a.kind) {
    case 'person': { const m = a.marks.filter((x) => x.t0 <= e.t0); return tr('Lo pide el navegador tras «{marksSaid}».', { marksSaid: marksSaid(ctx, a, m.length ? m : a.marks) }); }
    case 'page': return tr('Lo pide la página por su cuenta.');
    case 'burst': {
      const n = ctx.chain.acts.filter((x) => x.kind === 'burst' && x.step === a.step && x.t0 <= a.t0).length;
      return tr('Lo pide el navegador (tanda {n}{p1}).', { n, p1: a.step !== undefined ? tr(' del paso {step}', { step: a.step }) : '' });
    }
    case 'setup': return tr('Lo pide la prueba para preparar datos.');
    case 'check': return ctx.trace.steps.length ? tr('Lo pide la prueba para comprobar, no la persona.') : tr('Lo pide el caso.');
  }
}

/** Why an exchange has no visible cause here. */
export function sayOrphan(o: Chain['orphans'][number], ctx: SayCtx): string {
  const e = by(ctx).get(o.id)!;
  switch (o.reason) {
    case 'unknown-ip': return tr('Viene de {from}: una dirección que el entorno no conoce.', { from: e.from });
    case 'ambiguous-publisher': { const p = ctx.publishers(e.label); return tr('Alguien publica {label}: el código tiene {length} publicadores ({join}) y la traza no dice cuál.', { label: e.label, length: p.length, join: p.join(', ') }); }
    case 'host': return tr('Tráfico de tu máquina durante la prueba: no es de esta prueba.');
    case 'no-cause': return tr('{name} lo hace sin una petición ni un mensaje que lo explique en esta prueba (¿una tarea programada?).', { name: ctx.name(actorOf(e)) });
  }
}
