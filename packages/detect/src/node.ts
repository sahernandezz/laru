/**
 * JavaScript and TypeScript: Express/Fastify/Koa routes, Nest controllers, `process.env`, and the calls
 * a file makes — `fetch`, axios and Angular's HttpClient — with the base URL followed through constants.
 */
import type { Finding, Param } from './types.ts';
import { enclosed, EXCEPTION_STATUS, lineIndex, stripComments, topLevel } from './text.ts';

const VERBS = ['get', 'post', 'put', 'patch', 'delete'];
const SERVER_CTOR = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:express\s*\(|express\.Router\s*\(|Router\s*\(|fastify\s*\(|Fastify\s*\(|new\s+Koa\s*\(|new\s+Hono\s*\()/g;
const NEST_VERB: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE' };
const TEST_FILE = /(^|\/)(__tests__|test|tests|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

/** The arguments of the call whose parenthesis is at `open`. */
const callArgs = (src: string, open: number) => enclosed(src, open).inner;

/**
 * What an Express or Fastify handler reads of the request (`req.query.x`, `const { a } = req.body`, `req.get('x')`) and
 * the statuses it sets (`res.status(404)`, `reply.code(201)`); 200 when it sets none.
 */
function jsHandler(path: string, handler: string): { params: Param[]; statuses: number[] } {
  const params: Param[] = [...path.matchAll(/:(\w+)/g)].map((x) => ({ in: 'path', name: x[1], required: true }));
  const add = (where: Param['in'], name: string) => { if (!params.some((p) => p.in === where && p.name === name)) params.push({ in: where, name }); };
  const R = '\\b(?:req|request)';
  for (const [where, key] of [['query', 'query'], ['body', 'body'], ['header', 'headers'], ['path', 'params']] as const) {
    for (const x of handler.matchAll(new RegExp(`${R}\\.${key}(?:\\.(\\w+)|\\[\\s*['"]([^'"]+)['"]\\s*\\])`, 'g'))) add(where, x[1] ?? x[2]);
    for (const x of handler.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${R}\\.${key}\\b`, 'g'))) for (const part of x[1].split(',')) { const k = part.trim().split(/[:=\s]/)[0]; if (/^\w+$/.test(k)) add(where, k); }
  }
  for (const x of handler.matchAll(new RegExp(`${R}\\.(?:get|header)\\(\\s*['"]([^'"]+)['"]`, 'g'))) add('header', x[1]);
  const statuses = new Set([...handler.matchAll(/\b(?:res|response|reply)\.(?:status|sendStatus|code)\(\s*(\d{3})\s*\)/g)].map((x) => Number(x[1])));
  if (![...statuses].some((s) => s < 300)) statuses.add(200);
  return { params, statuses: [...statuses].sort((a, b) => a - b) };
}

const NEST_IN: Record<string, Param['in']> = { Param: 'path', Query: 'query', Body: 'body', Headers: 'header', UploadedFile: 'form', UploadedFiles: 'form' };
/** A Nest handler's parameters by their decorators (`@Body() dto: CreateDto` is a body of that type), its return type out of its Promise, the statuses it throws. */
function nestHandler(src: string, open: number, verb: string, decorators: string): { params: Param[]; returns?: string; statuses: number[] } {
  const sig = enclosed(src, open);
  const params = topLevel(sig.inner).flatMap((p): Param[] => {
    const d = p.match(/@(\w+)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
    const v = d && NEST_IN[d[1]] ? p.slice(d.index! + d[0].length).match(/^\s*(\w+)(\?)?\s*(?::\s*([\s\S]+?))?\s*(?:=[\s\S]*)?$/) : null;
    if (!d || !v) return [];
    return [{ in: NEST_IN[d[1]], name: d[2] ?? v[1], ...(v[3] ? { type: v[3].trim() } : {}), ...(NEST_IN[d[1]] === 'path' ? { required: true } : v[2] ? { required: false } : {}) }];
  });
  const after = src.slice(sig.end + 1), brace = after.indexOf('{');
  const ret = after.slice(0, brace).match(/^\s*:\s*([\s\S]+?)\s*$/)?.[1]?.replace(/^(?:Promise|Observable)<([\s\S]+)>$/, '$1').trim();
  const body = brace >= 0 ? enclosed(src, sig.end + 1 + brace).inner : '';
  const code = decorators.match(/@HttpCode\(\s*(?:HttpStatus\.\w+|(\d{3}))\s*\)/)?.[1];
  const statuses = new Set([...body.matchAll(/\bnew\s+(\w+?)Exception\s*\(/g)].flatMap((x) => (EXCEPTION_STATUS[x[1]] ? [EXCEPTION_STATUS[x[1]]] : [])));
  statuses.add(code ? Number(code) : verb === 'POST' ? 201 : 200);
  return { params, ...(ret && ret !== 'void' && ret !== 'any' ? { returns: ret } : ret === 'void' ? { returns: 'void' } : {}), statuses: [...statuses].sort((a, b) => a - b) };
}

/** What an expression stands for: an env var, a literal base, or both unknown. */
interface Base { envVar?: string; literal?: string }

export function detectJs(path: string, raw: string): Finding[] {
  const src = stripComments(raw);
  const lineOf = lineIndex(src);
  const out: Finding[] = [];

  if (TEST_FILE.test(path)) {
    const count = (src.match(/\b(?:it|test)(?:\.each\([^)]*\))?\s*\(\s*['"`]/g) ?? []).length;
    const cases = [...src.matchAll(/\b(?:it|test)(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => ({ name: m[2], line: lineOf(m.index) }));
    if (count) out.push({ kind: 'tests', count, cases, level: /@playwright\/test|cypress|\.e2e\./.test(raw + path) ? 'e2e' : /supertest|testcontainers/.test(raw) ? 'integration' : 'unit' });
    return out;
  }

  // Environment variables, and identifiers that hold one.
  const seen = new Set<string>();
  const envAt = (name: string, offset: number) => { const k = name + ':' + lineOf(offset); if (!seen.has(k)) { seen.add(k); out.push({ kind: 'env-var', name, via: 'process.env', line: lineOf(offset) }); } };
  for (const m of src.matchAll(/process\.env\.([A-Za-z_]\w*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]/g)) envAt(m[1] ?? m[2], m.index);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1].split(',')) { const name = part.trim().split(/[:=\s]/)[0]; if (name) envAt(name, m.index); }
  }

  // Constants and class fields that hold a base URL or an env var: `const API = '/api/files'`, `private readonly API = …`.
  const bases = new Map<string, Base>();
  for (const m of src.matchAll(/(?:\b(?:const|let|var)\s+|\b(?:private|public|protected|readonly|static)\s+(?:readonly\s+)?)(\w+)\s*(?::\s*[\w<>[\]|]+\s*)?=\s*([^;\n]+)/g)) {
    const v = m[2].trim();
    const env = v.match(/process\.env\.([A-Za-z_]\w*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]/);
    const lit = v.match(/^['"`]([^'"`$]*)['"`]/);
    if (env) bases.set(m[1], { envVar: env[1] ?? env[2], literal: v.match(/\?\?\s*['"`]([^'"`]+)/)?.[1] });
    else if (lit && (lit[1].startsWith('/') || /^https?:\/\//.test(lit[1]))) bases.set(m[1], { literal: lit[1] });
  }
  /** `${this.API}/x/${id}` or `API + '/x'` or `'/x'` → base + path. */
  const resolve = (expr: string): (Base & { path: string }) | null => {
    const e = expr.trim();
    const tpl = e.match(/^`([^`]*)`$/);
    const head = (tpl ? tpl[1] : e).match(/^\$\{\s*(?:this\.)?([\w.[\]'"]+)\s*\}(.*)$/s);
    if (tpl && head) {
      const ref = head[1];
      const env = ref.match(/^process\.env\.(\w+)$/);
      const b = env ? { envVar: env[1] } : bases.get(ref);
      return b ? { ...b, path: head[2] } : null;
    }
    if (tpl) return { path: tpl[1] };
    const lit = e.match(/^['"]([^'"]*)['"]/);
    if (lit) return { path: lit[1] };
    const plus = e.match(/^(?:this\.)?(\w+)\s*(?:\+\s*['"`]([^'"`]*)['"`])?/);
    if (plus && bases.has(plus[1])) return { ...bases.get(plus[1])!, path: plus[2] ?? '' };
    return null;
  };
  const emitCall = (expr: string, method: string, offset: number) => {
    const r = resolve(expr);
    if (!r) return;
    const url = (r.literal ?? '') + r.path;
    const abs = url.match(/^(https?:\/\/[^/]+)(.*)$/);
    const path = (abs ? abs[2] : url).split('?')[0] || '/';
    if (!r.envVar && !abs && !path.startsWith('/')) return;
    out.push({ kind: 'outbound', method, path, envVar: r.envVar, url: abs?.[1], relative: !r.envVar && !abs, line: lineOf(offset) });
  };

  // fetch(url, { method: 'POST' })
  for (const m of src.matchAll(/\bfetch\(\s*(`[^`]*`|'[^']*'|"[^"]*"|[\w.]+(?:\s*\+\s*['"`][^'"`]*['"`])?)/g)) {
    const args = callArgs(src, m.index + m[0].indexOf('(')); // only this call's own arguments
    emitCall(m[1], args.match(/method\s*:\s*['"](\w+)['"]/)?.[1]?.toUpperCase() ?? 'GET', m.index);
  }
  // axios.get(url) / http.post(url) / this.http.get<T>(url) / client.get(url) where client = axios.create({ baseURL })
  const clients = new Map<string, Base>();
  for (const m of src.matchAll(/(\w+)\s*=\s*axios\.create\(\s*\{[^}]*baseURL\s*:\s*([^,}\n]+)/g)) {
    const b = resolve(m[2]);
    if (b) clients.set(m[1], b);
  }
  for (const m of src.matchAll(new RegExp(`\\b((?:this\\.)?\\w+)\\.(${VERBS.join('|')})\\s*(?:<[^>()]*>)?\\(\\s*(\`[^\`]*\`|'[^']*'|"[^"]*"|(?:this\\.)?\\w+(?:\\s*\\+\\s*['"\`][^'"\`]*['"\`])?)`, 'g'))) {
    const recv = m[1].replace(/^this\./, '');
    if (recv === 'axios' || recv === 'http' || recv === 'httpClient' || /Http$/.test(recv)) emitCall(m[3], m[2].toUpperCase(), m.index);
    else if (clients.has(recv)) {
      const b = clients.get(recv)!;
      const r = resolve(m[3]);
      if (r) out.push({ kind: 'outbound', method: m[2].toUpperCase(), path: (r.path || '/').split('?')[0], envVar: b.envVar, url: b.literal, relative: false, line: lineOf(m.index) });
    }
  }
  for (const m of src.matchAll(/new\s+EventSource\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) emitCall(m[1], 'GET', m.index);
  // new HttpRequest('POST', `${this.API}/upload`, body): Angular's request object takes the verb first
  for (const m of src.matchAll(/new\s+HttpRequest(?:<[^>()]*>)?\(\s*['"](\w+)['"]\s*,\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) emitCall(m[2], m[1].toUpperCase(), m.index);

  // Server routes: receivers created as servers or routers, plus the conventional names.
  const servers = new Set(['app', 'router', 'server', 'fastify']);
  for (const m of src.matchAll(SERVER_CTOR)) servers.add(m[1]);
  const prefix = new Map<string, string>(); // router → mount prefix, when mounted in this same file
  for (const m of src.matchAll(/\b(\w+)\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)\s*\)/g)) if (servers.has(m[1])) prefix.set(m[3], m[2]);
  for (const m of src.matchAll(new RegExp(`\\b(\\w+)\\.(${VERBS.join('|')}|all)\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g'))) {
    if (!servers.has(m[1])) continue;
    const p = ((prefix.get(m[1]) ?? '') + '/' + m[3]).replace(/\/+/g, '/');
    const shape = jsHandler(m[3], callArgs(src, m.index + m[0].indexOf('(')));
    out.push({ kind: 'endpoint', method: m[2] === 'all' ? 'ANY' : m[2].toUpperCase(), path: p.length > 1 ? p.replace(/\/$/, '') : p, line: lineOf(m.index), source: 'code', ...(shape.params.length ? { params: shape.params } : {}), statuses: shape.statuses });
  }

  // Nest controllers.
  const ctrl = src.match(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/);
  if (ctrl) {
    for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)((?:\s*@\w+\([^)]*\))*)\s*(?:(?:public|private|protected)\s+)?(?:async\s+)?(\w+)?/g)) {
      const p = ('/' + (ctrl[1] ?? '') + '/' + (m[2] ?? '')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
      const open = m[4] ? src.indexOf('(', m.index + m[0].length) : -1;
      // its decorators: those after the verb's and those between the previous member's end and it
      const shape = open >= 0 ? nestHandler(src, open, NEST_VERB[m[1]], src.slice(Math.max(src.lastIndexOf('}', m.index), src.lastIndexOf(';', m.index)) + 1, m.index) + m[3]) : undefined;
      out.push({ kind: 'endpoint', method: NEST_VERB[m[1]], path: p, line: lineOf(m.index), symbol: m[4], source: 'code', ...(shape?.params.length ? { params: shape.params } : {}), ...(shape?.returns ? { returns: shape.returns } : {}), ...(shape ? { statuses: shape.statuses } : {}) });
    }
  }

  // kafkajs
  for (const m of src.matchAll(/\.send\(\s*\{\s*topic\s*:\s*['"`]([^'"`]+)['"`]/g)) out.push({ kind: 'topic', name: m[1], op: 'publishes', line: lineOf(m.index) });
  for (const m of src.matchAll(/\.subscribe\(\s*\{\s*topics?\s*:\s*\[?([^\]}]*)/g)) {
    for (const t of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) out.push({ kind: 'topic', name: t[1], op: 'consumes', line: lineOf(m.index) });
  }
  return out;
}
