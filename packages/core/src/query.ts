/**
 * What the AI asks for. Every answer is Markdown that fits a token budget and says what it left out
 * and how to ask for it, so an agent can pull the next piece instead of reading files blind.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadExtraction } from './extract.ts';
import type { Graph } from './graph.ts';
import { lastExchanges, lastParticipants } from './lastruns.ts';
import { anchorText, type Anchor, type Fact, type MapNode } from './model.ts';
import type { Workspace } from './workspace.ts';
import type { Param } from '@laru/detect';
import { loadKnowledge, ancestors, childrenOf, freshness, type Knowledge, type Loaded } from './knowledge/store.ts';
import { coverage } from './knowledge/coverage.ts';
import { isContainer } from './knowledge/standard.ts';
import { pieceSections, pieceSummaryLine, piecesForFile } from './knowledge/context.ts';
import { conventionsFor } from './knowledge/coverage.ts';

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const TYPE_ORDER: MapNode['type'][] = ['service', 'endpoint', 'table', 'topic', 'datastore', 'external', 'env-var', 'repository', 'dependency', 'application'];

const VERB: Record<Fact['p'], [string, string]> = {
  contains: ['contains', 'is contained in'],
  exposes: ['exposes', 'is exposed by'],
  calls: ['calls', 'is called by'],
  'forwards-to': ['forwards to', 'receives forwards from'],
  'reads-var': ['reads', 'is read by'],
  'declares-var': ['sets', 'is set by'],
  'maps-table': ['maps table', 'is mapped by'],
  'defines-table': ['creates table', 'is created by'],
  publishes: ['publishes to', 'gets messages from'],
  consumes: ['consumes', 'is consumed by'],
  uses: ['uses', 'is used by'],
  reads: ['reads table', 'is read by'],
  writes: ['writes table', 'is written by'],
  'depends-on': ['depends on', 'is a dependency of'],
};

/** Short anchors inside a repo — `FileController.java:38 FileController.upload` — and the full one across repos. */
const where = (a: Anchor | undefined, home?: string) => {
  if (!a) return '';
  if (a.repo !== home) return anchorText(a);
  return `${a.path.split('/').pop()}${a.line ? `:${a.line}` : ''}${a.symbol ? ` ${a.symbol}` : ''}`;
};

/** The endpoints whose requests did it, as runs saw it: `by POST /files, GET /files +2`. */
const byWhom = (g: Graph, f: Fact) => (f.via?.length ? ` — by ${f.via.slice(0, 3).map((e) => g.nodes.get(e)?.name ?? e).join(', ')}${f.via.length > 3 ? ` +${f.via.length - 3}` : ''}` : '');

function factLine(g: Graph, f: Fact, dir: 'out' | 'in', home?: string, also = 0): string {
  const other = g.nodes.get(dir === 'out' ? f.o : f.s);
  const name = other ? (other.type === 'service' || other.type === 'endpoint' ? other.id : other.name) : dir === 'out' ? f.o : f.s;
  const tag = (f.origin === 'extracted' ? '' : ` [${f.origin}]`) + (f.seen ? ` (seen in run ${f.seen.run}, ${f.seen.count}×)` : '');
  const note = f.note ? ` — ${f.note}` : '';
  const at = where(f.anchor, home);
  return `- ${VERB[f.p][dir === 'out' ? 0 : 1]} ${name}${note}${byWhom(g, f)}${tag}${at ? ` (${at}${also ? `, +${also} more` : ''})` : ''}`;
}

/**
 * One line per endpoint of a service: its handler, who calls it (through which gateway), how often runs saw it and how
 * many flows reach it. A caller reached through a gateway is named once, with the gateway; the gateway's forward is not
 * a caller of its own.
 */
function endpointLines(g: Graph, ws: Workspace | undefined, exposed: Fact[], home?: string): string[] {
  const reached = ws ? [...lastExchanges(ws).values()] : [];
  const svcOf = (id: string) => (g.nodes.get(id)?.type === 'endpoint' ? g.nodes.get(id)!.service ?? id : id);
  return exposed.map((f) => {
    const into = g.inOf(f.o).filter((x) => x.p === 'calls' || x.p === 'forwards-to');
    const via = new Set(into.filter((x) => x.p === 'forwards-to').map((x) => svcOf(x.s)));
    const callers = [...new Set(into.filter((x) => x.p === 'calls').map((x) => svcOf(x.s)).filter((s) => !via.has(s)))];
    const seen = Math.max(0, ...into.map((x) => x.seen?.count ?? 0));
    const flows = reached.filter((e) => e.endpoints.has(f.o)).length;
    const name = (id: string) => g.nodes.get(id)?.name ?? id;
    const who = callers.length ? `← ${callers.map(name).join(', ')}${via.size ? ` via ${[...via].map(name).join(', ')}` : ''}` : via.size ? `← ${[...via].map(name).join(', ')}` : '— nothing in the map calls it';
    const a = f.anchor, handler = a ? (a.repo === home ? `${a.symbol ?? a.path.split('/').pop()}${a.line ? `:${a.line}` : ''}` : anchorText(a)) : '';
    return `- ${name(f.o)}${handler ? ` (${handler})` : ''} ${who}${seen ? ` · seen ${seen}×` : ''}${flows ? ` · ${flows} ${flows === 1 ? 'flow' : 'flows'}` : ''}`;
  });
}

