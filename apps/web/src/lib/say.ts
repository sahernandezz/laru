/**
 * What «Paso a paso» and «Cadena» say: one sentence per act, per Secuencia row and for the failure, and why each hop
 * happened. Pure. The map and the knowledge (contracts, data models) only add names; without them a sentence falls
 * back to the code's handler, then to the table. A typed value is never said: marks do not carry it.
 */
import { isBrowser, type Action, type Exchange, type Trace } from '@laru/trace';
import { endpointMatcher } from '@laru/trace/assemble';
import { actorOf, chain as chainOf, isConsume, isHello, isStream, type Act, type Cause, type Chain } from '@laru/trace/chain';
import { endpointOf } from '@laru/trace/summarize';
import type { DocPiece, Fact, MapNode } from '../api.ts';
import { entitiesOf, errorsOf, eventsOf, listed, norm, opsOf } from './contracts.ts';
import type { Row, Stop } from './seq.ts';

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
  const names = new Map(o.trace.participants.map((p) => [p.id, p.name]));
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
  200: 'correcto', 201: 'creado', 202: 'aceptado', 204: 'sin contenido', 301: 'redirige', 302: 'redirige', 304: 'sin cambios', 400: 'petición incorrecta', 401: 'sin sesión',
  403: 'prohibido', 404: 'no existe', 409: 'conflicto', 422: 'no procesable', 429: 'demasiadas peticiones', 500: 'error interno', 502: 'pasarela sin respuesta válida',
  503: 'no disponible', 504: 'pasarela sin respuesta a tiempo',
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
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`);
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
const who = (ctx: SayCtx, id: string) => (id === 'browser' ? 'el navegador' : id.startsWith('browser:') ? `el navegador de ${id.slice(8)}` : id === 'runner' ? 'la prueba' : id === 'host' ? 'tu máquina' : ctx.name(id));
/** «al navegador», or «al navegador de luis» for another screen of the test. */
const toBrowser = (id: string) => (id === 'browser' ? 'al navegador' : `al navegador de ${id.slice(8)}`);
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
  button: ['el botón', 'un botón sin nombre'], link: ['el enlace', 'un enlace sin nombre'], textbox: ['el campo', 'un campo sin nombre'],
  checkbox: ['la casilla', 'una casilla sin nombre'], tab: ['la pestaña', 'una pestaña sin nombre'], menuitem: ['la opción', 'una opción sin nombre'],
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
  return t.role && ROLE[t.role] ? ROLE[t.role][1] : 'un elemento sin nombre';
};
/** The file an act picked: its multipart request's first file, else «un fichero». */
function picked(ctx: SayCtx, a: Act): string {
  const ex = by(ctx);
  for (const id of a.roots) {
    const f = (obj(json(ex.get(id)?.req?.text))?.files as Array<{ filename?: string; size?: number }> | undefined)?.[0];
    if (f?.filename) return `${f.filename}${f.size !== undefined ? ` (${f.size} B)` : ''}`;
  }
  return 'un fichero';
}
/** «de el campo» is «del campo». */
const de = (o: string) => (o.startsWith('el ') ? `del ${o.slice(3)}` : `de ${o}`);
/** A mark as a verb and what it acts on. */
function markWords(ctx: SayCtx, a: Act, m: Action): [string, string] {
  switch (m.kind) {
    case 'click': return m.target ? ['pulsa', thing(m.target)] : ['pulsa', 'en un punto de la página'];
    case 'dblclick': return ['pulsa dos veces', thing(m.target)];
    case 'tap': return ['toca', thing(m.target)];
    case 'fill': case 'type': { const t = targetOf(m.target); return ['escribe', t.name ? `en «${t.name}»` : `en ${thing(m.target)}`]; }
    case 'press': return m.key ? ['pulsa la tecla', m.key] : ['pulsa una tecla', ''];
    case 'check': return ['marca', thing(m.target)];
    case 'uncheck': return ['desmarca', thing(m.target)];
    case 'select': return ['elige una opción', de(thing(m.target))];
    case 'hover': return ['pasa por encima', de(thing(m.target))];
    case 'files': return ['elige', picked(ctx, a)];
    case 'navigate': return ['abre', m.path ?? 'una página'];
    case 'back': return ['vuelve', 'atrás'];
    case 'reload': return ['recarga', 'la página'];
    case 'drag': return ['arrastra', thing(m.target)];
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
    case 'setup': return `La prueba prepara datos por la API antes del primer paso: ${list([...new Set(roots.map((r) => what(ctx, r)))])}.`;
    case 'check': {
      const x = `${what(ctx, first)}${a.n ? ` ×${a.n}` : ''}`;
      return ctx.trace.steps.length ? `La prueba comprueba por la API: ${x} (no lo hace la persona).` : `El caso llama a la API: ${x}.`;
    }
    case 'page': return `La página pide ${what(ctx, first)} por su cuenta: la persona no hizo nada en el último segundo.`;
    case 'burst': {
      const where = step ? ` (paso ${step.n}, «${step.title}»)` : '';
      return isPage(first) ? `El navegador abre ${first.path}${where}.` : `El navegador envía ${what(ctx, first)}${where}.`;
    }
    case 'person': return `La persona ${marksSaid(ctx, a)}.${a.roots.length ? '' : ' No sale ninguna petición: solo cambia la página.'}`;
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
      if (v === 'INSERT') count(writes, e.to, ent ? `guarda «${ent}»` : 'guarda');
      else if (v === 'UPDATE') count(writes, e.to, 'actualiza');
      else if (v === 'DELETE') count(writes, e.to, 'borra');
    }
    if (e.kind === 'http' && ctx.storeKind(e.to) === 'file') count(objects, e.to, e.reqHeaders?.['x-amz-copy-source'] ? 'copia' : e.method === 'PUT' ? 'sube' : e.method === 'DELETE' ? 'borra' : 'lee');
    if (e.kind === 'kafka') { const s = topics.get(e.label) ?? topics.set(e.label, new Set()).get(e.label)!; if (isConsume(e)) s.add(e.to); }
    if (e.kind === 'sse' && isBrowser(e.from) && !isHello(e)) notices.add(evName(e));
  }
  // «guarda 2 filas de «Usuario» y 1 de «Fichero»»: «fila» agrees in number, so an entity's gender never has to
  const counts = (m: Map<string, number>) => {
    const ins = [...m].filter(([w]) => w.startsWith('guarda «'));
    const rows = list(ins.map(([w, n], i) => `${n}${i ? '' : n === 1 ? ' fila' : ' filas'} de ${w.slice(7)}`));
    return [...m].flatMap(([w, n]) => (!w.startsWith('guarda «') ? [`${w} ${n}`] : w === ins[0][0] ? [`guarda ${rows}`] : [])).join(', ');
  };
  const bad = mine.filter((e) => !e.ok).length;
  return [
    services.size ? `Recorre ${list([...services])}` : '',
    ...[...writes].map(([s, m]) => `${s}: ${counts(m)}`), ...[...objects].map(([s, m]) => `${s}: ${counts(m)}`),
    topics.size ? `publica ${[...topics].map(([t, c]) => `${t}${c.size ? ` (→ ${[...c].join(', ')})` : ''}`).join(', ')}` : '',
    notices.size ? `llega al navegador: ${[...notices].join(', ')}` : '',
    `${bad} ${bad === 1 ? 'fallo' : 'fallos'}`,
  ].filter(Boolean).join(' · ');
}

// ---- rows ----

function faults(e: Exchange, ctx: SayCtx): string[] {
  const from = who(ctx, e.from), to = ctx.name(e.to);
  return (e.fault ?? '').split(', ').filter(Boolean).map((f) => {
    let m: RegExpExecArray | null;
    if ((m = /^latencia \+(\d+) ms inyectada$/.exec(f))) return `Laru retrasa esta llamada ${m[1]} ms antes de pasarla a ${to}.`;
    if ((m = /^estado (\d+) inyectado$/.exec(f))) return `Laru no deja pasar esta llamada y responde ${m[1]} en nombre de ${to}.`;
    if (f === 'abortado') return `Laru corta la conexión: ${from} se queda sin respuesta.`;
    if (f === 'sin respuesta') return `Laru retiene la llamada sin responder: ${from} espera hasta su tiempo límite.`;
    if ((m = /^ancho de banda (\d+) B\/s(?: tras (\d+) B)?$/.exec(f))) return `Laru limita la respuesta a ${m[1]} B/s${m[2] ? ` a partir del byte ${m[2]}` : ''}.`;
    return `Laru: ${f}.`;
  });
}
function mockSaid(e: Exchange, ctx: SayCtx): string[] {
  if (e.mock === 'sink' || e.mock === 'callback') return []; // a mailbox is said by its own sentence
  return [
    ...(e.mock === 'miss' ? ['El mock no tiene respuesta para esto.'] : e.mock ? [`Responde el mock de Laru (${e.mock}), no ${ctx.name(e.to)} real.`] : []),
    ...(e.drift?.length ? [`No cumple el contrato del mock: ${e.drift[0]}.`] : []),
  ];
}

/** An object store call (a datastore of kind file, or S3's own headers): what it does with which object. */
function objectSaid(e: Exchange, ctx: SayCtx): string | undefined {
  if (ctx.storeKind(e.to) !== 'file' && !Object.keys(e.reqHeaders ?? {}).some((k) => /^x-amz-(?!target)/i.test(k))) return;
  const from = who(ctx, e.from), to = ctx.name(e.to);
  const [, bucket = '', ...rest] = (e.path ?? '').split('/');
  const key = short(decodeURIComponent(rest.join('/')));
  const copy = e.reqHeaders?.['x-amz-copy-source'];
  if (e.method === 'PUT' && copy) return `${from} copia ${short(decodeURIComponent(copy.replace(/^\//, '')))} a ${bucket}/${key}.`;
  if (!key) return `${from} comprueba el bucket ${bucket} de ${to}.`;
  if (e.method === 'PUT') return `${from} sube ${key} al bucket ${bucket} de ${to} (${e.req?.bytes ?? 0} B).`;
  if (e.method === 'GET' || e.method === 'HEAD') return `${from} lee ${key} del bucket ${bucket} de ${to}.`;
  if (e.method === 'DELETE') return `${from} borra ${key} del bucket ${bucket} de ${to}.`;
}
const DYNAMO: Array<[RegExp, string]> = [[/^(Get|BatchGet|Query|Scan)/, 'lee de'], [/^(Put|BatchWrite)/, 'escribe en'], [/^Update/, 'actualiza en'], [/^Delete/, 'borra de'], [/^(Execute|BatchExecute)/, 'ejecuta PartiQL sobre']];

function httpRequest(e: Exchange, ctx: SayCtx): string {
  const from = who(ctx, e.from), to = ctx.name(e.to);
  if (e.asset) return `${e.asset} ${e.asset === 1 ? 'recurso estático' : 'recursos estáticos'} (JS, CSS, imágenes) en ${(e.t1 ?? e.t0) - e.t0} ms.`;
  if (e.kind === 'ws') return `${Who(ctx, e.from)} abre un WebSocket con ${to} en ${e.path}.`;
  if (isStream(e)) return `${Who(ctx, e.from)} abre el canal de avisos con ${to} (SSE, ${e.path}).`;
  if (isBrowser(e.from) && isPage(e)) return `${cap(who(ctx, e.from))} pide la página ${e.path} a ${to}.`;
  if (isBrowser(e.from) || e.from === 'runner') {
    const d = deepest(ctx, e), ep = ctx.endpointOf(d), op = opOf(ctx, d), h = ep && ctx.handler(ep);
    return `${Who(ctx, e.from)} llama a ${what(ctx, e)}${op?.summary ? `: «${op.summary}»` : ''}. La atiende ${ctx.name(d.to)}${h ? ` (${h})` : ''}.`;
  }
  const c = ctx.chain.cause.get(e.id);
  if (c?.how === 'forward') {
    const proxy = ctx.proxy(e.from, e.to);
    if (proxy) return `${from} la pasa tal cual a ${to} (proxy ${proxy}).`;
    const rule = ctx.endpointOf(by(ctx).get(c.parent)!), ep = ctx.endpointOf(e), h = ep && ctx.handler(ep);
    return `${[`${from} la reenvía a ${to}`, rule && `por la regla ${tpl(rule)}`, h && `que la atiende con ${h}`].filter(Boolean).join(', ')}.`;
  }
  const obj = objectSaid(e, ctx);
  if (obj) return obj;
  const op = /^DynamoDB(?:Streams)?_\d+\.(\w+)$/.exec(e.reqHeaders?.['x-amz-target'] ?? '')?.[1];
  if (op) return `${from} ${DYNAMO.find(([re]) => re.test(op))?.[1] ?? 'llama a'} la tabla ${e.table ?? '?'} de ${to} (${op}).`;
  const ep = ctx.endpointOf(e), contract = opOf(ctx, e);
  const service = ctx.trace.participants.find((p) => p.id === e.to)?.type === 'service';
  return `${from} llama a ${to}: ${ep ? tpl(ep) : e.label}${contract?.summary ? ` — «${contract.summary}»` : ''}${!ep && service ? ` (${to} no tiene ese endpoint entre los extraídos del código)` : ''}.`;
}

function httpResponse(e: Exchange, ctx: SayCtx): string {
  const to = ctx.name(e.to);
  if (e.error) return `La llamada falla sin respuesta: ${stop(e.error)}`;
  if (e.status === undefined) return `${to} no responde.`;
  const body = json(e.res?.text);
  if (e.status >= 400 || !e.ok) {
    const b = obj(body), msg = b && ['error', 'message', 'detail', 'title'].map((k) => b[k]).find((v) => typeof v === 'string');
    const op = opOf(ctx, e);
    const err = op?.errors.find((x) => x.status === String(e.status)) ?? op?.errors.find((x) => listed(String(e.status), [x]));
    const hint = !op ? '' : err ? ` El contrato «${op.contract}» lo prevé${err.when ? `: «${err.when}»` : ''}.` : ' El contrato no lo lista entre sus errores.';
    return `${to} responde ${statusText(e.status)}${msg ? `: «${msg}»` : ''}.${hint}`;
  }
  const f = fields(body);
  const tail = f.n !== undefined ? `, con ${f.n} ${f.n === 1 ? 'elemento' : 'elementos'}${f.vals.length ? `: ${f.vals.join(', ')}` : ''}` : f.vals.length ? `, con ${list(f.vals)}` : '';
  return `${to} responde ${statusText(e.status)} en ${(e.t1 ?? e.t0) - e.t0} ms${tail}.`;
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
  if (e.error) return `${to} rechaza la sentencia: ${stop(e.error.split('\n')[0])}`;
  const verb = e.label.split(' ')[0], t = e.table, ent = t ? ctx.entity(t) : undefined;
  const owner = ent?.owner && ent.owner !== e.from ? `, tabla de ${ent.owner}` : '';
  switch (verb) {
    case 'SELECT': return ent ? `${from} lee «${ent.entity}» (${t}${owner}).` : `${from} lee de ${t ?? to}.`;
    case 'INSERT': return `${from} guarda una fila nueva${ent ? ` de «${ent.entity}»` : ''} en ${t ?? to}${owner}.`;
    case 'UPDATE': { const set = setSaid(e.req?.text); return `${from} actualiza ${ent ? `«${ent.entity}»` : t ?? to}${set ? ` y deja ${set}` : ''}.`; }
    case 'DELETE': return `${from} borra ${ent ? `«${ent.entity}»` : 'filas'} en ${t ?? to}.`;
    default: return `${from} ejecuta ${verb || 'una sentencia'} en ${to}.`;
  }
}

function kafkaRow(e: Exchange, ctx: SayCtx): string {
  if (isConsume(e)) {
    const l = ctx.listener(e.to, e.label);
    const first = (ctx.chain.effects.get(e.id) ?? []).map((id) => by(ctx).get(id)!)[0];
    // its work may start up to TOL_MS before the delivery's time (two clocks): that is at once, never «-1 ms más tarde»
    const late = first ? first.t0 - e.t0 : 0;
    return `${ctx.name(e.to)} recibe ${e.label}${l ? ` en ${l}` : ''}. Lo dice el código: la entrega no se ve en la red. ${!first ? 'No se ve que haga nada después en esta prueba.' : late > 0 ? `Lo primero que hace después se ve ${late} ms más tarde.` : 'Lo primero que hace se ve en ese mismo momento.'}`;
  }
  if (e.from === AMBIGUOUS) { const p = ctx.publishers(e.label); return `Alguien publica ${e.label}: el código tiene ${p.length} publicadores (${p.join(', ')}) y la traza no dice cuál.`; }
  const body = obj(json(e.req?.text));
  const keys = body ? Object.keys(body) : (ctx.payload(e.label) ?? []);
  const st = body && Object.entries(body).find(([k, v]) => STATUSY.test(k) && prim(v));
  const named = keys.length > 5 ? `${keys.slice(0, 4).join(', ')} y ${keys.length - 4} más` : list(keys);
  return `${ctx.name(e.from)} publica ${e.label} en ${ctx.name(e.to)}${keys.length ? `: ${named}` : ''}${st ? `, con ${st[0]} ${st[1]}` : ''}.`;
}

function sseRow(e: Exchange, ctx: SayCtx): string {
  const ev = evName(e), relay = ctx.chain.cause.get(e.id)?.how === 'relay';
  // only the hop that opens the channel greets; the ones nearer the browser pass its greeting on
  if (isHello(e)) return relay ? `${ctx.name(e.to)} pasa el saludo «${ev}» ${isBrowser(e.from) ? toBrowser(e.from) : `a ${ctx.name(e.from)}`}.` : `Se abre el canal: ${ctx.name(e.to)} saluda con «${ev}».`;
  if (isBrowser(e.from)) return `El aviso ${ev} llega ${toBrowser(e.from)}.`;
  if (relay) return `${ctx.name(e.to)} pasa el aviso a ${ctx.name(e.from)}.`;
  const b = obj(json(e.res?.text)), name = b && ['fileName', 'name', 'title'].map((k) => b[k]).find((v) => typeof v === 'string');
  return `${ctx.name(e.to)} envía el aviso ${ev} por el canal abierto${name ? `: ${name}` : ''}.`;
}

/** A message a sink kept, or the status call it made about it: said as what it is, and that nothing left the machine. */
function messageRow(e: Exchange, ctx: SayCtx): string | undefined {
  const m = e.msg;
  if (!m) return;
  const from = ctx.name(e.from), to = ctx.name(e.to);
  if (m.cb) return `${from} avisa a ${to} de que el SMS ${m.cb === 'delivered' ? 'se entregó' : m.cb === 'sent' ? 'salió' : m.cb === 'received' ? 'llegó desde un teléfono' : `quedó ${m.cb}`}${e.status ? ` (${to} responde ${e.status})` : ''}.`;
  const sent = m.kind === 'mail' ? `un correo a ${m.to}${m.subject ? `, «${m.subject}»` : ''}` : `un SMS a ${m.to}`;
  return `${from} manda ${sent}: ${e.status && e.status >= 400 ? `el buzón responde ${e.status}` : 'queda en el buzón del entorno'} y no sale de tu máquina.`;
}

function tcpRow(e: Exchange, ctx: SayCtx): string {
  const said = messageRow(e, ctx);
  if (said) return said;
  const from = ctx.name(e.from), to = ctx.name(e.to), up = e.req?.bytes ?? 0;
  const found = /^stream: (.+) FOUND\.?$/.exec(e.label);
  const scan = `${from} manda ${up} B a ${to} para analizarlo y ${to} responde`;
  if (/^stream: OK\.?$/.test(e.label)) return `${scan}: limpio.`;
  if (found) return `${scan}: infectado (${found[1]}).`;
  if (/ERROR/.test(e.label)) return `${scan} con error: ${e.label}.`;
  return `${from} abre una conexión con ${to}: ${up} B enviados, ${e.res?.bytes ?? 0} B recibidos${/^\d+ B ↑ \d+ B ↓$/.test(e.label) ? '' : `; la respuesta empieza por «${e.label}»`}.`;
}

function sayRow(r: Row, ctx: SayCtx): string {
  const e = r.ex;
  if (e.kind === 'sql') return sqlRow(e, ctx);
  if (e.kind === 'kafka') return kafkaRow(e, ctx);
  if (e.kind === 'sse') return sseRow(e, ctx);
  if (r.reply) return [httpResponse(e, ctx), ...mockSaid(e, ctx)].join(' ');
  const base = e.msg ? messageRow(e, ctx)! : e.kind === 'tcp' ? tcpRow(e, ctx) : httpRequest(e, ctx);
  const silent = e.kind === 'http' && e.t1 === undefined && !e.error && !isStream(e) ? [`${ctx.name(e.to)} no responde dentro de la ventana de la prueba.`] : [];
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
  if (!f) return 'La prueba no falló.';
  const step = ctx.trace.steps.find((s) => s.n === f.step);
  const lines = [step ? `Aquí falla la prueba, en el paso ${step.n} «${step.title}»: ${stop(f.message)}` : `Aquí falla el caso: ${stop(f.message)}`];
  if (step?.expected) lines.push(`Se esperaba: ${stop(step.expected)}`);
  const bad = ctx.rows.filter((r) => r.ex.id === f.exchange).sort((a, b) => Number(b.bad) - Number(a.bad))[0];
  lines.push(bad ? `El primer salto que falló: ${sayRow(bad, ctx)}` : 'Ningún salto entre servicios falló: el fallo está en la página.');
  const t = failTime(ctx);
  const last = ctx.rows.filter((r) => r.t <= t && isBrowser(r.ex.from) && !ctx.chain.noise.has(r.ex.id) && (r.reply || r.ex.kind === 'sse')).at(-1);
  if (last) {
    const fl = fields(json(last.ex.res?.text));
    lines.push(`Lo último que recibió el navegador antes del fallo: ${last.ex.kind === 'sse' ? `el aviso ${evName(last.ex)}` : `${what(ctx, last.ex)} → ${last.ex.status ?? last.ex.error}${fl.vals.length ? ` con ${list(fl.vals)}` : ''}`} (${at(last.t)}).`);
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
    return { what: `${({ SELECT: 'lee', INSERT: 'guarda', UPDATE: 'actualiza', DELETE: 'borra' } as Record<string, string>)[verb] ?? verb.toLowerCase()} ${obj}` };
  }
  if (e.kind === 'kafka') return { what: `${isConsume(e) ? 'recibe' : 'publica'} ${e.label}` };
  if (e.kind === 'sse') return { what: isHello(e) ? `saludo «${evName(e)}»` : `aviso ${evName(e)}` };
  if (e.msg) return { what: e.msg.cb ? `estado del SMS: ${e.msg.cb}` : `${e.msg.kind === 'mail' ? 'correo' : 'SMS'} a ${e.msg.to}` };
  if (e.kind === 'tcp') {
    const found = /^stream: (.+) FOUND\.?$/.exec(e.label);
    return { what: /^stream: OK\.?$/.test(e.label) ? 'analiza: limpio' : found ? `analiza: infectado (${found[1]})` : e.label };
  }
  if (e.asset) return { what: `${e.asset} ${e.asset === 1 ? 'recurso estático' : 'recursos estáticos'}` };
  if (e.kind === 'ws') return { what: `WebSocket ${e.path ?? ''}`.trim() };
  if (isStream(e)) return { what: 'abre el canal de avisos', note: e.path };
  if (isBrowser(e.from) && isPage(e)) return { what: `página ${e.path}` };
  const d = deepest(ctx, e), op = opOf(ctx, d) ?? opOf(ctx, e);
  return { what: what(ctx, e), ...(op?.summary ? { note: op.summary } : {}) };
}

/** The sentence of a stop: an act, a Secuencia row or the failure. */
export function say(s: Stop, ctx: SayCtx): string {
  return s.kind === 'act' ? sayAct(s.act, ctx) : s.kind === 'fail' ? sayFail(ctx) : ctx.rows[s.i] ? sayRow(ctx.rows[s.i], ctx) : '';
}

// ---- causes ----

const CERTAINTY = { sure: 'seguro', inferred: 'deducido', possible: 'posible' } as const;
/** «seguro», «deducido», «posible · también encaja en: GET /api/files/stats, GET /api/files/folders» */
export function chip(c: Cause, ctx: SayCtx): string {
  const ex = by(ctx);
  return c.certainty === 'possible' && c.alt?.length ? `posible · también encaja en: ${c.alt.map((id) => (ex.get(id) ? named(ctx, ex.get(id)!) : id)).join(', ')}` : CERTAINTY[c.certainty];
}

function reason(c: Cause, ctx: SayCtx): string {
  const ex = by(ctx), w = c.why;
  if (!w) return '';
  if (w.by === 'shape') {
    const anchor = ex.get(w.like), under = anchor && ex.get(ctx.chain.cause.get(anchor.id)?.parent ?? '');
    return ` · misma sentencia que en ${under ? named(ctx, under) : '?'}${anchor ? ` (${at(anchor.t0)})` : ''}`;
  }
  if (w.by === 'id') return ` · por el identificador ${w.id.slice(0, 4)}…, que solo trae ${ex.get(c.parent) ? named(ctx, ex.get(c.parent)!) : c.parent}`;
  if (w.by === 'write') return ' · una lectura (GET) no escribe';
  const [store, pid] = w.conn.split('#');
  return ` · misma conexión a ${store} (pid ${pid})`;
}

/** «Lo provocó»: why this exchange happened, with the reason an ambiguous link was narrowed; for a root, its act. */
export function sayCause(e: Exchange, ctx: SayCtx): string {
  const c = ctx.chain.cause.get(e.id);
  if (!c) return rootSaid(e, ctx);
  const p = by(ctx).get(c.parent)!;
  const s = {
    forward: () => `La misma petición, reenviada por ${who(ctx, e.from)}`,
    message: () => `La entrega del mensaje que publicó ${ctx.name(p.from)} (mismo tema, partición y offset)`,
    relay: () => 'El mismo aviso, un tramo antes',
    stream: () => (c.certainty === 'sure' ? 'La apertura del canal' : `La apertura del canal de ${ctx.name(e.from)}: su fila sale al cerrarse y no se cerró en la prueba`),
    inside: () => `Ocurre mientras ${ctx.name(p.to)} atendía ${named(ctx, p)}`,
    consume: () => `${ctx.name(p.to)} lo hace al procesar ${p.label}`,
    reaction: () => `La página reacciona al aviso ${evName(p)} que acaba de llegar`,
    callback: () => `El aviso de estado del SMS que ${ctx.name(p.from)} mandó antes (${p.label})`,
  }[c.how]();
  return `${s}${reason(c, ctx)}.`;
}

function rootSaid(e: Exchange, ctx: SayCtx): string {
  const a = ctx.chain.acts.find((x) => x.roots.includes(e.id));
  const orphan = ctx.chain.orphans.find((o) => o.id === e.id);
  if (orphan || !a) return orphan ? sayOrphan(orphan, ctx) : '';
  switch (a.kind) {
    case 'person': { const m = a.marks.filter((x) => x.t0 <= e.t0); return `Lo pide el navegador tras «${marksSaid(ctx, a, m.length ? m : a.marks)}».`; }
    case 'page': return 'Lo pide la página por su cuenta.';
    case 'burst': {
      const n = ctx.chain.acts.filter((x) => x.kind === 'burst' && x.step === a.step && x.t0 <= a.t0).length;
      return `Lo pide el navegador (tanda ${n}${a.step !== undefined ? ` del paso ${a.step}` : ''}).`;
    }
    case 'setup': return 'Lo pide la prueba para preparar datos.';
    case 'check': return ctx.trace.steps.length ? 'Lo pide la prueba para comprobar, no la persona.' : 'Lo pide el caso.';
  }
}

/** Why an exchange has no visible cause here. */
export function sayOrphan(o: Chain['orphans'][number], ctx: SayCtx): string {
  const e = by(ctx).get(o.id)!;
  switch (o.reason) {
    case 'unknown-ip': return `Viene de ${e.from}: una dirección que el entorno no conoce.`;
    case 'ambiguous-publisher': { const p = ctx.publishers(e.label); return `Alguien publica ${e.label}: el código tiene ${p.length} publicadores (${p.join(', ')}) y la traza no dice cuál.`; }
    case 'host': return 'Tráfico de tu máquina durante la prueba: no es de esta prueba.';
    case 'no-cause': return `${ctx.name(actorOf(e))} lo hace sin una petición ni un mensaje que lo explique en esta prueba (¿una tarea programada?).`;
  }
}
