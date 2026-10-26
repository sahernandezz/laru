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

  // terms → the glossary of the container they live in
  const terms = k.pieces.filter((p) => p.type === 'term' && p.parent);
  for (const parentId of new Set(terms.map((t) => t.parent!))) {
    const parent = k.byId.get(parentId)!;
    const mine = terms.filter((t) => t.parent === parentId);
    const rows: Row[] = mine.map((t) => ({ term: t.title, definition: String(t.fields.definition ?? '').replace(/\s*\n\s*/g, ' '), synonyms: ((t.fields.synonyms as string[]) ?? []).join(', '), code: ((t.fields['in-code'] as string[]) ?? []).join(', '), context: '' }));
    const existing = k.pieces.find((p) => p.type === 'glossary' && p.parent === parentId);
    if (existing) edit(existing, (x) => { x.fields.terms = [...((x.fields.terms as Row[]) ?? []), ...rows]; });
    else {
      const title = lang === 'es' ? 'Glosario' : 'Glossary';
      const g: Loaded = {
        id: `gls:${slugify(title)}${parentId === k.pieces.find((p) => p.type === 'application')?.id ? '' : `-${parentId.split(':')[1]}`}`, type: 'glossary', title, status: 'active', owner: mine[0].owner,
        summary: lang === 'es' ? 'Las palabras de la aplicación y lo que significan, con los nombres que toman en el código.' : 'The words of the application and what they mean, with the names they take in the code.',
        fields: { terms: rows }, path: join(parent.dir, 'glossary', `${slugify(title)}${parentId === k.pieces.find((p) => p.type === 'application')?.id ? '' : `-${parentId.split(':')[1]}`}.md`), dir: '', parent: parentId, source: '',
      };
      edited.set(g.id, g);
      report.created.push(g.path);
    }
    for (const t of mine) { removes.push(t.path); report.removed.push(t.path); }
  }

  // notes → known traps of their service or repository
  for (const n of k.pieces.filter((p) => p.type === 'note' && p.parent)) {
    const parent = k.byId.get(n.parent!)!;
    const host = pieceOf(parent);
    const field = STANDARD[parent.type].fields.find((f) => f.name === 'gotchas');
    const list = (host.fields.gotchas as string[] | undefined) ?? [];
    if (!field || (field.max && list.length >= field.max)) { report.kept.push(`${n.path}: a ${parent.type} has no room for it as a known trap`); continue; }
    edit(parent, (x) => { x.fields.gotchas = [...list, `${n.title}: ${String(n.fields.body ?? '').replace(/\s*\n\s*/g, ' ')}`]; });
    removes.push(n.path); report.removed.push(n.path);
  }

  // runbooks → guides of the application that name what they operate, so the operate stage still finds them
  const home = k.pieces.find((p) => p.type === 'application');
  const renamed = new Map<string, string>();
  for (const r of k.pieces.filter((p) => p.type === 'runbook')) {
    if (!home) { report.kept.push(`${r.path}: the application is missing, so its guide has no home`); continue; }
    const es = lang === 'es', list = (x: unknown) => ((x as string[] | undefined) ?? []);
    const one = (x: unknown) => String(x ?? '').replace(/\s*\n\s*/g, ' ').trim();
    const slug = slugify(r.title);
    const guide: Loaded = {
      id: `guide:${slug}`, type: 'guide', title: r.title, status: r.status, owner: r.owner, summary: r.summary, parent: home.id, dir: '', source: '',
      path: join(home.dir, 'guides', `${slug}.md`),
      // what the runbook said about itself (relations, meta, the code it was anchored to) goes with it
      ...(r.relations ? { relations: r.relations } : {}), ...(r.meta ? { meta: r.meta } : {}), ...(r.anchors ? { anchors: r.anchors } : {}),
      fields: {
        goal: `${es ? 'Dejar' : 'Get'} [[${r.parent ?? home.id}]] ${es ? 'funcionando otra vez.' : 'working again.'}`,
        steps: [
          ...list(r.fields.requirements).map((x) => `${es ? 'Antes' : 'Before'}: ${x}`),
          ...list(r.fields.diagnosis).map((x) => `${es ? 'Diagnóstico' : 'Diagnosis'}: ${x}`),
          ...list(r.fields.fix).map((x) => `${es ? 'Arreglo' : 'Fix'}: ${x}`),
          ...(r.fields.escalation ? [`${es ? 'Escalado' : 'Escalation'}: ${one(r.fields.escalation)}`] : []),
          ...list(r.fields.verify).map((x) => `${es ? 'Comprobar' : 'Check'}: ${x}`),
        ],
        ...(list(r.fields.symptoms).length ? { troubleshooting: list(r.fields.symptoms).map((symptom) => ({ symptom, fix: es ? 'Seguir los pasos de diagnóstico y arreglo de esta guía.' : 'Follow the diagnosis and fix steps of this guide.' })) } : {}),
      },
    };
    if (k.byId.has(guide.id) || edited.has(guide.id)) { report.kept.push(`${r.path}: ${guide.id} already exists`); continue; }
    edited.set(guide.id, guide); report.created.push(guide.path);
    removes.push(r.path); report.removed.push(r.path);
    renamed.set(r.id, guide.id);
  }
  // whoever pointed at a runbook now points at its guide: `[[rb:x]]`, a relation, a meta link
  const retarget = <T,>(x: T): T => { let t = JSON.stringify(x); for (const [from, to] of renamed) t = t.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), to); return JSON.parse(t) as T; };
  // the new guides too: a runbook may have pointed at another runbook
  for (const id of renamed.values()) { const g = edited.get(id)!; g.fields = retarget(g.fields); if (g.meta) g.meta = retarget(g.meta); if (g.relations) g.relations = retarget(g.relations); }
  if (renamed.size) for (const p of k.pieces) {
    if (removes.includes(p.path) || p.type === 'runbook') continue;
    const now = pieceOf(p);
    if ([...renamed.keys()].some((id) => JSON.stringify([now.fields, now.meta, now.relations]).includes(id))) {
      edit(p, (x) => { x.fields = retarget(x.fields); if (x.meta) x.meta = retarget(x.meta); if (x.relations) x.relations = retarget(x.relations); });
    }
  }

  // «In production» rows of an external or a runbook → the application's infrastructure («Production aspects»)
  const app = k.pieces.find((p) => p.type === 'application');
  const withRows = k.pieces.filter((p) => (p.type === 'external' || p.type === 'runbook') && Array.isArray(p.fields.production) && p.fields.production.length);
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
    const moved = (t: string) => { for (const [from, to] of renamed) t = t.split(from).join(to); return t; };
    for (const s of segments(old.source)) if (!after.includes(moved(s).replace(/\s+/g, ' '))) report.lost.push(`${path}: ${s.slice(0, 80)}`);
  }

  if (!opts.dryRun && !report.lost.length) {
    for (const [path, text] of writes) { const abs = join(ws.root, path); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }
    for (const path of removes) { const abs = join(ws.root, path); rmSync(abs, { force: true }); const dir = dirname(abs); if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir); }
  }
  return report;
}