/** One line per table or topic a service holds: what it does with it (in its code, and in runs), where, and by which endpoints. */
function dataLines(g: Graph, facts: Fact[], home?: string): string[] {
  const WORD: Partial<Record<Fact['p'], string>> = { 'maps-table': 'maps', 'defines-table': 'creates', writes: 'writes', reads: 'reads', publishes: 'publishes', consumes: 'consumes' };
  const by = new Map<string, Fact[]>();
  for (const f of facts) if (WORD[f.p]) (by.get(f.o) ?? by.set(f.o, []).get(f.o)!).push(f);
  return [...by].map(([o, fs]) => {
    const n = g.nodes.get(o);
    const did = [...new Set(fs.map((f) => `${WORD[f.p]}${f.origin === 'observed' ? ' in runs' : ''}`))];
    const at = fs.find((f) => f.anchor)?.anchor, via = [...new Set(fs.flatMap((f) => f.via ?? []))], seen = Math.max(0, ...fs.map((f) => f.seen?.count ?? 0));
    return `- ${n?.type ?? 'node'} ${n?.name ?? o}: ${did.join(', ')}${at ? ` (${where(at, home)})` : ''}${via.length ? ` — by ${via.slice(0, 3).map((e) => g.nodes.get(e)?.name ?? e).join(', ')}${via.length > 3 ? ` +${via.length - 3}` : ''}` : ''}${seen ? ` · seen ${seen}×` : ''}`;
  });
}

/** Who calls a service, one line each: how many of its endpoints, through which gateway, and whether runs saw it. */
function callerLines(g: Graph, exposed: Fact[], ins: Fact[], home?: string): string[] {
  const svcOf = (id: string) => (g.nodes.get(id)?.type === 'endpoint' ? g.nodes.get(id)!.service ?? id : id);
  const by = new Map<string, { eps: Set<string>; via: Set<string>; forwards: boolean; seen: number }>();
  const at = (s: string) => by.get(s) ?? by.set(s, { eps: new Set(), via: new Set(), forwards: false, seen: 0 }).get(s)!;
  for (const e of exposed) {
    const into = g.inOf(e.o).filter((x) => x.p === 'calls' || x.p === 'forwards-to');
    const via = new Set(into.filter((x) => x.p === 'forwards-to').map((x) => svcOf(x.s)));
    for (const x of into) {
      const c = at(svcOf(x.s));
      c.eps.add(e.o);
      c.seen = Math.max(c.seen, x.seen?.count ?? 0);
      if (x.p === 'forwards-to') c.forwards = true;
      else for (const v of via) if (v !== svcOf(x.s)) c.via.add(v);
    }
  }
  const own = lines(g, ins.filter((x) => x.p === 'calls' || x.p === 'forwards-to'), 'in', home);
  return [...own, ...[...by].map(([s, c]) => `- ${s} ${c.forwards ? 'forwards' : 'calls'} ${c.eps.size} of its endpoints${c.via.size ? ` through ${[...c.via].join(', ')}` : ''}${c.seen ? ' (seen in runs)' : ''}`)];
}

/** The flows whose last run went through a thing, with their title: what to run after changing it. */
function flowsThrough(ws: Workspace | undefined, k: Knowledge | undefined, n: MapNode): string[] {
  if (!ws) return [];
  const slugs = n.type === 'endpoint'
    ? [...lastExchanges(ws)].filter(([, e]) => e.endpoints.has(n.id)).map(([f]) => f)
    : [...lastParticipants(ws)].filter(([, p]) => (n.type === 'table' ? p.tables.includes(n.name) : n.type === 'topic' ? p.topics.includes(n.name) : p.nodes.includes(n.id))).map(([f]) => f);
  return slugs.sort().map((s) => { const p = k?.byId.get(`flow:${s}`); return `- flow:${s}${p ? ` «${p.title}»` : ''}`; });
}

