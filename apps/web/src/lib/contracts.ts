/**
 * Contracts and data models read against the code and the runs: which documented operation an endpoint or a call is,
 * and where they disagree. Pure, so the service sheet, the reference and the inspector say the same thing. The same
 * rules as the core's findings (contract-drift) and coverage (contract-missing-in-code, endpoint-without-contract).
 */
import type { DocPiece, MapNode, SeenEndpoint } from '../api.ts';

type Row = Record<string, string>;
const rows = (p: DocPiece, f: string) => ((p.fields[f] ?? []) as Row[]);

/** An operation as its contract documents it: what it is for (`summary`), what it takes (`request`) and what it answers (`response`). */
export interface Op { contract: DocPiece; method: string; path: string; service: string; summary?: string; request?: string; response?: string }
export interface Ev { contract: DocPiece; topic: string; direction: string; service: string; payload?: string }
export interface Entity { model: DocPiece; entity: string; table?: string; owner?: string; notes?: string }

export const opsOf = (pieces: DocPiece[]): Op[] => pieces.filter((p) => p.type === 'contract').flatMap((c) => rows(c, 'operations').filter((r) => r.method && r.path)
  .map((r) => ({ contract: c, method: r.method.toUpperCase(), path: r.path, service: r.service ?? '', summary: r.summary, request: r.request, response: r.response })));
export const eventsOf = (pieces: DocPiece[]): Ev[] => pieces.filter((p) => p.type === 'contract').flatMap((c) => rows(c, 'events').filter((r) => r.topic)
  .map((r) => ({ contract: c, topic: r.topic, direction: r.direction ?? '', service: r.service ?? '', payload: r.payload })));
/**
 * A contract's errors. For one operation, the rows that give it to that one (their `operation`, or a `when` that names it)
 * and the rows that name no operation, which any of them may answer.
 */
export const errorsOf = (c: DocPiece, op?: { method: string; path: string }) => rows(c, 'errors').filter((r) => r.status).filter((r) => {
  if (!op) return true;
  const said = namedOps(r.operation ?? '').length ? namedOps(r.operation ?? '') : namedOps(r.when ?? '');
  return !said.length || said.includes(`${op.method} ${norm(op.path)}`);
}).map((r) => ({ status: String(r.status).trim(), when: r.when ?? '' }));
export const entitiesOf = (pieces: DocPiece[]): Entity[] => pieces.filter((p) => p.type === 'data-model').flatMap((m) => rows(m, 'entities').filter((r) => r.entity)
  .map((r) => ({ model: m, entity: r.entity, table: r.table, owner: r.owner, notes: r.notes })));

/** `POST /api/files/{fileId}/share`: an operation's address in its contract's reference (`#/docs/<contract>/op/<key>`). */
export const opKey = (o: { method: string; path: string }) => `${o.method} ${o.path}`;

/** `{x}`, `:x` and `${x}` as one placeholder, so a contract's path and the code's compare. */
export const norm = (p: string) => ('/' + p).replace(/\/+/g, '/').replace(/\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*/g, '{}').replace(/(.)\/$/, '$1');
/** The operations a text names (`GET /api/files/{fileId}`), each as its method and normalized path. */
export const namedOps = (text: string) => [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+`?(\/[^\s`,;)|]*)/g)].map((m) => `${m[1]} ${norm(m[2])}`);

/**
 * What a contract says of one operation besides its row: the sections under a heading that names it
 * (`### GET /api/files/{fileId}/download`), however many, in the order they come.
 */
