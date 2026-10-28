/**
 * The repo's compose, read at the env's ref and normalized by `docker compose config`, becomes Laru's compose:
 * one labelled network, intercepted services renamed `<svc>-real` with the tap holding their names, images tagged
 * by content, values namespaced so they only exist in the compose process's environment. `renderCompose` is pure:
 * the same input gives the same bytes, so an unchanged env makes compose do nothing.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { dockerEnv, LABEL } from './docker.ts';
import { merge } from './env.ts';
import type { EnvSpec, TapRoute } from './types.ts';
import { ksVar, SMTP_PORTS, sinksOf } from './types.ts';

const run = promisify(execFile);

export type Service = Record<string, any>;
export interface ComposeDoc { name?: string; services: Record<string, Service>; networks?: Record<string, any>; volumes?: Record<string, any> }

/** `docker compose config` resolves paths, depends_on, extends and include; `--no-interpolate` keeps `${X}` as written. */
/** `files` merged in order, as `docker compose -f a -f b` merges them: paths in all of them are the first one's folder's. */
export async function importCompose(files: string | string[]): Promise<ComposeDoc> {
  const list = [files].flat();
  try {
    const { stdout } = await run('docker', ['compose', ...list.flatMap((f) => ['-f', f]), 'config', '--format', 'json', '--no-interpolate'], { env: dockerEnv(), maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout) as ComposeDoc;
  } catch (e) {
    throw new Error(`docker compose could not read ${list.join(', ')}: ${String((e as { stderr?: string }).stderr ?? e).trim().split('\n').slice(-2).join(' ')}`);
  }
}

/**
 * The compose files an env's `from` reads, inside the project at `dir`: the ones it lists (`docker-compose.yml,
 * docker-compose.infra.yml`), then the override compose reads by itself beside a file of its default name
 * (`docker-compose.override.yml` by `docker-compose.yml`), as `docker compose up` does with no -f.
 */
export function composeFiles(dir: string, path: string): string[] {
  const files = path.split(',').map((p) => p.trim()).filter(Boolean);
  const m = files[0]?.match(/^((?:.*\/)?(?:docker-)?compose)\.ya?ml$/);
  const override = m && ['yml', 'yaml'].map((x) => `${m[1]}.override.${x}`).find((f) => existsSync(join(dir, f)));
  return override && !files.includes(override) ? [...files, override] : files;
}

/**
 * What the map found in the project's compose files that the env leaves out: each file it does not read, with the
 * services there the env has none of. A file whose services the env has anyway (a dev variant) says nothing.
 */
export function leftOut(files: Record<string, { findings: Array<{ kind: string; name?: string }> }>, read: string[], doc: ComposeDoc): Array<{ file: string; services: string[] }> {
  return Object.entries(files).filter(([f]) => !read.includes(f)).flatMap(([file, x]) => {
    const services = x.findings.filter((f) => f.kind === 'compose-service' && f.name && !doc.services[f.name]).map((f) => f.name!);
    return services.length ? [{ file, services }] : [];
  });
}

/** What the map knows about a compose service, decided by the caller (up.ts) from the map and the compose. */
export interface Target { svc: string; ports: number[]; proto: 'http' | 'tcp' | 'pg' }

export interface RenderContext {
  app: string;
  env: string;
  run?: string;
  workspaceKey: string;
  project: string;
  /** third octet of 172.30.N.0/24 */
  subnet: number;
  /** services the tap stands in front of */
  targets: Target[];
  /** built service → image tag key */
  imageKeys: Record<string, string>;
  /** host path of Laru's packages/ (mounted read-only in the tap) */
  packagesDir: string;
  /** host path of .laru/envs/<env>/tap */
  tapDir: string;
  /** persistent envs only: service → container port → host port on 127.0.0.1 */
  hostPorts: Record<string, Record<string, number>>;
  entrancePort?: number;
  /** "uid:gid" the tap runs as, so its files belong to the user */
  user: string;
  /** service → env keys the vault injects */
  inject: Record<string, string[]>;
  /** datastores whose statements are logged (postgres) and brokers that get a host listener (kafka) */
  stores: Record<string, 'postgres' | 'kafka' | 'other'>;
  /** host path of the workspace's mocks/ (mounted in the tap when the env has mocks) */
  mocksDir?: string;
  /** service → env values Laru sets itself (an external's variable pointed at its mock) */
  extraEnv?: Record<string, Record<string, string>>;
  /** HTTPS hosts: the local CA's folder, and per built service a truststore made with its own keytool */
  tls?: { caDir: string; truststores: Record<string, string> };
  /** unique → compose name: the alias a service keeps on its project's network (absent: the same) */
  composeOf?: Record<string, string>;
  /** volume key → its cache volume's name, when it is not `ks-<app>-cache-<key>` (a later project's) */
  cacheNames?: Record<string, string>;
  /** joint envs: [0] is `ks` (the tap and the runner), then one network per project */
  nets?: Array<{ key: string; name: string; subnet: number }>;
  /** joint envs: unique → its project's network key */
  netOf?: Record<string, string>;
  /** joint envs: net key → name → unique, for another project's service reachable there by that name (visibility, share) */
  visible?: Record<string, Record<string, string>>;
  /** topics a service creates when it starts, with their partitions: created before any service starts (a consumer that subscribes first would wait minutes for the rest) */
  topics?: Array<{ name: string; partitions: number }>;
  /** joint envs: host ports a member publishes for a fronted service, reached as host.docker.internal:<port> */
  hostPortRoutes?: Array<{ svc: string; hostPort: number; port: number }>;
}

export interface Rendered { doc: ComposeDoc; yaml: string; routes: TapRoute[]; warnings: string[] }

const NET = 'ks';
/** the normal network of a closed env: where the tap and the stores meet the outside */
const OUT = 'ks-out';
const TAP = 'ks-tap';
// pinned by digest: the tap sees every request and secret of the env, so a re-pushed tag never becomes it unnoticed
const TAP_IMAGE = 'node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';
const INTERP = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)((?::?[-?+])[^}]*)?\}/g;