/**
 * How far the checkout the agent edits is from the commit the map read: what the map says is that commit's. Said when
 * the copy moved past it (or has uncommitted changes), and when the reference branch did, with what to do.
 */
function driftOf(g: Graph, ws: Workspace, repo: string | undefined): { ahead: number; behind: number; dirty: boolean; moved: number; commit: string; ref: string } | null {
  const read = g.map.repos.find((r) => r.name === repo), dir = repo ? ws.checkouts[repo] : undefined;
  if (!read || !dir || !existsSync(join(dir, '.git'))) return null;
  const git = (...args: string[]) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const head = git('rev-parse', 'HEAD');
  const [behind = 0, ahead = 0] = head && head !== read.commit ? git('rev-list', '--left-right', '--count', `${read.commit}...HEAD`).split(/\s+/).map(Number) : [];
  return { ahead, behind, dirty: git('status', '--porcelain', '--untracked-files=no') !== '', moved: Number(git('rev-list', '--count', `${read.commit}..${read.ref}`)) || 0, commit: read.commit.slice(0, 7), ref: read.ref };
}
function driftLine(g: Graph, ws: Workspace | undefined, repo: string | undefined): string {
  const d = ws ? driftOf(g, ws, repo) : null;
  if (!d || (!d.ahead && !d.behind && !d.dirty && !d.moved)) return '';
  const n = (x: number) => `${x} ${x === 1 ? 'commit' : 'commits'}`;
  const where = d.ahead && d.behind ? `${n(d.ahead)} ahead of and ${d.behind} behind` : d.ahead ? `${n(d.ahead)} ahead of` : d.behind ? `${n(d.behind)} behind` : '';
  const mine = where || d.dirty
    ? `Your checkout of ${repo} ${where ? `is ${where} what the map read (${d.commit})${d.dirty ? ', with uncommitted changes' : ''}` : `has uncommitted changes over what the map read (${d.commit})`}: what follows is that commit; \`impact\` says what your changes touch.`
    : '';
  const ref = d.moved ? `${d.ref} moved ${n(d.moved)} past what the map read: \`map_refresh\` reads it again.` : '';
  return [mine, ref].filter(Boolean).join(' ');
}

/** One line per relation and counterpart: the same link seen in three config profiles is one fact with three anchors. */
function lines(g: Graph, facts: Fact[], dir: 'out' | 'in', home?: string): string[] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) { const k = `${f.p}|${dir === 'out' ? f.o : f.s}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
  return [...groups.values()].map((fs) => factLine(g, fs.find((f) => f.note && !/\(\w+\)$/.test(f.note)) ?? fs[0], dir, home, fs.length - 1));
}

/** Sections in priority order; each is cut when the budget runs out and says what it dropped. */
export function render(header: string[], sections: Array<{ title: string; lines: string[]; more?: string }>, budget: number): string {
  const out = [...header];
  let used = estimateTokens(out.join('\n'));
  const omitted: string[] = [];
  for (const s of sections) {
    if (!s.lines.length) continue;
    const title = `\n## ${s.title} (${s.lines.length})`;
    if (used + estimateTokens(title) + 20 > budget) { omitted.push(`${s.title} (${s.lines.length})`); continue; }
    out.push(title); used += estimateTokens(title);
    let shown = 0;
    for (const l of s.lines) {
      const t = estimateTokens(l) + 1;
      if (used + t > budget - 30) break;
      out.push(l); used += t; shown++;
    }
    if (shown < s.lines.length) out.push(`- … ${s.lines.length - shown} more${s.more ? `: ${s.more}` : ''}`);
  }
  if (omitted.length) out.push(`\nLeft out for the budget: ${omitted.join(', ')}. Ask again with a larger budget.`);
  return out.join('\n');
}

export type Resolved = { kind: 'node'; node: MapNode } | { kind: 'file'; repo: string; path: string } | { kind: 'none'; suggestions: string[] };

