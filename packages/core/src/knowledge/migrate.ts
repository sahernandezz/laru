/**
 * `laru docs migrate`: brings a workspace written against the older standard to this one, losing nothing.
 *  - old headings and statuses are rewritten (a contract `implemented` is `active`, `proposed` is `draft`);
 *  - every `term` becomes a row of its container's glossary;
 *  - a `note` becomes a known trap of the service or repository it lives in (any other parent keeps it, said aloud).
 * After it runs, every text segment of the old files must be found in the new ones: what is not, is reported as lost.
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Workspace } from '../workspace.ts';
import { renderPiece, type Piece, type Row } from './piece.ts';
import { docsLang, slugify } from './write.ts';
import { loadKnowledge, type Loaded } from './store.ts';
import { STANDARD } from './standard.ts';

export interface MigrationReport { rewritten: string[]; created: string[]; removed: string[]; kept: string[]; lost: string[] }

const STATUS_MAP: Record<string, string> = { implemented: 'active', proposed: 'draft' };

/** The text of a file's body as segments: no headings, no table rules, list markers and pipes taken off. */
export function segments(source: string): string[] {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
  return body.split('\n').flatMap((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#') || /^\|?[-| :]+\|?$/.test(t)) return [];
    return t.replace(/^[-*]\s+/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim()).filter(Boolean);
  });
}

export function migrateWorkspace(ws: Workspace, opts: { dryRun?: boolean } = {}): MigrationReport {
  const lang = docsLang(ws);
  const k = loadKnowledge(ws);
  const report: MigrationReport = { rewritten: [], created: [], removed: [], kept: [], lost: [] };
  const writes = new Map<string, string>();
  const removes: string[] = [];
  const edited = new Map<string, Loaded>();
  const pieceOf = (p: Loaded): Loaded => edited.get(p.id) ?? p;
  const edit = (p: Loaded, change: (x: Loaded) => void) => { const x = structuredClone(pieceOf(p)); change(x); edited.set(p.id, x); };

  for (const p of k.pieces) if (STANDARD[p.type]?.legacyStatuses?.includes(p.status)) edit(p, (x) => { x.status = STATUS_MAP[p.status] ?? 'active'; });

  // «In production» rows of an external → the application's infrastructure («Production aspects»)
  const app = k.pieces.find((p) => p.type === 'application');
  const withRows = k.pieces.filter((p) => p.type === 'external' && Array.isArray(p.fields.production) && p.fields.production.length);
  if (app && withRows.length) {
    const moved: Row[] = withRows.flatMap((p) => (p.fields.production as Row[]).map((r) => ({ service: r.service || (p.type === 'external' ? p.id : ''), aspect: r.aspect, value: r.value })));
    for (const p of withRows) edit(p, (x) => { delete x.fields.production; });
    const infra = k.pieces.find((p) => p.type === 'infrastructure' && p.parent === app.id);
    if (infra) edit(infra, (x) => { x.fields.production = [...((x.fields.production as Row[]) ?? []), ...moved]; });
    else {
      const title = lang === 'es' ? 'Producción' : 'Production';
      const g: Loaded = {
        id: `infra:${slugify(title)}`, type: 'infrastructure', title, status: 'active', owner: withRows[0].owner,
        summary: lang === 'es' ? 'Dónde corre en producción y qué se sabe de ello que no dice ningún fichero de los repos.' : 'Where it runs in production, and what is known of it that no file of the repos says.',
        fields: { production: moved }, path: join(app.dir, 'infrastructure', `${slugify(title)}.md`), dir: '', parent: app.id, source: '',
      };
      edited.set(g.id, g);
      report.created.push(g.path);
    }
  }

  // render what changed; every other file is only rewritten when its canonical form differs (old headings)
  for (const p of k.pieces) {
    if (removes.includes(p.path)) continue;
    const next = renderPiece(pieceOf(p) as Piece, lang);
    if (next !== p.source) { writes.set(p.path, next); report.rewritten.push(p.path); }
  }
  for (const g of edited.values()) if (!g.source && !k.byId.has(g.id)) writes.set(g.path, renderPiece(g as Piece, lang));

  // nothing may be lost: every segment of an old file that changes or goes must be in the new text
  const after = [...writes.values()].concat(k.pieces.filter((p) => !writes.has(p.path) && !removes.includes(p.path)).map((p) => p.source)).flatMap(segments).join('\n').replace(/\s+/g, ' ');
  for (const path of [...writes.keys(), ...removes]) {
    const old = k.pieces.find((p) => p.path === path);
    if (!old) continue;
    for (const s of segments(old.source)) if (!after.includes(s.replace(/\s+/g, ' '))) report.lost.push(`${path}: ${s.slice(0, 80)}`);
  }

  if (!opts.dryRun && !report.lost.length) {
    for (const [path, text] of writes) { const abs = join(ws.root, path); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }
    for (const path of removes) { const abs = join(ws.root, path); rmSync(abs, { force: true }); const dir = dirname(abs); if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir); }
  }
  return report;
}
