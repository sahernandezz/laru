/**
 * Ephemeral envs whose run is over (or whose process died) are destroyed: at every start of the CLI's run commands,
 * the daemon and the MCP server. Persistent envs carry no run label and are never swept.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '@laru/core';
import { byLabel, destroyByLabel, docker, LABEL } from './docker.ts';
import { envDir } from './env.ts';
import { readRun } from './runs.ts';

export async function sweepOrphans(ws: Workspace): Promise<string[]> {
  const out = await docker(['ps', '-a', ...byLabel(ws), '--filter', `label=${LABEL.run}`, '--format', `{{.Label "${LABEL.run}"}} {{.Label "${LABEL.env}"}}`]).catch(() => '');
  const runs = new Map(out.split('\n').filter(Boolean).map((l) => { const [run, env] = l.split(' '); return [run, env] as const; }));
  const swept: string[] = [];
  for (const [run, env] of runs) {
    const r = readRun(ws, run); // reading marks a run whose process died as interrupted
    if (r && r.status === 'running') continue;
    await destroyByLabel(ws, { env, run }).catch(() => undefined);
    rmSync(join(envDir(ws, env), 'runs', run), { recursive: true, force: true }); // its tap files, mask.json included
    swept.push(run);
  }
  return swept;
}
