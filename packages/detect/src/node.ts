/**
 * JavaScript and TypeScript: Express/Fastify/Koa routes, Nest controllers, `process.env`, and the calls
 * a file makes — `fetch`, axios and Angular's HttpClient — with the base URL followed through constants.
 */
import type { Finding } from './types.ts';
import { lineIndex, stripComments } from './text.ts';

const VERBS = ['get', 'post', 'put', 'patch', 'delete'];
const SERVER_CTOR = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:express\s*\(|express\.Router\s*\(|Router\s*\(|fastify\s*\(|Fastify\s*\(|new\s+Koa\s*\(|new\s+Hono\s*\()/g;
const NEST_VERB: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE' };
const TEST_FILE = /(^|\/)(__tests__|test|tests|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

/** The text between the parenthesis at `open` and the one that closes it, skipping strings. */
function callArgs(src: string, open: number): string {
  let depth = 0, quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1, open + 400);
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
    out.push({ kind: 'endpoint', method: m[2] === 'all' ? 'ANY' : m[2].toUpperCase(), path: p.length > 1 ? p.replace(/\/$/, '') : p, line: lineOf(m.index), source: 'code' });
  }

  // Nest controllers.
  const ctrl = src.match(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/);
  if (ctrl) {
    for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)\s*(?:async\s+)?(\w+)?/g)) {
      const p = ('/' + (ctrl[1] ?? '') + '/' + (m[2] ?? '')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
      out.push({ kind: 'endpoint', method: NEST_VERB[m[1]], path: p, line: lineOf(m.index), symbol: m[3], source: 'code' });
    }
  }

  // kafkajs
  for (const m of src.matchAll(/\.send\(\s*\{\s*topic\s*:\s*['"`]([^'"`]+)['"`]/g)) out.push({ kind: 'topic', name: m[1], op: 'publishes', line: lineOf(m.index) });
  for (const m of src.matchAll(/\.subscribe\(\s*\{\s*topics?\s*:\s*\[?([^\]}]*)/g)) {
    for (const t of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) out.push({ kind: 'topic', name: t[1], op: 'consumes', line: lineOf(m.index) });
  }
  return out;
}
