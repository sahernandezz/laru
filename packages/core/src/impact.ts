/**
 * What a change touches, before anything is built: the services that own the changed files, the endpoints, tables
 * and topics anchored there or newly detected in the working copy, the contracts over those endpoints, the
 * conventions the new content breaks, the pieces whose anchored code moved, and the flows that go through any of
 * it, each with the reason. Read-only on the checkouts (`GIT_OPTIONAL_LOCKS=0`).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detectFile, isRelevant } from '@laru/detect';
import { loadExtraction } from './extract.ts';
import { gitOf, treeNow } from './folder.ts';
import { git } from './git.ts';
import type { Graph } from './graph.ts';
import { conventionsFor } from './knowledge/coverage.ts';
import { callKey, callsOf, changedKeys, isConfig, receivingFiles } from './reach.ts';
import type { Row } from './knowledge/piece.ts';
import { anchorCovers, anchorResolver, type Knowledge, type Loaded } from './knowledge/store.ts';
import { estimateTokens } from './query.ts';
import { stateDir, type Workspace } from './workspace.ts';

export interface Change { repo: string; path: string; status: 'M' | 'A' | 'D' | 'R'; content?: string }

/**
 * Changes of every checkout (or the named repos) against the commit the map was read at, untracked files included; a
 * folder's, between the tree the map read and its tree now.
 */
export async function changesFromWorktrees(ws: Workspace, repos?: string[]): Promise<Change[]> {
  const out: Change[] = [];
  for (const r of ws.repos) {
    if (repos && !repos.includes(r.name)) continue;
    const checkout = ws.checkouts[r.name];
    const ex = loadExtraction(ws, r.name);
    if (!checkout || !existsSync(checkout) || !ex) continue;
    let diff: string, untracked = '';
    if (r.source === 'folder') diff = await git(checkout, ['diff-tree', '-r', '--name-status', '--no-renames', ex.commit, await treeNow(ws, r.name)], gitOf(ws, r.name).env).catch(() => '');
    else {
      diff = await git(checkout, ['diff', '--name-status', '--no-renames', ex.commit]).catch(() => '');
      untracked = await git(checkout, ['ls-files', '-o', '--exclude-standard']).catch(() => '');
    }
    const rows: Array<[Change['status'], string]> = [
      ...diff.split('\n').filter(Boolean).map((l) => { const [st, p] = l.split('\t'); return [st[0] as Change['status'], p] as [Change['status'], string]; }),
      ...untracked.split('\n').filter(Boolean).map((p) => ['A', p] as [Change['status'], string]),
    ];
    for (const [status, path] of rows) {
      const abs = join(checkout, path);
      const content = status !== 'D' && existsSync(abs) && statSync(abs).size < 1_000_000 ? readFileSync(abs, 'utf8') : undefined;
      out.push({ repo: r.name, path, status, content });
    }
  }
  return out;
}

export interface Impact {
  changes: Array<Omit<Change, 'content'>>;
  services: Array<{ id: string; files: number }>;
  endpoints: Array<{ id: string; change: 'touched' | 'added' | 'removed' }>;
  tables: string[];
  topics: string[];
  vars: Array<{ name: string; change: 'added' | 'removed' }>;
  contracts: Array<{ id: string; why: string }>;
  conventions: Array<{ id: string; title: string; file: string; line?: number; rule: string }>;
  stale: string[];
  envWide: string[];
  /** what a changed file reaches, endpoint by endpoint: a frontend's calls through the services it invokes, a multipart setting's upload endpoints */
  reach: Array<{ file: string; via: string; calls: string[] }>;
  /** services whose changed file reached no endpoint: the service as a whole is affected, and this says why */
  whole: Array<{ id: string; why: string }>;
  flows: Array<{ id: string; why: string[] }>;
}

const ENV_WIDE = /(^|\/)(docker-compose[^/]*|compose)\.ya?ml$|^infrastructure\//;

/** The participants of the last trace of each flow, read from the runs (runtime writes them, core only reads). */
function lastParticipants(ws: Workspace): Map<string, { nodes: string[]; topics: string[] }> {
  const out = new Map<string, { nodes: string[]; topics: string[] }>();
  const idx = join(stateDir(ws), 'runs', 'index.jsonl');
  if (!existsSync(idx)) return out;
  const last = new Map<string, string>();
  for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); if (x.status !== 'error') last.set(x.flow, x.run); }
  for (const [flow, run] of last) {
    const f = join(stateDir(ws), 'runs', run, 'flows', flow, 'trace.json');
    if (!existsSync(f)) continue;
    const t = JSON.parse(readFileSync(f, 'utf8')) as { participants: Array<{ node?: string }>; exchanges: Array<{ topic?: string }> };
    out.set(flow, { nodes: t.participants.map((p) => p.node).filter((n): n is string => Boolean(n)), topics: [...new Set(t.exchanges.map((e) => e.topic).filter((x): x is string => Boolean(x)))] });
  }
  return out;
}