/** `svc:billing-api`, `billing-api`, `billing:api/src/…/X.java`, an absolute path in a checkout, or a bare name. */
export function resolveTarget(g: Graph, ws: Workspace, target: string): Resolved {
  const t = target.trim();
  const exact = g.nodes.get(t);
  if (exact) return { kind: 'node', node: exact };
  if (isAbsolute(t)) {
    // the longest checkout that contains it: a project never contains another, but the rule holds either way
    const hit = Object.entries(ws.checkouts).map(([repo, dir]) => ({ repo, dir, rel: relative(dir, t) })).filter((h) => !h.rel.startsWith('..') && !isAbsolute(h.rel)).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (hit) return { kind: 'file', repo: hit.repo, path: hit.rel };
  }
  const m = t.match(/^(?:repo:)?([a-z0-9-]+)(?:@\w+)?:(.+?)(?::\d+)?(?:#.*)?$/);
  if (m && ws.repos.some((r) => r.name === m[1])) return { kind: 'file', repo: m[1], path: m[2] };
  const lower = t.toLowerCase();
  const byName = g.map.nodes.filter((n) => n.name.toLowerCase() === lower).sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  if (byName[0]) return { kind: 'node', node: byName[0] };
  if (t.includes('/')) {
    for (const r of ws.repos) {
      const ex = loadExtraction(ws, r.name);
      const hit = ex && Object.keys(ex.files).find((p) => p === t || p.endsWith('/' + t));
      if (hit) return { kind: 'file', repo: r.name, path: hit };
    }
  }
  const suggestions = g.map.nodes.filter((n) => n.id.toLowerCase().includes(lower) || n.name.toLowerCase().includes(lower)).sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).slice(0, 8).map((n) => n.id);
  return { kind: 'none', suggestions };
}

export function context(g: Graph, ws: Workspace, target: string, budget = 2000): string {
  const k = loadKnowledge(ws);
  const piece = k.byId.get(target.trim());
  if (piece && !g.nodes.has(piece.id)) { const { header, sections } = pieceSections(ws, k, g, piece); return render(header, sections, budget); }
  const r = resolveTarget(g, ws, target);
  if (r.kind === 'none') return `Nothing in the map is called "${target}".${r.suggestions.length ? ` Closest: ${r.suggestions.join(', ')}.` : ' Try `tree` to see what exists.'}`;
  if (r.kind === 'file') return fileContext(g, ws, r.repo, r.path, budget, k);
  return nodeContext(g, r.node, budget, ws, k);
}

function nodeContext(g: Graph, n: MapNode, budget: number, ws?: Workspace, k?: Knowledge): string {
  const outs = g.outOf(n.id), ins = g.inOf(n.id);
  const home = n.repo ?? (n.service ? g.nodes.get(n.service)?.repo : undefined);
  const header = [`# ${n.id}`, describe(g, n), driftLine(g, ws, home)].filter(Boolean);
  const group = (facts: Fact[], dir: 'out' | 'in', ps: Fact['p'][]) => lines(g, facts.filter((f) => ps.includes(f.p)), dir, home);
  // What is declared about this node, when it has a piece of documentation: it goes first.
  const doc = k?.byId.get(n.id);
  // shorter than in the piece's own context: the file named in its title has it whole, and the map's sections need the room
  const declared = doc && ws && k ? pieceSections(ws, k, g, doc).sections.filter((s) => ['Declared', 'Facets', 'Coverage by stage'].includes(s.title)).map((s) => ({ ...s, title: `${s.title} (${doc.path})`, lines: s.lines.map((l) => clip(l, 300)) })) : [];
  const flows = { title: 'Flows that go through it (their last run)', lines: flowsThrough(ws, k, n), more: 'flow_run <flow>' };
  if (n.type === 'service') {
    const deps = outs.filter((f) => f.p === 'depends-on' && f.o.startsWith('dep:'));
    const exposed = outs.filter((f) => f.p === 'exposes');
    // What changing it needs first: its endpoints (one line each, with who calls them), its data and what it calls;
    // then who calls it, the flows that go through it, and what it is built on.
    return render(header, [
      ...declared,
      { title: 'Endpoints', lines: endpointLines(g, ws, exposed, home), more: `context ep:${n.name}:<METHOD> <path>` },
      { title: 'Data', lines: dataLines(g, outs, home) },
      { title: 'Calls and uses', lines: group(outs, 'out', ['calls', 'uses']) },
      { title: 'Called by', lines: callerLines(g, exposed, ins, home) },
      flows,
      { title: 'Environment variables', lines: group(outs, 'out', ['reads-var']), more: 'context var:<NAME>' },
      { title: 'Depends on repositories', lines: group(outs.filter((f) => f.o.startsWith('repo:')), 'out', ['depends-on']) },
      { title: 'Libraries', lines: deps.map((f) => `- ${g.nodes.get(f.o)?.name}${g.nodes.get(f.o)?.attrs?.version ? ` ${g.nodes.get(f.o)!.attrs!.version}` : ''}`) },
    ], budget);
  }
  if (n.type === 'endpoint') {
    const svc = n.service ? g.nodes.get(n.service) : undefined;
    const own = svc ? g.outOf(svc.id) : [];
    // what runs saw its service do while serving it: its tables, the stores and externals it used, its messages, its calls
    const did = [...new Set(own.filter((f) => f.via?.includes(n.id)).map((f) => {
      const o = g.nodes.get(f.o);
      return `- ${VERB[f.p][0]} ${o ? (o.type === 'service' || o.type === 'endpoint' ? o.id : o.name) : f.o}`;
    }))];
    return render(header, [
      { title: 'Callers', lines: group(ins, 'in', ['calls', 'forwards-to']) },
      { title: 'Forwards to', lines: group(outs, 'out', ['forwards-to']) },
      { title: 'What it did in runs', lines: did },
      { ...flows, title: 'Flows that reach it (their last run)' },
      { title: `What ${svc?.name ?? 'its service'} touches as a whole`, lines: svc ? group(own, 'out', ['maps-table', 'publishes', 'consumes', 'uses', 'calls']) : [], more: `context ${svc?.id}` },
    ], budget);
  }
  return render(header, [
    ...declared,
    { title: 'Inbound', lines: lines(g, ins, 'in', home) },
    { title: 'Outbound', lines: lines(g, outs, 'out', home) },
    flows,
  ], budget);
}

function describe(g: Graph, n: MapNode): string {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'service': {
      const repo = g.nodes.get(`repo:${n.repo}`);
      const tests = a.tests as Record<string, number> | undefined;
      const t = tests ? Object.entries(tests).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') : '';
      return `Service (${n.kind}) in repo:${n.repo}, folder \`${a.dir}\`, read at ${repo?.attrs?.ref}@${String(repo?.attrs?.commit ?? '').slice(0, 7)}.${t ? ` Tests: ${t}.` : ' No tests found.'}`;
    }
    case 'endpoint': {
      // what its code says of its contract: the start of the operation a contract writes for it
      const params = (a.params ?? []) as Param[];
      const takes = params.length ? ` Takes ${params.map((p) => `${p.in} ${p.name}${p.type ? ` (${p.type}${p.required === false ? ', optional' : ''})` : p.required === false ? ' (optional)' : ''}`).join(', ')}.` : '';
      const gives = `${a.returns ? ` Returns ${a.returns}.` : ''}${(a.statuses as number[] | undefined)?.length ? ` Its code answers ${(a.statuses as number[]).join(', ')}.` : ''}`;
      return `${a.method} ${a.path} on ${n.service}${a.handler ? `, handled by ${a.handler}` : ''}${a.contract ? ', declared in an OpenAPI file' : ''}${n.anchor ? ` (${anchorText(n.anchor)})` : ''}.${a.summary ? ` ${a.summary}.` : ''}${takes}${gives}`;
    }
    case 'repository': return a.source === 'folder' ? `Folder project, read at ${String(a.commit).slice(0, 7)}, role ${n.kind}.` : `Repository ${a.url}, reference branch ${a.branch} at ${String(a.commit).slice(0, 7)}, role ${n.kind}.`;
    case 'datastore': case 'external': return `${n.type === 'datastore' ? 'Data store' : 'External system'} (${n.kind})${a.image ? `, image ${a.image}` : ''}${n.repo ? `, of project ${n.repo}` : ''}${a.via ? `, reached through ${a.via}` : ''}.`;
    case 'env-var': return 'Environment variable. Values live in the vault, never in the repos.';
    case 'table': return `Table${a.schema ? ` in schema ${a.schema}` : ''}.`;
    case 'topic': return 'Message topic.';
    default: return n.name;
  }
}

