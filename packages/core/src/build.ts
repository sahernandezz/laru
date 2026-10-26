/**
 * From findings to the system map. Detectors only see one file; here the files of a repo become
 * services, and the services are tied together through what their configuration and code point at:
 * a URL whose host is another service, a `localhost` port that a compose service publishes, a proxy
 * prefix, a Kafka topic two services share. Each fact keeps its anchor; what is inferred rather than
 * read says so with origin `derived`.
 */
import { dirname, posix } from 'node:path';
import { normalizePath, type Finding, type FindingOf, type Tech } from '@laru/detect';
import type { RepoExtraction } from './extract.ts';
import type { Anchor, Fact, MapNode, Origin, Relation, SystemMap } from './model.ts';
import { MESSAGING, placeholder } from './messaging.ts';
import type { Workspace } from './workspace.ts';

/** A finding with the file it came from. `file`, not `path`: endpoints and calls have a `path` of their own. */
type Located<F extends Finding = Finding> = F & { file: string; repo: string; commit: string };
const STRONG: Tech[] = ['quarkus', 'spring', 'node', 'web', 'mobile'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal']);

export const IMAGE_KINDS: Array<[RegExp, 'datastore' | 'external', string]> = [
  [/postgres|mysql|mariadb|mssql|sqlserver|oracle|cockroach/, 'datastore', 'relational'],
  [/mongo|couchdb|cassandra|scylla|dynamodb/, 'datastore', 'document'],
  [/redis|valkey|memcached|dragonfly/, 'datastore', 'cache'],
  [/kafka|redpanda|rabbitmq|nats|activemq|artemis|pulsar/, 'datastore', 'queue'],
  [/minio|localstack|azurite|s3/, 'datastore', 'file'],
  [/elasticsearch|opensearch|meilisearch|typesense|solr/, 'datastore', 'search'],
  [/keycloak|openldap|ldap/, 'datastore', 'directory'],
];
const SCHEME_KINDS: Record<string, string> = { postgresql: 'relational', mysql: 'relational', mariadb: 'relational', sqlserver: 'relational', oracle: 'relational', mongodb: 'document', redis: 'cache', rediss: 'cache', amqp: 'queue', amqps: 'queue', kafka: 'queue' };

export interface Target { host: string; port?: number; path?: string; scheme?: string }

/** Every host the value points at: URLs (jdbc too), `host:port` lists, with `${VAR:default}` resolved to its default. */
export function targetsIn(raw: string): Target[] {
  const value = raw.replace(/\$\{[^}:]+:([^}]*)\}/g, '$1');
  if (/\$\{/.test(value)) return [];
  const out: Target[] = [];
  for (const m of value.matchAll(/(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]+@)?([A-Za-z0-9_.-]+)(?::(\d+))?(\/[^\s,;?]*)?/g)) out.push({ scheme: m[1], host: m[2], port: m[3] ? Number(m[3]) : undefined, path: m[4] });
  if (!out.length) for (const m of value.matchAll(/(?:^|,)\s*([A-Za-z0-9_.-]+):(\d{2,5})\s*(?=,|$)/g)) out.push({ host: m[1], port: Number(m[2]) });
  return out;
}

class Builder {
  nodes = new Map<string, MapNode>();
  facts: Fact[] = [];
  private seen = new Set<string>();
  node(n: MapNode): MapNode {
    const prev = this.nodes.get(n.id);
    if (prev) { prev.attrs = { ...n.attrs, ...prev.attrs }; prev.anchor ??= n.anchor; return prev; }
    this.nodes.set(n.id, n);
    return n;
  }
  fact(s: string, p: Relation, o: string, origin: Origin, anchor?: Anchor, note?: string) {
    const key = `${s}|${p}|${o}|${anchor?.path ?? ''}:${anchor?.line ?? ''}`;
    if (this.seen.has(key) || s === o) return;
    this.seen.add(key);
    this.facts.push({ s, p, o, origin, ...(anchor ? { anchor } : {}), ...(note ? { note } : {}) });
  }
}

