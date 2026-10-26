/**
 * A repo as an environment sees it: a read-only copy of one commit (`git archive`), or of the working copy
 * (tracked and untracked, never ignored files) when the env builds from `worktree`. The checkout is never
 * written: no checkout, no index refresh (GIT_OPTIONAL_LOCKS=0), no objects created. A folder project is always its
 * content now: `git archive` of the tree its shadow index hashed (core's folder.ts).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { appHome, git, gitOf, treeNow, WorkspaceError, type Workspace } from '@laru/core';

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

export interface Snapshot {
  repo: string;
  /** commit for a ref (a folder's tree hash); `wt-<hash12>` for a working copy */
  id: string;
  commit?: string;
  folder?: boolean;
  dir: string;
  worktree: boolean;
}

/** `worktree`, a branch or a commit, resolved against the repo's checkout. Default: the reference branch. */
export async function resolveEnvRef(ws: Workspace, repo: string, ref: string | undefined): Promise<{ commit?: string; worktree: boolean; label: string; folder?: boolean }> {
  const r = ws.repos.find((x) => x.name === repo);
  const checkout = ws.checkouts[repo];
  if (r?.source === 'folder') {
    // a folder has one state, its content now: `worktree` builds that too; a branch or commit cannot exist
    if (ref && ref !== 'worktree') throw new WorkspaceError('a folder has no branches or commits; remove it', `refs.${repo}`);
    return { commit: await treeNow(ws, repo), worktree: false, label: 'carpeta', folder: true };
  }
  if (!r || !checkout) throw new WorkspaceError(`repo "${repo}" is not cloned on this machine; run \`laru sync\``);
  if (ref === 'worktree') return { worktree: true, label: 'worktree' };
  for (const name of ref ? [ref, `origin/${ref}`] : [`origin/${r.branch}`, r.branch]) {
    const c = await git(checkout, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).catch(() => '');
    if (c) return { commit: c, worktree: false, label: name };
  }
  throw new WorkspaceError(`"${ref ?? r.branch}" is not a branch or commit of ${repo}`, `refs.${repo}`);
}

/** Copies a commit (or the working copy) into ~/.laru/<app>/snapshots/<repo>@<id>/, once; marked complete at the end. */
export async function snapshotRepo(ws: Workspace, repo: string, at: { commit?: string; worktree: boolean; folder?: boolean }): Promise<Snapshot> {
  const checkout = ws.checkouts[repo];
  const base = join(appHome(ws.app), 'snapshots');
  if (!at.worktree) {
    const id = at.commit!;
    const dir = join(base, `${repo}@${id.slice(0, 7)}`);
    if (!existsSync(join(dir, '.ks-complete'))) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // git archive streams the tree of one commit (a folder's: through its shadow); tar unpacks it. Nothing touches the checkout.
      await run('sh', ['-c', `git -C "$0" archive --format=tar "$1" | tar -x -C "$2"`, checkout, id, dir], { env: { ...gitEnv, ...gitOf(ws, repo).env }, maxBuffer: 1024 * 1024 });
      writeFileSync(join(dir, '.ks-complete'), id);
    }
    return { repo, id, commit: id, dir, worktree: false, ...(at.folder ? { folder: true } : {}) };
  }
  const files = (await git(checkout, ['ls-files', '-z', '-co', '--exclude-standard'])).split('\0').filter(Boolean);
  const h = createHash('sha1');
  const kept: string[] = [];
  for (const f of files.sort()) {
    const abs = join(checkout, f);
    if (!existsSync(abs)) continue; // deleted in the working copy
    const st = statSync(abs);
    if (!st.isFile()) continue;
    if (st.size > 50 * 1024 * 1024) continue; // Known limit: files over 50 MB are skipped from worktree builds
    h.update(`${f}\0${st.size}\0${st.mtimeMs}\0`);
    kept.push(f);
  }
  const id = `wt-${h.digest('hex').slice(0, 12)}`;
  const dir = join(base, `${repo}@${id}`);
  if (!existsSync(join(dir, '.ks-complete'))) {
    rmSync(dir, { recursive: true, force: true });
    for (const f of kept) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(checkout, f), join(dir, f)); }
    writeFileSync(join(dir, '.ks-complete'), id);
    pruneWorktreeSnapshots(base, repo, 3);
  }
  return { repo, id, dir, worktree: true };
}

function pruneWorktreeSnapshots(base: string, repo: string, keep: number) {
  const mine = readdirSync(base).filter((d) => d.startsWith(`${repo}@wt-`)).map((d) => ({ d, t: statSync(join(base, d)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { d } of mine.slice(keep)) rmSync(join(base, d), { recursive: true, force: true });
}

/**
 * The key an image is tagged with: what is inside its build context (the tree hash at a commit, or a hash of the
 * snapshot files for a working copy), the Dockerfile override and the build args. Same key, same image: no rebuild.
 */
export async function contextKey(ws: Workspace, snap: Snapshot, contextRel: string, extra: string): Promise<string> {
  const h = createHash('sha1');
  if (snap.commit) {
    const { cwd, env } = gitOf(ws, snap.repo);
    const tree = await git(cwd, ['rev-parse', `${snap.commit}:${contextRel || '.'}`], env).catch(() => snap.commit!);
    h.update(tree);
  } else {
    const walk = (d: string, rel: string) => {
      for (const n of readdirSync(d).sort()) {
        if (n === '.ks-complete') continue;
        const abs = join(d, n);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, `${rel}${n}/`);
        else h.update(`${rel}${n}\0`).update(readFileSync(abs));
      }
    };
    walk(join(snap.dir, contextRel), '');
  }
  return h.update(`\0${extra}`).digest('hex').slice(0, 12);
}
