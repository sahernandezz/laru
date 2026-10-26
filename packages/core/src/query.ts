/**
 * What the AI asks for. Every answer is Markdown that fits a token budget and says what it left out
 * and how to ask for it, so an agent can pull the next piece instead of reading files blind.
 */
import { isAbsolute, relative } from 'node:path';
import { loadExtraction } from './extract.ts';
import type { Graph } from './graph.ts';
import { anchorText, type Anchor, type Fact, type MapNode } from './model.ts';
import type { Workspace } from './workspace.ts';
import { loadKnowledge, ancestors, childrenOf, freshness, type Knowledge } from './knowledge/store.ts';
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

function factLine(g: Graph, f: Fact, dir: 'out' | 'in', home?: string, also = 0): string {
  const other = g.nodes.get(dir === 'out' ? f.o : f.s);
  const name = other ? (other.type === 'service' || other.type === 'endpoint' ? other.id : other.name) : dir === 'out' ? f.o : f.s;
  const tag = (f.origin === 'extracted' ? '' : ` [${f.origin}]`) + (f.seen ? ` (seen in run ${f.seen.run}, ${f.seen.count}×)` : '');
  const note = f.note ? ` — ${f.note}` : '';
  const at = where(f.anchor, home);
  return `- ${VERB[f.p][dir === 'out' ? 0 : 1]} ${name}${note}${tag}${at ? ` (${at}${also ? `, +${also} more` : ''})` : ''}`;
}

