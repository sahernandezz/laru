/**
 * The workspaces this machine knows: `~/.laru/workspaces.yaml`. Machine-local, never versioned; removing one never
 * deletes a file. `app` and `title` are read live from each `laru.yaml`. A workspace's id is given once, when it
 * is registered, and kept: its app id, or `<app>~<key4>` when another workspace holds that id. Roots are kept with
 * symlinks resolved.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { withLock } from './lock.ts';
import { configFile, findWorkspace, isWorkspace, laruHome, loadWorkspace, workspaceKey, WorkspaceError } from './workspace.ts';

export interface Registered { root: string; addedAt: string; openedAt?: string; id?: string }

const file = () => join(laruHome(), 'workspaces.yaml');
const HEADER = '# Workspaces this machine knows. Machine-local, never versioned. Removing one never deletes files.\n';

/** A path with symlinks resolved; one that does not exist yet keeps its missing part under its deepest real folder. */
export function realRoot(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { const up = dirname(abs); return up === abs ? abs : join(realRoot(up), basename(abs)); }
}

export function loadRegistry(): Registered[] {
  if (!existsSync(file())) return [];
  const raw = parse(readFileSync(file(), 'utf8')) as unknown;
  return withIds(Array.isArray(raw) ? raw.filter((x) => typeof x?.root === 'string').map((x) => ({ root: realRoot(x.root), addedAt: String(x.addedAt ?? ''), ...(x.openedAt ? { openedAt: String(x.openedAt) } : {}), ...(typeof x.id === 'string' ? { id: x.id } : {}) })) : []);
}

/**
 * A row keeps the id it was given while its laru.yaml keeps that app id (or cannot be read: an unmounted folder
 * keeps its id taken). One without (new, written before ids were kept, or whose app changed) takes its app id when no
 * other row holds it, else `<app>~<key>`: adding a twin never moves the first one's links, and removing one never
 * moves the other's. A root without a laru.yaml to read and no id gets none until it has one.
 */
function withIds(list: Registered[]): Registered[] {
  const apps = list.map((x) => appOf(x.root));
  const kept = (x: Registered, app: string | null) => Boolean(x.id && (!app || x.id === app || x.id.startsWith(`${app}~`)));
  const taken = new Set(list.flatMap((x, i) => (kept(x, apps[i]) ? [x.id!] : [])));
  return list.map((x, i) => {
    const app = apps[i];
    if (kept(x, app)) return x;
    if (!app) { const { id: _gone, ...rest } = x; return rest; }
    const key = workspaceKey({ root: x.root });
    let id = app;
    for (let n = 4; taken.has(id) && n <= key.length; n += 2) id = `${app}~${key.slice(0, n)}`;
    taken.add(id);
    return { ...x, id };
  });
}

/** Every write: read, change, write a temp file and rename it over, under the registry's lock (several processes write). */
async function edit(fn: (list: Registered[]) => Registered[] | null): Promise<void> {
  await withLock('registry', async () => {
    const next = fn(loadRegistry());
    if (!next) return;
    mkdirSync(laruHome(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, HEADER + stringify(withIds(next)));
    renameSync(tmp, file());
  }, undefined, join(laruHome(), 'locks', 'registry.lock'));
}

/** The app id in a root's laru.yaml, or null when there is none to read. */
export function appOf(root: string): string | null {
  try { return String((parse(readFileSync(configFile(root), 'utf8')) as { app?: unknown } | null)?.app ?? '') || null; } catch { return null; }
}

const real = realRoot;
const same = (root: string) => { const r = real(root); return (x: Registered) => x.root === r; };

/** Adds a root when it is missing (no write when it is listed). `twin`: an earlier registered workspace has its app id. */
export async function register(root: string): Promise<{ added: boolean; twin?: string }> {
  const r = real(root), mine = same(r);
  if (loadRegistry().some(mine)) return { added: false };
  let added = false;
  await edit((list) => { if (list.some(mine)) return null; added = true; return [...list, { root: r, addedAt: new Date().toISOString() }]; });
  const app = appOf(r);
  return { added, ...(added && app && loadRegistry().some((x) => !mine(x) && appOf(x.root) === app) ? { twin: app } : {}) };
}

export const touch = (root: string) => { const mine = same(root); return edit((list) => (list.some(mine) ? list.map((x) => (mine(x) ? { ...x, openedAt: new Date().toISOString() } : x)) : null)); };
export const unregister = (root: string) => { const mine = same(root); return edit((list) => (list.some(mine) ? list.filter((x) => !mine(x)) : null)); };

/** The id in URLs and `--ws`: the one its row has (see withIds), or the one it would get. Null without a laru.yaml. */
export function idOf(root: string, all = loadRegistry()): string | null {
  if (!appOf(root)) return null;
  const r = real(root);
  return (all.find((x) => x.root === r) ?? withIds([...all, { root: r, addedAt: '' }]).at(-1)!).id ?? null;
}

/** The root of the workspace with this id; null when none has it or its laru.yaml is gone (the screen says so). */
export const resolveId = (id: string, all = loadRegistry()): string | null => all.find((x) => x.id === id && appOf(x.root))?.root ?? null;

const inside = (a: string, b: string) => a === b || a.startsWith(b + '/');

/** Registered workspaces one of whose projects (clone or folder) holds `cwd`. */
export function byCwd(cwd: string, all = loadRegistry()): string[] {
  const at = real(cwd);
  return all.filter((x) => {
    // only the projects its laru.yaml names: checkouts.yaml can remember one that was removed
    try { const w = loadWorkspace(x.root); return w.repos.some((r) => w.checkouts[r.name] && inside(at, real(w.checkouts[r.name]))); } catch { return false; }
  }).map((x) => x.root);
}

const tilde = (p: string) => (p.startsWith(homedir() + '/') ? `~${p.slice(homedir().length)}` : p);

/**
 * The workspace a command means: `-C <dir>`, then `--ws <id|root>`, then LARU_WORKSPACE, then a laru.yaml above
 * the current directory, then the one registered workspace whose project holds it. Otherwise an error naming them all.
 */
export const resolveRoot = (o: { dir?: string; ws?: string; env?: string; cwd: string }): string => real(rootFor(o)); // one key per folder, however it is reached

function rootFor(o: { dir?: string; ws?: string; env?: string; cwd: string }): string {
  if (o.dir) { const r = findWorkspace(o.dir); if (!r) throw new WorkspaceError(`not inside a Laru workspace: ${o.dir}`); return r; }
  const all = loadRegistry();
  const known = () => all.map((x) => `${idOf(x.root, all) ?? '?'} (${tilde(x.root)})`).join(', ');
  for (const named of [o.ws, o.env]) {
    if (!named) continue;
    const r = resolveId(named, all) ?? (isWorkspace(resolve(o.cwd, named)) ? resolve(o.cwd, named) : null);
    if (!r) throw new WorkspaceError(`no workspace "${named}"${all.length ? `; known: ${known()}` : ''}`);
    return r;
  }
  const up = findWorkspace(o.cwd);
  if (up) return up;
  const hits = byCwd(o.cwd, all);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new WorkspaceError(`${tilde(o.cwd)} is a project of several workspaces: ${hits.map(tilde).join(', ')}. Use --ws <id>`);
  throw new WorkspaceError(all.length ? `not inside a Laru workspace; known: ${known()}. Use --ws <id>` : 'not inside a Laru workspace; run `laru init` or cd into one');
}
