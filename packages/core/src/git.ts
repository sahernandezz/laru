/** Git, read-only except for clone and fetch. Laru never checks out, commits or writes in a repo's tree. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `env` is merged over the defaults: a folder project's shadow index (folder.ts) comes in through it. */
export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env } });
  return stdout.trimEnd();
}

export const tryGit = (cwd: string, args: string[], env?: Record<string, string>): Promise<string | null> => git(cwd, args, env).catch(() => null);

/** Every file at a commit with its blob hash — the blob hash is what makes extraction incremental. */
export async function lsTree(cwd: string, commit: string, env?: Record<string, string>): Promise<Array<{ path: string; blob: string; size: number }>> {
  const out = await git(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], env);
  return out.split('\0').filter(Boolean).flatMap((entry) => {
    const [meta, path] = entry.split('\t');
    const [, type, blob, size] = meta.split(/\s+/);
    return type === 'blob' ? [{ path, blob, size: Number(size) || 0 }] : [];
  });
}

/** Reads many blobs in one `git cat-file --batch` process. */
export function readBlobs(cwd: string, blobs: string[], env?: Record<string, string>): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['cat-file', '--batch'], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env } });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
      const buf = Buffer.concat(chunks);
      const out = new Map<string, string>();
      let at = 0;
      while (at < buf.length) {
        const nl = buf.indexOf(10, at);
        const [sha, type, size] = buf.subarray(at, nl).toString().split(' ');
        if (type === 'missing') { at = nl + 1; continue; }
        const n = Number(size);
        out.set(sha, buf.subarray(nl + 1, nl + 1 + n).toString('utf8'));
        at = nl + 1 + n + 1;
      }
      resolve(out);
    });
    proc.stdin.end(blobs.join('\n') + '\n');
  });
}

/** `git@github.com:org/x.git`, `https://github.com/org/x` and `ssh://…/org/x.git` compare equal. */
export const normalizeUrl = (url: string): string =>
  url.trim().replace(/\.git$/, '').replace(/\/$/, '').replace(/^git@([^:]+):/, 'ssh://$1/').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '').toLowerCase();

export const repoNameFromUrl = (url: string): string => url.replace(/\.git$/, '').replace(/\/$/, '').split(/[/:]/).pop()!.toLowerCase();
