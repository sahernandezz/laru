/**
 * Contracts and data models read against the code and the runs: which documented operation an endpoint or a call is,
 * and where they disagree. Pure, so the service sheet, the reference and the inspector say the same thing. The same
 * rules as the core's findings (contract-drift) and coverage (contract-missing-in-code, endpoint-without-contract).
 */
import type { DocPiece, MapNode } from '../api.ts';

type Row = Record<string, string>;
const rows = (p: DocPiece, f: string) => ((p.fields[f] ?? []) as Row[]);

export interface Op { contract: DocPiece; method: string; path: string; service: string; summary?: string }
export interface Ev { contract: DocPiece; topic: string; direction: string; service: string; payload?: string }
export interface Entity { model: DocPiece; entity: string; table?: string; owner?: string; notes?: string }

export const opsOf = (pieces: DocPiece[]): Op[] => pieces.filter((p) => p.type === 'contract').flatMap((c) => rows(c, 'operations').filter((r) => r.method && r.path)
  .map((r) => ({ contract: c, method: r.method.toUpperCase(), path: r.path, service: r.service ?? '', summary: r.summary })));
export const eventsOf = (pieces: DocPiece[]): Ev[] => pieces.filter((p) => p.type === 'contract').flatMap((c) => rows(c, 'events').filter((r) => r.topic)
  .map((r) => ({ contract: c, topic: r.topic, direction: r.direction ?? '', service: r.service ?? '', payload: r.payload })));
export const errorsOf = (c: DocPiece) => rows(c, 'errors').filter((r) => r.status).map((r) => ({ status: String(r.status).trim(), when: r.when ?? '' }));
export const entitiesOf = (pieces: DocPiece[]): Entity[] => pieces.filter((p) => p.type === 'data-model').flatMap((m) => rows(m, 'entities').filter((r) => r.entity)
  .map((r) => ({ model: m, entity: r.entity, table: r.table, owner: r.owner, notes: r.notes })));

/** `POST /api/files/{fileId}/share`: an operation's address in its contract's reference (`#/docs/<contract>/op/<key>`). */
export const opKey = (o: { method: string; path: string }) => `${o.method} ${o.path}`;

/** `{x}`, `:x` and `${x}` as one placeholder, so a contract's path and the code's compare. */
export const norm = (p: string) => ('/' + p).replace(/\/+/g, '/').replace(/\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*/g, '{}').replace(/(.)\/$/, '$1');
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

export interface ApiRow { key: string; method: string; path: string; ep?: MapNode; op?: Op; drift?: 'no-contract' | 'not-in-code' }

/**
 * A service's API: each endpoint the code exposes with the operation that documents it, then the operations its
 * contracts declare and the code lacks. An endpoint without one is drift only when the service has contracts at all,
 * and never when the code's own OpenAPI file declares it.
 */
export function serviceApi(svc: string, endpoints: MapNode[], ops: Op[]): ApiRow[] {
  const mine = ops.filter((o) => o.service === svc);
  const out: ApiRow[] = endpoints.map((ep) => {
    const op = opOfEndpoint(ep, mine);
    return { key: ep.id, method: String(ep.attrs?.method), path: String(ep.attrs?.path), ep, op, drift: !op && mine.length && !ep.attrs?.contract ? 'no-contract' : undefined };
  });
  for (const o of mine) if (!endpoints.some((ep) => opOfEndpoint(ep, [o]))) out.push({ key: `${o.contract.id} ${opKey(o)}`, method: o.method, path: o.path, op: o, drift: 'not-in-code' });
  return out;
}

/** Whether a contract's errors list a status: `403` itself, or a class written as `4xx`. */
export const listed = (status: string, errors: Array<{ status: string }>) => errors.some((e) => e.status === status || (/^\dxx$/i.test(e.status) && e.status[0] === status[0]));
/** Statuses the runs saw that the contract does not list: error answers (4xx, 5xx) missing from its errors. */
export const unlisted = (statuses: Record<string, number> | undefined, errors: Array<{ status: string }>) =>
  Object.keys(statuses ?? {}).filter((s) => Number(s) >= 400 && !listed(s, errors));
