/**
 * Coverage by lifecycle stage, measured as contrasts and never as presence: a contract counts when the
 * extracted endpoints agree with it, an anchor when it finds files, a convention when its check passes.
 * Every reason travels with a stable key and its parameters; English is the default text.
 */
import { normalizePath } from '@laru/detect';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOf } from '../folder.ts';
import { readBlobs } from '../git.ts';
import { loadExtraction } from '../extract.ts';
import type { Graph } from '../graph.ts';
import { stateDir, type Workspace } from '../workspace.ts';
import type { Row } from './piece.ts';
import { anchorResolver, ancestors, childrenOf, type Knowledge, type Loaded } from './store.ts';
import { DEFAULT_PROFILE, STAGES, type Stage } from './standard.ts';

export type CovState = 'full' | 'part' | 'miss' | 'na';
export interface Reason { key: string; params?: Record<string, string | number>; text: string }
export interface StageCoverage { stage: Stage; state: CovState; required: boolean; reasons: Reason[] }
export interface ConventionResult { id: string; checked: number; violations: Array<{ file: string; line?: number; rule: string }> }

const R = (key: string, text: string, params?: Reason['params']): Reason => ({ key, text, params });

/** Files a container's code covers: its anchors, or the whole repo for a repository, or everything for the application. */
export function scopeFiles(ws: Workspace, k: Knowledge, p: Loaded): Array<{ repo: string; file: string }> {
  const resolve = anchorResolver(ws);
  if (p.type === 'application') return ws.repos.flatMap((r) => Object.keys(loadExtraction(ws, r.name)?.files ?? {}).map((file) => ({ repo: r.name, file })));
  if (p.type === 'repository') { const repo = p.id.slice(5); return Object.keys(loadExtraction(ws, repo)?.files ?? {}).map((file) => ({ repo, file })); }
  return (p.anchors ?? []).flatMap((a) => (resolve(a) ?? []).map((file) => ({ repo: a.split(':')[0], file })));
}

/** `#FileController` owns every method of the class, `#FileController.upload` only that one, `#FileController.upload*` upload and uploadBatch. */
export const symbolMatches = (sym: string | undefined, handler: string) =>
  !sym || (sym.endsWith('*') ? handler.startsWith(sym.slice(0, -1)) : handler === sym || handler.startsWith(sym + '.'));

