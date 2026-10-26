/**
 * Projects: git repos by URL and branch, or plain folders. Add, link to an existing clone or folder, sync, and report
 * where each one stands. A folder is only ever read (folder.ts).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { gitOf, scanFolder } from './folder.ts';
import { git, normalizeUrl, repoNameFromUrl, tryGit } from './git.ts';
import { appHome, branchError, gitUrlError, saveCheckouts, saveRepo, stateDir, WorkspaceError, type RepoConfig, type RepoRole, type Workspace } from './workspace.ts';

export interface RepoStatus {
  name: string;
  source: 'git' | 'folder';
  title: string;
  url: string;
  branch: string;
  role: RepoRole;
  checkout: string | null;
  /** the checkout is Laru's clone under ~/.laru/<app>/repos */
  managed: boolean;
  /** commit of the reference branch (remote-tracking when there is a remote) */
  ref: string | null;
  refName: string | null;
  localBranch: string | null;
  head: string | null;
  dirty: number;
  /** HEAD relative to the reference branch */
  ahead: number;
  behind: number;
  /** commits on the reference branch since the commit recorded in laru.lock */
  sinceVerified: number | null;
  verified: string | null;
  problem?: string;
  /** folder: the tree the map read, when it read it, files changed since, nested repos and big files left out */
  tree?: string | null;
  readAt?: string | null;
  changed?: number;
  nested?: string[];
  skipped?: string[];
}

