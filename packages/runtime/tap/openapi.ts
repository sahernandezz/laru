/**
 * The part of OpenAPI 3 a mock needs: find the operation of a request, check what the contract can check cheaply
 * (path template, required parameters, a JSON body against a schema subset), and answer with the contract's own
 * example or a value generated from its schema. Keywords outside the subset are reported, never silently passed.
 * Stdlib only: the host compiles openapi.yaml to JSON before the tap reads it.
 */

export type Schema = Record<string, any>;
export interface Operation { method: string; path: string; re: RegExp; op: Record<string, any> }

const SUPPORTED = new Set(['type', 'required', 'properties', 'items', 'enum', 'additionalProperties', '$ref', 'format', 'description', 'example', 'examples', 'nullable', 'default', 'title', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'readOnly', 'writeOnly']);

export function operations(doc: Record<string, any>): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries<Record<string, any>>(doc.paths ?? {})) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'head', 'options']) {
      if (!item[method]) continue;
      const op = { ...item[method], parameters: [...(item.parameters ?? []), ...(item[method].parameters ?? [])] };
      out.push({ method: method.toUpperCase(), path, re: new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}/?$`), op });
    }
  }
  // Literal segments first: /files/stats before /files/{id}.
  return out.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
}

export const findOperation = (ops: Operation[], method: string, path: string) => ops.find((o) => o.method === method && o.re.test(path.replace(/^\/+/, '/')));

function resolve(doc: Record<string, any>, s: Schema | undefined, seen = 0): Schema | undefined {
  if (!s || !s.$ref || seen > 8) return s;
  if (!String(s.$ref).startsWith('#/')) return { $unsupported: s.$ref };
  const target = String(s.$ref).slice(2).split('/').reduce<any>((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  return resolve(doc, target, seen + 1);
}

/** Violations of a value against a schema, by path; unsupported keywords are listed once as "not validated". */
export function validate(doc: Record<string, any>, schema: Schema | undefined, value: unknown, at = 'body', out: string[] = []): string[] {
  const s = resolve(doc, schema);
  if (!s) return out;
  if (s.$unsupported) { out.push(`not validated: $ref ${s.$unsupported}`); return out; }
  for (const k of Object.keys(s)) if (!SUPPORTED.has(k) && !k.startsWith('x-')) { const m = `not validated: ${k}`; if (!out.includes(m)) out.push(m); }
  if (value === null || value === undefined) { if (value === null && !s.nullable) out.push(`${at} is null`); return out; }
  const type = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (s.type && !(s.type === type || (s.type === 'number' && type === 'integer'))) { out.push(`${at} should be ${s.type}, is ${type}`); return out; }
  if (s.enum && !s.enum.includes(value)) out.push(`${at} is not one of ${s.enum.join(', ')}`);
  if (type === 'object') {
    const v = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in v)) out.push(`${at}.${r} is required`);
    for (const [k, sub] of Object.entries<Schema>(s.properties ?? {})) if (k in v) validate(doc, sub, v[k], `${at}.${k}`, out);
    if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (s.properties ?? {}))) out.push(`${at}.${k} is not allowed`);
  }
  if (type === 'array' && s.items) (value as unknown[]).forEach((x, i) => validate(doc, s.items, x, `${at}[${i}]`, out));
  return out;
}

/** A value for a schema: its example, its default, its first enum, or one made from its type. */
export function sample(doc: Record<string, any>, schema: Schema | undefined, depth = 0): unknown {
  const s = resolve(doc, schema);
  if (!s || depth > 6) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum) return s.enum[0];
  switch (s.type ?? (s.properties ? 'object' : s.items ? 'array' : 'string')) {
    case 'object': return Object.fromEntries(Object.entries<Schema>(s.properties ?? {}).map(([k, v]) => [k, sample(doc, v, depth + 1)]));
    case 'array': return [sample(doc, s.items, depth + 1)];
    case 'integer': return s.minimum ?? 1;
    case 'number': return s.minimum ?? 1.5;
    case 'boolean': return true;
    default: return s.format === 'uuid' ? '00000000-0000-4000-8000-000000000000' : s.format === 'date-time' ? '2026-01-01T00:00:00Z' : s.format === 'date' ? '2026-01-01' : s.format === 'email' ? 'ana@example.com' : 'string';
  }
}

export interface ContractAnswer { status: number; headers: Record<string, string>; body: string; drift: string[] }

/** What the contract says this request gets, and how the request differs from it. */
export function answer(doc: Record<string, any>, ops: Operation[], req: { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body?: string }): ContractAnswer {
  const o = findOperation(ops, req.method, req.path);
  if (!o) return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not in the contract' }), drift: [`undeclared operation ${req.method} ${req.path}`] };
  const drift: string[] = [];
  for (const p of o.op.parameters ?? []) {
    const prm = resolve(doc, p) ?? p;
    if (!prm.required) continue;
    if (prm.in === 'query' && !req.query.has(prm.name)) drift.push(`query.${prm.name} is required`);
    if (prm.in === 'header' && !(prm.name.toLowerCase() in req.headers)) drift.push(`header ${prm.name} is required`);
  }
  const rb = resolve(doc, o.op.requestBody);
  const media = rb?.content?.['application/json'];
  if (rb?.required && !req.body) drift.push('body is required');
  if (media?.schema && req.body) {
    try { validate(doc, media.schema, JSON.parse(req.body), 'body', drift); } catch { drift.push('body is not JSON'); }
  }
  const [code, res] = Object.entries<Record<string, any>>(o.op.responses ?? {}).find(([c]) => /^2/.test(c)) ?? ['200', {}];
  const r = resolve(doc, res) ?? {};
  const json = r.content?.['application/json'];
  const ex = json?.example ?? (json?.examples ? Object.values<any>(json.examples)[0]?.value : undefined);
  const body = json ? JSON.stringify(ex !== undefined ? ex : sample(doc, json.schema)) : '';
  return { status: Number(code) || 200, headers: json ? { 'content-type': 'application/json' } : {}, body, drift };
}
