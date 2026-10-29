/** The runtime commands: environments, logs, hybrid runs and the doctor. Values never travel on argv. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { acceptFinding, shareEvidence, changesFromWorktrees, computeFindings, findWorkspace, impact, loadGraph, loadKnowledge, loadWorkspace, postEdit, preEdit, renderImpact, scaffoldSpec, specPath, workspaceChanges, WorkspaceError, type Impact, type Workspace } from '@laru/core';
import { endpointMatcher, sessionSummary, summarize } from '@laru/trace';
import { flowEnvDown, flowEnvStatus, flowEnvUp, instanceOf,
  connection, docker, dockerAvailable, dockerHint, inWsl, down, envMasker, mongo, rabbit, redis, query as dbQuery, reset as dbReset, schema as dbSchema, snapshot as dbSnapshot, storeOf, stores as dbStores, storePassword, envDir, envFile, EnvError, exportKey, hybridEnv, importEnvFile, importKey, interpolations, listEnvs, logs, missingVars, readState, revealVar,
  sqs, mail, sweepOrphans, calibrate, writeConfig, clearFaults, readRules, saveFaults, setFaults, setMockMode, kafka, storage, cancelRun, compareRuns, failedFlows, markSession, openSessionBrowser, runSessionBrowser, sessionToFlow, sessionToScenario, sessionTrace, startSession, stopSession, applyScenario, listScenarios, provisionScenario, ScenarioConfirm, scenarioState, approveBehavior, behaviorIn, readApproved, fidelity, fidelityText, listFlows, listRuns, readRun, readTrace, runFlows, runsDir, runTraces,
  rebuildText, setVar, status, unsetVar, up, varTable, vaultKey, envFor, envProjects, flowProjects, loadEnvSpec, specFrom, ENV_NAME, diskReport, prune, heldByEnvs, envLock, runnerFiles, withLock, workspaceKey, type ComposeDoc, type EnvEvent, type EnvStatus, type Level, type PruneWhat, type VaultService,
} from '@laru/runtime';

type Out = { log: (s: string) => void; err: (s: string) => void };
type Opts = Record<string, string | boolean | undefined>;

const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const ICON: Record<string, string> = { healthy: '●', running: '●', done: '✓', host: '◆', starting: '◌', waiting: '·', unhealthy: '✕', exited: '✕', oom: '✕', absent: '·' };

/** The env a command means: the one named, else `local`, else the only one. */
export function pickEnv(ws: Workspace, named?: string): string {
  if (named) return named;
  const envs = listEnvs(ws);
  if (envs.includes('local')) return 'local';
  if (envs.length === 1) return envs[0];
  throw new WorkspaceError(envs.length ? `which env? ${envs.join(', ')}` : 'no envs yet; create one with `laru env init local --from <repo>:<compose file>[,<file>…]`');
}

function printStatus(io: Out, s: EnvStatus) {
  io.log(`${s.env}  ${s.state}${s.source ? `  from ${s.source}` : ''}${s.lastReadyAt ? `  ready since ${s.lastReadyAt.slice(0, 19).replace('T', ' ')}` : ''}`);
  for (const x of s.services) {
    const mem = x.memBytes ? `  ${Math.round(x.memBytes / 2 ** 20)} MiB${x.memLimit ? ` / ${Math.round(x.memLimit / 2 ** 20)}` : ''}` : '';
    const cpu = x.cpu !== undefined ? `  ${x.cpu.toFixed(1)}%` : '';
    io.log(`  ${ICON[x.health] ?? '·'} ${x.service.padEnd(22)} ${x.health.padEnd(9)} ${x.mode.padEnd(9)} ${(x.built ?? '').padEnd(6)}${cpu}${mem}${x.note && x.health !== 'healthy' ? `  ${x.note.split('\n').pop()}` : ''}`);
  }
  if (s.addresses.length) { io.log('\n  addresses'); for (const a of s.addresses) io.log(`    ${a.service.padEnd(22)} ${a.url}`); }
}

/** A value from stdin; on a terminal it is typed without echo. Never from argv. */
async function readValue(): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  process.stderr.write('value (not shown): ');
  process.stdin.setRawMode(true);
  let v = '';
  try {
    for await (const chunk of process.stdin) for (const ch of String(chunk)) {
      if (ch === '\r' || ch === '\n') return v;
      if (ch === '\u0003') throw new WorkspaceError('cancelled');
      v = ch === '\u007f' ? v.slice(0, -1) : v + ch;
    }
    return v;
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); }
}

/** The env's services as the vault sees them, from the last import of its compose (a joint env's: with each one's member env). */
export function vaultServices(w: Workspace, env: string): VaultService[] {
  const f = join(envDir(w, env), 'normalized.json');
  if (!existsSync(f)) return [];
  const doc = JSON.parse(readFileSync(f, 'utf8')) as ComposeDoc & { 'x-laru'?: { envOf: Record<string, string>; composeOf: Record<string, string> }; 'x-keelson'?: { envOf: Record<string, string>; composeOf: Record<string, string> } }; // legacy-name
  const x = doc['x-laru'] ?? doc['x-keelson']; // legacy-name: an env brought up before the rename
  return Object.entries(doc.services).map(([name, s]) => ({
    name, built: Boolean(s.build), interpolations: interpolations(s),
    environment: Array.isArray(s.environment) ? Object.fromEntries(s.environment.map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; })) : { ...(s.environment ?? {}) },
    ...(x?.envOf[name] ? { env: x.envOf[name] } : {}), ...(x?.composeOf[name] && x.composeOf[name] !== name ? { compose: x.composeOf[name] } : {}),
  }));
}

/** Flows whose projects no env runs together (with several projects). */
export function envGaps(w: Workspace, g: ReturnType<typeof graphOrNull>): Array<{ flow: string; projects: string[] }> {
  if (w.repos.length < 2) return [];
  const runs = listEnvs(w).map((e) => { try { return envProjects(w, e); } catch { return []; } });
  return listFlows(w).flatMap((f) => { const need = flowProjects(g, f); return need.length && !runs.some((r) => need.every((p) => r.includes(p))) ? [{ flow: f.id, projects: need }] : []; });
}

/** The env a run of these flows uses when none is named: the smallest that runs every project they need. */
export async function runEnv(w: Workspace, flows: string[]): Promise<string> {
  const all = listFlows(w);
  const picked = flows.length ? all.filter((f) => flows.includes(f.slug) || flows.includes(f.id)) : all.filter((f) => f.exists);
  const ready = new Set((await Promise.all(listEnvs(w).map((e) => status(w, e).catch(() => null)))).filter((s) => s?.state === 'ready').map((s) => s!.env));
  return envFor(w, graphOrNull(w), picked, ready);
}

/** What the working copies of the checkouts (and the workspace's own specs) change, against the map. */
export async function affected(w: Workspace): Promise<Impact> {
  return impact(w, loadGraph(w), loadKnowledge(w), await changesFromWorktrees(w), await workspaceChanges(w));
}

/** Findings with the vault's checks of an env (the default one) included; `fidelity: false` leaves the fidelity gaps unmeasured. */
export async function findingsOf(w: Workspace, env?: string, o: { fidelity?: boolean } = {}) {
  let g = null;
  try { g = loadGraph(w); } catch { /* findings that need the map are skipped */ }
  let vaultIssues: Array<{ level: string; key: string; code?: string; service?: string; message: string }> = [];
  try { const e = pickEnv(w, env); const services = vaultServices(w, e); if (services.length) vaultIssues = missingVars(w, e, services, g); } catch { /* no env yet */ }
  const fidelityGaps = o.fidelity === false ? [] : listEnvs(w).flatMap((e) => { try { return fidelity(w, e).rows.filter((r) => r.gap).map((r) => ({ env: e, ...r })); } catch { return []; } });
  return computeFindings(w, g, loadKnowledge(w), { vaultIssues, match: endpointMatcher(g?.map.nodes ?? []), envGaps: envGaps(w, g), fidelityGaps });
}

/** The findings the screens show: the same list as the CLI's and MCP's, fidelity gaps included. */
export const screenFindings = (w: Workspace, env?: string) => findingsOf(w, env);

/** Last status of each flow, from the runs index. */
export function lastResults(w: Workspace): Record<string, string> {
  const f = join(runsDir(w), 'index.jsonl');
  const out: Record<string, string> = {};
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); out[x.flow] = `${x.status} in run ${x.run}`; }
  return out;
}

export type BrokerKind = 'kafka' | 'rabbitmq' | 'sqs';
const none = (e: Error) => { if (/has no running/.test(e.message)) return null; throw e; };
/** The brokers of an env that is up, Kafka first: «Colas» shows whichever it has. */
export async function brokersOf(w: Workspace, env: string): Promise<Array<{ kind: BrokerKind; service: string }>> {
  const [k, r, q] = await Promise.all([kafka.brokerOf(w, env).catch(none), rabbit.rabbitOf(w, env).catch(none), sqs.sqsOf(w, env).catch(none)]);
  return [...(k ? [{ kind: 'kafka' as const, service: k.service }] : []), ...(r ? [{ kind: 'rabbitmq' as const, service: r.service }] : []), ...(q ? [{ kind: 'sqs' as const, service: q.service }] : [])];
}
/** The broker a queue command means: the one named, else the env's first (Kafka when it has both). */
export async function pickBroker(w: Workspace, env: string, named?: string): Promise<BrokerKind> {
  if (named && named !== 'kafka' && named !== 'rabbitmq' && named !== 'sqs') throw new WorkspaceError('the broker is kafka, rabbitmq or sqs');
  const b = (await brokersOf(w, env)).find((x) => !named || x.kind === named);
  if (!b) throw new WorkspaceError(`${env} has no running ${named === 'kafka' ? 'Kafka' : named === 'rabbitmq' ? 'RabbitMQ' : named === 'sqs' ? 'SQS' : 'Kafka, RabbitMQ or SQS'}`);
  return b.kind;
}