function fileContext(g: Graph, ws: Workspace, repo: string, path: string, budget: number, k: Knowledge): string {
  const services = g.ofType('service').filter((s) => s.repo === repo);
  const owner = services.filter((s) => { const d = String(s.attrs?.dir); return d === '.' || path.startsWith(d + '/'); }).sort((a, b) => String(b.attrs?.dir).length - String(a.attrs?.dir).length)[0];
  const here = g.map.facts.filter((f) => f.anchor?.repo === repo && f.anchor.path === path);
  const ex = loadExtraction(ws, repo);
  const known = ex?.files[path];
  const header = [`# ${repo}:${path}`, owner ? `Part of ${owner.id} (${owner.kind}).` : `In repo:${repo}, outside any service.`, driftLine(g, ws, repo)].filter(Boolean);
  if (!known) header.push('No detector reads this file, so the map has nothing anchored in it. The context below is its service.');
  const svcLines = owner ? nodeContext(g, owner, Math.floor(budget / 2)).split('\n').slice(1) : [];
  const owners = piecesForFile(ws, k, repo, path);
  const rulesFrom = owners[0] ?? k.byId.get(`repo:${repo}`) ?? k.pieces.find((p) => p.type === 'application');
  const rules = rulesFrom ? [...conventionsFor(k, rulesFrom), ...(k.byId.get(`repo:${repo}`) && rulesFrom.id !== `repo:${repo}` ? conventionsFor(k, k.byId.get(`repo:${repo}`)!) : [])] : [];
  return render(header, [
    { title: 'Documented as part of', lines: owners.map((p) => `${pieceSummaryLine(k, p, ws)}${ancestors(k, p.id).length ? ` (inside ${ancestors(k, p.id).map((a) => a.id).join(' > ')})` : ''}`), more: 'context <id>' },
    { title: 'Conventions that rule this file', lines: [...new Map(rules.map((c) => [c.id, c])).values()].map((c) => `- ${c.id} ${c.title}: ${String(c.fields.rule ?? '').replace(/\s+/g, ' ').slice(0, 200)}`) },
    { title: 'Anchored in this file', lines: here.map((f) => factLine(g, f, 'out', repo).replace(/^- /, `- ${g.nodes.get(f.s)?.id ?? f.s} `)) },
    { title: `Its service, ${owner?.id ?? '—'}`, lines: svcLines.filter((l) => l.startsWith('- ') || l.startsWith('## ')).map((l) => (l.startsWith('## ') ? `- **${l.slice(3)}**` : `  ${l}`)) },
  ], budget);
}