/** Whether an endpoint belongs to a piece's code: an anchor with `#Symbol` narrows a file shared by several features. */
export function endpointOwner(ws: Workspace, p: Pick<Loaded, 'anchors'>): (repo: string, file: string, handler: string) => boolean {
  const resolve = anchorResolver(ws);
  const rules = (p.anchors ?? []).flatMap((a) => { const sym = a.match(/#([\w.$*]+)$/)?.[1]; return (resolve(a.replace(/#.*$/, '')) ?? []).map((file) => ({ key: `${a.split(':')[0]}:${file}`, sym })); });
  return (repo, file, handler) => rules.some((r) => r.key === `${repo}:${file}` && symbolMatches(r.sym, handler));
}

/** Conventions that rule over a piece: its own, its ancestors', and its repository's. */
export function conventionsFor(k: Knowledge, p: Loaded): Loaded[] {
  const chain = [...ancestors(k, p.id), p];
  return chain.flatMap((c) => childrenOf(k, c.id).filter((x) => x.type === 'convention'));
}

const cache = new Map<string, ConventionResult>();
/** Runs every convention's `forbid:`/`require:` checks over the files it rules. Cached by the blobs it read. */
export async function evaluateConventions(ws: Workspace, k: Knowledge): Promise<Map<string, ConventionResult>> {
  const out = new Map<string, ConventionResult>();
  for (const c of k.pieces.filter((x) => x.type === 'convention' && (x.fields.check as string[] | undefined)?.length)) {
    const owner = c.parent ? k.byId.get(c.parent) : undefined;
    if (!owner) continue;
    const resolve = anchorResolver(ws);
    const files = c.anchors?.length ? c.anchors.flatMap((a) => (resolve(a) ?? []).map((file) => ({ repo: a.split(':')[0], file }))) : scopeFiles(ws, k, owner);
    const byRepo = new Map<string, string[]>();
    for (const f of files) (byRepo.get(f.repo) ?? byRepo.set(f.repo, []).get(f.repo)!).push(f.file);
    const key = c.id + JSON.stringify(c.fields.check) + [...byRepo].map(([r, fs]) => fs.map((f) => loadExtraction(ws, r)?.tree[f]).join()).join();
    if (cache.has(key)) { out.set(c.id, cache.get(key)!); continue; }
    const rules = (c.fields.check as string[]).map((s) => s.match(/^(forbid|require):\s*(.+)$/)).filter(Boolean).map((m) => ({ mode: m![1], re: new RegExp(m![2], 'm'), text: m![0] }));
    const result: ConventionResult = { id: c.id, checked: files.length, violations: [] };
    for (const [repo, list] of byRepo) {
      const ex = loadExtraction(ws, repo);
      const checkout = ws.checkouts[repo];
      if (!ex || !checkout || !ws.repos.some((r) => r.name === repo)) continue;
      const blobs = await readBlobs(checkout, list.map((f) => ex.tree[f]).filter(Boolean), gitOf(ws, repo).env);
      for (const f of list) {
        const src = blobs.get(ex.tree[f]);
        if (src === undefined) continue;
        for (const r of rules) {
          const m = r.re.exec(src);
          if (r.mode === 'forbid' && m) result.violations.push({ file: `${repo}:${f}`, line: src.slice(0, m.index).split('\n').length, rule: r.text });
          if (r.mode === 'require' && !m) result.violations.push({ file: `${repo}:${f}`, rule: r.text });
        }
      }
    }
    cache.set(key, result);
    out.set(c.id, result);
  }
  return out;
}

/** The last result of each flow (error runs, which say nothing about the code, do not count). */
function lastResults(ws: Workspace): Map<string, { run: string; status: string }> {
  const f = join(stateDir(ws), 'runs', 'index.jsonl');
  const out = new Map<string, { run: string; status: string }>();
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); if (x.status !== 'error') out.set(x.flow, { run: x.run, status: x.status }); }
  return out;
}

/** Envs this machine has started: when each was last ready and which services its last up included (from the runtime's state.json). */
function envStates(ws: Workspace): Array<{ env: string; ready?: string; services: string[] }> {
  const dir = join(stateDir(ws), 'envs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((env) => {
    const f = join(dir, env, 'state.json');
    try { const s = JSON.parse(readFileSync(f, 'utf8')); return [{ env, ready: s.lastReadyAt as string | undefined, services: Object.keys(s.built ?? {}) }]; } catch { return []; }
  });
}