const LEVELS: Level[] = ['app', 'env', 'service', 'flows', 'personal'];
const graphOrNull = (w: Workspace) => { try { return loadGraph(w); } catch { return null; } };

/**
 * A joint env, plus the project envs it joins that do not exist yet (`create`), validated as one before anything is
 * written: kebab-case names (so every file lands in envs/), members, and share ends against the members' unique names
 * in the map. An error names its field and leaves the disk as it was. Returns the files written.
 */
export function writeJoint(w: Workspace, name: string, members: string[], share: Record<string, string> = {}, create: Array<{ env: string; from: string }> = []): string[] {
  const named = (n: unknown, at: string) => { if (typeof n !== 'string' || !ENV_NAME.test(n)) throw new WorkspaceError('env names are kebab-case', at); };
  named(name, 'name');
  if (existsSync(envFile(w, name))) throw new WorkspaceError(`envs/${name}.yaml already exists`, 'name');
  if (!Array.isArray(create ?? [])) throw new WorkspaceError('a list of {env, from}', 'create');
  const pending: Record<string, Record<string, string | boolean>> = {};
  (create ?? []).forEach((c, i) => {
    named(c?.env, `create[${i}].env`);
    if (existsSync(envFile(w, c.env))) return;
    pending[c.env] = { from: c.from, persistent: true };
    specFrom(w, c.env, pending[c.env]);
  });
  const spec = specFrom(w, name, { join: members ?? [], ...(share && Object.keys(share).length ? { share } : {}), persistent: true }, undefined, pending);
  const g = graphOrNull(w);
  const repoOf: Record<string, string> = {};
  for (const m of spec.join!) { const repo = (pending[m] ? specFrom(w, m, pending[m]) : loadEnvSpec(w, m)).from!.repo; for (const u of Object.values(g?.map.names?.[repo] ?? {})) repoOf[u] = repo; }
  for (const [dropped, used] of Object.entries(spec.share)) {
    const at = `envs/${name}.yaml: share.${dropped}`;
    for (const n of [dropped, used]) if (!repoOf[n]) throw new WorkspaceError(`"${n}" is not a service of ${spec.join!.join(' or ')}${g ? '' : ' (no map: run laru map)'}`, at);
    if (repoOf[dropped] === repoOf[used]) throw new WorkspaceError(`${dropped} and ${used} are both ${repoOf[used]}'s; share is between projects`, at);
  }
  mkdirSync(join(w.root, 'envs'), { recursive: true });
  for (const [env, raw] of Object.entries(pending)) writeFileSync(envFile(w, env), `from: ${/^[\w./@:-]+$/.test(String(raw.from)) ? raw.from : JSON.stringify(raw.from)}\npersistent: true\n`);
  writeFileSync(envFile(w, name), `# ${spec.join!.join(' + ')}: one compose project, a network per project, the tap on all of them\njoin: [${spec.join!.join(', ')}]\n${Object.keys(spec.share).length ? `share: { ${Object.entries(spec.share).map(([a, b]) => `${a}: ${b}`).join(', ')} }\n` : ''}persistent: true\n`);
  return [...Object.keys(pending), name].map((e) => `envs/${e}.yaml`);
}

export interface Check { name: string; ok: boolean; note: string }

/** What this machine needs for envs: Docker, compose, memory, the vault key, and each env's subnet and entrance. */
/** `w` absent: only the machine (Docker, WSL), what a fresh install checks before it has a workspace. */
export async function doctorChecks(w?: Workspace): Promise<Check[]> {
  const d = await dockerAvailable();
  const checks: Check[] = [{ name: 'docker', ok: d.ok, note: d.ok ? `engine ${d.server}` : d.error ?? 'not running' }];
  if (d.ok) {
    const compose = await docker(['compose', 'version', '--short']).then((v) => v.trim(), () => '');
    checks.push({ name: 'compose', ok: Boolean(compose), note: compose || 'docker compose is missing' });
    const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}']).then((v) => v.trim().split(' '), () => []);
    const gb = Number(info[1] ?? 0) / 2 ** 30;
    checks.push({ name: 'resources', ok: gb >= 6, note: `${info[0]} CPUs, ${gb.toFixed(1)} GiB${gb < 6 ? ' (an app like vaultflow needs about 6)' : ''}` });
  }
  // Laru inside WSL2: the Linux filesystem, the file key store, and the interface reached from Windows.
  const wsl = process.platform === 'linux' && existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  if (wsl) {
    // with no workspace yet, where one would be made: the folder this runs in
    const onWindows = (w ? [w.root, ...Object.values(w.checkouts)] : [process.cwd()]).filter((p) => p.startsWith('/mnt/'));
    checks.push({ name: 'wsl2', ok: !onWindows.length, note: onWindows.length ? `on a Windows drive: ${onWindows.join(', ')}. Move them into the Linux filesystem (~/…): git, file watching and Docker bind mounts are many times slower on /mnt` : 'running inside WSL2; open the interface from Windows at http://localhost:<port> (WSL forwards localhost)' });
    checks.push({ name: 'wsl2 docker', ok: Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock'), note: existsSync('/var/run/docker.sock') ? 'docker socket present (Docker Desktop integration or Docker Engine in WSL)' : 'no docker socket: enable Docker Desktop\'s WSL integration for this distro or install Docker Engine in WSL' });
  }
  if (!w) return checks;
  const k = await vaultKey(w).catch(() => null);
  checks.push({ name: 'vault key', ok: !k?.warning, note: k ? `in ${k.store}` : 'none yet (the first secret creates it)' });
  for (const env of listEnvs(w)) { const st = readState(w, env); if (st) checks.push({ name: `env ${env}`, ok: true, note: `subnet 172.30.${st.subnet}.0/24, entrance :${st.entrance || '-'}` }); }
  // What the envs running on this machine hold now: an up of another env moves off these.
  if (d.ok) for (const h of await heldByEnvs().catch(() => [])) checks.push({ name: `held ${h.app}/${h.env}${h.run ? ` run ${h.run}` : ''}`, ok: true, note: `${h.key === workspaceKey(w) ? 'this workspace' : `workspace ${h.key}`}: subnets ${h.subnets.join(', ') || '-'}, ports ${h.ports.join(', ') || '-'}` });
  return checks;
}

/** What a config file holds: '' when there is none, null when it is there but cannot be read (never mistaken for empty). */
export function readWslConf(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null; }
}

/** /etc/wsl.conf with `systemd=true` in its [boot] section: added to the one there is (never a second [boot]), or as one. */
export function withSystemd(conf: string): string {
  const lines = conf.split('\n');
  const boot = lines.findIndex((l) => /^\s*\[boot\]\s*$/i.test(l));
  if (boot < 0) return `${conf}${conf && !conf.endsWith('\n') ? '\n' : ''}[boot]\nsystemd=true\n`;
  let end = lines.findIndex((l, i) => i > boot && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > boot && i < end && /^\s*systemd\s*=/i.test(l));
  if (at >= 0) { if (/=\s*true\s*$/i.test(lines[at])) return conf; lines[at] = 'systemd=true'; }
  else lines.splice(boot + 1, 0, 'systemd=true');
  return lines.join('\n');
}

/**
 * `laru doctor --fix`: Docker Engine inside Linux (WSL2 above all, with no Docker Desktop), set up so it answers and keeps
 * answering. Every command is printed before it runs and asks for sudo itself; nothing is installed from the internet.
 */
async function fixDocker(io: Out): Promise<number> {
  const d = await dockerAvailable();
  if (d.ok) { io.log('✓ docker already answers: nothing to fix'); return 0; }
  if (process.platform !== 'linux') { io.err(`docker does not answer: ${d.error}`); return 1; }
  const sh = (cmd: string, args: string[], input?: string) => {
    io.log(`→ sudo ${cmd} ${args.join(' ')}`);
    const r = spawnSync('sudo', [cmd, ...args], { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input });
    return r.status === 0;
  };
  const err = d.error ?? '';
  if (/ENOENT|not found/i.test(err)) { io.err(`docker is not installed here. ${dockerHint(err, inWsl()) ?? ''}`); return 1; }
  const systemd = (() => { try { return readFileSync('/proc/1/comm', 'utf8').trim() === 'systemd'; } catch { return false; } })();
  if (inWsl() && !systemd) {
    // the file is rewritten whole, so what it holds must be read first: a file there but unreadable is left alone
    const conf = readWslConf('/etc/wsl.conf');
    if (conf === null) io.err('  /etc/wsl.conf is there but could not be read: add `systemd=true` under its [boot] section yourself.');
    else {
      const next = withSystemd(conf);
      if (next !== conf) {
        if (conf && !sh('cp', ['-p', '/etc/wsl.conf', '/etc/wsl.conf.laru-backup'])) return 1;
        if (!sh('tee', ['/etc/wsl.conf'], next)) return 1;
        if (conf) io.log('  the previous one is kept as /etc/wsl.conf.laru-backup');
      }
      io.log('  WSL starts Docker by itself from the next start: run `wsl --shutdown` in PowerShell and open this terminal again.');
    }
  }
  if (/permission denied/i.test(err)) {
    if (!sh('usermod', ['-aG', 'docker', userInfo().username])) return 1;
    io.log('  you are in the docker group from the next terminal you open (or run `newgrp docker` in this one).');
    return 0;
  }
  if (!(systemd ? sh('systemctl', ['enable', '--now', 'docker']) : sh('service', ['docker', 'start']))) return 1;
  const again = await dockerAvailable();
  io.log(again.ok ? `✓ docker answers: engine ${again.server}` : `✕ docker still does not answer: ${again.error}`);
  return again.ok ? 0 : 1;
}

