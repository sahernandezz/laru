/**
 * The documentation tree on disk. The folder is the containment: a container is `<folder>/<slug>/<type>.md`
 * inside its parent's folder, and a facet is `<facet folder>/<slug>.md` (a flow, `flows/<slug>/flow.md`,
 * because its test lives next to it). There is no `parent:` field that could contradict the folders.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadExtraction } from '../extract.ts';
import { stateDir, type Workspace } from '../workspace.ts';
import { parsePiece, type Piece } from './piece.ts';
import { CONTAINER_BY_FOLDER, FACET_BY_FOLDER, isContainer, OWN_FOLDER, STANDARD, type ContainerType, type PieceType } from './standard.ts';

export const DOCS_DIR = 'docs';
/** The working agreement is each person's: in the workspace's state folder, which git ignores, not in docs/. */
export const AGREEMENT_FILE = 'agreement.md';
export const agreementPath = (ws: Pick<Workspace, 'root'>) => relative(ws.root, join(stateDir(ws), AGREEMENT_FILE));

export interface Loaded extends Piece {
  /** file, relative to the workspace root */
  path: string;
  /** folder that holds the piece's children (containers) or the piece itself (flows) */
  dir: string;
  parent: string | null;
  source: string;
}
export interface FileIssue { level: 'error' | 'warning'; path: string; at: string; key: string; message: string }
export interface Knowledge { pieces: Loaded[]; byId: Map<string, Loaded>; issues: FileIssue[] }

export function loadKnowledge(ws: Workspace): Knowledge {
  const root = join(ws.root, DOCS_DIR);
  const pieces: Loaded[] = [];
  const issues: FileIssue[] = [];
  const rel = (p: string) => relative(ws.root, p);
  const read = (file: string, dir: string, parent: string | null, expect: PieceType) => {
    const source = readFileSync(file, 'utf8');
    const { piece, issues: pi } = parsePiece(source);
    for (const i of pi) issues.push({ level: 'error', path: rel(file), ...i });
    if (!piece) return null;
    if (piece.type !== expect) issues.push({ level: 'error', path: rel(file), at: 'type', key: 'misplaced', message: `this folder holds a ${expect}, the file says ${piece.type}` });
    const loaded: Loaded = { ...piece, path: rel(file), dir: rel(dir), parent, source };
    pieces.push(loaded);
    return loaded;
  };
  const subdirs = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith('.') && statSync(join(d, n)).isDirectory()) : []);

  const walk = (dir: string, owner: Loaded) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      const isDir = statSync(full).isDirectory();
      if (!isDir) {
        if (name !== `${owner.type}.md`) issues.push({ level: 'warning', path: rel(full), at: 'path', key: 'misplaced', message: `files beside ${owner.type}.md are not read; facets live in their folder (decisions/, contracts/…)` });
        continue;
      }
      const ctype = CONTAINER_BY_FOLDER[name];
      const ftype = FACET_BY_FOLDER[name];
      if (ctype) {
        for (const slug of subdirs(full)) {
          const d = join(full, slug), file = join(d, `${ctype}.md`);
          if (!existsSync(file)) { issues.push({ level: 'error', path: rel(d), at: 'path', key: 'missing-file', message: `${rel(d)} needs a ${ctype}.md` }); continue; }
          const child = read(file, d, owner.id, ctype);
          if (child) walk(d, child);
        }
      } else if (ftype && OWN_FOLDER.includes(ftype)) {
        for (const slug of subdirs(full)) {
          const file = join(full, slug, `${ftype}.md`);
          if (existsSync(file)) read(file, join(full, slug), owner.id, ftype);
          else issues.push({ level: 'error', path: rel(join(full, slug)), at: 'path', key: 'missing-file', message: `a ${ftype} folder needs its ${ftype}.md` });
        }
      } else if (ftype) {
        for (const f of readdirSync(full)) if (f.endsWith('.md')) read(join(full, f), full, owner.id, ftype);
      } else issues.push({ level: 'warning', path: rel(full), at: 'path', key: 'misplaced', message: `"${name}" is neither a container folder nor a facet folder of a ${owner.type}` });
    }
  };

  const appFile = join(root, 'application.md');
  if (existsSync(appFile)) {
    const app = read(appFile, root, null, 'application');
    if (app) walk(root, app);
    // the person's own working agreement, beside the documentation but never in git
    const own = join(ws.root, agreementPath(ws));
    if (app && existsSync(own)) read(own, join(own, '..'), app.id, 'agreement');
  } else if (existsSync(root) && readdirSync(root).some((n) => !n.startsWith('.'))) {
    issues.push({ level: 'error', path: DOCS_DIR, at: 'path', key: 'missing-file', message: 'docs/ needs an application.md at its root' });
  }

  const byId = new Map<string, Loaded>();
  for (const p of pieces) {
    const prev = byId.get(p.id);
    if (prev) issues.push({ level: 'error', path: p.path, at: 'id', key: 'duplicate-id', message: `"${p.id}" is also used by ${prev.path}` });
    else byId.set(p.id, p);
  }
  return { pieces, byId, issues };
}