/** The documentation as a tree: containers with their class, stage coverage and facets. */
export function docsTree(ws: Workspace, g: Graph | null): string {
  const k = loadKnowledge(ws);
  const app = k.pieces.find((p) => p.type === 'application');
  if (!app) return 'No documentation yet: docs/application.md is the root. Write it with knowledge_write({ type: "application", … }).';
  const MARK: Record<string, string> = { full: '●', part: '◐', miss: '○', na: '·' };
  const out: string[] = ['Coverage marks per stage (plan design build test deploy operate): ● covered ◐ partial ○ missing · not required'];
  const walk = (p: typeof app, depth: number) => {
    const cov = isContainer(p.type) && g ? coverage(ws, k, g, p).map((c) => MARK[c.state]).join('') : '';
    const facets = childrenOf(k, p.id).filter((c) => !isContainer(c.type));
    const counts = [...new Set(facets.map((f) => f.type))].map((t) => `${facets.filter((f) => f.type === t).length} ${t}`).join(', ');
    out.push(`${'  '.repeat(depth)}${p.id}${p.kind ? ` (${p.kind})` : ''} ${cov}${counts ? `  — ${counts}` : ''}${freshness(ws, p) === 'stale' ? '  STALE' : ''}`);
    for (const c of childrenOf(k, p.id).filter((c) => isContainer(c.type))) walk(c, depth + 1);
  };
  walk(app, 0);
  return out.join('\n');
}

/** The application as a tree: repositories, their services and what each one holds, plus the infrastructure. */
export function tree(g: Graph, depth = 2, ws?: Workspace): string {
  const lines: string[] = [];
  const app = g.ofType('application')[0];
  lines.push(`${app?.id} — ${app?.name}`);
  for (const r of g.ofType('repository')) {
    // how far the checkout (or the reference branch) is from what the map read: what to do before trusting it
    const d = ws ? driftOf(g, ws, r.name) : null;
    const copy = d ? [d.ahead ? `${d.ahead} ahead` : '', d.behind ? `${d.behind} behind` : '', d.dirty ? 'uncommitted changes' : ''].filter(Boolean).join(', ') : '';
    const drift = d && (copy || d.moved) ? `  — ${copy ? `your checkout: ${copy} (impact)` : ''}${copy && d.moved ? '; ' : ''}${d.moved ? `${d.ref} moved ${d.moved} (map_refresh)` : ''}` : '';
    lines.push(`  ${r.id} (${r.kind}, ${r.attrs?.source === 'folder' ? 'folder' : r.attrs?.branch}@${String(r.attrs?.commit).slice(0, 7)})${drift}`);
    for (const f of g.outOf(r.id).filter((x) => x.p === 'contains')) {
      const s = g.nodes.get(f.o)!;
      const o = g.outOf(s.id);
      const count = (p: Fact['p']) => o.filter((x) => x.p === p).length;
      lines.push(`    ${s.id} (${s.kind}, ${s.attrs?.dir}) endpoints ${count('exposes')}, tables ${count('maps-table')}, topics ${count('publishes') + count('consumes')}, vars ${count('reads-var')}`);
      if (depth > 2) for (const e of o.filter((x) => x.p === 'exposes')) lines.push(`      ${g.nodes.get(e.o)?.name}`);
    }
  }
  const infra = g.outOf(app?.id ?? '').filter((f) => f.p === 'contains' && !f.o.startsWith('repo:'));
  if (infra.length) {
    lines.push('  infrastructure');
    for (const f of infra) { const n = g.nodes.get(f.o)!; lines.push(`    ${n.id} (${n.kind}${n.attrs?.image ? `, ${n.attrs.image}` : ''}${n.repo ? `, project ${n.repo}` : ''})`); }
  }
  return lines.join('\n');
}

