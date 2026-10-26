/**
 * The approved behavior of a flow on disk: `behavior.yaml` beside its flow.md, one hop a line (with the hop
 * that caused it after «⟵»), so its diff in the workspace's PR is the review of a change in behavior. Written only by
 * an approval; every run that plays the story compares against it and keeps the drift in its own folder.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph, type Workspace } from '@laru/core';
import { behaviorOf, driftOf, endpointMatcher, isGreen, mergeBehaviors, stepKey, type Behavior, type Drift, type Trace } from '@laru/trace';
import { parse, stringify } from 'yaml';
import { listFlows, readRun, readTrace, runDir, runsDir } from './runs.ts';

const CAUSE = ' ⟵ ';
export interface Approved extends Behavior { approved: { run: string; runs?: string[]; at: string; env: string; sources?: string[]; /** soft checks that failed in that story: app deviations it was approved with */ soft: number } }
export interface BehaviorDiff { flow: string; run: string; approvedRun: string; drifts: Drift[] }

const flowOf = (ws: Workspace, flow: string) => {
  const f = listFlows(ws).find((x) => x.slug === flow.replace(/^flow:/, ''));
  if (!f) throw new Error(`no flow ${flow}`);
  return f;
};
export const behaviorFile = (ws: Workspace, flow: string) => join(ws.root, flowOf(ws, flow).dir, 'behavior.yaml');
const matcher = (ws: Workspace) => { try { return endpointMatcher(loadGraph(ws).map.nodes); } catch { return endpointMatcher([]); } };

export function readApproved(ws: Workspace, flow: string): Approved | null {
  const f = behaviorFile(ws, flow);
  if (!existsSync(f)) return null;
  const doc = parse(readFileSync(f, 'utf8')) as { flow: string; approved: Approved['approved']; steps: Array<{ key?: string; n?: number; step: string; hops: string[]; sometimes?: string[] }> };
  return { flow: doc.flow, approved: doc.approved, steps: (doc.steps ?? []).map((s, i) => {
    const pairs = (s.hops ?? []).map((l) => l.split(CAUSE));
    // a file from before the keys: the title's slug and the row's place
    return { key: s.key ?? stepKey(s.step), n: s.n ?? i + 1, step: s.step, hops: pairs.map(([h]) => h), ...(s.sometimes?.length ? { sometimes: s.sometimes } : {}), causes: Object.fromEntries(pairs.filter((p) => p[1]).map(([h, c]) => [h, c])) };
  }) };
}

/** The behavior of a flow's story in a run: its own, normalized against the map's endpoints. */
export function behaviorIn(ws: Workspace, run: string, flow: string): { trace: Trace; behavior: Behavior } {
  const slug = flowOf(ws, flow).slug;
  const trace = readTrace(ws, run, slug);
  if (!trace) throw new Error(`run ${run} kept no story of ${slug}`);
  return { trace, behavior: behaviorOf(trace, matcher(ws)) };
}

/** The newest green runs that played a flow's story, newest first: «passed» in the index is green (it played everything and carries only known deviations). */
function greenRuns(ws: Workspace, slug: string, n: number): string[] {
  const idx = join(runsDir(ws), 'index.jsonl');
  const rows = existsSync(idx) ? readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { run: string; flow: string; status: string }) : [];
  const played = rows.filter((x) => x.flow === slug && x.status !== 'error' && x.status !== 'cached');
  const green = played.filter((x) => x.status === 'passed').map((x) => x.run).reverse().slice(0, n);
  if (!green.length) throw new Error(played.length ? `${slug}'s last run was not green: a behavior is approved from a run that failed only on its known deviations (// app:)` : `${slug} has not been played yet: laru test ${slug}`);
  return green;
}

/**
 * Approves what green runs of a story did as the flow's behavior: the newest few (`last`, 5), or the runs named. A run
 * must have played every step and carry only known deviations (`// app:`). What every run did is the behavior; what only
 * some did (a poll, a cached read) is kept as «sometimes»: allowed to come, never missed.
 */
export function approveBehavior(ws: Workspace, flow: string, o: { run?: string; runs?: string[]; last?: number } = {}): { file: string; run: string; runs: string[]; hops: number; sometimes: number; soft: number } {
  const f = flowOf(ws, flow);
  const runs = o.runs ?? (o.run ? [o.run] : greenRuns(ws, f.slug, o.last ?? 5));
  const seen = runs.map((run) => {
    const { trace, behavior } = behaviorIn(ws, run, f.slug);
    const total = trace.stepsTotal ?? f.steps.length;
    if (trace.steps.length < total) throw new Error(`run ${run} played ${trace.steps.length} of ${total} steps of ${f.slug}: a behavior is approved from a story that played them all`);
    if (!isGreen(trace)) throw new Error(`run ${run} is not green for ${f.slug}: ${trace.failure ? `${trace.failure.unexpected ?? 'some'} unexpected failure(s), «${trace.failure.message.slice(0, 120)}»` : trace.status}. A behavior is approved from a run that failed only on its known deviations (// app:)`);
    return { run, trace, behavior };
  });
  const behavior = mergeBehaviors(seen.map((x) => x.behavior));
  const run = runs[0], info = readRun(ws, run);
  const soft = seen[0].trace.failure?.known ?? 0;
  const approved = { run, ...(runs.length > 1 ? { runs } : {}), at: new Date().toISOString(), env: info?.env ?? '', ...(info?.sources ? { sources: info.sources } : {}), soft };
  const doc = {
    flow: f.id, approved,
    steps: behavior.steps.map((s) => ({ key: s.key, n: s.n, step: s.step, hops: s.hops.map((h) => (s.causes[h] ? `${h}${CAUSE}${s.causes[h]}` : h)), ...(s.sometimes?.length ? { sometimes: s.sometimes } : {}) })),
  };
  const file = join(ws.root, f.dir, 'behavior.yaml');
  writeFileSync(file, `# The approved behavior of ${f.id}: what the system does under each step of its story, one hop a\n# line, after «⟵» the hop that caused it; «sometimes» are hops only some of the approved runs made. A step is found again by\n# its key (its title as a slug), else by its place. Written by \`laru behavior approve\`; review its diff, never edit it.\n${stringify(doc, { lineWidth: 0 })}`);
  return { file, run, runs, hops: behavior.steps.reduce((n, s) => n + s.hops.length, 0), sometimes: behavior.steps.reduce((n, s) => n + (s.sometimes?.length ?? 0), 0), soft };
}

/** How a run's story differs from the approved behavior, kept in the run's folder for the evidence and the findings. */
export function behaviorDrift(ws: Workspace, run: string, flow: string): BehaviorDiff | null {
  const approved = readApproved(ws, flow);
  if (!approved) return null;
  const slug = flowOf(ws, flow).slug;
  const diff: BehaviorDiff = { flow: approved.flow, run, approvedRun: approved.approved.run, drifts: driftOf(approved, behaviorIn(ws, run, slug).behavior) };
  writeFileSync(join(runDir(ws, run), 'flows', slug, 'behavior-diff.json'), JSON.stringify(diff, null, 2));
  return diff;
}
