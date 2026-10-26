/**
 * A flow's environment: an instance of `local` or `fast` with ALL of it (the app calls more than the flow names, and a part
 * left out is a part that answers nothing), its scenario restored and
 * addresses of its own on 127.0.0.1. It is a real env named `f-<flow>`, its spec written beside the machine's state,
 * so everything that works on an env works on it: scenarios, runs, explorers, the vault, the tap. It stays while you use
 * it and goes by label when you ask: nothing of the base env, and nothing that is not Laru's, is touched.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WorkspaceError, type Workspace } from '@laru/core';
import { parse, stringify } from 'yaml';
import { destroyByLabel, type DestroyReport } from './docker.ts';
import { envDir, forgetValues, instanceFile, isInstance, listEnvs, loadEnvSpec } from './env.ts';
import { listFlows } from './runs.ts';
import { applyScenario, listScenarios, type Applied } from './scenarios.ts';
import { down, status, upStoppingOffered, type EnvEvent, type EnvStatus, type UpResult } from './up.ts';

export const instanceOf = (slug: string) => `f-${slug}`;
const flowOf = (ws: Workspace, slug: string) => {
  const f = listFlows(ws).find((x) => x.slug === slug || x.id === slug);
  if (!f) throw new WorkspaceError(`no flow "${slug}"; flows are ${listFlows(ws).map((x) => x.slug).join(', ') || 'none yet'}`, 'flow');
  return f;
};

/** The services a flow needs by their compose names (`svc:api-gateway` → `api-gateway`), with its scenario's. */
export function needsOf(ws: Workspace, slug: string): string[] {
  const f = flowOf(ws, slug);
  const want = f.scenario?.replace(/^scn:/, '');
  const scn = want ? listScenarios(ws).find((s) => s.slug === want) : undefined;
  return [...new Set([...f.needs, ...(scn?.needs ?? [])].map((n) => n.replace(/^[a-z]+:/, '')))].sort();
}

/** Which env to derive from: the one asked for, else `fast` when the workspace has it (the lighter), else `local`. */
export function baseFor(ws: Workspace, from?: string): string {
  const envs = listEnvs(ws);
  const base = from ?? (envs.includes('fast') ? 'fast' : envs.includes('local') ? 'local' : envs[0]);
  if (!base || !envs.includes(base)) throw new WorkspaceError(`derive it from one of ${envs.join(', ') || 'no env yet'}`, 'from');
  return base;
}

export interface FlowEnvUp extends UpResult { instance: string; base: string; scenario?: Applied; /** the env stopped to make room, as the admission offered and the caller accepted */ stopped?: string }

/**
 * Writes the instance's spec — an extension of the base env, whole — and checks it reads. It is not narrowed to what the
 * flow names: a person trying the app live reaches every screen, and a service left out answers nothing. `services` is what
 * the flow documents as needing, for the sheet.
 */
export function prepareInstance(ws: Workspace, slug: string, from?: string): { env: string; base: string; services: string[] } {
  const f = flowOf(ws, slug), env = instanceOf(f.slug), base = baseFor(ws, from);
  const services = needsOf(ws, f.slug);
  mkdirSync(dirname(instanceFile(ws, env)), { recursive: true });
  writeFileSync(instanceFile(ws, env), `# ${f.id}: an instance of ${base}, all of it. Generated; Laru removes it with the instance.\n${stringify({ extends: base, persistent: true })}`);
  loadEnvSpec(ws, env); // names the field if the base env cannot be read
  return { env, base, services };
}

/**
 * Adds to a narrowed instance the services it lacks, and only that: its data and its scenario are not touched (an `up` starts
 * what is missing and leaves what runs), and a refusal for memory is the caller's to read, never an env stopped on its own.
 */
export async function widenInstance(ws: Workspace, env: string, onEvent?: (e: EnvEvent) => void): Promise<void> {
  prepareInstance(ws, env.replace(/^f-/, ''), instanceBase(ws, env));
  await upStoppingOffered(ws, { env, onEvent, stopOffered: false });
}

/** An instance written when they were narrowed to what the flow names: it lacks services the app calls. */
export function instanceNarrowed(ws: Workspace, env: string): boolean {
  try { return existsSync(instanceFile(ws, env)) && Array.isArray((parse(readFileSync(instanceFile(ws, env), 'utf8')) as { services?: unknown } | null)?.services); } catch { return false; }
}

/**
 * Starts the flow's environment (or finds it ready) and puts its scenario in. `stopOffered`: when the memory does not
 * allow it beside the env you have running, stop that one as the admission offered (you said yes).
 */
export async function flowEnvUp(ws: Workspace, slug: string, o: { from?: string; onEvent?: (e: EnvEvent) => void; stopOffered?: boolean } = {}): Promise<FlowEnvUp> {
  const f = flowOf(ws, slug), { env, base } = prepareInstance(ws, slug, o.from);
  const r = await upStoppingOffered(ws, { env, onEvent: o.onEvent, stopOffered: o.stopOffered });
  const scenario = f.scenario ? await applyScenario(ws, f.scenario, { env, confirm: true }) : undefined;
  return { ...r, instance: env, base, ...(scenario ? { scenario } : {}) };
}

/** The env an instance was derived from. */
export const instanceBase = (ws: Workspace, env: string): string | undefined => (existsSync(instanceFile(ws, env)) ? (parse(readFileSync(instanceFile(ws, env), 'utf8')) as { extends?: string } | null)?.extends : undefined);

export interface FlowEnvStatus { instance: string; exists: boolean; base?: string; status?: EnvStatus; services: string[] }
export async function flowEnvStatus(ws: Workspace, slug: string): Promise<FlowEnvStatus> {
  const f = flowOf(ws, slug), env = instanceOf(f.slug);
  const exists = existsSync(instanceFile(ws, env));
  if (!exists) return { instance: env, exists, services: needsOf(ws, f.slug) };
  return { instance: env, exists, base: instanceBase(ws, env), status: await status(ws, env), services: needsOf(ws, f.slug) };
}

/** Takes the flow's environment down by label and forgets it: its containers, networks, volumes, masks and state. */
export async function flowEnvDown(ws: Workspace, slug: string): Promise<DestroyReport> {
  const env = instanceOf(flowOf(ws, slug).slug);
  const report = await down(ws, env);
  forgetValues(ws, env);
  rmSync(envDir(ws, env), { recursive: true, force: true });
  rmSync(instanceFile(ws, env), { force: true });
  return report;
}

/** Every flow environment this workspace has on disk. */
export const instancesOf = (ws: Workspace): string[] => (existsSync(dirname(instanceFile(ws, 'f-x'))) ? readdirSync(dirname(instanceFile(ws, 'f-x'))).filter((x) => x.endsWith('.yaml')).map((x) => x.slice(0, -5)).filter(isInstance) : []);
export { destroyByLabel };