/** `${X:-d}` → `${KS_SVC__X:-d}` in every string of a service: values reach compose only through its own environment. */
function namespace(value: unknown, svc: string): unknown {
  if (typeof value === 'string') return value.replace(INTERP, (_m, name: string, rest = '') => `\${${ksVar(svc, name)}${rest}}`);
  if (Array.isArray(value)) return value.map((v) => namespace(v, svc));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, namespace(v, svc)]));
  return value;
}

/** The body of every `${…}` a service interpolates, as written (`JWT_SECRET`, `POSTGRES_DB:-vaultflow`): what the vault may have to provide. */
export function interpolations(s: Service): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(INTERP)) out.add(m[1] + (m[2] ?? ''));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(s);
  return [...out].sort();
}

/** depends_on closure of a subset, plus the jobs that only depend on what is included. */
export function closure(doc: ComposeDoc, subset?: string[]): string[] {
  const all = Object.keys(doc.services);
  if (!subset) return all.sort();
  const keep = new Set<string>();
  const add = (s: string) => { if (keep.has(s) || !doc.services[s]) return; keep.add(s); for (const d of Object.keys(doc.services[s].depends_on ?? {})) add(d); };
  subset.forEach(add);
  for (const s of all) {
    const svc = doc.services[s];
    const deps = Object.keys(svc.depends_on ?? {});
    const job = !svc.ports?.length && !svc.healthcheck && !svc.build && deps.length && deps.every((d) => keep.has(d));
    if (job) keep.add(s);
  }
  return [...keep].sort();
}

const mem = (v?: string) => v;