export const childrenOf = (k: Knowledge, id: string) => k.pieces.filter((p) => p.parent === id);
export function ancestors(k: Knowledge, id: string): Loaded[] {
  const out: Loaded[] = [];
  for (let p = k.byId.get(id); p?.parent; p = k.byId.get(p.parent)) { const parent = k.byId.get(p.parent); if (parent) out.unshift(parent); }
  return out;
}
export const containerOf = (k: Knowledge, id: string): { id: string; type: ContainerType } | null => {
  const p = k.byId.get(id);
  return p && isContainer(p.type) ? { id: p.id, type: p.type } : null;
};

/* ------------------------------ code anchors ------------------------------ */

// A glob such as `src/**/refund/*.java` as a regex: `**` crosses folders, `*` and `?` stay inside one.
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { const slash = glob[i + 2] === '/'; re += slash ? '(?:.*/)?' : '.*'; i += slash ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Whether an anchor covers one file of a repo: one it matches at the reference branch, or one its path or glob names
 * that is not there yet (a file the working copy just added), so a new file is ruled like the old ones next to it.
 */
export function anchorCovers(resolve: (anchor: string) => string[] | undefined, anchor: string, repo: string, path: string): boolean {
  const m = anchor.match(/^([a-z0-9][a-z0-9-]*):([^#\s]+)/);
  if (!m || m[1] !== repo) return false;
  const glob = m[2].replace(/\/$/, '/**');
  return (resolve(anchor) ?? []).includes(path) || globRe(glob).test(path) || glob === path;
}

/** Files an anchor matches at the reference branch; undefined when the repo is not in the workspace. */
export function anchorResolver(ws: Workspace): (anchor: string) => string[] | undefined {
  const trees = new Map<string, Record<string, string> | null>();
  return (anchor) => {
    const m = anchor.match(/^([a-z0-9][a-z0-9-]*):([^#\s]+)/);
    if (!m || !ws.repos.some((r) => r.name === m[1])) return undefined;
    if (!trees.has(m[1])) trees.set(m[1], loadExtraction(ws, m[1])?.tree ?? null);
    const tree = trees.get(m[1]);
    if (!tree) return [];
    const path = m[2].replace(/\/$/, '/**');
    const re = globRe(path);
    return Object.keys(tree).filter((f) => re.test(f) || f === path);
  };
}

/** What the anchored code looks like now: a hash over every anchored file's blob, and the commit of each repo. */
export function fingerprint(ws: Workspace, anchors: string[]): { fingerprint: string; commits: Record<string, string>; files: number } {
  const h = createHash('sha1');
  const commits: Record<string, string> = {};
  let files = 0;
  const resolve = anchorResolver(ws);
  for (const a of [...anchors].sort()) {
    const repo = a.split(':')[0];
    const ex = loadExtraction(ws, repo);
    if (!ex) continue;
    commits[repo] = ex.commit.slice(0, 7);
    for (const f of (resolve(a) ?? []).sort()) { h.update(`${repo}:${f}:${ex.tree[f]}\n`); files++; }
  }
  return { fingerprint: h.digest('hex').slice(0, 12), commits, files };
}

export type Freshness = 'fresh' | 'stale' | 'unverified' | 'none';
export function freshness(ws: Workspace, p: Piece): Freshness {
  if (!p.anchors?.length) return 'none';
  if (!p.verified) return 'unverified';
  return fingerprint(ws, p.anchors).fingerprint === p.verified.fingerprint ? 'fresh' : 'stale';
}