export function detailOf(c: DocPiece, op: { method: string; path: string }): string {
  const key = `${op.method} ${norm(op.path)}`, out: string[] = [];
  for (const v of Object.values(c.fields)) {
    if (typeof v !== 'string') continue;
    const lines = v.split('\n');
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
      const h = !fence && lines[i].match(/^(#{3,6})\s+(.*)$/);
      if (!h || !namedOps(h[2]).includes(key)) continue;
      let j = i + 1;
      for (let f = false; j < lines.length; j++) { if (/^\s*(```|~~~)/.test(lines[j])) f = !f; const n = !f && lines[j].match(/^(#{1,6})\s/); if (n && n[1].length <= h[1].length) break; }
      out.push(lines.slice(i + 1, j).join('\n').trim());
    }
  }
  return out.filter(Boolean).join('\n\n');
}

/** The success status a response says (`201 con la devolución` → 201), when it says one. */
export const successOf = (response?: string) => response?.match(/\b([1-3]\d\d)\b/)?.[1];
const holes = (p: string) => (norm(p).match(/\{\}|\*/g) ?? []).length;
/** A path template over concrete paths: a placeholder is one segment, `*` part of one, `**` anything. */
export function pathRe(t: string): RegExp {
  const re = norm(t).split(/(\{\}|\*\*|\*)/).map((x) => (x === '{}' ? '[^/]+' : x === '**' ? '.*' : x === '*' ? '[^/]*' : x.replace(/[.+?^$()|[\]\\{}]/g, '\\$&'))).join('');
  return new RegExp(`^${re}/?$`);
}

/** The operation an endpoint of the map implements: same service and method, the same path once placeholders compare. */
export const opOfEndpoint = (ep: MapNode, ops: Op[]) => ops.find((o) => o.service === ep.service && o.method === String(ep.attrs?.method) && norm(o.path) === norm(String(ep.attrs?.path)));

/**
 * The operation a call to a service exercised. The map endpoint it reached decides when there is one: a literal
 * `/api/files/quarantine` no contract declares is not `/api/files/{fileId}`. Else a literal path before a template.
 */
export function opOfCall(service: string, method: string | undefined, path: string | undefined, ops: Op[], ep?: MapNode): Op | undefined {
  if (ep) return opOfEndpoint(ep, ops);
  if (!method || !path) return undefined;
  return ops.filter((o) => o.service === `svc:${service}` && o.method === method).sort((a, b) => holes(a.path) - holes(b.path)).find((o) => pathRe(o.path).test(path));
}

/** `forward`: the services an endpoint that only passes calls on (a gateway's `/api/x/**`) forwards to; its contract is theirs. */
export interface ApiRow { key: string; method: string; path: string; ep?: MapNode; op?: Op; drift?: 'no-contract' | 'not-in-code'; forward?: string[] }

/**
 * A service's API: each endpoint the code exposes with the operation that documents it, then the operations its
 * contracts declare and the code lacks. Every endpoint is owed an operation, unless the code's own OpenAPI file declares
 * it or it only forwards to other services (`forwardsOf`), whose contracts say it.
 */
export function serviceApi(svc: string, endpoints: MapNode[], ops: Op[], forwardsOf: (ep: MapNode) => string[] = () => []): ApiRow[] {
  const mine = ops.filter((o) => o.service === svc);
  const out: ApiRow[] = endpoints.map((ep) => {
    const op = opOfEndpoint(ep, mine), forward = forwardsOf(ep);
    // a wildcard route (`/**`) is no operation: a pass-through, or a fallback
    return { key: ep.id, method: String(ep.attrs?.method), path: String(ep.attrs?.path), ep, op, ...(forward.length ? { forward } : {}), drift: !op && !forward.length && !ep.attrs?.contract && !String(ep.attrs?.path).endsWith('/**') ? 'no-contract' : undefined };
  });
  for (const o of mine) if (!endpoints.some((ep) => opOfEndpoint(ep, [o]))) out.push({ key: `${o.contract.id} ${opKey(o)}`, method: o.method, path: o.path, op: o, drift: 'not-in-code' });
  return out;
}

/** Whether a contract's errors list a status: `403` itself, or a class written as `4xx`. */
export const listed = (status: string, errors: Array<{ status: string }>) => errors.some((e) => e.status === status || (/^\dxx$/i.test(e.status) && e.status[0] === status[0]));
/** Statuses the runs saw that the contract does not list: error answers (4xx, 5xx) missing from its errors. */
export const unlisted = (statuses: Record<string, number> | undefined, errors: Array<{ status: string }>) =>
  Object.keys(statuses ?? {}).filter((s) => Number(s) >= 400 && !listed(s, errors));

const VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'];
const byPath = (a: ApiRow, b: ApiRow) => a.path.localeCompare(b.path) || VERB_ORDER.indexOf(a.method) - VERB_ORDER.indexOf(b.method);
export interface ApiGroup { key: string; kind: 'contract' | 'resource' | 'forward'; contract?: DocPiece; prefix?: string; rows: ApiRow[] }

/**
 * A service's API in groups a reader recognizes: each contract that documents some of its endpoints (what the contract
 * is for says what the group is), the endpoints no contract documents by the resource of their path (the segment after
 * what all its paths share: `/api/files/trash`), and last those that only forward to other services.
 */
export function groupApi(rows: ApiRow[]): ApiGroup[] {
  const segs = (p: string) => p.split('/').filter(Boolean);
  const all = rows.map((r) => segs(r.path));
  let common = 0;
  while (all.length && all.every((x) => x.length > common && x[common] === all[0][common] && !/[{:*]/.test(x[common]))) common++;
  const resource = (p: string) => `/${segs(p).slice(0, Math.min(segs(p).length, common + 1)).join('/')}`;
  const groups = new Map<string, ApiGroup>();
  for (const r of [...rows].sort(byPath)) {
    const key = r.op ? `ctr ${r.op.contract.id}` : r.forward ? 'fwd' : `res ${resource(r.path)}`;
    const g = groups.get(key) ?? groups.set(key, { key, kind: r.op ? 'contract' : r.forward ? 'forward' : 'resource', ...(r.op ? { contract: r.op.contract } : r.forward ? {} : { prefix: resource(r.path) }), rows: [] }).get(key)!;
    g.rows.push(r);
  }
  return [...groups.values()].sort((a, b) => (a.kind === 'forward' ? 1 : 0) - (b.kind === 'forward' ? 1 : 0) || byPath(a.rows[0], b.rows[0]));
}

/** Where the code and the runs part from what the contract says of an operation; each says what and how much. */
export type Diff =
  | { key: 'status-unlisted'; status: string; count: number }
  | { key: 'code-status-unlisted'; statuses: string[] }
  | { key: 'success-differs'; status: string; declared: string; from: 'runs' | 'code' }
  | { key: 'unnamed'; side: 'query' | 'request' | 'response' | 'code'; names: string[] }
  | { key: 'mock'; text: string };

/** Everything a piece says, as plain text: its summary, its sections, its lists and its tables' cells. */
const textOf = (p: DocPiece) => [p.summary, ...Object.values(p.fields).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : Object.values(x as Row).join(' '))) : []))].join('\n');

/** The top-level fields of a JSON body (of its first element, when it is a list); none when it is not JSON. */
export function fieldsOf(text?: string): string[] {
  try {
    const v = JSON.parse(text ?? '');
    const o = Array.isArray(v) ? v[0] : v;
    return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [];
  } catch { return []; }
}

/** What a service's contracts say, as one text: a type described once (a response's fields) is named for all of them. */
export const contractsText = (ops: Op[], svc: string) => [...new Set(ops.filter((o) => o.service === svc).map((o) => o.contract))].map(textOf).join('\n');

/**
 * An endpoint's code and runs against its operation: error statuses the contract does not list for it (seen in the
 * runs, or answered by its code), a success other than the one its response says, query parameters, body fields and
 * code parameters its service's contracts (`said`, else its own) never name, and what a mock saw off-contract.
 * Nothing without an operation: then there is nothing to differ from, and the sheet says the operation is owed.
 */
export function diffsOf(r: ApiRow, seen?: SeenEndpoint, said?: string): Diff[] {
  const op = r.op;
  if (!op || !r.ep) return seen?.drift.map((text) => ({ key: 'mock' as const, text })) ?? [];
  const errors = errorsOf(op.contract, op);
  said ??= textOf(op.contract);
  const names = (xs: string[]) => [...new Set(xs)].filter((x) => x && !new RegExp(`(?<![\\w-])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(said));
  const out: Diff[] = [];
  for (const st of unlisted(seen?.statuses, errors)) out.push({ key: 'status-unlisted', status: st, count: seen!.statuses[st] });
  const code = ((r.ep.attrs?.statuses ?? []) as number[]).map(String);
  const off = code.filter((st) => Number(st) >= 400 && !listed(st, errors));
  if (off.length) out.push({ key: 'code-status-unlisted', statuses: off });
  const declared = successOf(op.response);
  const ran = Object.keys(seen?.statuses ?? {}).filter((st) => /^2\d\d$/.test(st));
  if (declared && ran.length && !ran.includes(declared)) out.push({ key: 'success-differs', status: ran.join(', '), declared, from: 'runs' });
  else if (declared && code.some((st) => /^2\d\d$/.test(st)) && !code.includes(declared)) out.push({ key: 'success-differs', status: code.filter((st) => /^2\d\d$/.test(st)).join(', '), declared, from: 'code' });
  const samples = Object.values(seen?.samples ?? {});
  const query = names(samples.flatMap((x) => [...new URLSearchParams(x.query ?? '').keys()]));
  if (query.length) out.push({ key: 'unnamed', side: 'query', names: query });
  const req = names(samples.flatMap((x) => fieldsOf(x.req?.text)));
  if (req.length) out.push({ key: 'unnamed', side: 'request', names: req });
  const res = names(samples.filter((x) => (x.status ?? 0) < 300).flatMap((x) => fieldsOf(x.res?.text)));
  if (res.length) out.push({ key: 'unnamed', side: 'response', names: res });
  const params = names(((r.ep.attrs?.params ?? []) as Array<{ in: string; name: string; type?: string }>).filter((x) => !(x.in === 'body' && x.type)).map((x) => x.name));
  if (params.length) out.push({ key: 'unnamed', side: 'code', names: params });
  for (const text of seen?.drift ?? []) out.push({ key: 'mock', text });
  return out;
}