export function renderCompose(normalized: ComposeDoc, spec: EnvSpec, ctx: RenderContext): Rendered {
  const warnings: string[] = [];
  const labels = (service?: string) => ({
    [LABEL.workspace]: ctx.workspaceKey, [LABEL.app]: ctx.app, [LABEL.env]: ctx.env,
    ...(ctx.run ? { [LABEL.run]: ctx.run } : {}), ...(service ? { [LABEL.service]: service } : {}),
  });
  const included = closure(normalized, spec.services);
  const targets = new Map(ctx.targets.filter((t) => included.includes(t.svc) && !spec.intercept.exclude.includes(t.svc)).map((t) => [t.svc, t]));
  const hybrid = new Set(spec.hybrid);
  // A mocked service is not started: the tap answers for it under its own name.
  const mocked = new Set(Object.keys(spec.mocks).filter((m) => included.includes(m)));
  const realName = (s: string) => (targets.has(s) ? `${s}-real` : s);
  const subnet = `172.30.${ctx.subnet}`;
  const services: Record<string, Service> = {};
  const routes: TapRoute[] = [];
  const alias = (s: string) => ctx.composeOf?.[s] ?? s;
  // A joint env: a network per project, the tap on all of them. A service sits on its own project's network under its
  // compose name; another project reaches it there by that name when it does not define the name itself (visibility).
  const nets = ctx.nets?.length ? ctx.nets : undefined;
  const reachedAs = (svc: string) => (nets ?? []).slice(1).flatMap((n) => Object.entries(ctx.visible?.[n.key] ?? {}).filter(([, u]) => u === svc).map(([c]) => ({ net: n.key, alias: c })));
  const netSubnet = (key: string) => nets!.find((n) => n.key === key)!.subnet;

  for (const name of included) {
    const src = normalized.services[name];
    if (src.network_mode && /^(host|service:)/.test(String(src.network_mode))) throw new Error(`services.${name}.network_mode: "${src.network_mode}" cannot be isolated; remove it in the env overlay`);
    const t = targets.get(name);
    if (t) {
      const ports = [...new Set([...t.ports, ...(spec.intercept.ports[name] ?? [])])].sort((a, b) => a - b);
      const upstream = hybrid.has(name) ? 'host.docker.internal' : mocked.has(name) ? (spec.mocks[name].real ?? '') : `${name}-real`;
      if (!nets) routes.push({ svc: name, aliases: [alias(name)], ports, upstream, proto: t.proto });
      else {
        routes.push({ svc: name, net: 'ks', aliases: [name], ports, upstream, proto: t.proto });
        routes.push({ svc: name, net: ctx.netOf![name], aliases: [alias(name)], ports, upstream, proto: t.proto });
        for (const r of reachedAs(name)) routes.push({ svc: name, net: r.net, aliases: [r.alias], ports, upstream, proto: t.proto, visible: true });
      }
    }
    if (mocked.has(name) && !t) throw new Error(`mocks.${name}: ${name} listens on no port the tap could answer; set intercept.ports.${name}`);
    if (hybrid.has(name) || mocked.has(name)) continue;

    const s: Service = namespace(structuredClone(src), name) as Service;
    delete s.container_name;
    delete s.networks;
    delete s.network_mode;
    // a profile would make compose skip the service: what runs is the env's say (its services, else all of them)
    delete s.profiles;
    s.labels = { ...(Array.isArray(s.labels) ? Object.fromEntries(s.labels.map((l: string) => l.split('='))) : s.labels ?? {}), ...labels(name) };
    // Docker's DNS also answers for a container's hostname, so the real one keeps only its own name.
    if (!nets) s.networks = { [NET]: t ? { aliases: [`${name}-real`] } : { aliases: [alias(name)] } };
    else {
      const own = ctx.netOf![name];
      s.networks = { [own]: { aliases: [t ? `${name}-real` : alias(name)] } };
      // A store another project reaches by name is attached to that project's network too, under that name.
      if (!t) for (const r of reachedAs(name)) (s.networks[r.net] ??= { aliases: [] }).aliases.push(r.alias);
      // host.docker.internal is the tap on the service's own network: it routes a published host port to its service.
      const hosts = Array.isArray(s.extra_hosts) ? s.extra_hosts : Object.entries(s.extra_hosts ?? {}).map(([h, ip]) => `${h}:${ip}`);
      s.extra_hosts = [...hosts.filter((h: string) => !/^host\.docker\.internal[:=]/.test(h)), `host.docker.internal:172.30.${netSubnet(own)}.254`];
    }

    // Ports: only data stores the tap does not front are published, and only in persistent envs, on 127.0.0.1.
    delete s.ports;
    const published = ctx.hostPorts[name];
    if (published && !t && Object.keys(published).length) s.ports = Object.entries(published).map(([c, h]) => `127.0.0.1:${h}:${c}`);

    // Built services: an image tag per content key, so an unchanged context is never rebuilt.
    if (s.build) {
      const key = ctx.imageKeys[name];
      if (!key) throw new Error(`services.${name}: no image key computed for its build context`);
      s.image = `ks-${ctx.app}/${name}:${key}`;
      s.build = { ...s.build, labels: { [LABEL.workspace]: ctx.workspaceKey, [LABEL.app]: ctx.app, [LABEL.service]: name } };
    }

    // Values: the vault's keys, as references to the compose process's own environment.
    for (const key of ctx.inject[name] ?? []) {
      if (!s.environment || Array.isArray(s.environment)) s.environment = Object.fromEntries((s.environment ?? []).map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; }));
      if (s.environment[key] === undefined || s.environment[key] === null) s.environment[key] = `\${${ksVar(name, key)}}`;
    }

    for (const [k, v] of Object.entries(ctx.extraEnv?.[name] ?? {})) {
      if (!s.environment || Array.isArray(s.environment)) s.environment = Object.fromEntries((s.environment ?? []).map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; }));
      s.environment[k] = v;
    }

    // depends_on: renamed targets, and every service waits for the tap to be healthy.
    const deps: Record<string, any> = {};
    for (const [d, cond] of Object.entries(s.depends_on ?? {})) if (included.includes(d) && !hybrid.has(d) && !mocked.has(d)) deps[realName(d)] = cond;
    if (targets.size) deps[TAP] = { condition: 'service_healthy', required: true };
    s.depends_on = deps;

    // A readiness check where the repo has none: any HTTP answer counts, a 401 included.
    const h = spec.health[name];
    if (h?.none) delete s.healthcheck;
    else if (h?.cmd) s.healthcheck = { test: ['CMD-SHELL', h.cmd], interval: '5s', retries: 3, start_period: '240s', start_interval: '2s' };
    else if (!s.healthcheck && t?.proto === 'http' && t.ports.length) {
      const port = h?.port ?? t.ports[0];
      s.healthcheck = { test: ['CMD-SHELL', `wget -qSO/dev/null http://127.0.0.1:${port}${h?.http ?? '/'} 2>&1 | grep -q HTTP/`], interval: '5s', timeout: '5s', retries: 3, start_period: '240s', start_interval: '2s' };
    }

    // Statements of Postgres are logged so a run can attribute them; Kafka gets a listener the host can reach.
    if (ctx.stores[name] === 'postgres') {
      const flags = ['-c', 'log_min_duration_statement=0', '-c', 'log_line_prefix=%m|%h|%p|%u|%d|', '-c', 'log_parameter_max_length=256'];
      const cmd = Array.isArray(s.command) ? s.command : typeof s.command === 'string' ? s.command.split(/\s+/) : ['postgres'];
      // Only the server: a job on the same image (psql, pg_dump) keeps its command.
      if (cmd[0] === 'postgres' && !cmd.includes('log_min_duration_statement=0')) s.command = [...cmd, ...flags];
    }
    if (ctx.stores[name] === 'kafka' && spec.persistent && s.environment && !Array.isArray(s.environment) && s.environment.KAFKA_LISTENERS) {
      const hostPort = ctx.hostPorts[name]?.['29092'];
      if (hostPort) {
        s.environment.KAFKA_LISTENERS += ',HOST://0.0.0.0:29092';
        s.environment.KAFKA_ADVERTISED_LISTENERS = `${s.environment.KAFKA_ADVERTISED_LISTENERS ?? ''},HOST://127.0.0.1:${hostPort}`.replace(/^,/, '');
        if (s.environment.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP) s.environment.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP += ',HOST:PLAINTEXT';
        s.ports = [...(s.ports ?? []), `127.0.0.1:${hostPort}:29092`];
      }
    }

    const r = spec.resources[name];
    if (r?.memory) s.mem_limit = mem(r.memory);
    if (r?.cpus) s.cpus = r.cpus;
    s.logging = { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '3' } };
    // Docker starts an always or unless-stopped container again when it starts itself (the machine turned on): an env
    // runs when laru up asks, so those become on-failure, which still brings back a service that crashed.
    if (ctx.run) delete s.restart;
    else if (s.restart === 'always' || s.restart === 'unless-stopped') s.restart = 'on-failure';
    services[realName(name)] = s;
  }

  // Topics before services: a one-shot job creates them with their partitions as soon as the broker answers, and whoever
  // talks to the broker waits for it. Created later by the service that owns them, a consumer that subscribed first sees
  // the missing partitions only after its metadata refresh (five minutes).
  const broker = Object.entries(services).find(([n]) => ctx.stores[n.replace(/-real$/, '')] === 'kafka' && /apache\/kafka/.test(String(services[n].image)));
  if (ctx.topics?.length && broker) {
    const [bname, b] = broker;
    const env = Array.isArray(b.environment) ? {} : b.environment ?? {};
    const adv = /PLAINTEXT:\/\/([^:,]+):(\d+)/.exec(String(env.KAFKA_ADVERTISED_LISTENERS ?? ''));
    const at = `${adv?.[1] ?? bname}:${adv?.[2] ?? 9092}`;
    const tool = '/opt/kafka/bin/kafka-topics.sh';
    const make = ctx.topics.map((t) => `${tool} --bootstrap-server ${at} --create --if-not-exists --topic '${t.name}' --partitions ${t.partitions} --replication-factor 1`).join(' && ');
    services['ks-topics'] = {
      image: b.image,
      command: ['sh', '-c', `until ${tool} --bootstrap-server ${at} --list >/dev/null 2>&1; do sleep 1; done; ${make}`],
      networks: b.networks,
      depends_on: { [bname]: { condition: 'service_healthy', required: true } },
      labels: labels('ks-topics'),
      restart: 'no',
      logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '1' } },
    };
    for (const [n, s] of Object.entries(services)) {
      if (n === 'ks-topics' || n === bname || n === TAP) continue;
      if (Object.keys(s.depends_on ?? {}).includes(bname)) s.depends_on = { ...s.depends_on, 'ks-topics': { condition: 'service_completed_successfully', required: true } };
    }
  }

  // An SMTP sink the compose does not run (a name the app uses: `smtp`) listens on the usual mail ports, with a certificate of its name.
  const smtpNames = sinksOf(spec.mocks, 'smtp').filter((n) => !normalized.services[n]);
  for (const n of smtpNames) routes.push({ svc: n, aliases: [n], ports: spec.mocks[n].implicitTls ? [...new Set([...SMTP_PORTS, ...spec.mocks[n].implicitTls!])] : SMTP_PORTS, upstream: '', proto: 'tcp', tls: { cert: `/ks/ca/hosts/${n}.crt`, key: `/ks/ca/hosts/${n}.key` } });
  const trusting = spec.hosts.length > 0 || smtpNames.length > 0;
  // HTTPS hosts the app calls by name: the tap holds the name and presents a certificate of the local CA.
  for (const host of spec.hosts) routes.push({ svc: host, aliases: [host], ports: [443], upstream: spec.mocks[host]?.real ?? host, proto: 'https', tls: { cert: `/ks/ca/hosts/${host}.crt`, key: `/ks/ca/hosts/${host}.key` } });
  if (trusting && ctx.tls) {
    for (const [name, s] of Object.entries(services)) {
      if (!s.build) continue;
      s.volumes = [...(s.volumes ?? []), `${ctx.tls.caDir}/ca.crt:/ks/ca/ca.crt:ro`];
      if (!s.environment || Array.isArray(s.environment)) s.environment = Object.fromEntries((s.environment ?? []).map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; }));
      s.environment.NODE_EXTRA_CA_CERTS = '/ks/ca/ca.crt';
      const store = ctx.tls.truststores[s.labels?.[LABEL.service] ?? name];
      if (store) {
        s.volumes.push(`${store}:/ks/ca/cacerts:ro`);
        const flags = '-Djavax.net.ssl.trustStore=/ks/ca/cacerts -Djavax.net.ssl.trustStorePassword=changeit';
        const prev = s.environment.JAVA_TOOL_OPTIONS;
        s.environment.JAVA_TOOL_OPTIONS = prev ? `${prev} ${flags}` : flags;
      }
    }
  }

  // Mocks of externals compose does not run: the tap takes their name too.
  for (const [m, ms] of Object.entries(spec.mocks)) if (!normalized.services[m] && !spec.hosts.includes(m) && ms.mode !== 'sink') routes.push({ svc: m, aliases: [m], ports: [ms.port ?? 80], upstream: ms.real ?? '', proto: 'http' });

  // Joint envs: a member's published host port reaches its service through the tap, from every project's network.
  if (nets) {
    for (const h of ctx.hostPortRoutes ?? []) {
      const main = routes.find((r) => r.svc === h.svc && r.net === 'ks');
      if (main) for (const n of nets.slice(1)) routes.push({ svc: h.svc, net: n.key, aliases: ['host.docker.internal'], ports: [h.hostPort], portMap: { [h.hostPort]: h.port }, upstream: main.upstream, proto: main.proto, kind: 'host-port' });
    }
    // Two TCP services on one port of one project's network cannot be told apart (no Host): refused, naming both. On
    // `ks` (the runner's) the first keeps the port, and the render says so.
    for (const n of nets) {
      const byPort = new Map<number, string>();
      for (const r of routes.filter((x) => x.proto === 'tcp' && !x.kind && (!x.net || x.net === n.key))) for (const p of r.ports) {
        const other = byPort.get(p);
        if (other && other !== r.svc && n.key !== 'ks') throw new Error(`${other} and ${r.svc} both answer TCP on port ${p} of network ${n.key}; the tap cannot tell them apart`);
        if (other && other !== r.svc) warnings.push(`${other} and ${r.svc} share TCP port ${p}: by that port, the runner reaches ${other}`);
        else byPort.set(p, r.svc);
      }
    }
  }

  // The tap holds every intercepted name on the network, so callers reach it whatever way they address a peer.
  if (routes.length) {
    const tapPorts: string[] = [];
    if (ctx.entrancePort) tapPorts.push(`127.0.0.1:${ctx.entrancePort}:7999`);
    if (!nets) for (const r of routes) for (const p of r.ports) { const hp = ctx.hostPorts[r.svc]?.[String(p)]; if (hp) tapPorts.push(`127.0.0.1:${hp}:${p}`); }
    else {
      // Two fronted services may share a container port (two 80s): each host port gets a listener of its own.
      let i = 0;
      for (const r of routes.filter((x) => x.net === 'ks')) for (const p of r.ports) {
        const hp = ctx.hostPorts[r.svc]?.[String(p)];
        if (!hp) continue;
        const pin = 30000 + i++;
        routes.push({ svc: r.svc, aliases: [], ports: [pin], portMap: { [pin]: p }, upstream: r.upstream, proto: r.proto, kind: 'pinned' });
        tapPorts.push(`127.0.0.1:${hp}:${pin}`);
      }
    }
    const tapNets = nets
      ? Object.fromEntries(nets.map((n) => [n.key, { ipv4_address: `172.30.${n.subnet}.254`, aliases: [...new Set(routes.filter((r) => !r.kind && (!r.net || r.net === n.key)).flatMap((r) => r.aliases))] }]))
      : { [NET]: { ipv4_address: `${subnet}.254`, aliases: routes.flatMap((r) => r.aliases) } };
    services[TAP] = {
      image: TAP_IMAGE,
      command: ['node', '/ks/packages/runtime/tap/tap.ts', '/ks/env'],
      user: ctx.user,
      sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0' },
      volumes: [`${ctx.packagesDir}:/ks/packages:ro`, `${ctx.tapDir}:/ks/env`, ...(Object.keys(spec.mocks).length && ctx.mocksDir ? [`${ctx.mocksDir}:/ks/mocks`] : []),
        // the hosts' certificates and the CA's public half; the CA key is never mounted
        ...(trusting && ctx.tls ? [`${ctx.tls.caDir}/hosts:/ks/ca/hosts:ro`, `${ctx.tls.caDir}/ca.crt:/ks/ca/ca.crt:ro`] : [])],
      labels: labels(TAP),
      networks: tapNets,
      extra_hosts: ['host.docker.internal:host-gateway'],
      healthcheck: { test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:7999/__ks/health'], interval: '2s', timeout: '2s', retries: 30, start_period: '10s' },
      restart: ctx.run ? 'no' : 'on-failure',
      logging: { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '3' } },
      ...(tapPorts.length ? { ports: tapPorts } : {}),
    };
  }

  // Named volumes: per env, labelled; caches are shared external volumes that survive a destroy.
  const volumes: Record<string, any> = {};
  for (const [v, def] of Object.entries(normalized.volumes ?? {})) {
    const used = Object.values(services).some((s) => (s.volumes ?? []).some((m: any) => m?.type === 'volume' && m.source === v));
    if (!used) continue;
    volumes[v] = spec.cache.includes(v)
      ? { name: ctx.cacheNames?.[v] ?? `ks-${ctx.app}-cache-${v}`, external: true }
      : { name: `${ctx.project}_${v}`, labels: labels() };
    void def;
  }

  // A closed env: its network is internal (nothing on it reaches the internet or this Mac), and what has to be reached from outside it (the tap's and the stores' published ports) also sits on a normal one.
  const closed = spec.egress === 'closed' && !nets;
  if (closed) {
    for (const [n, s] of Object.entries(services)) if (n === TAP || (s.ports ?? []).length) s.networks = { ...s.networks, [OUT]: {} };
  }
  let doc: ComposeDoc = {
    name: ctx.project,
    services,
    networks: nets
      ? Object.fromEntries(nets.map((n) => [n.key, { name: n.name, labels: labels(), ipam: { config: [{ subnet: `172.30.${n.subnet}.0/24` }] } }]))
      : { [NET]: { name: ctx.project, labels: labels(), ipam: { config: [{ subnet: `${subnet}.0/24` }] }, ...(closed ? { internal: true } : {}) }, ...(closed ? { [OUT]: { name: `${ctx.project}-out`, labels: labels() } } : {}) },
    ...(Object.keys(volumes).length ? { volumes } : {}),
  };
  if (spec.overlay.services || spec.overlay.volumes) {
    // An overlay entry for a service of the compose that this env leaves out (a flow's environment runs a few) would start it half-made:
    // an image and nothing else. Only what the env runs, and what the overlay adds beyond the compose, is merged.
    const left = (k: string) => Boolean(normalized.services[k]) && !included.includes(k);
    const overlay = { services: Object.fromEntries(Object.entries(spec.overlay.services ?? {}).filter(([k]) => !left(k)).map(([k, v]) => [realName(k), v])), volumes: spec.overlay.volumes };
    for (const k of Object.keys(overlay.services)) if (!services[k] && !spec.overlay.services?.[k.replace(/-real$/, '')]?.image) warnings.push(`overlay.services.${k}: adds a service that is not in the compose`);
    doc = merge(doc, overlay) as ComposeDoc;
  }
  return { doc, yaml: stringify(doc, { lineWidth: 0, sortMapEntries: false }), routes, warnings };
}
