/** What the AI reads about the declared side: a piece with its chain, facets, inherited conventions and code. */
import type { Graph } from '../graph.ts';
import type { Workspace } from '../workspace.ts';
import { coverage, endpointOwner } from './coverage.ts';
import { liveOf } from './live.ts';
import { owedLine, sheetNote } from './sheet.ts';
import type { Row } from './piece.ts';
import { anchorResolver, ancestors, childrenOf, freshness, type Knowledge, type Loaded } from './store.ts';
import { isContainer, STANDARD } from './standard.ts';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const fieldLine = (p: Loaded, name: string): string | null => {
  const v = p.fields[name];
  if (v === undefined) return null;
  if (typeof v === 'string') return clip(v.replace(/\s+/g, ' '), 500);
  if (v.length && typeof v[0] === 'string') return (v as string[]).map((x) => clip(x, 120)).join('; ');
  return (v as Row[]).map((r) => Object.values(r).join(' · ')).slice(0, 8).join(' | ') + ((v as Row[]).length > 8 ? ` | … ${(v as Row[]).length - 8} more` : '');
};

export function pieceSummaryLine(k: Knowledge, p: Loaded, ws: Workspace): string {
  const f = freshness(ws, p);
  return `- ${p.id} [${p.type}${p.kind ? `/${p.kind}` : ''}, ${p.status}${f === 'stale' ? ', STALE' : ''}] ${p.title} — ${p.summary}`;
}

/** Sections for the context renderer, in priority order. */
export function pieceSections(ws: Workspace, k: Knowledge, g: Graph | null, p: Loaded): { header: string[]; sections: Array<{ title: string; lines: string[]; more?: string }> } {
  const std = STANDARD[p.type];
  const chain = ancestors(k, p.id);
  const f = freshness(ws, p);
  const header = [
    `# ${p.id}`,
    `${std.label.en}${p.kind ? ` (${p.kind})` : ''}, ${p.status}: ${p.summary}`,
    chain.length ? `Inside ${chain.map((c) => c.id).join(' > ')}.` : '',
    f === 'stale' ? `STALE: the anchored code changed since ${Object.entries(p.verified!.commits).map(([r, c]) => `${r}@${c}`).join(', ')}. Review it against the code before trusting it, then \`verify\`.` : '',
    `File: ${p.path}`,
  ].filter(Boolean);
  const fields = std.fields.map((fd) => { const v = fieldLine(p, fd.name); return v ? `- ${fd.name}: ${v}` : null; }).filter(Boolean) as string[];
  const facets = childrenOf(k, p.id).filter((c) => !isContainer(c.type)).map((c) => pieceSummaryLine(k, c, ws));
  const kids = childrenOf(k, p.id).filter((c) => isContainer(c.type)).map((c) => pieceSummaryLine(k, c, ws));
  const inherited = [...chain].reverse().flatMap((a) => childrenOf(k, a.id).filter((c) => c.type === 'convention').map((c) => `- ${c.id} (from ${a.id}) ${c.title}: ${clip(String(c.fields.rule ?? ''), 200)}`));
  const cov = isContainer(p.type) ? coverage(ws, k, g, p).filter((c) => c.required || c.state !== 'na').map((c) => `- ${c.stage}: ${c.state}${c.required ? '' : ' (not required)'} — ${c.reasons.map((r) => r.text).join('; ')}`) : [];
  const resolve = anchorResolver(ws);
  const code = (p.anchors ?? []).map((a) => `- ${a} → ${(resolve(a) ?? []).length} files`);
  const owns = endpointOwner(ws, p);
  const eps = g ? g.ofType('endpoint').filter((e) => e.anchor && owns(e.anchor.repo, e.anchor.path, String(e.attrs?.handler ?? ''))).map((e) => `- ${e.id}`) : [];
  // The live sections of the sheet: what it owes, and what its code says (names only, never values).
  const note = isContainer(p.type) ? sheetNote(ws, k, g, p) : null;
  const owed = note ? [`- document ${note.doc}${note.sheet !== null ? `, sheet ${note.sheet}` : ''}`, ...note.owed.map((i) => `- ${i.kind === 'structure' ? 'structure' : 'contrast'}: ${owedLine(i)}`)] : [];
  const live = p.anchors?.length || p.type === 'flow' ? liveOf(ws, k, g, p) : null;
  const tests = live ? live.tests.map((t) => `- ${t.file} (${t.level}): ${t.cases.slice(0, 6).map((c) => `${c.name}:${c.line}`).join(', ')}${t.cases.length > 6 ? `, … ${t.cases.length - 6} more` : ''}`) : [];
  const vars = live ? live.vars.map((v) => `- ${v.name}${v.secret ? ' (secret)' : ''} at ${v.file}${v.line ? `:${v.line}` : ''}`) : [];
  const gaps = live ? [...live.endpoints.filter((e) => !e.declared).map((e) => `- ${e.method} ${e.path} is in the code and in no contract`), ...live.declaredOnly.map((o) => `- ${o.method} ${o.path} is in ${o.contract} and not in the code`)] : [];
  return {
    header,
    sections: [
      { title: 'What it owes', lines: owed },
      { title: 'Interface gaps', lines: gaps },
      { title: 'Tests of its code', lines: tests },
      { title: 'Variables its code reads', lines: vars },
      { title: 'Declared', lines: fields },
      { title: 'Coverage by stage', lines: cov },
      { title: 'Facets', lines: facets, more: 'context <id>' },
      { title: 'Conventions inherited', lines: inherited },
      { title: 'Inside it', lines: kids },
      { title: 'Code anchored', lines: code },
      { title: 'Endpoints in its code', lines: eps },
    ],
  };
}

/** Pieces whose code anchors cover a file, innermost first. */
export function piecesForFile(ws: Workspace, k: Knowledge, repo: string, path: string): Loaded[] {
  const resolve = anchorResolver(ws);
  return k.pieces.filter((p) => (p.anchors ?? []).some((a) => a.startsWith(repo + ':') && (resolve(a) ?? []).includes(path))).sort((a, b) => ancestors(k, b.id).length - ancestors(k, a.id).length);
}