const isGitDir = async (dir: string) => (await tryGit(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';

/** `origin/<branch>` when the remote has it, else the local branch. */
export async function resolveRef(checkout: string, branch: string): Promise<{ name: string; commit: string } | null> {
  for (const name of [`origin/${branch}`, branch]) {
    const commit = await tryGit(checkout, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
    if (commit) return { name, commit };
  }
  return null;
}

async function defaultBranch(checkout: string): Promise<string> {
  const head = await tryGit(checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  return (await tryGit(checkout, ['branch', '--show-current'])) || 'main';
}

const managedPath = (ws: Workspace, name: string) => join(appHome(ws.app), 'repos', name);

const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/')); };
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * A directory a project may live in: not `/` or the home folder, not inside the workspace or around it, not inside or
 * around another project's checkout or folder. Each refusal names both paths.
 */
function checkPlace(ws: Workspace, name: string, dir: string) {
  const d = real(dir), root = real(ws.root);
  if (d === '/' || d === real(homedir())) throw new WorkspaceError(`${d} is too wide to be a project; point at its folder`);
  if (inside(d, root) || inside(root, d)) throw new WorkspaceError(`${d} and the workspace ${root} overlap; a project lives outside the workspace`);
  for (const [other, at] of Object.entries(ws.checkouts)) {
    if (other === name || !at) continue;
    const o = real(at);
    if (inside(d, o) || inside(o, d)) throw new WorkspaceError(`${d} overlaps ${other} at ${o}; projects never contain one another`);
  }
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * `source` is a URL (cloned into ~/.laru/<app>/repos/<name>), a folder that is a clone with an `origin` (linked
 * where it is, never moved or copied), or any other folder: a folder project, read as it is now.
 */
export async function addRepo(ws: Workspace, source: string, opts: { name?: string; branch?: string; role?: RepoRole; title?: string; ignore?: string[] } = {}): Promise<RepoConfig> {
  const asDir = resolve(source.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  let url: string, checkout: string;
  if (existsSync(asDir)) {
    if (!statSync(asDir).isDirectory()) throw new WorkspaceError(`${asDir} is not a folder`);
    const remote = (await isGitDir(asDir)) ? await tryGit(asDir, ['remote', 'get-url', 'origin']) : null;
    if (!remote) return addFolder(ws, asDir, opts);
    if (opts.ignore?.length) throw new WorkspaceError('only a folder project ignores paths; this folder is a clone of ' + remote);
    url = remote; checkout = (await git(asDir, ['rev-parse', '--show-toplevel']));
    checkPlace(ws, opts.name ?? '', checkout);
  } else {
    const issue = gitUrlError(source);
    if (issue) throw new WorkspaceError(`${issue}: ${source}`);
    url = source;
    checkout = managedPath(ws, opts.name ?? repoNameFromUrl(source));
  }
  if (opts.branch && branchError(opts.branch)) throw new WorkspaceError(`${branchError(opts.branch)}: ${opts.branch}`);
  const name = opts.name ?? (existsSync(asDir) ? basename(checkout) : repoNameFromUrl(url)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const clash = ws.repos.find((r) => r.name !== name && r.source === 'git' && normalizeUrl(r.url) === normalizeUrl(url));
  if (clash) throw new WorkspaceError(`${url} is already in this workspace as "${clash.name}"`);
  if (!existsSync(checkout)) await clone(url, checkout);
  const repo: RepoConfig = { name, source: 'git', url, branch: opts.branch ?? (await defaultBranch(checkout)), role: opts.role ?? 'service', ...(opts.title ? { title: opts.title } : {}) };
  saveRepo(ws, repo);
  ws.checkouts[name] = checkout;
  saveCheckouts(ws);
  return repo;
}

/** A folder project: its name defaults to the folder's name in kebab-case. Nothing is written in the folder. */
async function addFolder(ws: Workspace, dir: string, opts: { name?: string; branch?: string; role?: RepoRole; title?: string; ignore?: string[] }): Promise<RepoConfig> {
  if (opts.branch) throw new WorkspaceError('a folder project has no branch');
  const name = opts.name ?? kebab(basename(dir));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new WorkspaceError(`"${name}" is not a project name; give one with --name`);
  const taken = ws.repos.find((r) => r.name === name);
  if (taken && taken.source !== 'folder') throw new WorkspaceError(`"${name}" is already a git project here; give another with --name`);
  checkPlace(ws, name, dir);
  const repo: RepoConfig = { name, source: 'folder', url: '', branch: '', role: opts.role ?? 'service', ...(opts.title ? { title: opts.title } : {}), ...(opts.ignore?.length ? { ignore: opts.ignore } : {}) };
  saveRepo(ws, repo);
  ws.checkouts[name] = real(dir);
  saveCheckouts(ws);
  return repo;
}

async function clone(url: string, dir: string) {
  mkdirSync(resolve(dir, '..'), { recursive: true });
  // `--`: whatever the URL says, git reads it as a repository, never as an option
  await git(resolve(dir, '..'), ['clone', '--quiet', '--', url, dir]);
}

/** Points a repo at a clone you already have (refusing a clone of a different remote), or a folder project at its folder. */
export async function linkRepo(ws: Workspace, name: string, dir: string): Promise<void> {
  const repo = ws.repos.find((r) => r.name === name);
  if (!repo) throw new WorkspaceError(`no repo "${name}" in laru.yaml`);
  const abs = resolve(dir.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (repo.source === 'folder') {
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new WorkspaceError(`${abs} is not a folder`);
    checkPlace(ws, name, abs);
    ws.checkouts[name] = real(abs);
    saveCheckouts(ws);
    return;
  }
  if (!(await isGitDir(abs))) throw new WorkspaceError(`${abs} is not a git repository`);
  checkPlace(ws, name, abs);
  const remote = await tryGit(abs, ['remote', 'get-url', 'origin']);
  if (!remote || normalizeUrl(remote) !== normalizeUrl(repo.url)) throw new WorkspaceError(`${abs} is a clone of ${remote ?? 'nothing'}, not of ${repo.url}`);
  ws.checkouts[name] = await git(abs, ['rev-parse', '--show-toplevel']);
  saveCheckouts(ws);
}

/** Clones what is missing, fetches the rest. Never touches a working tree. */
export async function syncRepos(ws: Workspace, opts: { fetch?: boolean } = {}): Promise<RepoStatus[]> {
  for (const repo of ws.repos) {
    if (repo.source === 'folder') continue; // a folder is linked, never cloned or fetched
    const dir = ws.checkouts[repo.name];
    if (!dir || !existsSync(dir)) {
      const target = managedPath(ws, repo.name);
      if (!existsSync(target)) await clone(repo.url, target);
      ws.checkouts[repo.name] = target;
    } else if (opts.fetch !== false) {
      await tryGit(dir, ['fetch', '--quiet', '--prune', 'origin']);
    }
  }
  saveCheckouts(ws);
  return Promise.all(ws.repos.map((r) => repoStatus(ws, r)));
}

export async function repoStatus(ws: Workspace, repo: RepoConfig): Promise<RepoStatus> {
  const checkout = ws.checkouts[repo.name] ?? null;
  const managed = Boolean(checkout && inside(checkout, join(appHome(ws.app), 'repos')));
  const base: RepoStatus = { name: repo.name, source: repo.source, title: repo.title ?? repo.name, url: repo.url, branch: repo.branch, role: repo.role, checkout, managed, ref: null, refName: null, localBranch: null, head: null, dirty: 0, ahead: 0, behind: 0, sinceVerified: null, verified: ws.lock[repo.name] ?? null };
  if (repo.source === 'folder') return folderStatus(ws, repo, base);
  if (!checkout || !existsSync(checkout)) return { ...base, checkout: null, problem: 'not cloned on this machine: run `laru sync`' };
  const ref = await resolveRef(checkout, repo.branch);
  if (!ref) return { ...base, problem: `branch "${repo.branch}" not found` };
  const [head, localBranch, porcelain, counts] = await Promise.all([
    tryGit(checkout, ['rev-parse', 'HEAD']),
    tryGit(checkout, ['branch', '--show-current']),
    tryGit(checkout, ['status', '--porcelain']),
    tryGit(checkout, ['rev-list', '--left-right', '--count', `${ref.commit}...HEAD`]),
  ]);
  const [behind, ahead] = (counts ?? '0\t0').split(/\s+/).map(Number);
  const verified = ws.lock[repo.name];
  const since = verified ? await tryGit(checkout, ['rev-list', '--count', `${verified}..${ref.commit}`]) : null;
  return {
    ...base, ref: ref.commit, refName: ref.name, head, localBranch: localBranch || null,
    dirty: porcelain ? porcelain.split('\n').filter(Boolean).length : 0, ahead, behind,
    sinceVerified: since === null ? null : Number(since),
  };
}

/** A folder: the tree the map read and when, how many files changed since (map tree → now) and since it was verified. */
async function folderStatus(ws: Workspace, repo: RepoConfig, base: RepoStatus): Promise<RepoStatus> {
  if (!base.checkout || !existsSync(base.checkout)) return { ...base, checkout: null, problem: `carpeta sin enlazar en esta máquina: laru repo link ${repo.name} <carpeta>` };
  const { cwd, env } = gitOf(ws, repo.name);
  const scan = await scanFolder(ws, repo.name);
  const extract = join(stateDir(ws), 'extract', `${repo.name}.json`);
  const mapTree = existsSync(extract) ? (JSON.parse(readFileSync(extract, 'utf8')) as { commit?: string }).commit ?? null : null;
  // null when this machine does not hold that tree (verified on another machine)
  const count = async (from: string | null | undefined) => {
    const out = from ? await tryGit(cwd, ['diff-tree', '-r', '--name-only', '--no-renames', from, scan.tree], env) : null;
    return out === null ? null : out.split('\n').filter(Boolean).length;
  };
  const verified = ws.lock[repo.name];
  return {
    ...base, ref: scan.tree, refName: 'carpeta', tree: mapTree, readAt: existsSync(extract) ? statSync(extract).mtime.toISOString() : null,
    changed: (await count(mapTree)) ?? 0, sinceVerified: await count(verified), nested: scan.nested, skipped: scan.skipped,
  };
}
