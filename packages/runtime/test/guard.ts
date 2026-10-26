/**
 * Docker tests run on a machine with other people's containers. `guard` records every container that is not this
 * test's (id and state) and `check` asserts nothing about them changed.
 */
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';

// A run's runner of another workspace comes and goes on its own (a run in progress elsewhere): it is not watched.
const ps = (key: string) => execFileSync('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.State}} {{.Label "keelson.workspace"}} {{.Label "keelson.run"}}'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, , ws, run]) => ws !== key && !run).map(([id, state]) => `${id} ${state}`).sort();

export const dockerUp = (() => { try { execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; } })();

export function guard(workspaceKey: string) {
  const before = ps(workspaceKey);
  return { check: () => assert.deepEqual(ps(workspaceKey), before, 'a container that is not this test\'s changed') };
}