interface Service {
  /** `local`: the name inside its own project (compose or detected); `name`: unique in the workspace */
  id: string; name: string; local: string; repo: string; commit: string; dir: string; tech: Tech; stack?: string; platform?: string;
  findings: Located[]; ports: Set<number>; config: Map<string, Array<{ value: string; profile?: string; at: Anchor }>>;
}

export function buildSystemMap(ws: Workspace, extractions: RepoExtraction[]): SystemMap {
  const b = new Builder();
  const appId = `app:${ws.app}`;
  b.node({ id: appId, type: 'application', name: ws.title });
  const services: Service[] = [];
  const located: Located[] = [];
  const anchorOf = (f: Located): Anchor => ({ repo: f.repo, commit: f.commit, path: f.file, ...('line' in f && f.line ? { line: f.line } : {}), ...('symbol' in f && f.symbol ? { symbol: f.symbol } : {}) });

  // ---------- repositories and their services ----------
  for (const ex of extractions) {
    const repo = ws.repos.find((r) => r.name === ex.repo)!;
    const repoId = `repo:${repo.name}`;
    b.node({ id: repoId, type: 'repository', name: repo.name, kind: repo.role, attrs: repo.source === 'folder' ? { source: 'folder', commit: ex.commit, ref: ex.ref } : { url: repo.url, branch: repo.branch, commit: ex.commit, ref: ex.ref } });
    b.fact(appId, 'contains', repoId, 'declared');
    const all: Located[] = Object.entries(ex.files).flatMap(([path, f]) => f.findings.map((x) => ({ ...x, file: path, repo: repo.name, commit: ex.commit }) as Located));
    located.push(...all);

    const roots = new Map<string, { tech: Tech; name?: string; stack?: string; platform?: string }>();
    const parents = new Set(all.filter((f) => f.kind === 'parent-module').map((f) => dirname(f.file).replace(/^\.$/, '')));
    for (const f of all) {
      if (f.kind !== 'service-root') continue;
      const dir = dirname(f.file).replace(/(^|\/)[^/]+\.xcodeproj$/, '').replace(/^\.$/, '');
      if (parents.has(dir)) continue;
      const cur = roots.get(dir);
      if (!cur || (cur.tech === 'docker' && STRONG.includes(f.tech))) roots.set(dir, { tech: f.tech, name: f.name ?? cur?.name, stack: f.stack, platform: f.platform });
    }
    for (const [dir, r] of [...roots]) {
      if (r.tech === 'docker' && [...roots].some(([d, o]) => d !== dir && STRONG.includes(o.tech) && (dir === '' || d.startsWith(dir + '/')))) roots.delete(dir);
    }
    if (repo.role === 'library' || repo.role === 'docs') roots.clear();
    for (const o of ws.services.filter((s) => s.repo === repo.name)) roots.set(o.dir, { ...(roots.get(o.dir) ?? { tech: 'docker' }), name: o.name });

    const composeNames = new Map<string, string>();
    for (const f of all) if (f.kind === 'compose-service' && f.build) composeNames.set(posix.join(dirname(f.file).replace(/^\.$/, ''), f.build).replace(/^\.\/?/, ''), f.name);

    for (const [dir, r] of roots) {
      const inDir = (p: string) => dir === '' || p === dir || p.startsWith(dir + '/');
      const owner = (p: string) => [...roots.keys()].filter((d) => d === '' || p.startsWith(d + '/')).sort((x, y) => y.length - x.length)[0];
      const findings = all.filter((f) => inDir(f.file) && owner(f.file) === dir);
      const cfg = (key: string) => findings.find((f) => f.kind === 'config' && f.key === key && !f.profile) as FindingOf<'config'> | undefined;
      const override = ws.services.find((s) => s.repo === repo.name && s.dir === dir)?.name;
      const name = override ?? composeNames.get(dir) ?? cfg('spring.application.name')?.value ?? cfg('quarkus.application.name')?.value ?? r.name ?? (dir ? posix.basename(dir) : repo.name);
      services.push({ id: `svc:${name}`, name, local: name, repo: repo.name, commit: ex.commit, dir, tech: r.tech, stack: r.stack, platform: r.platform, findings, ports: new Set(), config: new Map() });
    }
  }

  // Unique names across the workspace, walking the projects in laru.yaml order: a name an earlier project claimed
  // (a service or a compose service) gets the repo as prefix, so adding a project never renames what exists. Two
  // services of one project with the same name both get it, as before.
  const several = ws.repos.length > 1;
  const order = ws.repos.map((r) => r.name).filter((r) => extractions.some((e) => e.repo === r));
  const claimed = new Map<string, string>();
  const composeOf = (repo: string) => located.filter((f): f is Located<FindingOf<'compose-service'>> => f.kind === 'compose-service' && f.repo === repo);
  const builds = (f: Located<FindingOf<'compose-service'>>) => f.build ? services.find((s) => s.repo === f.repo && s.dir === posix.join(dirname(f.file).replace(/^\.$/, ''), f.build!).replace(/^\.\/?/, '')) : undefined;
  const names: Record<string, Record<string, string>> = {};
  for (const repo of order) {
    const taken = (n: string) => claimed.has(n) && claimed.get(n) !== repo;
    for (const s of services.filter((x) => x.repo === repo)) {
      if (taken(s.name) || services.some((o) => o !== s && o.repo === repo && o.name === s.name)) { s.name = `${s.repo}-${s.name}`; s.id = `svc:${s.name}`; }
    }
    const table: Record<string, string> = {};
    for (const f of composeOf(repo)) table[f.name] ??= builds(f)?.name ?? (taken(f.name) ? `${repo}-${f.name}` : f.name);
    for (const s of services.filter((x) => x.repo === repo)) { claimed.set(s.local, repo); claimed.set(s.name, repo); }
    for (const [c, u] of Object.entries(table)) { claimed.set(c, repo); claimed.set(u, repo); }
    names[repo] = table;
  }

  for (const s of services) {
    for (const f of s.findings) {
      if (f.kind === 'config' && !/(^|\/)src\/test\//.test(f.file)) {
        const list = s.config.get(f.key) ?? [];
        list.push({ value: f.value, profile: f.profile, at: anchorOf(f) });
        s.config.set(f.key, list);
        if (/^(server\.port|quarkus\.http\.port|port)$/.test(f.key) && /^\d+$/.test(f.value)) s.ports.add(Number(f.value));
      }
      if (f.kind === 'port') s.ports.add(f.port);
    }
    const tests = { unit: 0, integration: 0, e2e: 0 };
    for (const f of s.findings) if (f.kind === 'tests') tests[f.level] += f.count;
    b.node({ id: s.id, type: 'service', name: s.name, kind: s.tech, repo: s.repo, attrs: { dir: s.dir || '.', tech: s.tech, ...(s.stack ? { stack: s.stack } : {}), ...(s.platform ? { platform: s.platform } : {}), tests, ports: [...s.ports].sort((a, b) => a - b) }, anchor: { repo: s.repo, commit: s.commit, path: s.dir || '.' } });
    b.fact(`repo:${s.repo}`, 'contains', s.id, 'extracted', { repo: s.repo, commit: s.commit, path: s.dir || '.' });
  }

  // ---------- infrastructure declared in compose files ----------
  // Keyed `<repo>/<compose name>`: two projects' `postgres` are two stores, `ds:postgres` and `ds:audit-postgres`.
  const infra = new Map<string, { id: string; ports: number[] }>();
  const composeBuilt = new Map<string, Service>(); // `<repo>/<compose name>` → our service built from its context
  const composeEnv = new Map<string, Record<string, string>>(); // service id → the literal environment its compose sets
  for (const f of located) {
    if (f.kind !== 'compose-service') continue;
    const built = builds(f as Located<FindingOf<'compose-service'>>);
    if (built) { composeBuilt.set(`${f.repo}/${f.name}`, built); for (const p of f.ports) { if (p.host) built.ports.add(p.host); built.ports.add(p.container); } continue; }
    if (!f.image || /(^|-)init$|setup$/.test(f.name)) continue;
    const hit = IMAGE_KINDS.find(([re]) => re.test(f.image!));
    const type = hit?.[1] ?? 'external';
    const unique = names[f.repo]?.[f.name] ?? f.name;
    const id = `${type === 'datastore' ? 'ds' : 'ext'}:${unique}`;
    b.node({ id, type, name: unique, kind: hit?.[2] ?? 'infra', ...(several ? { repo: f.repo } : {}), attrs: { image: f.image, ports: f.ports }, anchor: anchorOf(f) });
    b.fact(appId, 'contains', id, 'extracted', anchorOf(f));
    infra.set(`${f.repo}/${f.name}`, { id, ports: f.ports.flatMap((p) => [p.host ?? p.container]) });
  }
  for (const f of located) {
    if (f.kind !== 'compose-service') continue;
    const s = composeBuilt.get(`${f.repo}/${f.name}`);
    if (!s || s.repo !== f.repo) continue;
    for (const d of f.dependsOn) { const i = infra.get(`${f.repo}/${d}`); if (i) b.fact(s.id, 'uses', i.id, 'extracted', anchorOf(f), 'compose depends_on'); }
    for (const e of f.env) { b.node({ id: `var:${e}`, type: 'env-var', name: e }); b.fact(s.id, 'declares-var', `var:${e}`, 'extracted', anchorOf(f), 'set by compose'); }
    if (f.values) composeEnv.set(s.id, { ...composeEnv.get(s.id), ...f.values });
  }

  /**
   * A host (and port) to a node of the map, as the projects reach each other when they run side by side: the caller's
   * own project first; then another project's service or store whose compose name the caller's project does not
   * define; then a local host and port that a compose publishes; else a new external.
   */
  const defines = (repo: string, host: string) => services.some((s) => s.repo === repo && (s.local === host || s.name === host)) || composeOf(repo).some((f) => f.name === host);
  const resolveTarget = (t: Target, from: Service): string | null => {
    const byName = services.find((s) => s.repo === from.repo && (s.name === t.host || s.local === t.host)) ?? composeBuilt.get(`${from.repo}/${t.host}`);
    if (byName && byName !== from) return byName.id;
    if (infra.has(`${from.repo}/${t.host}`)) return infra.get(`${from.repo}/${t.host}`)!.id;
    if (several && !defines(from.repo, t.host)) {
      for (const repo of order.filter((r) => r !== from.repo)) {
        const other = services.find((s) => s.repo === repo && s.local === t.host) ?? composeBuilt.get(`${repo}/${t.host}`) ?? infra.get(`${repo}/${t.host}`);
        if (other) return other.id;
      }
    }
    if (LOCAL_HOSTS.has(t.host) && t.port) {
      const svc = services.find((s) => s !== from && s.ports.has(t.port!));
      if (svc) return svc.id;
      const inf = [...infra.values()].find((i) => i.ports.includes(t.port!));
      if (inf) return inf.id;
      return null;
    }
    if (LOCAL_HOSTS.has(t.host) || !/[a-z]/i.test(t.host)) return null;
    const kind = t.scheme ? SCHEME_KINDS[t.scheme] : undefined;
    const id = `${kind ? 'ds' : 'ext'}:${t.host}`;
    b.node({ id, type: kind ? 'datastore' : 'external', name: t.host, kind: kind ?? 'service' });
    return id;
  };
  /** A fact between two projects says so: the map draws it apart and «Hallazgos» reads «audit → vaultflow». */
  const across = (s: Service, target: string, note?: string) => (b.nodes.get(target)?.repo && b.nodes.get(target)!.repo !== s.repo ? [note, 'across projects'].filter(Boolean).join(', ') : note);
  const link = (s: Service, target: string, at: Anchor, origin: Origin, note?: string) => {
    const t = b.nodes.get(target)!;
    b.fact(s.id, t.type === 'service' ? 'calls' : 'uses', target, origin, at, across(s, target, note));
  };

  const repoConstant = (repo: string, name: string) => (located.find((x) => x.kind === 'constant' && x.repo === repo && x.name === name) as Located<FindingOf<'constant'>> | undefined)?.value;
  const owned = new Set<Located>(services.flatMap((s) => s.findings));

  // ---------- per service: endpoints, config targets, vars, tables, topics, calls ----------
  const endpointsOf = new Map<string, Array<{ id: string; method: string; path: string }>>();
  const datastoreOf = new Map<string, { relational?: string; queue?: string }>();
  const pendingCalls: Array<{ s: Service; f: Located<FindingOf<'outbound'>>; target: string | null; origin: Origin; note?: string }> = [];

  for (const s of services) {
    const cfgDefault = (key: string) => s.config.get(key)?.find((c) => !c.profile)?.value;
    const root = cfgDefault('server.servlet.context-path') ?? cfgDefault('quarkus.http.root-path') ?? '';
    const eps: Array<{ id: string; method: string; path: string }> = [];
    for (const f of s.findings) {
      if (f.kind !== 'endpoint') continue;
      const path = ('/' + root + '/' + f.path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
      const id = `ep:${s.name}:${f.method} ${path}`;
      b.node({ id, type: 'endpoint', name: `${f.method} ${path}`, service: s.id, repo: s.repo, attrs: { method: f.method, path, ...(f.source === 'openapi' ? { contract: true } : { handler: f.symbol }) }, anchor: anchorOf(f) });
      b.fact(s.id, 'exposes', id, 'extracted', anchorOf(f), f.source === 'openapi' ? 'declared in an OpenAPI file' : undefined);
      eps.push({ id, method: f.method, path });
    }
    endpointsOf.set(s.id, eps);

    // Configuration values that point somewhere: another service, a datastore, an external system.
    const stores: { relational?: string; queue?: string } = {};
    for (const [key, entries] of s.config) {
      for (const e of entries) {
        for (const t of targetsIn(e.value)) {
          const target = resolveTarget(t, s);
          if (!target) continue;
          link(s, target, e.at, 'extracted', `config ${key}${e.profile ? ` (${e.profile})` : ''}`);
          const node = b.nodes.get(target)!;
          if (node.type === 'datastore' && node.kind === 'relational' && /datasource|jdbc/.test(key)) stores.relational ??= target;
          if (node.type === 'datastore' && node.kind === 'queue' && /kafka|bootstrap/.test(key)) stores.queue ??= target;
        }
      }
      // `clamav.host` + `clamav.port`
      const hp = key.match(/^(.*)\.host$/);
      if (hp) {
        const port = s.config.get(`${hp[1]}.port`)?.find((c) => !c.profile)?.value;
        for (const e of entries) {
          // `${MAIL_HOST:smtp.gmail.com}` is the host smtp.gmail.com, read from MAIL_HOST: the external is named by the host and says which variable moves it
          const ph = placeholder(e.value);
          if (ph && !ph.default) continue; // no default: it is only known by the variable, which the messaging pass names
          const target = resolveTarget({ host: ph?.default ?? e.value, port: port ? Number(port) : undefined }, s);
          if (!target) continue;
          if (ph && b.nodes.get(target)?.type === 'external') b.node({ id: target, type: 'external', name: b.nodes.get(target)!.name, kind: 'service', attrs: { via: ph.var, ...(/mail|smtp/i.test(hp[1]) ? { messaging: 'smtp' } : {}) } });
          link(s, target, e.at, 'extracted', `config ${hp[1]}.host/port`);
        }
      }
    }
    datastoreOf.set(s.id, stores);

    // What the service sends by mail or SMS: its dependency says how, a variable or a fixed server says where.
    const varsOf = new Set(s.findings.filter((f) => f.kind === 'env-var').map((f) => (f as FindingOf<'env-var'>).name));
    for (const f of s.findings) {
      if (f.kind !== 'dependency' || /^(?:test|dev|provided)$/i.test(f.scope ?? '')) continue;
      const m = MESSAGING.find((x) => x.dep.test(f.name));
      if (!m) continue;
      const via = m.vars?.find((v) => varsOf.has(v) || [...s.config.values()].flat().some((c) => placeholder(c.value)?.var === v)) ?? m.vars?.[0];
      // a server named in configuration (`spring.mail.host`) is already its own external; only a service with none of its own gets the stand-in
      const own = b.facts.some((x) => x.s === s.id && m.vars?.includes(String(b.nodes.get(x.o)?.attrs?.via)));
      const named = m.host ?? (own ? undefined : 'smtp');
      if (!named) continue;
      const id = `ext:${named}`;
      b.node({ id, type: 'external', name: named, kind: 'service', attrs: { messaging: m.kind, provider: m.provider, ...(via ? { via } : {}) } });
      const node = b.nodes.get(id)!;
      node.attrs = { ...node.attrs, messaging: m.kind, provider: m.provider };
      b.fact(s.id, 'calls', id, 'derived', { repo: s.repo, commit: s.commit, path: (f as Located).file }, `${m.kind === 'sms' ? 'sends text messages' : 'sends mail'} (${m.provider})`);
    }

    const constants = new Map(s.findings.filter((f) => f.kind === 'constant').map((f) => [(f as FindingOf<'constant'>).name, (f as FindingOf<'constant'>).value]));
    for (const f of s.findings) {
      const at = anchorOf(f);
      if (f.kind === 'env-var' && f.via !== 'env-file' && f.via !== 'compose') {
        b.node({ id: `var:${f.name}`, type: 'env-var', name: f.name });
        // That a default exists, never the value: it is often a secret's dev stand-in. The vault reads a note here as "has a default or is overridden".
        b.fact(s.id, 'reads-var', `var:${f.name}`, 'extracted', at, [f.via === 'config-mapping' ? `overrides ${f.configKey}` : '', f.hasDefault ? 'has a default' : ''].filter(Boolean).join(', ') || undefined);
      }
      if (f.kind === 'table') {
        const id = `tbl:${f.schema ? f.schema + '.' : ''}${f.name}`;
        b.node({ id, type: 'table', name: f.schema ? `${f.schema}.${f.name}` : f.name, attrs: { schema: f.schema } });
        b.fact(s.id, f.op === 'maps' ? 'maps-table' : 'defines-table', id, 'extracted', at);
        if (stores.relational) b.fact(stores.relational, 'contains', id, 'derived', undefined, `${s.name} maps it through its datasource`);
      }
      if (f.kind === 'topic' || f.kind === 'channel') {
        let name: string | undefined;
        let op: 'publishes' | 'consumes' | 'defines';
        if (f.kind === 'topic') { op = f.op; name = f.name.startsWith('const:') ? constants.get(f.name.slice(6)) ?? repoConstant(s.repo, f.name.slice(6)) : f.name; }
        else { op = f.dir === 'in' ? 'consumes' : 'publishes'; name = s.config.get(`mp.messaging.${f.dir === 'in' ? 'incoming' : 'outgoing'}.${f.name}.topic`)?.[0]?.value ?? f.name; }
        if (!name) continue;
        if (f.kind === 'topic' && f.op === 'defines') { b.node({ id: `topic:${name}`, type: 'topic', name, attrs: { partitions: f.partitions } }); if (stores.queue) b.fact(stores.queue, 'contains', `topic:${name}`, 'derived'); continue; }
        b.node({ id: `topic:${name}`, type: 'topic', name });
        b.fact(s.id, op as 'publishes' | 'consumes', `topic:${name}`, 'extracted', at);
        if (stores.queue) b.fact(stores.queue, 'contains', `topic:${name}`, 'derived');
      }
      if (f.kind === 'dependency') {
        const id = `dep:${f.ecosystem}:${f.name}`;
        b.node({ id, type: 'dependency', name: f.name, kind: f.ecosystem, attrs: { version: f.version, scope: f.scope } });
        b.fact(s.id, 'depends-on', id, 'extracted', at);
      }
      if (f.kind === 'outbound') {
        let target: string | null = null, origin: Origin = 'extracted', note: string | undefined;
        if (f.configKey) {
          const v = (s.config.get(`quarkus.rest-client.${f.configKey}.url`) ?? s.config.get(`quarkus.rest-client."${f.configKey}".url`) ?? s.config.get(`${f.configKey}/mp-rest/url`))?.[0];
          const t = v ? targetsIn(v.value)[0] : undefined;
          target = t ? resolveTarget(t, s) : null;
          const env = v?.value.match(/^\$\{([A-Z][A-Z0-9_]*)/)?.[1];
          if (!target && env) { target = guessByVar(env, s); origin = 'derived'; }
          note = `rest client ${f.configKey}`;
        } else if (f.envVar) {
          // the value its compose sets says where it goes; else a guess from the variable's name
          const t = targetsIn(composeEnv.get(s.id)?.[f.envVar] ?? '')[0];
          target = t ? resolveTarget(t, s) : null;
          note = `base URL from ${f.envVar}`;
          if (!target) { target = guessByVar(f.envVar, s); origin = 'derived'; }
        }
        else if (f.url) { const t = targetsIn(f.url)[0]; target = t ? resolveTarget(t, s) : null; }
        else if (f.relative && f.path) {
          const proxies = s.findings.filter((p): p is Located<FindingOf<'proxy'>> => p.kind === 'proxy' && f.path!.startsWith(p.prefix.replace(/\/$/, ''))).sort((x, y) => y.prefix.length - x.prefix.length);
          for (const p of proxies) { const t = targetsIn(p.target)[0]; target = t ? resolveTarget(t, s) : null; if (target) { note = `via proxy ${p.prefix}`; break; } }
        }
        pendingCalls.push({ s, f: f as Located<FindingOf<'outbound'>>, target, origin, note });
      }
    }
  }

  function guessByVar(name: string, from: Service): string {
    const stem = name.replace(/_(SERVICE_)?(BASE_)?(URL|URI|HOST|ENDPOINT|ADDR|ADDRESS)$/, '').toLowerCase().replace(/_/g, '-');
    const svc = services.find((s) => s !== from && [s.name, s.name.replace(/-(service|api|svc)$/, '')].includes(stem));
    if (svc) return svc.id;
    const id = `ext:${stem.replace(/-(api|service)$/, '')}`;
    b.node({ id, type: 'external', name: stem.replace(/-(api|service)$/, ''), kind: 'service', attrs: { via: name } });
    return id;
  }

  // ---------- calls, down to the endpoint when it can be matched ----------
  const matchEndpoint = (svcId: string, method: string | undefined, path: string) => {
    const want = normalizePath(path);
    const eps = endpointsOf.get(svcId) ?? [];
    const same = (e: { method: string }) => !method || e.method === method || e.method === 'ANY';
    return eps.find((e) => same(e) && normalizePath(e.path) === want)
      ?? eps.filter((e) => same(e) && e.path.endsWith('/**') && want.startsWith(normalizePath(e.path.slice(0, -3)))).sort((x, y) => y.path.length - x.path.length)[0];
  };
  // A gateway's `/prefix/**` endpoint forwards to the endpoints under that prefix in the services it calls.
  const forwards = new Map<string, Array<{ id: string; method: string; path: string; via: string }>>();
  for (const s of services) {
    const downstream = new Set(b.facts.filter((f) => f.s === s.id && f.p === 'calls' && b.nodes.get(f.o)?.type === 'service').map((f) => f.o));
    for (const w of (endpointsOf.get(s.id) ?? []).filter((e) => e.path.endsWith('/**'))) {
      const prefix = normalizePath(w.path.slice(0, -3));
      for (const d of downstream) {
        for (const e of endpointsOf.get(d) ?? []) {
          const p = normalizePath(e.path);
          if ((p === prefix || p.startsWith(prefix + '/')) && (w.method === e.method || w.method === 'ANY')) {
            b.fact(w.id, 'forwards-to', e.id, 'derived', undefined, `${w.path} is proxied to ${b.nodes.get(d)!.name}`);
            (forwards.get(w.id) ?? forwards.set(w.id, []).get(w.id)!).push({ ...e, via: s.name });
          }
        }
      }
    }
  }

  for (const c of pendingCalls) {
    if (!c.target) continue;
    const at = anchorOf(c.f);
    const t = b.nodes.get(c.target)!;
    const label = c.f.method && c.f.path ? `${c.f.method} ${c.f.path}` : undefined;
    if (t.type === 'service' && c.f.path) {
      const ep = matchEndpoint(c.target, c.f.method, c.f.path);
      if (ep) {
        b.fact(c.s.id, 'calls', ep.id, c.origin, at, across(c.s, ep.id, [normalizePath(ep.path) === normalizePath(c.f.path) ? undefined : label, c.note].filter(Boolean).join(', ') || undefined));
        // Through a gateway: the request ends at the downstream endpoint with the same path.
        const end = (forwards.get(ep.id) ?? []).find((e) => normalizePath(e.path) === normalizePath(c.f.path!) && (!c.f.method || e.method === c.f.method));
        if (end) b.fact(c.s.id, 'calls', end.id, 'derived', at, `through ${end.via} ${ep.method} ${ep.path}`);
        continue;
      }
    }
    b.fact(c.s.id, t.type === 'service' ? 'calls' : 'uses', c.target, c.origin, at, across(c.s, c.target, [label, c.note].filter(Boolean).join(', ')));
  }

  // Env vars declared by example files and compose, at repo level.
  for (const f of located) {
    if (f.kind === 'env-var' && (f.via === 'env-file' || f.via === 'compose')) {
      b.node({ id: `var:${f.name}`, type: 'env-var', name: f.name });
      b.fact(`repo:${f.repo}`, 'declares-var', `var:${f.name}`, 'extracted', anchorOf(f), f.via === 'compose' ? 'expected by compose' : 'listed in an example env file');
    }
    if (f.kind === 'table' && f.op === 'defines' && !owned.has(f)) {
      const id = `tbl:${f.schema ? f.schema + '.' : ''}${f.name}`;
      b.node({ id, type: 'table', name: f.schema ? `${f.schema}.${f.name}` : f.name, attrs: { schema: f.schema } });
      b.fact(`repo:${f.repo}`, 'defines-table', id, 'extracted', anchorOf(f));
    }
  }

  // A dependency that is the artifact of another repo of this application is a dependency on that repo.
  const artifacts = new Map<string, string>();
  for (const f of located) if (f.kind === 'service-root' && f.name) artifacts.set(f.name, f.repo);
  for (const f of b.facts.filter((x) => x.p === 'depends-on' && x.o.startsWith('dep:'))) {
    const art = b.nodes.get(f.o)!.name.split(':').pop()!.replace(/^@[^/]+\//, '');
    const owner = artifacts.get(art);
    const from = b.nodes.get(f.s)!;
    if (owner && owner !== from.repo) b.fact(f.s, 'depends-on', `repo:${owner}`, 'derived', f.anchor, `through ${b.nodes.get(f.o)!.name}`);
  }

  return {
    version: 1, app: ws.app, builtAt: new Date().toISOString(),
    repos: extractions.map((e) => ({ name: e.repo, commit: e.commit, ref: e.ref })),
    nodes: [...b.nodes.values()], facts: b.facts, names,
  };
}