/** A scenario that would delete data of a persistent env says what, and how to say yes: nothing ran, and `undefined` comes back. */
const confirmable = <T>(io: Out, again: string, p: Promise<T>): Promise<T | undefined> =>
  p.catch((e) => { if (!(e instanceof ScenarioConfirm)) throw e; io.err(`${e.message}\nTo go ahead: ${again}`); return undefined; });

export async function runtimeCommand(cmd: string, args: string[], o: Opts, ws: () => Workspace, io: Out): Promise<number | undefined> {
  // Leftovers of ephemeral runs that ended badly go before anything else starts.
  if (['up', 'test', 'runs', 'env'].includes(cmd)) { const swept = await sweepOrphans(ws()).catch(() => []); if (swept.length && !o.json) io.err(`swept the envs of finished runs ${swept.join(', ')}`); }
  switch (cmd) {
    case 'env': {
      const w = ws();
      if (args[0] === 'init' && args[1]) {
        if (!ENV_NAME.test(args[1])) { io.err(`${args[1]}: env names are kebab-case`); return 1; }
        const f = envFile(w, args[1]);
        if (existsSync(f)) { io.err(`envs/${args[1]}.yaml already exists`); return 1; }
        if (o.join) {
          const share: Record<string, string> = Object.fromEntries((list(o.share) ?? []).map((x) => x.split('=').map((y) => y.trim()) as [string, string]));
          writeJoint(w, args[1], list(o.join)!, share);
          io.log(`envs/${args[1]}.yaml written. Next: laru up ${args[1]}`);
          return 0;
        }
        if (!o.from || !/^[a-z0-9-]+:.+/.test(String(o.from))) { io.err('usage: laru env init <name> --from <repo>:<compose file>[,<file>…] | --join <env>,<env> [--share <svc>=<svc>]'); return 2; }
        mkdirSync(join(w.root, 'envs'), { recursive: true });
        writeFileSync(f, `from: ${String(o.from)}\npersistent: true\n`);
        io.log(`envs/${args[1]}.yaml written. Next: laru up ${args[1]}`);
        return 0;
      }
      if (args[0] === 'list' || !args[0]) {
        const rows = await Promise.all(listEnvs(w).map((e) => status(w, e)));
        if (o.json) { io.log(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) io.log('No envs yet: laru env init local --from <repo>:<compose file>[,<file>…]');
        const several = w.repos.length > 1;
        for (const r of rows) {
          const projects = several ? (() => { try { return `  [${envProjects(w, r.env).join(' · ')}]`; } catch { return ''; } })() : '';
          io.log(`${r.env.padEnd(14)} ${r.state.padEnd(9)} ${r.services.filter((s) => s.health === 'healthy' || s.health === 'running').length}/${r.services.length} up${r.source ? `  ${r.sources?.join(' · ') ?? r.source}` : ''}${projects}`);
        }
        return 0;
      }
      if (args[0] === 'status') {
        const s = await status(w, pickEnv(w, args[1]), { stats: true });
        if (o.json) io.log(JSON.stringify(s, null, 2)); else printStatus(io, s);
        return s.state === 'failed' ? 1 : 0;
      }
      io.err('usage: laru env init <name> --from <repo>:<file> | env list | env status [env]'); return 2;
    }
    case 'up': {
      const w = ws();
      const env = pickEnv(w, args[0]);
      const verbose = Boolean(o.verbose);
      const onEvent = (e: EnvEvent) => {
        if (o.json) return;
        if (e.kind === 'phase') io.log(`  ${e.phase.padEnd(9)} ${secs(e.ms ?? 0).padStart(7)}  ${e.note ?? ''}`);
        else if (e.kind === 'service' && e.health !== 'waiting') io.log(`  ${ICON[e.health] ?? '·'} ${e.service} ${e.health}`);
        else if (e.kind === 'log' && (verbose || e.source === 'laru' || e.source === 'pull')) io.log(`    ${e.line}`);
      };
      try {
        const rebuild = list(o.rebuild);
        // a rebuild replaces the containers of what it rebuilds: on a persistent env that is running it needs a yes
        if (rebuild?.length && !o.yes && loadEnvSpec(w, env).persistent !== false && ['ready', 'starting'].includes((await status(w, env)).state)) {
          io.err(`${rebuildText(rebuild)}\nAdd --yes to go ahead.`);
          return 1;
        }
        const r = await up(w, { env, services: list(o.services), hybrid: list(o.hybrid), worktree: Boolean(o.worktree), onEvent, force: Boolean(o.force), rebuild });
        if (o.json) { io.log(JSON.stringify(r, null, 2)); return 0; }
        io.log(`\n${env} ready in ${secs(r.ms)}${r.changed ? '' : ' (nothing changed)'}.`);
        for (const a of r.addresses) io.log(`  ${a.service.padEnd(22)} ${a.url}`);
        for (const h of r.services.filter((s) => s.mode === 'host')) io.log(`  ${h.service} runs on this machine: laru run --env ${env} --service ${h.service} -- <command>`);
        for (const x of r.warnings) io.log(`  warning: ${x}`);
        return 0;
      } catch (e) {
        if (!(e instanceof EnvError)) throw e;
        io.err(`\n${env} did not start: ${e.message}`);
        if (e.logs?.length) { io.err(`\nlast lines of ${e.service ?? 'the build'}:`); for (const l of e.logs) io.err(`  ${l}`); }
        return 1;
      }
    }
    case 'down': {
      const w = ws();
      const env = pickEnv(w, args[0]);
      const dry = await down(w, env, { caches: Boolean(o.caches), dryRun: true });
      if (o['dry-run']) { io.log(`would remove ${dry.containers} containers, ${dry.networks} networks, ${dry.volumes} volumes${o.caches ? ' (caches included)' : ''}`); return 0; }
      const r = await down(w, env, { caches: Boolean(o.caches) });
      io.log(`${env}: removed ${r.containers} containers, ${r.networks} networks, ${r.volumes} volumes${o.caches ? '' : '; caches kept'}.`);
      if (r.left.length) { io.err(`still there: ${r.left.join(', ')}`); return 1; }
      return 0;
    }
    case 'logs': {
      const w = ws();
      const env = pickEnv(w, o.env as string);
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      await logs(w, env, { service: args[0], tail: Number(o.tail ?? 100), follow: Boolean(o.follow), signal: ac.signal }, (svc, line) => io.log(args[0] ? line : `${svc.padEnd(20)} ${line}`));
      return 0;
    }
    case 'run': {
      const w = ws();
      const env = pickEnv(w, o.env as string);
      if (!o.service || !args.length) { io.err('usage: laru run [--env e] --service <name> -- <command…>'); return 2; }
      const h = await hybridEnv(w, env, String(o.service));
      io.err(`laru: ${o.service} on this machine, listening on ${h.ports.join(', ')}; the tap sends its traffic here.`);
      for (const r of h.rewrites) io.err(`  ${r.key}: ${r.from} → ${r.to}`);
      return await new Promise<number>((resolve) => {
        const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: { ...process.env, ...h.env } });
        child.on('error', (e) => { io.err(String(e.message)); resolve(127); });
        child.on('close', (code) => resolve(code ?? 1));
      });
    }
    case 'vars': {
      const w = ws();
      const sub = args[0] ?? 'list';
      const level = (o.level as Level | undefined) ?? (o.service ? 'service' : 'app');
      if (!LEVELS.includes(level)) { io.err(`--level is one of ${LEVELS.join(', ')}`); return 2; }
      const scope = level === 'service' ? (o.service as string) : level === 'env' ? (o.env as string) : undefined;
      if (sub === 'list') {
        const env = pickEnv(w, o.env as string);
        const services = vaultServices(w, env), g = graphOrNull(w);
        const rows = varTable(w, env, services, g);
        const issues = services.length ? missingVars(w, env, services, g) : [];
        if (o.json) { io.log(JSON.stringify({ env, rows, issues }, null, 2)); return 0; }
        for (const r of rows) io.log(`${r.secret ? '🔒' : '  '} ${r.key.padEnd(34)} ${(r.effective ?? 'not set').padEnd(22)} ${r.readers.join(', ') || (r.compose.length ? `compose: ${r.compose.join(', ')}` : 'nobody reads it')}`);
        for (const i of issues) io.log(`${i.level === 'error' ? 'error' : 'warn '}  ${i.message}`);
        if (!services.length) io.log(`\n(the compose of ${env} is read at its first up; until then only the vault's own keys are listed)`);
        return issues.some((i) => i.level === 'error') ? 1 : 0;
      }
      if (sub === 'set' && args[1]) { await setVar(w, { key: args[1], value: await readValue(), level, scope, secret: Boolean(o.secret) }); io.log(`${args[1]} set at ${scope ? `${level}.${scope}` : level}${o.secret ? ', encrypted' : ''}`); return 0; }
      if (sub === 'unset' && args[1]) { const ok = await unsetVar(w, { key: args[1], level, scope }); io.log(ok ? `${args[1]} removed from ${scope ? `${level}.${scope}` : level}` : `${args[1]} was not set there`); return ok ? 0 : 1; }
      if (sub === 'reveal' && args[1]) { const v = await revealVar(w, pickEnv(w, o.env as string), args[1], o.service as string); if (v === null) { io.err(`${args[1]} has no value`); return 1; } io.log(v); return 0; }
      if (sub === 'import' && args[1]) {
        const r = await importEnvFile(w, args[1], { env: o.env as string | undefined });
        for (const x of r.imported) io.log(`  ${x.secret ? '🔒' : '  '} ${x.key}`);
        if (r.skipped.length) io.log(`  already set, kept: ${r.skipped.join(', ')}`);
        for (const x of r.warnings) io.log(`  warning: ${x}`);
        io.log(`${r.imported.length} imported from ${args[1]} at the ${r.level === 'app' ? 'app level' : `${r.level} level`}; the repo was not touched.`);
        return 0;
      }
      io.err('usage: laru vars [list] [--env e] | set <KEY> [--level app|env|service|flows|personal] [--env e] [--service s] [--secret] (value on stdin) | unset <KEY> | reveal <KEY> | import <repo>:<file>'); return 2;
    }
    case 'db': {
      const w = ws();
      const env = pickEnv(w, o.env as string);
      const sub = args[0] ?? 'schema';
      if (sub === 'list') {
        for (const s of await dbStores(w, env)) io.log(`${s.service.padEnd(16)} ${s.kind.padEnd(9)} ${s.user}@${s.db}  ${s.hostPort ? `127.0.0.1:${s.hostPort}` : 'not published'}`);
        for (const s of await mongo.mongoStores(w, env)) io.log(`${s.service.padEnd(16)} ${'mongo'.padEnd(9)} ${s.user ?? '(no user)'}@admin  ${mongo.connection(s).url ?? 'not published'}`);
        return 0;
      }
      const store = await storeOf(w, env, o.service as string);
      if (sub === 'schema') {
        const tables = await dbSchema(store);
        if (o.json) { io.log(JSON.stringify(tables, null, 2)); return 0; }
        for (const t of tables) io.log(`${`${t.schema}.${t.name}`.padEnd(40)} ${t.rows === null ? '      ?' : String(t.rows).padStart(7)} rows  ${t.columns.map((c) => `${c.pk ? '*' : ''}${c.name}`).join(', ')}`);
        return 0;
      }
      if (sub === 'query') {
        const sql = args[1] === '-' || !args[1] ? readFileSync(0, 'utf8') : args.slice(1).join(' ');
        const r = await dbQuery(store, sql, { write: Boolean(o.write), limit: Number(o.limit ?? 200) });
        if (o.json) { io.log(JSON.stringify(r, null, 2)); return 0; }
        if (r.columns.length) io.log(r.columns.join('\t'));
        for (const row of r.rows) io.log(row.map((v) => (v === null ? 'NULL' : v)).join('\t'));
        io.err(`${r.rows.length} rows${r.truncated ? ' (more not shown)' : ''} in ${r.ms} ms, as ${o.write ? store.user : 'ks_reader'}`);
        return 0;
      }
      if (sub === 'conn') {
        const c = connection(store, w.app);
        if (o.json) { io.log(JSON.stringify(c, null, 2)); return 0; }
        io.log(`host ${c.host}${c.port ? `:${c.port}` : ' (not published: ephemeral env)'}\ndb   ${c.db}\nuser ${c.user}${c.jdbc ? `\njdbc ${c.jdbc}` : ''}\nshell ${c.shell}\npassword: laru db password${o.service ? ` --service ${o.service}` : ''}`);
        return 0;
      }
      if (sub === 'password') { io.log((await storePassword(store)) ?? ''); return 0; }
      io.err('usage: laru db [list | schema | query "<sql>"|- [--write] | conn | password] [--env e] [--service s]'); return 2;
    }
    case 'snapshot': case 'reset': {
      const w = ws();
      const env = pickEnv(w, args[0] ?? (o.env as string));
      const targets = o.service ? [await storeOf(w, env, String(o.service))] : (await dbStores(w, env)).filter((s) => s.kind === 'postgres');
      if (!targets.length) { io.err(`${env} has no running Postgres`); return 1; }
      // under the env's lock: an up or a run of this env waits, and so does this for them
      await withLock(`${cmd} ${w.app}/${env}`, async () => {
        for (const s of targets) {
          if (cmd === 'snapshot') { const r = await dbSnapshot(s); io.log(`${s.service}: «base» of ${s.db} taken in ${r.ms} ms (${Math.round(r.bytes / 2 ** 20)} MB)`); }
          else { const r = await dbReset(s); io.log(`${s.service}: ${s.db} back to «base» in ${r.ms} ms`); }
        }
      }, (holder) => io.err(`waiting for ${holder} to finish`), envLock(w, env));
      return 0;
    }
    case 'flow': {
      const w = ws();
      if (args[0] === 'list' || !args[0]) {
        const last = lastResults(w);
        for (const f of listFlows(w)) io.log(`${f.exists ? '●' : '○'} ${f.slug.padEnd(28)} ${String(f.steps.length).padStart(2)} steps  ${last[f.slug] ?? 'never run'}${f.exists ? '' : `  (no spec: laru flow scaffold ${f.id})`}`);
        return 0;
      }
      if (args[0] === 'scaffold' && args[1]) {
        const k = loadKnowledge(w);
        const id = args[1].startsWith('flow:') ? args[1] : `flow:${args[1]}`;
        const p = k.byId.get(id);
        if (!p || p.type !== 'flow') { io.err(`no flow ${id}`); return 1; }
        const file = join(w.root, specPath(p));
        if (existsSync(file)) { io.err(`${specPath(p)} already exists; the scaffold never overwrites a spec`); return 1; }
        writeFileSync(file, scaffoldSpec(p));
        io.log(`${specPath(p)} written UI first: a prepare() per row of Precondiciones, a step() per row of Pasos. Fill every '…' and todo() to guide:flujos-e2e, run it with laru test until only its // app: expect.soft fail, then laru check`);
        return 0;
      }
      if (args[0] === 'env' && args[1]) {
        const slug = args[1].replace(/^flow:/, '');
        if (o.down) {
          const r = await flowEnvDown(w, slug);
          io.log(`${instanceOf(slug)}: removed ${r.containers} containers, ${r.networks} networks, ${r.volumes} volumes.`);
          if (r.left.length) { io.err(`still there: ${r.left.join(', ')}`); return 1; }
          return 0;
        }
        if (args[2] === 'status') { io.log(JSON.stringify(await flowEnvStatus(w, slug), null, 2)); return 0; }
        const onEvent = (e: EnvEvent) => { if (!o.json && e.kind === 'phase') io.log(`  ${e.phase.padEnd(9)} ${secs(e.ms ?? 0).padStart(7)}  ${e.note ?? ''}`); };
        try {
          const r = await flowEnvUp(w, slug, { from: o.from as string | undefined, onEvent, stopOffered: Boolean(o.yes) });
          io.log(`\n${r.instance} (from ${r.base}) ready in ${secs(r.ms)}.${r.scenario ? ` Scenario ${r.scenario.slug} in, ${r.scenario.mode === 'snapshot' ? 'restored' : 'played'} in ${secs(r.scenario.ms)}.` : ''}${r.stopped ? ` ${r.stopped} was stopped to make room.` : ''}`);
          for (const a of r.addresses) io.log(`  ${a.service.padEnd(22)} ${a.url}`);
          io.log(`Play it here: laru test ${slug} --env ${r.instance}    Remove it: laru flow env ${slug} --down`);
          return 0;
        } catch (e) {
          if (!(e instanceof EnvError)) throw e;
          io.err(`\n${instanceOf(slug)} did not start: ${e.message}${e.admission?.offer ? '\nTo stop it and go ahead: add --yes' : ''}`);
          return 1;
        }
      }
      io.err('usage: laru flow list | flow scaffold <flow:id> | flow env <flow> [--from env] [--yes] | flow env <flow> --down | flow env <flow> status'); return 2;
    }
    case 'test': {
      const w = ws();
      let flows = args;
      let worktree = Boolean(o.worktree);
      // «Recargar y repetir» is both together: what the change affects and what failed unexpectedly, once each.
      const picked = new Set(flows);
      if (o.failed) {
        const failed = failedFlows(w, o.env as string | undefined);
        if (!o.json) io.log(`failed unexpectedly last time: ${failed.join(', ') || 'none'}`);
        failed.forEach((f) => picked.add(f));
      }
      if (o.affected) {
        const im = await affected(w);
        if (!o.json) io.log(`affected: ${im.flows.length ? im.flows.map((f) => `${f.id} (${f.why[0]})`).join(', ') : 'none'}`);
        im.flows.forEach((f) => picked.add(f.id.replace(/^flow:/, '')));
        worktree = worktree || im.changes.length > 0;
      }
      if ((o.failed || o.affected) && !picked.size) return 0;
      flows = [...picked];
      // No --env: the smallest env that runs every project the flows need (local, with one project).
      const env = (o.env as string | undefined) ?? (await runEnv(w, flows));
      if (!o.json && !o.env && w.repos.length > 1) io.log(`  env ${env}`);
      const r = await confirmable(io, 'the same command with --yes', runFlows(w, {
        env, flows, ephemeral: Boolean(o.ephemeral), retries: o.retries ? Number(o.retries) : undefined, pwTrace: Boolean(o['pw-trace']), id: o.run as string | undefined, cache: !o['no-cache'], worktree, workers: o.workers ? Number(o.workers) : undefined, confirm: Boolean(o.yes),
        onEvent: (e) => {
          if (o.json) return;
          if (e.e === 'phase') io.log(`  ${e.phase}`);
          else if (e.e === 'test-begin') io.log(`  ▶ ${e.title}`);
          else if (e.e === 'step-end') io.log(`    ${e.status === 'passed' ? '✓' : '✕'} ${e.title}${e.error ? `: ${e.error}` : ''}`);
          else if (e.e === 'test-end' && e.status !== 'passed') io.log(`  ✕ ${e.status}${e.error ? `: ${e.error}` : ''}`);
        },
      }));
      if (!r) return 1;
      if (o.json) { io.log(JSON.stringify(r, null, 2)); return r.status === 'passed' ? 0 : 1; }
      const traces = runTraces(w, r.id);
      io.log('\n' + summarize(r, traces, { budget: 900 }));
      io.log(`\nevidence: ${join(runsDir(w), r.id)}`);
      return r.status === 'passed' ? 0 : 1;
    }
    case 'behavior': {
      const w = ws();
      const [sub, flow] = args;
      if (!flow || !['show', 'diff', 'approve'].includes(sub)) { io.err('usage: laru behavior show|diff|approve <flow> [--run id | --runs a,b,c | --last n]'); return 2; }
      if (sub === 'approve') {
        const r = approveBehavior(w, flow, { run: o.run as string | undefined, runs: o.runs ? String(o.runs).split(',') : undefined, last: o.last ? Number(o.last) : undefined });
        io.log(`${flow}: ${r.hops} hops approved from ${r.runs.length > 1 ? `runs ${r.runs.join(', ')}, and ${r.sometimes} more as «sometimes»` : `run ${r.run}`}${r.soft ? `, with ${r.soft} step(s) whose soft checks failed (the app's own deviations)` : ''}\n  ${r.file}: commit it with the change that made it`);
        return 0;
      }
      const a = readApproved(w, flow);
      if (sub === 'show') {
        if (!a) { io.log(`${flow} has no approved behavior: laru behavior approve ${flow}`); return 0; }
        io.log(`${a.flow}, approved from run ${a.approved.run} (${a.approved.at.slice(0, 10)})`);
        for (const s of a.steps) { io.log(`«${s.step}»`); for (const h of s.hops) io.log(`  ${h}${s.causes[h] ? `  ⟵ ${s.causes[h]}` : ''}`); }
        return 0;
      }
      if (!a) { io.err(`${flow} has no approved behavior to compare with`); return 1; }
      const { driftOf } = await import('@laru/trace');
      const runId = (o.run as string | undefined) ?? listRuns(w, 200).find((r) => r.results[flow.replace(/^flow:/, '')] && r.results[flow.replace(/^flow:/, '')].status !== 'cached')?.id;
      if (!runId) { io.err(`${flow} has no run to compare`); return 1; }
      const d = driftOf(a, behaviorIn(w, runId, flow).behavior);
      io.log(d.length ? `run ${runId}: ${d.length} hop(s) differ from run ${a.approved.run}` : `run ${runId} does what run ${a.approved.run} approved`);
      for (const x of d) io.log(`  «${x.step}» ${x.kind === 'missing' ? '−' : x.kind === 'new' ? '+' : '~'} ${x.hop}${x.kind === 'cause' ? `: ⟵ ${x.was} → ${x.now}` : ''}`);
      return d.length ? 1 : 0;
    }
    case 'fidelity': {
      const w = ws();
      io.log(fidelityText(fidelity(w, pickEnv(w, args[0] ?? (o.env as string | undefined)))));
      return 0;
    }
    case 'scenario': {
      const w = ws();
      const [sub = 'list', name] = args;
      const env = pickEnv(w, o.env as string | undefined);
      if (sub === 'list') {
        for (const s of listScenarios(w)) {
          const st = scenarioState(w, env, s.slug);
          io.log(`${s.id.padEnd(30)} ${s.title}${s.extends ? `  (extends ${s.extends})` : ''}${s.setup ? '' : s.extends ? '' : '  (no setup yet)'}`);
          io.log(`  ${!st ? 'never provisioned' : st.broken ? `broken: ${st.broken.split('\n')[0]}` : `${st.mode === 'snapshot' ? 'from snapshots' : `setup played again each time (keeps ${st.keeps.join(', ')})`}, provisioned ${st.provisionedAt.slice(0, 16).replace('T', ' ')} in ${secs(st.ms)}`}`);
        }
        return 0;
      }
      if ((sub === 'apply' || sub === 'provision') && name) {
        if (sub === 'provision') { const st = await confirmable(io, `laru scenario provision ${name} --env ${env} --yes`, provisionScenario(w, name, { env, confirm: Boolean(o.yes) })); if (!st) return 1; io.log(st.broken ? `${name} is broken: ${st.broken}` : `${name} provisioned in ${secs(st.ms)}: wrote ${st.touched.join(', ') || 'nothing'}; ${st.mode === 'snapshot' ? 'applies from snapshots' : `plays its setup again on every apply (${st.keeps.join(', ')} cannot be put back)`}`); return st.broken ? 1 : 0; }
        const r = await confirmable(io, `laru scenario apply ${name} --env ${env} --yes`, applyScenario(w, name, { env, confirm: Boolean(o.yes) }));
        if (!r) return 1;
        io.log(`${name} applied on ${r.env} in ${secs(r.ms)}${r.provisioned ? ' (its setup played)' : ' (from snapshots)'}`);
        if (r.keeps.length) io.log(`  ${r.keeps.join(', ')} keep what they had before: they have no snapshot`);
        for (const i of r.identities) io.log(`  ${i.name}: ${i.username ?? i.email ?? ''}${i.password ? " (password: the one its setup made, not shown here)" : ''}`);
        return 0;
      }
      io.err('usage: laru scenario [list] | apply <scn:x> [--env e] | provision <scn:x> [--env e]'); return 2;
    }
    case 'session': {
      const w = ws();
      const [sub, id] = args;
      if (sub === 'start') {
        const env = pickEnv(w, o.env as string | undefined);
        const r = await confirmable(io, `laru session start --env ${env} --scenario ${o.scenario}${o.title ? ` --title ${JSON.stringify(o.title)}` : ''}${o.browser ? ' --browser' : ''} --yes`, startSession(w, { env, title: o.title as string | undefined, scenario: o.scenario as string | undefined, confirm: Boolean(o.yes) }));
        if (!r) return 1;
        if (o.browser) openSessionBrowser(w, r.id);
        io.log(`session ${r.id} open on ${r.env}: ${o.browser ? 'the app opens inside «En vivo» (laru open; laru session browser reopens it)' : `use the app through its addresses (laru env status ${r.env}), or open its browser: laru session browser ${r.id}`}`);
        io.log(`  mark what you do:  laru session mark ${r.id} "<what>"\n  see it so far:     laru session show ${r.id}\n  keep it:           laru session stop ${r.id}`);
        return 0;
      }
      if (sub === 'to-flow' && id) {
        if (!o.in) { io.err('usage: laru session to-flow <id> --in <mod:x|proc:y> [--title t]'); return 2; }
        const r = await sessionToFlow(w, id, { in: String(o.in), title: o.title as string | undefined });
        for (const i of r.issues) io.err(`  ${i.level} ${i.at}: ${i.message}`);
        if (!r.ok) return 1;
        io.log(`${r.id} drafted: ${r.spec}; laru check says ${r.checks.length} thing(s) to write:`);
        for (const c of r.checks) io.log(`  ${c.line ? `${r.spec}:${c.line}` : r.spec} ${c.key}: ${c.message}`);
        return 0;
      }
      if (sub === 'to-scenario' && id) {
        if (!o.in) { io.err('usage: laru session to-scenario <id> --in <mod:x|app:y> [--title t]'); return 2; }
        const r = await sessionToScenario(w, id, { in: String(o.in), title: o.title as string | undefined });
        for (const i of r.issues) io.err(`  ${i.level} ${i.at}: ${i.message}`);
        if (!r.ok) return 1;
        io.log(`${r.id} drafted: ${r.setup}; write its '…' and todo(), say who can sign in, then laru scenario provision ${r.id} --env <env>`);
        return 0;
      }
      if (sub === 'browser' && id) { await runSessionBrowser(w, id); io.log(`the browser of session ${id} closed`); return 0; }
      if (sub === 'mark' && id) { const m = markSession(w, id, args.slice(2).join(' ')); io.log(`mark ${m.n} at ${new Date(m.t).toISOString().slice(11, 19)}`); return 0; }
      if (sub === 'show' && id) { const { run, trace } = await sessionTrace(w, id); io.log(sessionSummary(run, trace, Number(o.since ?? 0), Number(o.budget ?? 900))); return 0; }
      if (sub === 'stop' && id) {
        const r = await stopSession(w, id);
        if (r.status === 'error') { io.err(`session ${id} could not be kept: ${r.error}`); return 1; }
        io.log(`session ${id} kept: ${r.results.session?.steps ?? 0} marks, ${secs(r.results.session?.ms ?? 0)}; laru runs show ${id} · ${join(runsDir(w), id)}`);
        return 0;
      }
      io.err('usage: laru session start [--env e] [--title t] [--browser] | browser <id> | to-flow <id> --in <container> | mark <id> "<what>" | show <id> [--since ms] | stop <id>'); return 2;
    }
    case 'runs': {
      const w = ws();
      const sub = args[0] ?? 'list';
      if (sub === 'list') { for (const r of listRuns(w, Number(o.limit ?? 20))) io.log(`${r.id.padStart(4)} ${r.status.padEnd(11)} ${r.env.padEnd(8)} ${r.startedAt.slice(0, 19).replace('T', ' ')}  ${Object.entries(r.results).map(([f, x]) => `${x.status === 'passed' ? '✓' : x.status === 'cached' ? '=' : '✕'}${f}`).join(' ') || r.flows.join(' ')}`); return 0; }
      if (sub === 'show' && args[1]) {
        const r = readRun(w, args[1]);
        if (!r) { io.err(`no run ${args[1]}`); return 1; }
        const traces = runTraces(w, r.id);
        io.log(summarize(r, traces, { flow: o.flow as string, step: o.step ? Number(o.step) : undefined, exchange: o.exchange as string, service: o.service as string, budget: Number(o.budget ?? 900) }));
        return 0;
      }
      if (sub === 'share') {
        // The last pass of each flow becomes its shared evidence (evidence/<flow>/): for runs from before Laru kept it.
        const f = join(runsDir(w), 'index.jsonl');
        const last = new Map<string, string>();
        if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); if (x.status === 'passed' && (!args[1] || args.slice(1).includes(x.flow))) last.set(x.flow, x.run); }
        for (const [flow, run] of last) io.log(`${shareEvidence(w, run, flow) ? '✓' : '='} ${flow}  run ${run}`);
        io.log(last.size ? `evidence/: commit it to share the last pass of each flow with the team` : 'no flow has passed yet');
        return 0;
      }
      if (sub === 'cancel' && args[1]) { io.log((await cancelRun(w, args[1])) ? `run ${args[1]} cancelled` : `run ${args[1]} is not running`); return 0; }
      if (sub === 'compare' && args[1] && args[2]) {
        const c = compareRuns(w, args[1], args[2]);
        for (const x of c.exchanges) if (JSON.stringify(x.a) !== JSON.stringify(x.b)) io.log(`${x.flow}  ${x.from}→${x.to} ${x.label}: ${x.a ? `${x.a.count}× ${x.a.statuses.join('/')} p50 ${x.a.p50 ?? '-'} ms` : 'absent'}  →  ${x.b ? `${x.b.count}× ${x.b.statuses.join('/')} p50 ${x.b.p50 ?? '-'} ms` : 'absent'}`);
        return 0;
      }
      io.err('usage: laru runs [list] | share [flow…] | show <id> [--flow f] [--step n | --exchange id | --service s] | cancel <id> | compare <a> <b>'); return 2;
    }
    case 'impact': {
      const w = ws();
      const im = await affected(w);
      if (o.json) { io.log(JSON.stringify(im, null, 2)); return 0; }
      io.log(renderImpact(im, Number(o.budget ?? 1200)));
      return 0;
    }
    case 'findings': {
      const w = ws();
      if (args[0] === 'accept' && args[1]) {
        if (!o.reason) { io.err('usage: laru findings accept <key> --reason "<why>" [--until YYYY-MM-DD]'); return 2; }
        acceptFinding(w, args[1], { reason: String(o.reason), until: o.until as string | undefined, by: process.env.USER });
        io.log(`${args[1]} accepted in findings.yaml`);
        return 0;
      }
      const list = await findingsOf(w, o.env as string | undefined);
      if (o.json) { io.log(JSON.stringify(list, null, 2)); return 0; }
      const open = list.filter((f) => !f.accepted);
      for (const f of open) io.log(`${f.severity === 'error' ? '✕' : f.severity === 'warning' ? '!' : '·'} ${f.type.padEnd(19)} ${f.message}${f.evidence ? `  (${f.evidence})` : ''}`);
      io.log(`\n${open.length} open, ${list.length - open.length} accepted. Accept one: laru findings accept <key> --reason "…"`);
      return open.some((f) => f.severity === 'error') ? 1 : 0;
    }
    case 'hook': {
      // Claude Code passes the event as JSON on stdin; silence (exit 0, no output) unless there is something to say.
      const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
      const root = findWorkspace(input.cwd ?? process.cwd());
      if (!root) return 0;
      const w = loadWorkspace(root);
      const out = args[0] === 'pre-edit' ? preEdit(w, input) : args[0] === 'post-edit' ? postEdit(w, input) : null;
      if (out) io.log(JSON.stringify(out));
      return 0;
    }
    case 'calibrate': {
      const w = ws();
      io.log('playing the calibration test 3 times (a magenta frame at a known instant)…');
      const r = await calibrate(w, Number(o.runs ?? 3));
      io.log(`offsets ${r.offsets.join(', ')} ms; mean ${r.mean} ms, spread ${r.spread} ms`);
      if (r.spread > 100) io.err('the spread is over 100 ms: per-run marker detection would be needed for this machine');
      writeConfig({ videoOffsetMs: r.mean });
      io.log(`videoOffsetMs: ${r.mean} saved in ~/.laru/config.yaml`);
      return 0;
    }
    case 'mail': {
      // the env's mailbox: what its sinks received (nothing leaves the machine)
      const w = ws();
      const sub = args[0] ?? 'list';
      const env = pickEnv(w, (sub === 'enable' ? args[1] : undefined) ?? (o.env as string | undefined));
      const when = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
      if (sub === 'list') {
        const r = mail.list(w, env, { kind: o.kind === 'mail' || o.kind === 'sms' ? o.kind : 'all', query: o.q as string | undefined, limit: Number(o.limit ?? 50) });
        if (o.json) { io.log(JSON.stringify(r, null, 2)); return 0; }
        io.log(`${env}: ${r.counts.mail} mail, ${r.counts.sms} SMS`);
        for (const m of r.messages) io.log(`${m.id.slice(0, 8)}  ${when(m.t)}  ${m.kind.padEnd(4)} ${(m.kind === 'sms' ? `${m.from} → ${m.to}` : `→ ${m.to}`).slice(0, 40).padEnd(40)} ${m.subject.slice(0, 50)}${m.codes.length ? `  code ${m.codes.join(', ')}` : ''}${m.status === 'accepted' || m.status === 'delivered' ? '' : `  [${m.status}]`}`);
        return 0;
      }
      if (sub === 'status') {
        const s = mail.sinkReport(w, env);
        if (!s.hasSinks) io.log(`${env} has no mail or SMS sink; laru mail enable ${env} shows what it would add`);
        io.log(`internet access: ${s.egress === 'closed' ? 'closed (what Laru builds sees only this env\'s network)' : 'open'}`);
        for (const k of s.sinks) io.log(`${k.name}  ${k.kind === 'smtp' ? `SMTP, in the env ${k.containerPorts.join(' ')}${k.ports.length ? `; from this Mac ${k.ports.map((p) => `127.0.0.1:${p.host}`).join(' ')}` : ''}` : 'SMS (Twilio API)'}`);
        for (const d of mail.detected(w, env)) io.log(`${d.intercepted ? 'received ' : d.kind === 'http' ? 'NOT SERVED' : 'real mail or SMS can leave'}  ${d.name} (${d.provider}) by ${d.services.join(', ')}`);
        return 0;
      }
      if (sub === 'read' && args[1]) {
        const id = mail.list(w, env, { limit: 500 }).messages.find((m) => m.id.startsWith(args[1]))?.id ?? args[1];
        const m = mail.message(w, env, id);
        if (!m) { io.err(`no message ${args[1]}`); return 1; }
        const part = String(o.part ?? 'text');
        if (part === 'source') { io.log(mail.part(w, env, id, 'eml').body.toString('latin1')); return 0; }
        if (part === 'html') { io.log(mail.part(w, env, id, 'html').body.toString()); return 0; }
        if (part === 'headers') { for (const [k, v] of m.headers) io.log(`${k}: ${v}`); return 0; }
        io.log(`${m.kind === 'sms' ? `${m.from} → ${m.to}` : `${m.from} → ${m.to}\n${m.subject}`}\n\n${m.text ?? ''}`);
        if (m.links.length) io.log(`\nlinks (as received, unmasked):\n${m.links.map((l) => `  ${l.class.padEnd(12)} ${l.url}`).join('\n')}`);
        if (m.codes.length) io.log(`codes (unmasked): ${m.codes.join(', ')}`);
        return 0;
      }
      if (sub === 'wait') {
        const hit = await mail.wait(w, env, { query: `${o.to ? `para:${o.to} ` : ''}${(o.q ?? '') as string}`.trim(), ms: Number(o.within ?? 15) * 1000 });
        if (!hit) { io.err('nothing arrived'); return 1; }
        io.log(`${hit.id}  ${hit.kind}  ${hit.subject}${hit.codes.length ? `  code ${hit.codes.join(', ')}` : ''}`);
        return 0;
      }
      if (sub === 'clear') {
        const ids = args.slice(1);
        const n = mail.list(w, env).counts.all;
        if (!o.yes) { io.log(ids.length ? `would delete ${ids.length} message(s) of ${env}; add --yes` : `would delete the ${n} message(s) of ${env}; add --yes`); return 0; }
        await (ids.length ? mail.remove(w, env, ids) : mail.clear(w, env));
        io.log(ids.length ? `${ids.length} deleted` : `the mailbox of ${env} is empty`);
        return 0;
      }
      if (sub === 'enable') {
        const r = mail.enable(w, env, { as: o.as as string | undefined, confirm: Boolean(o.yes) });
        io.log(`${r.file}: ${Object.keys(r.mocks).length ? Object.entries(r.mocks).map(([n, m]) => `${n} → ${m.sink} sink`).join(', ') : 'nothing to add'}`);
        for (const n of r.notes) io.log(`  ${n}`);
        if (Object.keys(r.mocks).length && !r.wrote) io.log('add --yes to write it, then laru up');
        return 0;
      }
      io.err('usage: laru mail [list [--kind mail|sms] [--q "de:x asunto:y"] [--json]] | status | read <id> [--part text|html|source|headers] | wait [--to x] [--within s] | clear [id…] [--yes] | enable [env] [--as name] [--yes]   (--env e)'); return 2;
    }
    case 'sms': {
      const w = ws(), env = pickEnv(w, o.env as string);
      const sub = args[0];
      if (sub === 'status' && args[1] && args[2]) { io.log(JSON.stringify(await mail.smsStatus(w, env, args[1], args[2] as 'delivered', o.code ? Number(o.code) : undefined))); return 0; }
      if (sub === 'reply' && args[1] && args[2]) { io.log(JSON.stringify(await mail.smsReply(w, env, args[1], args.slice(2).join(' ')))); return 0; }
      io.err('usage: laru sms status <id> sent|delivered|undelivered|failed [--code 30003] | reply <from number> <text…>   (--env e)'); return 2;
    }
    case 'fault': {
      const w = ws(), env = pickEnv(w, o.env as string);
      const sub = args[0] ?? 'list';
      if (sub === 'list') { const r = readRules(w, env); const all = Object.entries(r.faults); if (!all.length) io.log('no faults'); for (const [svc, rs] of all) for (const f of rs) io.log(`${svc.padEnd(22)} ${JSON.stringify(f)}`); return 0; }
      if (sub === 'set' && args[1]) {
        const n = (k: string) => (o[k] === undefined ? undefined : Number(o[k]));
        const rule = { latency: n('latency'), status: n('status'), abort: o.abort ? true : undefined, timeout: o.timeout ? true : undefined, bandwidth: n('bandwidth'), slowAfter: n('slow-after'), code: n('code'), p: n('p'), from: o.from as string | undefined, path: o.path as string | undefined, method: (o.method as string | undefined)?.toUpperCase() };
        const clean = Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined));
        if (!['latency', 'status', 'abort', 'timeout', 'bandwidth', 'code'].some((k) => k in clean)) { io.err('a fault needs --latency ms, --status n, --abort, --timeout, --bandwidth bytes/s or --code n'); return 2; }
        setFaults(w, env, args[1], [clean]);
        io.log(`${args[1]}: ${JSON.stringify(clean)} (live; laru fault save keeps it in envs/${env}.yaml)`);
        return 0;
      }
      if (sub === 'clear') { clearFaults(w, env, args[1]); io.log(args[1] ? `faults of ${args[1]} cleared` : 'all faults cleared'); return 0; }
      if (sub === 'save') { saveFaults(w, env); io.log(`faults saved in envs/${env}.yaml`); return 0; }
      io.err('usage: laru fault [list] | set <service> [--latency ms] [--status n] [--abort] [--timeout] [--bandwidth B/s] [--slow-after bytes] [--code n] [--p 0.2] [--from svc] [--path re] [--method M] | clear [service] | save'); return 2;
    }
    case 'mock': {
      const w = ws(), env = pickEnv(w, o.env as string);
      if (!args[0] || args[0] === 'list') { const r = readRules(w, env); const all = Object.entries(r.mocks); if (!all.length) io.log(`no mocks in ${env}`); for (const [svc, m] of all) io.log(`${svc.padEnd(22)} ${m.mode}${m.real ? ` → ${m.real}` : ''}`); return 0; }
      if (args[1]) { setMockMode(w, env, args[0], args[1] as never); io.log(`${args[0]} is now ${args[1]} (live)`); return 0; }
      io.err('usage: laru mock [list] | mock <service> <contract|record|simulate|spy|script>'); return 2;
    }
    case 'queue': {
      const w = ws(), env = pickEnv(w, o.env as string);
      const sub = args[0] ?? 'topics';
      if ((await pickBroker(w, env, o.broker as string | undefined)) === 'rabbitmq') {
        const r = await rabbit.rabbitOf(w, env);
        if (sub === 'topics') {
          const [qs, bs] = await Promise.all([rabbit.queues(r), rabbit.bindings(r, envMasker(w, env))]);
          for (const q of qs) {
            io.log(`${q.name.padEnd(28)} ${String(q.messages).padStart(6)} messages, ${q.consumers} consumers${q.durable ? '' : ', transient'}`);
            for (const b of bs.filter((x) => x.destination_name === q.name && x.source_name)) io.log(`  ← ${b.source_name}${b.routing_key ? ` (${b.routing_key})` : ''}`);
          }
          return 0;
        }
        if (sub === 'peek' && args[1]) { for (const x of await rabbit.get(r, args[1], envMasker(w, env), Number(o.limit ?? 5), Boolean(o.reorder))) io.log(`${x.exchange || '(default)'} ${x.routing_key}${x.redelivered ? ' redelivered' : ''}${x.truncated ? ' (first 50 KB)' : ''} ${x.payload}`); return 0; }
        if (sub === 'publish' && args[1]) {
          const routed = await rabbit.publish(r, (o.exchange as string | undefined) ?? '', args[1], readFileSync(0, 'utf8').trim());
          io.log(routed ? `published to ${args[1]}` : `not routed: nothing is bound to ${args[1]}${o.exchange ? ` on ${o.exchange}` : ''}`);
          return routed ? 0 : 1;
        }
        io.err('usage: laru queue --broker rabbitmq [topics] | peek <queue> [--limit n] [--reorder] (put back, marked redelivered; a quorum queue puts them at its end: --reorder) | publish <routing key> [--exchange x] (payload on stdin)'); return 2;
      }
      const b = await kafka.brokerOf(w, env);
      if (sub === 'topics') {
        const [ts, gs] = await Promise.all([kafka.topics(b), kafka.groups(b)]);
        for (const t of ts) {
          io.log(`${t.name.padEnd(28)} ${String(t.messages).padStart(6)} messages in ${t.partitions.length} partitions`);
          const byGroup = new Map<string, number>();
          for (const g of gs.filter((x) => x.topic === t.name)) byGroup.set(g.group, (byGroup.get(g.group) ?? 0) + (g.lag ?? 0));
          for (const [g, lag] of byGroup) io.log(`  ${g.padEnd(26)} lag ${lag}`);
        }
        return 0;
      }
      if (sub === 'peek' && args[1]) { for (const m of await kafka.peek(w, env, b, args[1], Number(o.limit ?? 10))) io.log(`${new Date(m.t).toISOString().slice(11, 23)} ${m.topic}/${m.partition}@${m.offset}${m.key ? ` key=${m.key}` : ''} ${m.value ?? ''}`); return 0; }
      if (sub === 'publish' && args[1]) { await kafka.publish(b, args[1], readFileSync(0, 'utf8').trim(), o.key as string | undefined); io.log(`published to ${args[1]}`); return 0; }
      io.err('usage: laru queue [topics] | peek <topic> [--limit n] | publish <topic> [--key k] (value on stdin)'); return 2;
    }
    case 'redis': {
      const w = ws(), env = pickEnv(w, o.env as string), s = await redis.redisOf(w, env, o.service as string | undefined), m = envMasker(w, env);
      const sub = args[0] ?? 'keys';
      if (sub === 'keys') { for (const k of await redis.scan(s, m, args[1] ?? '*', Number(o.limit ?? 500))) io.log(k); return 0; }
      if (sub === 'get' && args[1]) {
        const v = await redis.read(s, args[1], m);
        if (o.json) { io.log(JSON.stringify(v, null, 2)); return 0; }
        if (v.type === 'none') { io.err(`${args[1]} does not exist`); return 1; }
        const shown = v.value && typeof v.value === 'object' ? Object.keys(v.value).length : 0;
        const size = v.size === undefined ? '' : `, ${shown < v.size ? `${shown} shown of ` : ''}${v.size} ${v.type === 'stream' ? 'entries' : 'items'}`;
        io.err(`${v.type}, ${v.ttl < 0 ? 'no expiry' : `expires in ${v.ttl} s`}${size}${v.cut ? (v.type === 'string' ? ', first 64 KB' : ', items past 8 KB cut') : ''}${v.capped ? ', entries past 100 fields show their first 100' : ''}`);
        io.log(typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2));
        return 0;
      }
      if (sub === 'del' && args[1]) { const ok = await redis.del(s, args[1]); io.log(ok ? `${args[1]} deleted` : `${args[1]} did not exist`); return ok ? 0 : 1; }
      io.err('usage: laru redis [keys [pattern]] | get <key> | del <key>  [--env e] [--service s]'); return 2;
    }
    case 'mongo': {
      const w = ws(), env = pickEnv(w, o.env as string), s = await mongo.mongoOf(w, env, o.service as string | undefined);
      const sub = args[0] ?? 'dbs';
      if (sub === 'dbs') { for (const d of await mongo.dbs(s)) io.log(`${d.name.padEnd(28)} ${String(Math.round(d.sizeOnDisk / 1024)).padStart(9)} KB${d.empty ? '  empty' : ''}`); return 0; }
      if (sub === 'collections' && args[1]) {
        for (const c of await mongo.collections(s, args[1])) io.log(`${c.name.padEnd(28)} ${c.count === null ? c.type.padStart(9) : String(c.count).padStart(9)}  ${c.indexes.map((i) => `${i.unique ? 'unique ' : ''}${Object.entries(i.key).map(([k, d]) => `${k}:${d}`).join(',')}`).join('  ')}`);
        return 0;
      }
      if (sub === 'find' && args[2]) {
        const r = await mongo.find(s, { db: args[1], collection: args[2], filter: o.filter as string | undefined, sort: o.sort as string | undefined, projection: o.projection as string | undefined, limit: o.limit ? Number(o.limit) : undefined, skip: o.skip ? Number(o.skip) : undefined }, envMasker(w, env));
        for (const d of r.docs) io.log(JSON.stringify(d));
        io.err(`${r.docs.length} documents${r.more ? ' (more: --skip)' : ''} in ${r.ms} ms, ${s.user ? 'as ks_reader' : 'with no user: this Mongo has no access control'}`);
        return 0;
      }
      if (sub === 'get' && args[3]) { const d = await mongo.get(s, args[1], args[2], args[3], envMasker(w, env)); if (d === null) { io.err(`no document with _id ${args[3]}`); return 1; } io.log(JSON.stringify(d, null, 2)); return 0; }
      if (sub === 'conn') { const c = mongo.connection(s); io.log(`${c.url ? `url   ${c.url}` : 'host  127.0.0.1 (not published: ephemeral env)'}\nuser  ${c.user ?? '(none: no access control)'}\nshell ${c.shell}`); return 0; }
      io.err('usage: laru mongo [dbs] | collections <db> | find <db> <collection> [--filter json] [--sort json] [--projection json] [--limit n] [--skip n] | get <db> <collection> <id> | conn  [--env e] [--service s]'); return 2;
    }
    case 'storage': {
      const w = ws(), s = await storage.storeOfEnv(w, pickEnv(w, o.env as string));
      if (!args[0] || args[0] === 'ls') { for (const e of await storage.ls(s, args[1] ?? '', Boolean(o.recursive))) io.log(`${e.type === 'folder' ? 'd' : '-'} ${String(e.size).padStart(10)} ${e.lastModified.slice(0, 19)} ${e.key}`); return 0; }
      if (args[0] === 'cat' && args[1]) { const c = await storage.cat(s, args[1]); process.stdout.write(c.bytes); if (c.truncated) io.err('\n(first 1 MiB only)'); return 0; }
      io.err('usage: laru storage [ls [bucket[/prefix]] [--recursive]] | cat <bucket/key>'); return 2;
    }
    case 'vault': {
      const w = ws();
      if (args[0] === 'key' && args[1] === 'export') { io.log(await exportKey(w)); return 0; }
      if (args[0] === 'key' && args[1] === 'import') { const k = await importKey(w, await readValue()); io.log(`key stored in ${k.store}`); return 0; }
      if (args[0] === 'key') { const k = await vaultKey(w); io.log(k ? `key in ${k.store}${k.warning ? ' (a plain file: prefer the keychain)' : ''}` : 'no key yet: the first secret creates one'); return 0; }
      io.err('usage: laru vault key [export | import]  (import reads the key from stdin)'); return 2;
    }
    case 'where': {
      const w = ws();
      if (o.json && !o.run) { io.log(JSON.stringify(await diskReport(w), null, 2)); return 0; }
      io.log(await whereText(w, o.run as string | undefined));
      return 0;
    }
    case 'prune': {
      const w = ws();
      const KINDS: PruneWhat[] = ['runs', 'snapshots', 'images', 'shadow'];
      if (args.some((a) => !KINDS.includes(a as PruneWhat))) { io.err('usage: laru prune [runs] [snapshots] [images] [shadow] [--dry-run]   (none named: all four)'); return 2; }
      const r = await prune(w, { dryRun: Boolean(o['dry-run']), what: args as PruneWhat[] });
      if (o.json) { io.log(JSON.stringify(r, null, 2)); return 0; }
      const verb = o['dry-run'] ? 'would remove' : 'removed';
      const by = (what: string) => r.runs.filter((a) => a.what === what);
      io.log(`runs       ${verb} the runner's raw media of ${by('raw').length} runs (${human(by('raw').reduce((n, a) => n + a.bytes, 0))}), the video and screenshots of ${by('media').length} (${human(by('media').reduce((n, a) => n + a.bytes, 0))}), ${by('run').length} whole runs (${human(by('run').reduce((n, a) => n + a.bytes, 0))})`);
      io.log(`snapshots  ${verb} ${r.snapshots.length} (${human(r.snapshots.reduce((n, x) => n + x.bytes, 0))})${r.snapshots.length ? `: ${r.snapshots.map((x) => x.path.split('/').pop()).join(', ')}` : ''}`);
      io.log(`images     ${verb} ${r.images.length} tags (${human(r.images.reduce((n, x) => n + x.bytes, 0))}, before Docker shares layers)${r.images.length ? `: ${r.images.map((x) => x.ref).join(', ')}` : ''}`);
      io.log(`shadow     ${o['dry-run'] ? 'would collect' : 'collected'} ${r.shadow.length} folder shadows`);
      io.log(`${o['dry-run'] ? 'would free' : 'freed'} about ${human(r.bytes)}${o['dry-run'] ? '. Run it without --dry-run to remove.' : '.'}`);
      return 0;
    }
    case 'doctor': {
      // a fresh machine has no workspace yet: the machine's checks still run
      // a workspace asked for by name must exist; only when none was asked is "none here" the machine's checks alone
      const w = o.ws || o.workspace || process.env.LARU_WORKSPACE ? ws() : (() => { try { return ws(); } catch (e) { if (e instanceof WorkspaceError) return undefined; throw e; } })();
      if (o.fix) { const code = await fixDocker(io); if (code) return code; }
      const checks = await doctorChecks(w);
      for (const c of checks) io.log(`${c.ok ? '✓' : '✕'} ${c.name.padEnd(12)} ${c.note}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
  }
  return undefined;
}

export const human = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);

/** `laru where` and MCP `where`: every place this workspace keeps something, absolute and with its size; or one run's files. */
export async function whereText(w: Workspace, run?: string): Promise<string> {
  if (run) {
    const dir = join(runsDir(w), run);
    if (!/^\d+$/.test(run) || !existsSync(dir)) throw new WorkspaceError(`no run ${run}`);
    // out/ is the runner's: a link it left is not followed, and what it points at is not listed
    const files = runnerFiles(dir).sort().map((f) => `  ${human(statSync(join(dir, f)).size).padStart(9)}  ${f}`);
    return [`run ${run}  ${dir}`, ...files, '', 'flows/ and raw/ are masked when captured, except videos and screenshots; out/ is the runner\'s raw output and is never served.'].join('\n');
  }
  const d = await diskReport(w);
  const row = (label: string, path: string, bytes: number | null, note = '') => `${label.padEnd(24)} ${path}${bytes === null ? '' : `  ${human(bytes)}`}${note ? `  ${note}` : ''}`;
  const out = [
    row('workspace', d.workspace.path, d.workspace.bytes, 'versioned: laru.yaml, docs/, envs/, vault/'),
    row('state', d.state.path, d.state.bytes, 'derived and local; deleting it is safe, it is rebuilt'),
  ];
  if (existsSync(d.runs.path)) out.push(row('runs', d.runs.path, d.runs.bytes, `${d.runs.count} runs, ${human(d.runs.videoBytes)} of video${d.runs.rawBytes ? `, ${human(d.runs.rawBytes)} of it the runner's raw copies (laru prune)` : ''}; keeps videos ${d.runs.policy.videoDays} days, runs ${d.runs.policy.runDays} days, at most ${d.runs.policy.maxGB} GB`));
  for (const e of d.envs) if (existsSync(e.path)) out.push(row(`env ${e.env}`, e.path, e.bytes, e.trafficBytes ? `traffic journal ${human(e.trafficBytes)}` : ''));
  for (const p of d.projects) out.push(p.problem ? `${`project ${p.name}`.padEnd(24)} ${p.problem === 'missing' ? `${p.path} is gone` : 'not on this machine: laru sync / repo link'}` : row(`project ${p.name}`, p.path!, p.bytes, p.source === 'folder' ? 'your folder (Laru only reads it)' : p.managed ? "Laru's clone" : 'your clone'));
  for (const s of d.snapshots) out.push(row(`snapshot ${s.id}`, s.path, s.bytes, s.usedBy.length ? `used by ${s.usedBy.join(', ')}` : 'unused'));
  if (d.images) out.push(`${'images'.padEnd(24)} ${d.images.count} ks-${w.app}/* tags, ${d.images.old} beyond the 3 newest per service (laru prune)`);
  if (existsSync(d.personal.path)) out.push(row('personal', d.personal.path, null, d.personal.files.join(', ')));
  out.push(`${'vault key'.padEnd(24)} ${d.vaultKey.store === 'file' ? `a 0600 file in ${d.personal.path}` : `${d.vaultKey.store}, service ${d.vaultKey.service}, account ${d.vaultKey.account}`}`);
  if (existsSync(d.machine.path)) out.push(row('machine', d.machine.path, null, d.machine.files.join(', ')));
  return out.join('\n');
}