/** `- svc:portal → POST /refunds — note (anchor)`: who reaches which endpoint of a service. */
function epCallerLines(g: Graph, facts: Fact[], home?: string): string[] {
  return facts.map((f) => {
    const ep = g.nodes.get(f.o);
    const tag = (f.origin === 'extracted' ? '' : ` [${f.origin}]`) + (f.seen ? ` (seen in run ${f.seen.run}, ${f.seen.count}×)` : '');
    const at = where(f.anchor, home);
    return `- ${f.s} → ${ep?.name ?? f.o}${f.note ? ` — ${f.note}` : ''}${tag}${at ? ` (${at})` : ''}`;
  });
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
  const home = n.repo;
  const header = [`# ${n.id}`, describe(g, n)];
  const group = (facts: Fact[], dir: 'out' | 'in', ps: Fact['p'][]) => lines(g, facts.filter((f) => ps.includes(f.p)), dir, home);
  // What is declared about this node, when it has a piece of documentation: it goes first.
  const doc = k?.byId.get(n.id);
  const declared = doc && ws && k ? pieceSections(ws, k, g, doc).sections.filter((s) => ['Declared', 'Facets', 'Coverage by stage'].includes(s.title)).map((s) => ({ ...s, title: `${s.title} (${doc.path})` })) : [];
  if (n.type === 'service') {
    const deps = outs.filter((f) => f.p === 'depends-on' && f.o.startsWith('dep:'));
    // Callers of the service and of each of its endpoints: most calls land on an endpoint, not on the service.
    const exposed = outs.filter((f) => f.p === 'exposes').map((f) => f.o);
    const epCallers = exposed.flatMap((ep) => g.inOf(ep).filter((f) => f.p === 'calls' || f.p === 'forwards-to'));
    return render(header, [
      ...declared,
      { title: 'Called by', lines: [...group(ins, 'in', ['calls', 'forwards-to']), ...epCallerLines(g, epCallers, home)] },
      { title: 'Calls and uses', lines: group(outs, 'out', ['calls', 'uses']) },
      { title: 'Endpoints', lines: outs.filter((f) => f.p === 'exposes').map((f) => `- ${g.nodes.get(f.o)?.name}${f.anchor ? ` (${where(f.anchor, home)})` : ''}${g.inOf(f.o).some((x) => x.p === 'calls' || x.p === 'forwards-to') ? '' : ' — nothing in the map calls it'}`), more: `context ep:${n.name}:<METHOD> <path>` },
      { title: 'Data', lines: group(outs, 'out', ['maps-table', 'defines-table', 'publishes', 'consumes']) },
      { title: 'Environment variables', lines: group(outs, 'out', ['reads-var']), more: 'context var:<NAME>' },
      { title: 'Depends on repositories', lines: group(outs.filter((f) => f.o.startsWith('repo:')), 'out', ['depends-on']) },
      { title: 'Libraries', lines: deps.map((f) => `- ${g.nodes.get(f.o)?.name}${g.nodes.get(f.o)?.attrs?.version ? ` ${g.nodes.get(f.o)!.attrs!.version}` : ''}`) },
    ], budget);
  }
  if (n.type === 'endpoint') {
    const svc = n.service ? g.nodes.get(n.service) : undefined;
    return render(header, [
      { title: 'Callers', lines: group(ins, 'in', ['calls', 'forwards-to']) },
      { title: 'Forwards to', lines: group(outs, 'out', ['forwards-to']) },
      { title: `What ${svc?.name ?? 'its service'} touches`, lines: svc ? group(g.outOf(svc.id), 'out', ['maps-table', 'publishes', 'consumes', 'uses', 'calls']) : [], more: `context ${svc?.id}` },
    ], budget);
  }
  return render(header, [
    ...declared,
    { title: 'Inbound', lines: lines(g, ins, 'in', home) },
    { title: 'Outbound', lines: lines(g, outs, 'out', home) },
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
    case 'endpoint': return `${a.method} ${a.path} on ${n.service}${a.handler ? `, handled by ${a.handler}` : ''}${a.contract ? ', declared in an OpenAPI file' : ''}${n.anchor ? ` (${anchorText(n.anchor)})` : ''}.`;
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
  const header = [`# ${repo}:${path}`, owner ? `Part of ${owner.id} (${owner.kind}).` : `In repo:${repo}, outside any service.`];
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
export function tree(g: Graph, depth = 2): string {
  const lines: string[] = [];
  const app = g.ofType('application')[0];
  lines.push(`${app?.id} — ${app?.name}`);
  for (const r of g.ofType('repository')) {
    lines.push(`  ${r.id} (${r.kind}, ${r.attrs?.source === 'folder' ? 'folder' : r.attrs?.branch}@${String(r.attrs?.commit).slice(0, 7)})`);
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

/** Open questions: nodes scored by the words they share with the question, each with its neighbourhood. */
export function ask(g: Graph, question: string, budget = 2000): string {
  const words = question.toLowerCase().split(/[^a-z0-9_.\-/]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) return 'Ask with the names of things: a service, a table, an endpoint, a topic, a variable.';
  const scored = g.map.nodes.filter((n) => n.type !== 'dependency' && n.type !== 'application').map((n) => {
    const hay = `${n.id} ${n.name}`.toLowerCase();
    return { n, score: words.reduce((s, w) => s + (hay.includes(w) ? (hay.split(/[^a-z0-9]+/).includes(w) ? 3 : 1) : 0), 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || TYPE_ORDER.indexOf(a.n.type) - TYPE_ORDER.indexOf(b.n.type)).slice(0, 6);
  if (!scored.length) return `Nothing in the map matches ${words.join(', ')}.`;
  return render([`# ${question}`], scored.map(({ n }) => ({
    title: `${n.id}`,
    lines: [...lines(g, g.inOf(n.id), 'in', n.repo), ...lines(g, g.outOf(n.id).filter((f) => !f.o.startsWith('dep:')), 'out', n.repo)],
    more: `context ${n.id}`,
  })), budget);
}
const STOP = new Set(['the', 'who', 'what', 'which', 'where', 'does', 'how', 'and', 'for', 'from', 'with', 'que', 'quien', 'quién', 'donde', 'dónde', 'como', 'cómo', 'los', 'las', 'del', 'una', 'por', 'para', 'escribe', 'writes', 'calls', 'llama']);

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
