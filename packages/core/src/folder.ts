/**
 * Folder projects: a directory without git (or without a remote) read through a bare git dir Laru owns,
 * `~/.laru/<app>/shadow/<repo>.git`, with the folder as its work tree. `git add -A` writes only the shadow's index
 * and objects; `git write-tree` gives a content hash, the same for any copy of the same files. Nobody's global
 * config, excludes, attributes, line endings or fsmonitor can change it, and the folder is never written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './git.ts';
import { withLock } from './lock.ts';
import { resolveRef } from './repos.ts';
import { appHome, workspaceKey, WorkspaceError, type RepoConfig, type Workspace } from './workspace.ts';

export const DEFAULT_IGNORE = ['node_modules/', 'target/', 'build/', 'dist/', 'out/', '.gradle/', '.idea/', '.vscode/', '__pycache__/', '.venv/', 'coverage/', '.DS_Store', '*.log', '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template'];
const BIG = 50 * 1024 * 1024;
/** A `.env` that is not an example: never hashed, archived or extracted, whatever the folder's own .gitignore says. */
const SECRET_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/;

export const shadowDir = (ws: Pick<Workspace, 'app'>, repo: string) => join(appHome(ws.app), 'shadow', `${repo}.git`);

/** The environment every git call on a folder runs with: the shadow as GIT_DIR, the folder as work tree, no user config. */
export function shadowEnv(git: string, folder: string): Record<string, string> {
  const config: Array<[string, string]> = [
    ['core.autocrlf', 'false'], ['core.fileMode', 'true'], ['core.symlinks', 'true'], ['core.fsmonitor', 'false'], ['core.untrackedCache', 'false'], ['core.quotePath', 'false'],
    // defaults plus the project's ignore: (see scan); info/exclude holds what a scan found (nested repos, big files)
    ['core.excludesFile', join(git, 'laru-exclude')], ['core.attributesFile', '/dev/null'],
  ];
  return {
    GIT_DIR: git, GIT_WORK_TREE: folder, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(config.length), ...Object.fromEntries(config.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
}

const repoOf = (ws: Workspace, repo: string): RepoConfig => {
  const r = ws.repos.find((x) => x.name === repo);
  if (!r) throw new WorkspaceError(`no repo "${repo}" in laru.yaml`);
  return r;
};

/** Where git runs for a project: a git checkout as it is, a folder through its shadow. */
export function gitOf(ws: Workspace, repo: string): { cwd: string; env: Record<string, string> } {
  const r = repoOf(ws, repo);
  const dir = ws.checkouts[repo];
  if (!dir || !existsSync(dir)) {
    throw new WorkspaceError(r.source === 'folder' ? `carpeta sin enlazar en esta máquina: laru repo link ${repo} <carpeta>` : `repo "${repo}" is not cloned on this machine; run \`laru sync\``);
  }
  return r.source === 'folder' ? { cwd: dir, env: shadowEnv(shadowDir(ws, repo), dir) } : { cwd: dir, env: {} };
}

export interface FolderScan { tree: string; nested: string[]; skipped: string[] }

/** Escapes a path for an exclude file, anchored at the folder's root. */
const exact = (p: string) => '/' + p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ $/, '\\ ');

/**
 * Hashes the folder as it is now, under a lock per shadow (concurrent calls wait). Nested git repos (`git add -A`
 * aborts on one without a commit) and files over 50 MB are left out and reported. When what is ignored changed, the
 * index is rebuilt, so a newly ignored path leaves the tree.
 */
export async function scanFolder(ws: Workspace, repo: string): Promise<FolderScan> {
  const r = repoOf(ws, repo);
  const { cwd, env } = gitOf(ws, repo);
  const dir = env.GIT_DIR;
  return withLock(`hash ${repo}`, async () => {
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(dirname(dir), { recursive: true });
      await git(dirname(dir), ['init', '--bare', '-q', dir], { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    }
    const write = (file: string, text: string) => {
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (prev === text) return false;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      return true;
    };
    let changed = write(join(dir, 'laru-exclude'), [...DEFAULT_IGNORE, ...(r.ignore ?? [])].join('\n') + '\n');
    // Listed without info/exclude (what the last scan found): a nested repo found once must keep being found.
    const listed = (await git(cwd, ['ls-files', '-z', '-co', `--exclude-from=${join(dir, 'laru-exclude')}`, '--exclude-per-directory=.gitignore'], env)).split('\0').filter(Boolean);
    const nested = listed.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)).sort();
    const skipped = listed.filter((p) => !p.endsWith('/')).filter((p) => { try { const st = lstatSync(join(cwd, p)); return st.isFile() && st.size > BIG; } catch { return false; } }).sort();
    changed = write(join(dir, 'info', 'exclude'), [...nested.map((p) => `${exact(p)}/`), ...skipped.map(exact)].join('\n') + '\n') || changed;
    // Tracked but ignored now (the folder's own .gitignore changed) stays tracked by `add -A`: the index is rebuilt.
    if (!changed && (await git(cwd, ['ls-files', '-ci', '--exclude-standard'], env))) changed = true;
    if (changed) rmSync(join(dir, 'index'), { force: true });
    // A .env the folder's own .gitignore re-includes never reaches `add`: its content would sit in the shadow's objects.
    // Known limit: one created between the listing above and `add` slips in until the next gc; a glob pathspec closes it
    await git(cwd, ['add', '-A', '--', '.', ...listed.filter((p) => SECRET_FILE.test(p)).map((p) => `:(exclude,literal)${p}`)], env);
    const secret = (await git(cwd, ['ls-files', '-z'], env)).split('\0').filter((p) => SECRET_FILE.test(p));
    if (secret.length) await git(cwd, ['rm', '-q', '--cached', '--', ...secret], env);
    const tree = await git(cwd, ['write-tree'], env);
    // write-tree skips a tree the shadow already has, however old: written again it is fresh for gc's grace, and what
    // a fresh object reaches (its blobs) stays with it
    const o = { cwd, env: { ...process.env, ...env } };
    execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { ...o, input: execFileSync('git', ['cat-file', 'tree', tree], o) });
    return { tree, nested, skipped };
  }, undefined, `${dir}.lock`);
}

/** The tree hash of a folder project's content now. */
export const treeNow = async (ws: Workspace, repo: string): Promise<string> => (await scanFolder(ws, repo)).tree;

/** What `map` reads: a git project's reference branch, or a folder's content now (`ref` is «carpeta»). */
export async function refOf(ws: Workspace, repo: string): Promise<{ name: string; commit: string }> {
  const r = repoOf(ws, repo);
  if (r.source === 'folder') return { name: 'carpeta', commit: await treeNow(ws, repo) };
  const { cwd } = gitOf(ws, repo);
  const ref = await resolveRef(cwd, r.branch);
  if (!ref) throw new WorkspaceError(`branch "${r.branch}" not found in ${cwd}`, `repos.${repo}.branch`);
  return ref;
}

/**
 * Keeps a folder's tree reachable in its shadow (`refs/laru/<workspace key>/map|lock`; git accepts refs to trees).
 * Per workspace: two workspaces with one app id share the shadow, and one's map must not unpin the other's.
 */
export async function keepTree(ws: Workspace, repo: string, which: 'map' | 'lock', tree: string): Promise<void> {
  const { cwd, env } = gitOf(ws, repo);
  await git(cwd, ['update-ref', `refs/laru/${workspaceKey(ws)}/${which}`, tree], env);
}
