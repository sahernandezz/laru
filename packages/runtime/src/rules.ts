/**
 * Live control of an env's tap: faults and mock modes written to its rules.json, which the tap reloads within a
 * second. Nothing here survives the next `up` unless it is saved into envs/<env>.yaml.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { WorkspaceError, type Workspace } from '@laru/core';
import { operations, sample } from '../tap/openapi.ts';
import { envDir, envFile, listEnvs, loadEnvSpec } from './env.ts';
import type { FaultRule, MockSpec, TapConfig, TapRules } from './types.ts';

const file = (ws: Workspace, env: string, f: string) => join(envDir(ws, env), 'tap', f);

export function readRules(ws: Workspace, env: string): TapRules {
  const f = file(ws, env, 'rules.json');
  if (!existsSync(f)) throw new WorkspaceError(`${env} has not been started: no tap rules yet`);
  return { seed: 1, faults: {}, mocks: {}, peers: {}, ...JSON.parse(readFileSync(f, 'utf8')) };
}
const writeRules = (ws: Workspace, env: string, r: TapRules) => writeFileSync(file(ws, env, 'rules.json'), JSON.stringify(r, null, 2));

function route(ws: Workspace, env: string, svc: string) {
  const cfg = JSON.parse(readFileSync(file(ws, env, 'routes.json'), 'utf8')) as TapConfig;
  const r = cfg.routes.find((x) => x.svc === svc);
  if (!r) throw new WorkspaceError(`the tap does not stand in front of ${svc}; faults and mocks apply to ${cfg.routes.map((x) => x.svc).join(', ')}`);
  return r;
}

const MODES: MockSpec['mode'][] = ['contract', 'record', 'simulate', 'spy', 'script'];

/** Switches the mode of a service that is already mocked in this env (adding a mock changes the env: envs/<env>.yaml). */
export function setMockMode(ws: Workspace, env: string, svc: string, mode: MockSpec['mode']): TapRules {
  if (!MODES.includes(mode)) throw new WorkspaceError(`a mode is one of ${MODES.join(', ')}`, 'mode');
  const r = readRules(ws, env);
  const rt = route(ws, env, svc);
  if (r.mocks[svc]?.mode === 'sink') throw new WorkspaceError(`${svc} is a mailbox: it keeps what it receives and cannot change mode`, 'mode');
  if (!r.mocks[svc]) throw new WorkspaceError(`${svc} is not mocked in ${env}: add mocks.${svc} to envs/${env}.yaml and run laru up ${env}`);
  if ((mode === 'record' || mode === 'spy') && !rt.upstream && !r.mocks[svc].real) throw new WorkspaceError(`${mode} forwards to the real ${svc}: set mocks.${svc}.real (host:port) in envs/${env}.yaml`);
  r.mocks[svc] = { ...r.mocks[svc], mode };
  writeRules(ws, env, r);
  return r;
}

export function setFaults(ws: Workspace, env: string, svc: string, rules: FaultRule[], append = true): TapRules {
  route(ws, env, svc);
  const r = readRules(ws, env);
  for (const f of rules) {
    if (f.p !== undefined && (f.p < 0 || f.p > 1)) throw new WorkspaceError('p is a probability between 0 and 1', 'p');
    if (f.path) new RegExp(f.path);
    if (f.code !== undefined && !(Number.isInteger(f.code) && f.code >= 1 && f.code <= 99999)) throw new WorkspaceError('code is the provider\'s own error code (30003 for Twilio)', 'code');
    if (f.from && !Object.values(r.peers).includes(f.from)) throw new WorkspaceError(`no service ${f.from} in ${env}`, 'from');
  }
  r.faults[svc] = append ? [...(r.faults[svc] ?? []), ...rules] : rules;
  if (!r.faults[svc].length) delete r.faults[svc];
  writeRules(ws, env, r);
  return r;
}

export function clearFaults(ws: Workspace, env: string, svc?: string): TapRules {
  const r = readRules(ws, env);
  if (svc) delete r.faults[svc]; else r.faults = {};
  writeRules(ws, env, r);
  return r;
}

/** Copies the live faults into envs/<env>.yaml (comments and the rest of the file kept). */
export function saveFaults(ws: Workspace, env: string): void {
  const r = readRules(ws, env);
  loadEnvSpec(ws, env); // the file must be valid before it is touched
  const f = envFile(ws, env);
  const doc = parseDocument(readFileSync(f, 'utf8'));
  if (Object.keys(r.faults).length) doc.set('faults', r.faults); else doc.delete('faults');
  writeFileSync(f, doc.toString());
}

/** An operation of a mock's OpenAPI file, with the examples the mock answers (its own, or generated from the schema). */
export interface MockOperation { method: string; path: string; summary?: string; request?: string; responses: Array<{ status: string; description?: string; example?: string }> }
/** A mocked service: the mode each env gives it, the files of its folder and, with an OpenAPI file, its operations. */
export interface MockContract { envs: Array<{ env: string; mode: MockSpec['mode'] }>; dir: string; files: string[]; operations?: MockOperation[]; error?: string }

export function mockOperations(doc: Record<string, any>): MockOperation[] {
  const example = (m?: Record<string, any>) => {
    const v = m?.example ?? (m?.examples ? Object.values<any>(m.examples)[0]?.value : undefined) ?? (m?.schema ? sample(doc, m.schema) : undefined);
    return v === undefined ? undefined : JSON.stringify(v);
  };
  const json = (x?: Record<string, any>) => x?.content?.['application/json'];
  return operations(doc).map(({ method, path, op }) => ({
    method, path, summary: op.summary ?? op.description, request: example(json(op.requestBody)),
    responses: Object.entries<Record<string, any>>(op.responses ?? {}).map(([status, r]) => ({ status, description: r?.description, example: example(json(r)) })),
  }));
}

/** Every service some env mocks, read from envs/*.yaml and mocks/; an env whose file does not load is left out. */
export function mockContracts(ws: Workspace): Record<string, MockContract> {
  const out: Record<string, MockContract> = {};
  for (const env of listEnvs(ws)) {
    let mocks: Record<string, MockSpec>;
    try { mocks = loadEnvSpec(ws, env).mocks; } catch { continue; }
    for (const [name, m] of Object.entries(mocks)) (out[name] ??= { envs: [], dir: `mocks/${m.dir ?? name}`, files: [] }).envs.push({ env, mode: m.mode });
  }
  for (const c of Object.values(out)) {
    const dir = join(ws.root, c.dir);
    if (!existsSync(dir)) continue;
    c.files = readdirSync(dir).sort();
    const oa = ['openapi.yaml', 'openapi.yml', 'openapi.json'].find((f) => c.files.includes(f));
    if (oa) try { c.operations = mockOperations(parse(readFileSync(join(dir, oa), 'utf8'))); } catch (e) { c.error = `${oa}: ${(e as Error).message.split('\n')[0]}`; }
  }
  return out;
}
