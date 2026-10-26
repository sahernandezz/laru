/**
 * A hybrid service runs on the host while the rest stays in containers. It gets what its container would have had:
 * the compose environment and the vault's values, with every address of a compose peer rewritten to the host port
 * the env publishes for it. For the JVM, config keys pointing at peers become `-D` system properties, which beat
 * profile files in both Spring and Quarkus.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadExtraction, loadGraph, targetsIn, type Graph, type Workspace } from '@laru/core';
import { interpolations, type ComposeDoc } from './compose.ts';
import { envDir, readState } from './env.ts';
import { ksVar } from './types.ts';
import { EnvError, listenPorts } from './up.ts';
import { injection } from './vault.ts';

export interface HybridEnv { env: Record<string, string>; rewrites: Array<{ key: string; from: string; to: string }>; ports: number[] }

const INTERP = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g;
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal']);
const tryGraph = (ws: Workspace): Graph | null => { try { return loadGraph(ws); } catch { return null; } };
const noUserinfo = (v: string) => v.replace(/\/\/[^/@\s]+@/g, '//…@');

export async function hybridEnv(ws: Workspace, env: string, service: string): Promise<HybridEnv> {
  const state = readState(ws, env);
  const file = join(envDir(ws, env), 'normalized.json');
  if (!state?.lastReadyAt || !existsSync(file)) throw new EnvError(`${env} is not up; run \`laru up ${env} --hybrid ${service}\``);
  if (!state.hybrid?.includes(service)) throw new EnvError(`${service} runs in a container in ${env}; run \`laru up ${env} --hybrid ${service}\` first`);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as ComposeDoc;
  const s = doc.services[service];
  const environment: Record<string, string | null> = Array.isArray(s.environment)
    ? Object.fromEntries(s.environment.map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; }))
    : { ...(s.environment ?? {}) };
  const g = tryGraph(ws);
  const inj = await injection(ws, env, [{ name: service, built: true, environment, interpolations: interpolations(s) }], g);
  const value = (k: string) => inj.values[ksVar(service, k)];

  // The peer behind a host:port, and the host port this env publishes for it.
  const byPort = (port: number) => { const c = Object.keys(doc.services).filter((n) => n !== service && listenPorts(doc.services[n]).includes(port)); return c.length === 1 ? c[0] : undefined; };
  const hostPort = (host: string, port?: number): number | undefined => {
    if (!port) return undefined;
    const peer = doc.services[host] ? host : LOCAL.has(host) ? byPort(port) : undefined;
    const m = peer && peer !== service ? state.ports[peer] : undefined;
    if (!m) return undefined;
    return m[String(port)] ?? (Object.keys(m).length === 1 ? Object.values(m)[0] : undefined);
  };
  const rewrite = (raw: string): string => {
    let v = raw.replace(INTERP, (_m, name: string, dflt?: string) => value(name) ?? dflt ?? '');
    for (const t of targetsIn(v)) { const hp = hostPort(t.host, t.port); if (hp) v = v.replace(`${t.host}:${t.port}`, `127.0.0.1:${hp}`); }
    return v;
  };

  const out: Record<string, string> = {};
  const rewrites: HybridEnv['rewrites'] = [];
  for (const [k, v] of Object.entries(environment)) if (v !== null) out[k] = String(v);
  for (const k of inj.perService[service] ?? []) if (value(k) !== undefined) out[k] = value(k)!;
  for (const [k, v] of Object.entries(out)) { const r = rewrite(v); if (r !== v && !inj.secrets.includes(v)) rewrites.push({ key: k, from: noUserinfo(v), to: noUserinfo(r) }); out[k] = r; }

  // JVM: config keys of the active profiles that point at a peer.
  const node = g?.ofType('service').find((n) => n.name === service);
  if (node && /spring|quarkus/.test(String(node.attrs?.tech ?? node.kind))) {
    const ex = loadExtraction(ws, node.repo!);
    const dir = String(node.attrs?.dir ?? '.');
    const profiles = new Set(String(out.SPRING_PROFILES_ACTIVE ?? out.QUARKUS_PROFILE ?? '').split(',').map((p) => p.trim()).filter(Boolean));
    const keys = new Map<string, { value: string; profiled: boolean }>();
    for (const [path, f] of Object.entries(ex?.files ?? {})) {
      if (dir !== '.' && !path.startsWith(posix.join(dir, '/'))) continue;
      for (const x of f.findings) {
        if (x.kind !== 'config' || (x.profile && !profiles.has(x.profile))) continue;
        if (keys.get(x.key)?.profiled && !x.profile) continue;
        keys.set(x.key, { value: x.value, profiled: Boolean(x.profile) });
      }
    }
    const opts: string[] = [];
    for (const [k, { value: v }] of keys) {
      const r = rewrite(v);
      if (r === v.replace(INTERP, (_m, name: string, dflt?: string) => value(name) ?? dflt ?? '')) continue;
      if (/\s/.test(r)) continue; // Known limit: values with spaces are not passed as -D; set them in the vault's service level
      opts.push(`-D${k}=${r}`);
      rewrites.push({ key: k, from: noUserinfo(v), to: noUserinfo(r) });
    }
    if (opts.length) out.JAVA_TOOL_OPTIONS = [process.env.JAVA_TOOL_OPTIONS, out.JAVA_TOOL_OPTIONS, ...opts].filter(Boolean).join(' ');
  }
  return { env: out, rewrites, ports: listenPorts(s) };
}
