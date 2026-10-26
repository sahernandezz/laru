/**
 * The three edits that are not a write: a piece that does not exist yet (`new`), one that changes container
 * (`move`) and one that changes its id (`rename`). The folder is the containment, so each is a rename on disk;
 * `rename` also rewrites every reference to the old id.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Graph } from '../graph.ts';
import type { Workspace } from '../workspace.ts';
import { containerOf, loadKnowledge, type Loaded } from './store.ts';
import { isContainer, OWN_FOLDER, STANDARD, type PieceType } from './standard.ts';
import { knowledgeWrite, slugify, type WriteResult } from './write.ts';

const fail = (id: string, key: string, message: string): WriteResult => ({ ok: false, id, issues: [{ level: 'error', at: 'id', key, message }] });

/** A piece with its title and nothing else: the note says what it still owes. Its place is its container's folder. */
export function newPiece(ws: Workspace, g: Graph | null, input: { type: PieceType; title: string; in?: string; kind?: string }): WriteResult {
  const std = STANDARD[input.type];
  if (!std) return fail('', 'unknown-type', `unknown type "${input.type}"`);
  const app = loadKnowledge(ws).pieces.find((p) => p.type === 'application');
  const parent = input.in ?? (input.type !== 'application' && std.livesIn.includes('application') ? app?.id : undefined);
  return knowledgeWrite(ws, { type: input.type, title: input.title, in: parent, kind: input.kind ?? std.kinds?.[0], summary: input.title, fields: {} }, g);
}

const holds = (p: Loaded) => (isContainer(p.type) || OWN_FOLDER.includes(p.type) ? dirname(join(p.path)) : p.path);

export function movePiece(ws: Workspace, id: string, to: string): WriteResult {
  const k = loadKnowledge(ws);
  const p = k.byId.get(id), isBox = containerOf(k, to), target = isBox ? k.byId.get(to) : undefined;
  if (!p) return fail(id, 'unknown-ref', `no piece "${id}"`);
  if (p.type === 'application') return fail(id, 'wrong-parent', 'the application is the root');
  if (!target || !isBox) return fail(id, 'unknown-ref', `"${to}" is not a documented container`);
  if (!STANDARD[p.type].livesIn.includes(target.type as never)) return fail(id, 'wrong-parent', `a ${p.type} cannot live in a ${target.type}; it lives in ${STANDARD[p.type].livesIn.join(' or ')}`);
  if (p.parent === to) return { ok: true, id, path: p.path, issues: [] };
  if (target.id === id || target.dir.startsWith(`${p.dir}/`)) return fail(id, 'wrong-parent', 'a piece cannot move inside itself');
  const std = STANDARD[p.type];
  const src = holds(p);
  const dest = join(target.dir, std.folder, basename(src));
  if (existsSync(join(ws.root, dest))) return fail(id, 'duplicate-id', `${dest} already exists`);
  mkdirSync(dirname(join(ws.root, dest)), { recursive: true });
  renameSync(join(ws.root, src), join(ws.root, dest));
  const emptied = join(ws.root, dirname(src));
  if (existsSync(emptied) && !readdirSync(emptied).length) rmdirSync(emptied);
  return { ok: true, id, path: isContainer(p.type) || OWN_FOLDER.includes(p.type) ? join(dest, basename(p.path)) : dest, issues: [] };
}

/** `mod:pagos` → `mod:cobros`: the folder or file, the id in its frontmatter and every reference to it. */
export function renamePiece(ws: Workspace, id: string, slug: string): WriteResult & { rewritten?: number } {
  const k = loadKnowledge(ws);
  const p = k.byId.get(id);
  if (!p) return fail(id, 'unknown-ref', `no piece "${id}"`);
  if (p.type === 'application' || OWN_FOLDER.includes(p.type)) return fail(id, 'not-supported', `a ${p.type} keeps its id: its tests and evidence are filed under it`);
  const next = `${STANDARD[p.type].prefix}:${slugify(slug)}`;
  if (k.byId.has(next)) return fail(id, 'duplicate-id', `"${next}" already exists`);
  const re = new RegExp(`(?<![\\w.:-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g');
  let rewritten = 0;
  for (const q of k.pieces) {
    const text = q.source.replace(re, next);
    if (text !== q.source) { writeFileSync(join(ws.root, q.path), text); rewritten++; }
  }
  const newSlug = next.split(':')[1];
  const src = holds({ ...p, path: p.path });
  const dest = isContainer(p.type) ? join(dirname(src), newSlug) : join(dirname(src), `${newSlug}.md`);
  if (existsSync(join(ws.root, dest))) return fail(id, 'duplicate-id', `${dest} already exists`);
  renameSync(join(ws.root, src), join(ws.root, dest));
  return { ok: true, id: next, path: isContainer(p.type) ? join(dest, basename(p.path)) : dest, issues: [], rewritten };
}