/** What each flow's last played run called: the endpoints its traffic reached, and the requests its browser made (`POST /api/x`). */
function lastExchanges(ws: Workspace): Map<string, { endpoints: Set<string>; browser: Set<string> }> {
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

/** Files that say nothing about what runs: a change in them reaches no service. */
const NOISE = /\.(md|txt|png|jpe?g|svg|ico|lock)$|(^|\/)(docs?|\.github)\//i;

export function impact(ws: Workspace, g: Graph, k: Knowledge, changes: Change[], wsChanges: string[] = []): Impact {
  const files = new Set(changes.map((c) => `${c.repo}:${c.path}`));
  const services = g.ofType('service');
  const ownerOf = (repo: string, path: string) => services.filter((s) => s.repo === repo).map((s) => ({ s, dir: String(s.attrs?.dir ?? '.') })).filter(({ dir }) => dir === '.' || path === dir || path.startsWith(`${dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]?.s;
  const svcCount = new Map<string, number>();
  for (const c of changes) { const s = ownerOf(c.repo, c.path); if (s) svcCount.set(s.id, (svcCount.get(s.id) ?? 0) + 1); }

  // Anchored in the changed files, then what the working copy declares that the cached extraction does not.
  const endpoints = new Map<string, Impact['endpoints'][number]['change']>();
  const tables = new Set<string>(), topics = new Set<string>();
  for (const n of g.map.nodes) {
    if (!n.anchor || !files.has(`${n.anchor.repo}:${n.anchor.path}`)) continue;
    if (n.type === 'endpoint') endpoints.set(n.id, 'touched');
    if (n.type === 'table') tables.add(n.id);
    if (n.type === 'topic') topics.add(n.id);
  }
  const vars: Impact['vars'] = [];
  const withEndpoints = new Set<string>();
  for (const c of changes) {
    if (!isRelevant(c.path)) continue;
    const before = loadExtraction(ws, c.repo)?.files[c.path]?.findings ?? [];
    const after = c.content !== undefined ? detectFile(c.path, c.content) : [];
    const svc = ownerOf(c.repo, c.path)?.name ?? c.repo;
    const eps = (fs: typeof before) => new Set(fs.flatMap((f) => (f.kind === 'endpoint' ? [`${f.method} ${f.path}`] : [])));
    const [b, a] = [eps(before), eps(after)];
    if (b.size || a.size) withEndpoints.add(`${c.repo}:${c.path}`);
    for (const e of a) if (!b.has(e)) endpoints.set(`ep:${svc}:${e}`, 'added');
    for (const e of b) if (!a.has(e)) endpoints.set(`ep:${svc}:${e}`, 'removed');
    const vs = (fs: typeof before) => new Set(fs.flatMap((f) => (f.kind === 'env-var' ? [f.name] : [])));
    const [vb, va] = [vs(before), vs(after)];
    for (const v of va) if (!vb.has(v)) vars.push({ name: v, change: 'added' });
    for (const v of vb) if (!va.has(v)) vars.push({ name: v, change: 'removed' });
    for (const f of after) if (f.kind === 'topic') topics.add(`topic:${f.name}`);
  }

  // Contracts whose operations are one of the impacted endpoints.
  const epKey = (id: string) => id.replace(/^ep:[^:]+:/, '');
  const impacted = new Set([...endpoints.keys()].map(epKey));
  const contracts: Impact['contracts'] = [];
  for (const p of k.pieces.filter((x) => x.type === 'contract')) {
    const hit = ((p.fields.operations ?? []) as Row[]).find((o) => impacted.has(`${o.method} ${o.path}`));
    if (hit) contracts.push({ id: p.id, why: `${hit.method} ${hit.path}` });
  }

  // Conventions ruling the changed files, checked against their new content.
  const resolve = anchorResolver(ws);
  const conventions: Impact['conventions'] = [];
  const owners = k.pieces.filter((p) => p.type === 'module' || p.type === 'service');
  for (const c of changes.filter((x) => x.content !== undefined)) {
    const rulers = new Set<Loaded>();
    for (const o of owners) if ((o.anchors ?? []).some((a) => anchorCovers(resolve, a, c.repo, c.path))) for (const cv of conventionsFor(k, o)) rulers.add(cv);
    // and a convention anchored to the file itself, as the edit hook reads it
    for (const cv of k.pieces) if (cv.type === 'convention' && (cv.anchors ?? []).some((a) => anchorCovers(resolve, a, c.repo, c.path))) rulers.add(cv);
    for (const cv of rulers) for (const rule of (cv.fields.check as string[] | undefined) ?? []) {
      const m = /^(forbid|require):\s*(.+)$/.exec(rule);
      if (!m) continue;
      const hit = new RegExp(m[2], 'm').exec(c.content!);
      if (m[1] === 'forbid' && hit) conventions.push({ id: cv.id, title: cv.title, file: `${c.repo}:${c.path}`, line: c.content!.slice(0, hit.index).split('\n').length, rule });
      if (m[1] === 'require' && !hit) conventions.push({ id: cv.id, title: cv.title, file: `${c.repo}:${c.path}`, rule });
    }
  }

  // Pieces whose anchors cover a changed file.
  const stale = k.pieces.filter((p) => (p.anchors ?? []).some((a) => { const repo = a.split(':')[0]; return (resolve(a) ?? []).some((f) => files.has(`${repo}:${f}`)); })).map((p) => p.id);

  const envWide = changes.filter((c) => ENV_WIDE.test(c.path)).map((c) => `${c.repo}:${c.path}`);
  // Each changed file reaches endpoints when that can be told; otherwise its whole service, and the impact says so.
  const whole = new Map<string, string>();
  const reach: Impact['reach'] = [];
  const touchedEps = new Map<string, string>(), browserCalls = new Map<string, { why: string; svc?: string }>();
  for (const [id, change] of endpoints) touchedEps.set(id, change === 'touched' ? 'its handler changed' : `endpoint ${change}`);
  for (const c of changes) {
    const key = `${c.repo}:${c.path}`, svc = ownerOf(c.repo, c.path), checkout = ws.checkouts[c.repo];
    if (NOISE.test(c.path) || ENV_WIDE.test(c.path)) continue;
    let found = withEndpoints.has(key) || g.map.nodes.some((n) => n.type === 'endpoint' && n.anchor?.repo === c.repo && n.anchor.path === c.path);
    if (c.content !== undefined && checkout && /\.(ts|tsx|js|jsx|mjs)$/.test(c.path)) {
      const calls = callsOf(checkout, c.path, c.content);
      if (calls.length) {
        found = true;
        reach.push({ file: key, via: [...new Set(calls.map((x) => x.via))].join(', '), calls: [...new Set(calls.map((x) => callKey(x.method, x.path)))] });
        for (const x of calls) browserCalls.set(callKey(x.method, x.path), { why: x.via, svc: svc?.id });
      }
    }
    if (isConfig(c.path)) {
      const keys = changedKeys(c.path, (loadExtraction(ws, c.repo)?.files[c.path]?.findings ?? []) as Array<{ kind: string; key?: string; value?: string }>, c.content);
      if (!keys.length) found = true;
      const multipart = keys.filter((x) => /^spring\.servlet\.multipart\./.test(x));
      if (multipart.length && svc) {
        const eps = receivingFiles(g, ws.checkouts, svc.id);
        if (eps.length) {
          found = true;
          for (const id of eps) touchedEps.set(id, `${multipart[0]} changed`);
          reach.push({ file: key, via: multipart.join(', '), calls: eps.map((id) => id.replace(/^ep:[^:]+:/, '')) });
        }
      }
    }
    if (!found && svc && !whole.has(svc.id)) whole.set(svc.id, `no endpoint or call found in ${c.path}`);
  }
  const touched = new Set<string>(whole.keys());
  const consumersOf = (topic: string) => g.inOf(`topic:${topic}`).filter((f) => f.p === 'consumes').map((f) => f.s);
  const seen = lastParticipants(ws), exchanges = lastExchanges(ws);
  const flows: Impact['flows'] = [];
  for (const p of k.pieces.filter((x) => x.type === 'flow')) {
    const slug = p.id.replace(/^flow:/, '');
    const why: string[] = [];
    const needs = ([] as string[]).concat(p.meta?.needs ?? []);
    // With several projects an env-wide change in one reaches only the flows that need that project.
    const projects = new Set(needs.map((n) => g.nodes.get(n)?.repo).filter(Boolean));
    const wide = ws.repos.length > 1 ? envWide.find((c) => projects.has(c.split(':')[0])) : envWide[0];
    if (wide) why.push(`env-wide change: ${wide}`);
    for (const n of needs) if (touched.has(n)) why.push(`needs ${n}`);
    for (const s of (p.fields.steps ?? []) as Row[]) if (s.service && touched.has(s.service)) why.push(`step «${s.step}» runs on ${s.service}`);
    const last = seen.get(slug), ex = exchanges.get(slug);
    // by endpoint: what its last run called, what a step names, and a flow never played is judged by its services
    const named = (path: string) => ((p.fields.steps ?? []) as Row[]).find((st) => `${st.step ?? ''} ${st.expected ?? ''}`.includes(path));
    for (const [id, because] of touchedEps) {
      const name = id.replace(/^ep:[^:]+:/, ''), svcId = `svc:${id.split(':')[1]}`, st = named(name.split(' ').slice(1).join(' '));
      if (ex?.endpoints.has(id)) why.push(`its last run called ${name} (${because})`);
      else if (st) why.push(`step «${st.step}» names ${name} (${because})`);
      else if (!ex && needs.includes(svcId)) why.push(`never played, and needs ${svcId} (${because}: ${name})`);
    }
    for (const [callk, b] of browserCalls) {
      if (ex?.browser.has(callk)) why.push(`its browser called ${callk}, which ${b.why} makes`);
      else if (!ex && b.svc && needs.includes(b.svc)) why.push(`never played, and needs ${b.svc} (${b.why} calls ${callk})`);
    }
    for (const n of last?.nodes ?? []) if (touched.has(n)) why.push(`its last run went through ${n}`);
    for (const t of last?.topics ?? []) for (const c of consumersOf(t)) if (touched.has(c)) why.push(`${c} consumes ${t}, which it published`);
    if (wsChanges.some((f) => f.startsWith(`${p.dir}/`) || f.startsWith('support/'))) why.push('its spec, flow.md or support changed');
    if (why.length) flows.push({ id: p.id, why: [...new Set(why)] });
  }
  return {
    changes: changes.map(({ content: _c, ...rest }) => rest),
    services: [...svcCount].map(([id, n]) => ({ id, files: n })),
    endpoints: [...endpoints].map(([id, change]) => ({ id, change })),
    tables: [...tables], topics: [...topics], vars, contracts, conventions, stale, envWide, reach, whole: [...whole].map(([id, why]) => ({ id, why })), flows,
  };
}

/** The impact as text within a budget, what matters first. */
export function renderImpact(i: Impact, budget = 1200): string {
  const lines = [
    `${i.changes.length} changed files${i.envWide.length ? `; env-wide: ${i.envWide.join(', ')}` : ''}`,
    i.services.length ? `services: ${i.services.map((s) => `${s.id} (${s.files})`).join(', ')}` : 'services: none',
    ...(i.reach.length ? ['reaches:', ...i.reach.map((r) => `  ${r.file} → ${r.via}: ${r.calls.join(', ')}`)] : []),
    ...(i.whole.length ? ['whole service (no endpoint found):', ...i.whole.map((w) => `  ${w.id} — ${w.why}`)] : []),
    ...(i.flows.length ? ['flows to run:', ...i.flows.map((f) => `  ${f.id} — ${f.why.join('; ')}`)] : ['flows to run: none']),
    ...(i.conventions.length ? ['conventions broken:', ...i.conventions.map((c) => `  ${c.file}${c.line ? `:${c.line}` : ''} breaks «${c.title}» (${c.rule})`)] : []),
    ...(i.endpoints.length ? [`endpoints: ${i.endpoints.map((e) => `${e.id}${e.change === 'touched' ? '' : ` [${e.change}]`}`).join(', ')}`] : []),
    ...(i.contracts.length ? [`contracts to review: ${i.contracts.map((c) => `${c.id} (${c.why})`).join(', ')}`] : []),
    ...(i.vars.length ? [`variables: ${i.vars.map((v) => `${v.name} ${v.change}`).join(', ')}`] : []),
    ...(i.stale.length ? [`pieces whose code moved: ${i.stale.join(', ')}`] : []),
    ...(i.tables.length ? [`tables: ${i.tables.join(', ')}`] : []),
    ...(i.topics.length ? [`topics: ${i.topics.join(', ')}`] : []),
  ];
  const out: string[] = [];
  let used = 0;
  for (const [n, l] of lines.entries()) {
    if (used + estimateTokens(l) > budget) { out.push(`… ${lines.length - n} more lines left out (raise budget)`); break; }
    out.push(l);
    used += estimateTokens(l);
  }
  return out.join('\n');
}

/** Files changed in the workspace itself (specs, flow.md, support/), relative to its root. */
export async function workspaceChanges(ws: Workspace): Promise<string[]> {
  const out = await git(ws.root, ['status', '--porcelain', '--untracked-files=all']).catch(() => '');
  return out.split('\n').filter(Boolean).map((l) => relative('.', l.slice(3)));
}