/** Lower case and without accents: `Quién` and `quien` are one word. */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
/** A kind of thing the question names: it ranks those first, and is not a name to look for. */
const TYPE_WORD: Record<string, MapNode['type']> = Object.fromEntries(([
  ['table', ['table', 'tables', 'tabla', 'tablas']], ['topic', ['topic', 'topics', 'tema', 'temas', 'cola', 'colas', 'queue', 'queues']],
  ['endpoint', ['endpoint', 'endpoints', 'ruta', 'rutas', 'route', 'routes']], ['env-var', ['variable', 'variables', 'var', 'vars']],
  ['service', ['service', 'services', 'servicio', 'servicios']], ['datastore', ['store', 'stores', 'bucket', 'buckets', 'almacen', 'almacenes', 'database']],
] as Array<[MapNode['type'], string[]]>).flatMap(([t, ws]) => ws.map((w) => [w, t])));
/** What the question asks someone does: those facts come first in each answer. */
const VERB_WORD: Record<string, Fact['p'][]> = Object.fromEntries(([
  [['writes', 'write', 'writing', 'escribe', 'escriben', 'guarda', 'guardan', 'inserta', 'updates', 'actualiza', 'borra', 'deletes'], ['writes', 'maps-table']],
  [['reads', 'read', 'lee', 'leen', 'consulta', 'consultan'], ['reads', 'maps-table']],
  [['publishes', 'publish', 'publica', 'publican', 'emite', 'emits'], ['publishes']],
  [['consumes', 'consume', 'consumen', 'escucha', 'listens'], ['consumes']],
  [['calls', 'call', 'llama', 'llaman', 'invoca'], ['calls', 'forwards-to']],
  [['uses', 'use', 'usa', 'usan'], ['uses']],
] as Array<[string[], Fact['p'][]]>).flatMap(([ws, ps]) => ws.map((w) => [w, ps])));
const STOP = new Set(['the', 'who', 'what', 'which', 'where', 'when', 'does', 'how', 'and', 'for', 'from', 'with', 'into', 'that', 'this', 'are',
  'que', 'quien', 'quienes', 'cual', 'cuales', 'donde', 'como', 'cuando', 'los', 'las', 'del', 'una', 'uno', 'por', 'para', 'con', 'sin', 'sobre', 'esta', 'este', 'hay', 'son']);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The map's things a piece names: its `[[id]]` links, the endpoints it writes as `METHOD /path`, the tables and topics in backticks. */
