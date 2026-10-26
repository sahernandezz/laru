/**
 * A lock is a file holding a pid; a lock whose pid is dead is stale and taken over. Another `file` is another lock: an
 * env's, the machine's (the default), the registry's, the vault's, a folder's shadow. A pid that is alive waits, the
 * holder's own process too, so two operations of one daemon on the same file take turns.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { laruHome } from './workspace.ts';

/** The locks the current operation holds: a nested withLock in the same operation (a run starting its env) enters. */
const held = new AsyncLocalStorage<Set<string>>();

export async function withLock<T>(what: string, fn: () => Promise<T>, onWait?: (holder: string) => void, file = join(laruHome(), 'locks', 'machine.lock')): Promise<T> {
  if (held.getStore()?.has(file)) return fn();
  mkdirSync(dirname(file), { recursive: true });
  for (let waited = 0; ; waited++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch {
      let holder: { pid?: number; what?: string } = {};
      try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch { /* being written */ }
      const alive = holder.pid ? (() => { try { process.kill(holder.pid!, 0); return true; } catch { return false; } })() : true;
      if (!alive) { try { unlinkSync(file); } catch { /* raced */ } continue; }
      if (waited === 0) onWait?.(holder.what ?? 'another operation');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  try { return await held.run(new Set([...(held.getStore() ?? []), file]), fn); }
  finally { try { if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file); } catch { /* gone */ } }
}
