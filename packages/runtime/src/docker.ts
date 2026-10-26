/**
 * Docker through its CLI, never a shell: arguments are an array, and the process gets a minimal environment so
 * nothing from the user's shell leaks into a compose interpolation. Everything Laru creates carries its labels,
 * and everything Laru removes is selected by those labels — never by a project name, never by `compose down`.
 */
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { laruHome, withLock, workspaceKey, type Workspace } from '@laru/core';

export { withLock, workspaceKey };

/**
 * The labels keep the name the product had before it was called Laru: containers, networks and volumes made then carry them,
 * and a new name would leave them unseen (never stopped, never removed). Known limit: renaming them needs every env destroyed first.
 */
export const LABEL = {
  workspace: 'keelson.workspace', // legacy-name
  app: 'keelson.app', // legacy-name
  env: 'keelson.env', // legacy-name
  run: 'keelson.run', // legacy-name
  service: 'keelson.service', // legacy-name
  cache: 'keelson.cache', // legacy-name
  tool: 'keelson.tool', // legacy-name
} as const;

/** The environment a docker process runs with: PATH, HOME, DOCKER_* and whatever the caller adds (KS_* values). */
export function dockerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = Object.entries(process.env).filter(([k]) => k === 'PATH' || k === 'HOME' || k.startsWith('DOCKER_')) as Array<[string, string]>;
  return { ...Object.fromEntries(keep), ...extra };
}

export class DockerError extends Error {
  readonly stderr: string;
  readonly args: string[];
  constructor(args: string[], stderr: string) { super(`docker ${args.slice(0, 3).join(' ')}: ${stderr.trim().split('\n').slice(-3).join(' ')}`); this.stderr = stderr; this.args = args; }
}

export function docker(args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { env: dockerEnv(opts.env), cwd: opts.cwd, maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 0 }, (err, stdout, stderr) => {
      if (err) return reject(new DockerError(args, String(stderr || err.message)));
      resolve(String(stdout));
    });
    if (opts.input !== undefined) { child.stdin?.end(opts.input); }
  });
}

/** Streams a long docker command (build, up) line by line into `onLine`, and resolves with its exit code. */
export function dockerStream(args: string[], onLine: (line: string) => void, opts: { env?: Record<string, string>; cwd?: string; signal?: AbortSignal } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv(opts.env), cwd: opts.cwd, signal: opts.signal });
    let buf = '';
    const feed = (c: Buffer) => { buf += c.toString(); const lines = buf.split('\n'); buf = lines.pop()!; lines.forEach(onLine); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => (e.name === 'AbortError' ? resolve(0) : reject(e)));
    child.on('close', (code) => { if (buf) onLine(buf); resolve(code ?? 1); });
  });
}

export const dockerJson = async <T>(args: string[]): Promise<T> => JSON.parse(await docker(args)) as T;

export async function dockerAvailable(): Promise<{ ok: boolean; server?: string; error?: string }> {
  try { return { ok: true, server: (await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 })).trim() }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** `--filter label=…` arguments for this workspace, optionally narrowed to an env and a run. */
export function byLabel(ws: Pick<Workspace, 'root'>, scope: { env?: string; run?: string } = {}): string[] {
  const f = ['--filter', `label=${LABEL.workspace}=${workspaceKey(ws)}`];
  if (scope.env) f.push('--filter', `label=${LABEL.env}=${scope.env}`);
  if (scope.run) f.push('--filter', `label=${LABEL.run}=${scope.run}`);
  return f;
}

const ids = (out: string) => out.split('\n').map((s) => s.trim()).filter(Boolean);

export interface DestroyReport { containers: number; networks: number; volumes: number; left: string[] }

/**
 * Removes what carries this workspace's (and env's) labels: containers with their anonymous volumes, networks,
 * then named volumes except caches. It re-queries at the end and names anything left over.
 */
export async function destroyByLabel(ws: Pick<Workspace, 'root'>, scope: { env: string; run?: string; caches?: boolean; dryRun?: boolean }): Promise<DestroyReport> {
  const f = byLabel(ws, scope);
  // Without a run it is the base env: the instances of the same env (a flow's environment, a run) carry its env label too and stay.
  const base = scope.run === undefined;
  const own = async (kind: 'ps' | 'network' | 'volume') => {
    const args = kind === 'ps' ? ['ps', '-a'] : [kind, 'ls'];
    const rows = (await docker([...args, ...f, '--format', `{{${kind === 'ps' ? '.ID' : '.Name'}}}|{{.Label "${LABEL.run}"}}`])).split('\n').map((l) => l.trim()).filter(Boolean);
    return rows.map((r) => r.split('|')).filter(([, run]) => !base || !run).map(([id]) => id);
  };
  const containers = await own('ps');
  const networks = await own('network');
  const volumes = await own('volume');
  // Cache volumes carry no env label, so they are only removed when asked for.
  const cacheVols = scope.caches ? ids(await docker(['volume', 'ls', '-q', '--filter', `label=${LABEL.workspace}=${workspaceKey(ws)}`, '--filter', `label=${LABEL.cache}=1`])) : [];
  const vols = [...new Set([...volumes, ...cacheVols])];
  if (scope.dryRun) return { containers: containers.length, networks: networks.length, volumes: vols.length, left: [] };
  if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
  for (const n of networks) await docker(['network', 'rm', n]).catch(() => undefined);
  for (const v of vols) await docker(['volume', 'rm', '-f', v]).catch(() => undefined);
  const left = [...await own('ps'), ...await own('network'), ...await own('volume')];
  return { containers: containers.length, networks: networks.length, volumes: vols.length, left };
}