export function coverage(ws: Workspace, k: Knowledge, g: Graph | null, p: Loaded, conventions?: Map<string, ConventionResult>, today = new Date().toISOString().slice(0, 10)): StageCoverage[] {
  const profile = { ...DEFAULT_PROFILE, ...(ws.profile ?? {}) };
  const required = new Set<Stage>(profile[p.kind ?? p.type] ?? profile[p.type] ?? []);
  const facets = childrenOf(k, p.id);
  const of = (t: string) => facets.filter((f) => f.type === t);
  const files = p.type === 'module' || p.type === 'service' ? scopeFiles(ws, k, p) : [];
  const fileSet = new Set(files.map((f) => `${f.repo}:${f.file}`));

  const stage = (s: Stage): StageCoverage => {
    const req = required.has(s);
    const done = (state: CovState, reasons: Reason[]): StageCoverage => ({ stage: s, state: !req && state === 'miss' ? 'na' : state, required: req, reasons: !req && state === 'miss' ? [R('not-required', 'Not required for this class')] : reasons });
    switch (s) {
      case 'plan': {
        const plans = of('plan');
        if (!plans.length) return done('miss', [R('no-pieces', 'No plan', { pieces: 'plan' })]);
        const overdue = plans.flatMap((pl) => ((pl.fields.milestones ?? []) as Row[]).filter((m) => m.done !== 'yes' && m.date && m.date < today));
        return overdue.length ? done('part', overdue.map((m) => R('milestone-overdue', `"${m.milestone}" was due on ${m.date}`, { milestone: m.milestone, date: m.date }))) : done('full', [R('milestones-ok', 'No milestone overdue')]);
      }
      case 'design': {
        const contracts = of('contract'), models = of('data-model'), decisions = of('decision');
        if (!contracts.length && !models.length && !decisions.length) return done('miss', [R('no-pieces', 'No contract, data model or decision', { pieces: 'contract, data-model, decision' })]);
        const reasons: Reason[] = [];
        if (g) {
          for (const c of contracts) for (const op of (c.fields.operations ?? []) as Row[]) {
            const svc = op.service?.replace(/^svc:/, '');
            const hit = g.outOf(`svc:${svc}`).some((f) => f.p === 'exposes' && g.nodes.get(f.o)?.attrs?.method === op.method && normalizePath(String(g.nodes.get(f.o)?.attrs?.path)) === normalizePath(op.path));
            if (!hit) reasons.push(R('contract-missing-in-code', `${op.method} ${op.path} is in ${c.id} but not in the code`, { op: `${op.method} ${op.path}`, contract: c.id }));
          }
          if (contracts.length && fileSet.size) {
            const declared = new Set(contracts.flatMap((c) => ((c.fields.operations ?? []) as Row[]).map((o) => `${o.method} ${normalizePath(o.path)}`)));
            const owns = endpointOwner(ws, p);
            for (const ep of g.ofType('endpoint')) {
              if (!ep.anchor || !owns(ep.anchor.repo, ep.anchor.path, String(ep.attrs?.handler ?? '')) || ep.attrs?.contract) continue;
              if (!declared.has(`${ep.attrs?.method} ${normalizePath(String(ep.attrs?.path))}`)) reasons.push(R('endpoint-without-contract', `${ep.name} is in the code but in no contract`, { op: String(ep.name) }));
            }
          }
          for (const m of models) for (const e of (m.fields.entities ?? []) as Row[]) if (e.table && !g.nodes.has(`tbl:${e.table}`)) reasons.push(R('table-missing', `Table ${e.table} is declared but not found in the code`, { table: e.table }));
        }
        if (reasons.length) return done('part', reasons);
        return done('full', [R('design-ok', `${contracts.length + models.length + decisions.length} design pieces agree with the code`, { count: contracts.length + models.length + decisions.length })]);
      }
      case 'build': {
        if (p.type !== 'module' && p.type !== 'service' && p.type !== 'repository' && p.type !== 'application') return done('miss', []);
        const rules = conventionsFor(k, p);
        const failing = rules.filter((c) => (conventions?.get(c.id)?.violations.length ?? 0) > 0);
        if ((p.type === 'module' || p.type === 'service') && !p.anchors?.length) return done('miss', [R('no-anchors', 'No code anchored')]);
        if ((p.type === 'module' || p.type === 'service') && !files.length) return done('part', [R('anchors-empty', 'The anchors find no file')]);
        if (failing.length) return done('part', failing.map((c) => R('convention-fails', `${c.title}: ${conventions!.get(c.id)!.violations.length} violations`, { id: c.id, title: c.title, count: conventions!.get(c.id)!.violations.length })));
        return done('full', [R('build-ok', `${files.length ? `${files.length} files anchored` : 'Code in place'}${rules.length ? `, ${rules.length} conventions apply` : ''}`, { files: files.length, conventions: rules.length })]);
      }
      case 'test': {
        // A test plan covers what its scope names, wherever the plan lives.
        const plans = k.pieces.filter((x) => x.type === 'test-plan' && (x.parent === p.id || ((x.fields.scope ?? []) as Row[]).some((r) => r.target === p.id)));
        // Flows anywhere below count: an application is tested by the flows of its modules and processes.
        // and the ones its use cases point at, wherever they live (the upload flows are in the process, and prove the upload module)
        const cited = new Set(((p.fields.usecases ?? []) as Row[]).map((r) => r.flow).filter(Boolean));
        const flows = k.pieces.filter((x) => x.type === 'flow' && (x.parent === p.id || ancestors(k, x.id).some((a) => a.id === p.id) || cited.has(x.id)));
        if (!plans.length && !flows.length) return done('miss', [R('no-pieces', 'No test plan or flow', { pieces: 'test-plan, flow' })]);
        if (!flows.length) return done('part', [R('no-pieces', 'No flow', { pieces: 'flow' })]);
        // Tested means: every flow below has a spec and its last run passed (or was cached from a pass).
        const last = lastResults(ws);
        const reasons: Reason[] = [];
        for (const fl of flows) {
          const slug = fl.id.replace(/^flow:/, '');
          const r = last.get(slug);
          if (!existsSync(join(ws.root, fl.dir, `${slug}.spec.ts`))) reasons.push(R('flow-no-spec', `${fl.id} has no spec`, { flow: fl.id }));
          else if (!r) reasons.push(R('flow-not-run', `${fl.id} has not run`, { flow: fl.id }));
          else if (r.status !== 'passed') reasons.push(R('flow-failed', `${fl.id} ${r.status} in run ${r.run}`, { flow: fl.id, run: r.run, status: r.status }));
        }
        if (reasons.length) return done('part', reasons);
        return done('full', [R('flows-green', `${flows.length} flows passed in their last run`, { count: flows.length })]);
      }
      case 'deploy': {
        if (!['application', 'service', 'datastore', 'external'].includes(p.type)) return done('miss', []);
        const envs = envStates(ws);
        if (!envs.length) return done('miss', [R('no-envs', 'No env has been started: laru env init, then laru up')]);
        const name = p.type === 'application' ? null : p.id.slice(p.id.indexOf(':') + 1);
        const mine = name ? envs.filter((e) => e.services.includes(name)) : envs;
        if (!mine.length) return done('miss', [R('not-in-env', `${name} is in no env`, { name: name! })]);
        const ready = mine.filter((e) => e.ready).sort((a, b) => b.ready!.localeCompare(a.ready!));
        if (!ready.length) return done('part', [R('env-not-ready', `${mine.map((e) => e.env).join(', ')} never reached ready`, { envs: mine.map((e) => e.env).join(', ') })]);
        return done('full', [R('env-ready', `Ready in ${ready[0].env} at ${ready[0].ready}`, { env: ready[0].env, at: ready[0].ready!.slice(0, 16).replace('T', ' ') })]);
      }
      case 'operate': {
        const targets = p.type === 'application' && g ? [...g.ofType('service'), ...g.ofType('datastore')].map((n) => n.id) : ['service', 'datastore', 'external'].includes(p.type) ? [p.id] : [];
        if (!targets.length) return done('miss', []);
        // Operating it is written as a guide that names it (`[[ds:kafka]]`): there is no piece type of its own for that.
        const named = (t: string) => k.pieces.some((x) => x.type === 'guide' && JSON.stringify(x.fields).includes(`[[${t}]]`));
        const covered = targets.filter(named);
        const missing = targets.filter((t) => !covered.includes(t));
        if (!covered.length) return done('miss', [R('runbooks-missing', `No operating guide for ${missing.join(', ')}`, { list: missing.join(', ') })]);
        return missing.length ? done('part', [R('runbooks-missing', `No operating guide for ${missing.join(', ')}`, { list: missing.join(', ') })]) : done('full', [R('runbooks-ok', `${covered.length} operating guides`, { count: covered.length })]);
      }
    }
  };
  return STAGES.map(stage);
}
