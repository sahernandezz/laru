/**
 * «Montar todo el entorno con datos»: the project's env up with every flow's scenario seeded, so the whole application
 * can be walked through by hand. Each flow's scenario is played under the flow's own name (its accounts and rows are its
 * alone, nothing is put back), exactly as a run seeds them; one that is exclusive (mocks, faults, restarts) cannot share
 * the env and is left out, said so. Nothing is deleted: a persistent env keeps what it had.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '@laru/core';
import { envLock, withLock } from './docker.ts';
import { envDir } from './env.ts';
import { listFlows } from './runs.ts';
import { isExclusive, seedScenario, type Identity } from './scenarios.ts';
import { status, up } from './up.ts';

export interface MountedFlow {
  flow: string;
  title: string;
  scenario?: string;
  state: 'seeded' | 'no-scenario' | 'exclusive' | 'failed';
  identities: Identity[];
  signedIn: boolean;
  error?: string;
}
export interface Mounted { env: string; at: string; flows: MountedFlow[] }

const file = (ws: Workspace, env: string) => join(envDir(ws, env), 'mounted.json');

/** The last mounting of an env, or null. */
export function mountedOf(ws: Workspace, env: string): Mounted | null {
  try { return JSON.parse(readFileSync(file(ws, env), 'utf8')) as Mounted; } catch { return null; }
}

export async function mountAll(ws: Workspace, o: { env: string; onLine?: (line: string) => void }): Promise<Mounted> {
  const say = o.onLine ?? (() => undefined);
  const now = (await status(ws, o.env)).state;
  if (now === 'starting') throw new Error(`${o.env} is still starting: mount it once it is ready`);
  if (now !== 'ready') { say(`laru: bringing ${o.env} up\n`); await up(ws, { env: o.env }); }
  const out: MountedFlow[] = [];
  await withLock(`mount ${ws.app}/${o.env}`, async () => {
    for (const f of listFlows(ws).filter((x) => x.exists)) {
      const base = { flow: f.slug, title: f.title, scenario: f.scenario, identities: [] as Identity[], signedIn: false };
      if (!f.scenario) { out.push({ ...base, state: 'no-scenario' }); continue; }
      if (isExclusive(ws, f.scenario)) { out.push({ ...base, state: 'exclusive' }); continue; }
      const dir = join(envDir(ws, o.env), 'mount', f.slug);
      mkdirSync(dir, { recursive: true });
      try {
        say(`laru: seeding ${f.scenario} for ${f.slug}\n`);
        const r = await seedScenario(ws, f.scenario, { env: o.env, as: f.slug, out: dir });
        out.push({ ...base, state: 'seeded', identities: r.identities, signedIn: r.signedIn });
      } catch (e) { out.push({ ...base, state: 'failed', error: (e as Error).message.split('\n')[0] }); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, undefined, envLock(ws, o.env));
  rmSync(join(envDir(ws, o.env), 'mount'), { recursive: true, force: true }); // the runner's env files stay out of the way
  const r: Mounted = { env: o.env, at: new Date().toISOString(), flows: out };
  writeFileSync(file(ws, o.env), JSON.stringify(r, null, 2));
  return r;
}