export interface ContainerState {
  id: string; name: string; service: string; state: string; health?: string; exitCode: number; oomKilled: boolean;
  /** `ip` is the first network's; a joint env's container is on several (`ips`) */
  image: string; ip?: string; ips: string[]; ports: Array<{ container: number; host?: number }>; startedAt: string; labels: Record<string, string>;
  /** output of the last failed health probe */
  probe?: string;
}

/** Every container of this env with its state, health, IP and published ports, in one inspect. */
export async function inspectEnv(ws: Pick<Workspace, 'root'>, env: string, run?: string): Promise<ContainerState[]> {
  let raw: any[] | null = null;
  for (let tries = 1; !raw; tries++) {
    const list = ids(await docker(['ps', '-aq', ...byLabel(ws, { env, run })]));
    if (!list.length) return [];
    // While compose recreates a service, a container listed a moment ago can be gone: list again.
    raw = await dockerJson<any[]>(['inspect', ...list]).catch((e: Error) => { if (tries < 3 && /no such object/i.test(e.message)) return null; throw e; });
  }
  return raw.map((c) => ({
    id: c.Id.slice(0, 12), name: String(c.Name).replace(/^\//, ''), service: c.Config.Labels?.[LABEL.service] ?? c.Config.Labels?.['com.docker.compose.service'] ?? '',
    state: c.State.Status, health: c.State.Health?.Status, exitCode: c.State.ExitCode, oomKilled: Boolean(c.State.OOMKilled), image: c.Config.Image,
    ip: Object.values(c.NetworkSettings?.Networks ?? {}).map((n: any) => n.IPAddress).find(Boolean),
    ips: Object.values(c.NetworkSettings?.Networks ?? {}).map((n: any) => String(n.IPAddress ?? '')).filter(Boolean),
    ports: Object.entries(c.NetworkSettings?.Ports ?? {}).map(([k, v]: [string, any]) => ({ container: parseInt(k, 10), host: v?.[0]?.HostPort ? Number(v[0].HostPort) : undefined })),
    startedAt: c.State.StartedAt, labels: c.Config.Labels ?? {},
    probe: (c.State.Health?.Log ?? []).filter((l: any) => l.ExitCode !== 0).map((l: any) => String(l.Output).trim()).pop() || undefined,
  }));
}

/** Docker's sizes as bytes: `77.3MB`, `20.9kB` (SI) and `1.2GiB` (binary). */
export const sizeBytes = (s: string) => { const m = s.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i); if (!m) return 0; const u = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }[m[2].toUpperCase()] ?? 1; return Math.round(Number(m[1]) * u); };

export interface ContainerStats { id: string; name: string; cpu: number; memBytes: number; memLimit: number }

/** One `docker stats --no-stream` over the env's running containers. */
export async function stats(ids: string[]): Promise<ContainerStats[]> {
  if (!ids.length) return [];
  const out = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]).catch(() => '');
  return out.split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); const [used, limit] = String(j.MemUsage).split('/'); return { id: String(j.ID ?? ''), name: j.Name, cpu: parseFloat(j.CPUPerc) || 0, memBytes: sizeBytes(used), memLimit: sizeBytes(limit ?? '') }; });
}

// Locks live in core (folder projects hash under one too), as files under ~/.laru/locks/.
/** One env (or one ephemeral run of it): its up, down, data snapshot or reset, and a whole run on it. */
export const envLock = (ws: Pick<Workspace, 'root'>, env: string, run?: string) => join(laruHome(), 'locks', `env-${workspaceKey(ws)}-${env}${run ? `-r${run}` : ''}.lock`);
/** The machine: claims, render, pull, build, admission and `compose up -d`, one env at a time. Always taken after an env lock. */
export const machineLock = () => join(laruHome(), 'locks', 'machine.lock');
/** Takes a lock and hands back its release, for a span that is not one function (an up holds the machine until compose returns). */
export const hold = (what: string, file: string, onWait?: (holder: string) => void) => new Promise<() => void>((ok, fail) => {
  withLock(what, () => new Promise<void>((release) => ok(() => release())), onWait, file).catch(fail);
});