function namesIn(g: Graph, p: Loaded): string[] {
  const out = new Set<string>();
  for (const m of p.source.matchAll(/\[\[([a-z-]+:[^\]|]+)/g)) if (g.nodes.has(m[1])) out.add(m[1]);
  for (const n of g.map.nodes) {
    if (n.type === 'endpoint' ? p.source.includes(`${n.attrs?.method} ${n.attrs?.path}`) : (n.type === 'table' || n.type === 'topic') && p.source.includes(`\`${n.name}\``)) out.add(n.id);
  }
  return [...out];
}

/**
 * Open questions: nodes scored by the words they share with the question, each with its neighbourhood. The words go
 * without accents and in singular too; a kind named (`table`, `tema`) ranks those first, and a verb (`escribe`,
 * `publishes`) puts those facts first. The documentation answers in its own words (the business', often Spanish): the
 * pieces that match, and the things they name, which join the answer.
 */
export function ask(g: Graph, question: string, budget = 2000, k?: Knowledge): string {
  const all = fold(question).split(/[^a-z0-9_.\-/{}]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const type = all.map((w) => TYPE_WORD[w]).find(Boolean);
  const verbs = all.flatMap((w) => VERB_WORD[w] ?? []);
  const words = all.filter((w) => !TYPE_WORD[w] && !VERB_WORD[w]);
  if (!words.length) return 'Ask with the names of things: a service, a table, an endpoint, a topic, a variable.';
  const forms = (w: string) => [w, ...(w.length > 4 && w.endsWith('es') ? [w.slice(0, -2)] : []), ...(w.length > 3 && w.endsWith('s') ? [w.slice(0, -1)] : [])];
  // the word as asked weighs 3, its singular 2 (`files` is not only `file.uploaded`), inside a longer name 1
  const score = (hay: string) => { const toks = new Set(hay.split(/[^a-z0-9]+/)); return words.reduce((s, w) => s + Math.max(0, ...forms(w).map((x, i) => (toks.has(x) ? (i ? 2 : 3) : hay.includes(x) ? 1 : 0))), 0); };
  const pieces = (k?.pieces ?? []).map((p) => ({ p, score: score(fold(`${p.id} ${p.title} ${p.summary}`)) })).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, 3);
  const named = new Map<string, string[]>();
  for (const { p } of pieces) for (const id of namesIn(g, p)) (named.get(id) ?? named.set(id, []).get(id)!).push(p.id);
  const scored = g.map.nodes.filter((n) => n.type !== 'dependency' && n.type !== 'application').map((n) => {
    const s = score(fold(`${n.id} ${n.name}`));
    return { n, score: s + (s && type === n.type ? 4 : 0) + 2 * (named.get(n.id)?.length ?? 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || TYPE_ORDER.indexOf(a.n.type) - TYPE_ORDER.indexOf(b.n.type)).slice(0, 6);
  if (!scored.length && !pieces.length) return `Nothing in the map or the documentation matches ${words.join(', ')}.`;
  // the verb asked for first (`escribe`: who writes it, then who maps it), then the rest as they are
  const first = (fs: Fact[]) => (verbs.length ? [...fs.filter((f) => verbs.includes(f.p)).sort((a, b) => verbs.indexOf(a.p) - verbs.indexOf(b.p)), ...fs.filter((f) => !verbs.includes(f.p))] : fs);
  return render([`# ${question}`], [
    { title: 'Documentation', lines: pieces.map(({ p }) => { const ns = namesIn(g, p); return `- ${p.id} «${p.title}» — ${clip(p.summary.replace(/\s+/g, ' '), 180)}${ns.length ? ` (names ${ns.slice(0, 4).join(', ')}${ns.length > 4 ? ` +${ns.length - 4}` : ''})` : ''}`; }), more: 'context <id>' },
    ...scored.map(({ n }) => ({
      title: `${n.id}`,
      lines: [...lines(g, first(g.inOf(n.id)), 'in', n.repo), ...lines(g, first(g.outOf(n.id).filter((f) => !f.o.startsWith('dep:'))), 'out', n.repo)],
      more: `context ${n.id}`,
    })),
  ], budget);
}

/** Shortest chain of facts between two nodes. Hubs that join everything — the repo, the app, libraries,
 *  env vars — are never crossed, and data stores only when nothing else connects the two. */
export function path(g: Graph, ws: Workspace, from: string, to: string): string {
  const a = resolveTarget(g, ws, from), b = resolveTarget(g, ws, to);
  if (a.kind !== 'node') return `Cannot find "${from}" in the map.`;
  if (b.kind !== 'node') return `Cannot find "${to}" in the map.`;
  const HUBS = /^(repo|app|dep|var):/;
  const search = (allowStores: boolean) => {
    const prev = new Map<string, { node: string; fact: Fact }>();
    const queue = [a.node.id];
    const seen = new Set(queue);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === b.node.id) return prev;
      for (const [id, fact] of [...g.outOf(cur).map((f) => [f.o, f] as const), ...g.inOf(cur).map((f) => [f.s, f] as const)]) {
        if (seen.has(id) || (id !== b.node.id && (HUBS.test(id) || (!allowStores && /^(ds|ext):/.test(id))))) continue;
        seen.add(id); prev.set(id, { node: cur, fact }); queue.push(id);
      }
    }
    return null;
  };
  const prev = search(false) ?? search(true);
  if (!prev) return `No path in the map between ${a.node.id} and ${b.node.id}.`;
  const steps: string[] = [];
  for (let cur = b.node.id; cur !== a.node.id;) {
    const { node, fact: f } = prev.get(cur)!;
    steps.unshift(`- ${f.s} ${VERB[f.p][0]} ${f.o}${f.note ? ` — ${f.note}` : ''}${f.origin !== 'extracted' ? ` [${f.origin}]` : ''}${f.anchor ? ` (${anchorText(f.anchor)})` : ''}`);
    cur = node;
  }
  return [`# ${a.node.id} → ${b.node.id}`, ...steps].join('\n');
}
