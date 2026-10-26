/**
 * Several projects' composes as one: every service re-keyed by its unique name (depends_on within its project
 * follows), named volumes prefixed with their project, and `share` dropping a service in favour of another
 * project's. Pure. With one member it is the identity for the first project, so its env renders as before.
 */
import { closure, type ComposeDoc, type Service } from './compose.ts';
import type { EnvSpec } from './types.ts';

export interface Member { repo: string; env: string; doc: ComposeDoc; spec: EnvSpec }
export interface Joined {
  /** keys are unique names */
  doc: ComposeDoc;
  /** unique → repo */
  repoOf: Record<string, string>;
  /** unique → member env (its vault level) */
  envOf: Record<string, string>;
  /** unique → compose name (its alias on its project's network) */
  composeOf: Record<string, string>;
  /** a service share dropped → the one used instead */
  shareAlias: Record<string, string>;
}

export function joinComposes(members: Member[], name: (repo: string, svc: string) => string, share: Record<string, string> = {}): Joined {
  const several = members.length > 1;
  const out: Joined = { doc: { services: {} }, repoOf: {}, envOf: {}, composeOf: {}, shareAlias: {} };
  if (!several && members[0]) out.doc = { ...members[0].doc, services: {} }; // its keys in their order: normalized.json as before
  for (const m of members) {
    const key = (svc: string) => name(m.repo, svc);
    const named = new Set(Object.keys(m.doc.volumes ?? {}));
    const services: Record<string, Service> = {};
    for (const [svc, s] of Object.entries(m.doc.services)) {
      const x: Service = { ...s };
      if (s.depends_on && !Array.isArray(s.depends_on)) x.depends_on = Object.fromEntries(Object.entries(s.depends_on).map(([d, c]) => [key(d), c]));
      if (several && Array.isArray(s.volumes)) x.volumes = s.volumes.map((v: any) => (v?.type === 'volume' && named.has(v.source) ? { ...v, source: `${m.repo}-${v.source}` } : v));
      services[key(svc)] = x;
      out.repoOf[key(svc)] = m.repo;
      out.envOf[key(svc)] = m.env;
      out.composeOf[key(svc)] = svc;
    }
    // Each member keeps what its own env runs: its services: subset with their depends_on closure.
    const kept = several ? closure({ services }, m.spec.services) : Object.keys(services);
    for (const k of kept) out.doc.services[k] = services[k];
    if (several) for (const [v, def] of Object.entries(m.doc.volumes ?? {})) (out.doc.volumes ??= {})[`${m.repo}-${v}`] = def;
  }
  for (const [dropped, used] of Object.entries(share)) {
    delete out.doc.services[dropped];
    out.shareAlias[dropped] = used;
    for (const s of Object.values(out.doc.services)) {
      if (!s.depends_on?.[dropped]) continue;
      const deps: Record<string, unknown> = {};
      for (const [d, c] of Object.entries(s.depends_on)) deps[d === dropped ? used : d] ??= c;
      s.depends_on = deps;
    }
  }
  return out;
}

/**
 * How the projects of a joint env reach each other. Visibility: on a project's network, another project's service
 * answers to its compose name when that project does not define the name itself (a shared network, its own names
 * first); `share` adds the dropped service's name for the one used instead. Host ports: what a member publishes for
 * a fronted service is reached as host.docker.internal:<port>; two members publishing one host port are refused.
 */
export function jointRouting(j: Joined, included: string[], fronted: Set<string>, listens: (svc: string) => boolean, share: Record<string, string>) {
  const repos = [...new Set(Object.values(j.repoOf))];
  const visible: Record<string, Record<string, string>> = {};
  for (const r of repos) {
    const own = new Set(Object.keys(j.doc.services).filter((u) => j.repoOf[u] === r).map((u) => j.composeOf[u]));
    visible[r] = {};
    for (const u of included) if (j.repoOf[u] !== r && !own.has(j.composeOf[u]) && (fronted.has(u) || listens(u))) visible[r][j.composeOf[u]] ??= u;
  }
  for (const [dropped, used] of Object.entries(share)) visible[j.repoOf[dropped]][j.composeOf[dropped]] = used;
  const hostPortRoutes: Array<{ svc: string; hostPort: number; port: number }> = [];
  const publisher = new Map<number, string>();
  for (const u of included) {
    for (const p of j.doc.services[u].ports ?? []) {
      const hostPort = Number(typeof p === 'object' ? p.published : String(p).split(':').slice(-2, -1)[0]);
      const port = Number(typeof p === 'object' ? p.target : String(p).split(':').pop()?.split('/')[0]);
      if (!hostPort) continue;
      const other = publisher.get(hostPort);
      if (other && j.repoOf[other] !== j.repoOf[u]) throw new Error(`${j.repoOf[other]}:${j.composeOf[other]} and ${j.repoOf[u]}:${j.composeOf[u]} both publish host port ${hostPort}; they could not run side by side either`);
      publisher.set(hostPort, u);
      if (fronted.has(u)) hostPortRoutes.push({ svc: u, hostPort, port });
    }
  }
  return { visible, hostPortRoutes };
}

export interface JointProposal {
  name: string;
  members: Array<{ repo: string; env: string; create?: string }>;
  share: Record<string, string>;
  /** compose names more than one project uses: each keeps its own inside its network */
  collisions: Array<{ name: string; as: Record<string, string> }>;
  /** what the map says one project calls of another, with its anchor */
  talks: Array<{ from: string; to: string; note?: string; at?: string }>;
  shareWhy: Record<string, string>;
  yaml: string;
}

/**
 * What «Nuevo entorno conjunto» proposes: each chosen project with its env (or a `<repo>-local` to create from the
 * compose the map found), a share where two projects run the same kind of broker and one consumes what the other
 * publishes, the names both define, and how the projects talk according to the map.
 */
export function proposeJoint(o: {
  name: string;
  picked: string[];
  envs: Array<{ env: string; repo: string }>;
  map: { names?: Record<string, Record<string, string>>; nodes: Array<{ id: string; repo?: string; kind?: string; type: string }>; facts: Array<{ s: string; p: string; o: string; note?: string; anchor?: { repo: string; path: string; line?: number } }> };
  composeOf: Record<string, string | undefined>;
  repos: string[];
}): JointProposal {
  const members = o.picked.map((p) => {
    const env = o.envs.find((e) => e.env === p);
    if (env) return { repo: env.repo, env: env.env };
    const own = o.envs.filter((e) => e.repo === p).sort((a, b) => Number(b.env === 'local') - Number(a.env === 'local') || a.env.localeCompare(b.env))[0];
    return own ? { repo: p, env: own.env } : { repo: p, env: `${p}-local`, create: `${p}:${o.composeOf[p] ?? 'docker-compose.yml'}` };
  }).sort((a, b) => o.repos.indexOf(a.repo) - o.repos.indexOf(b.repo));
  const node = (id: string) => o.map.nodes.find((n) => n.id === id);
  const brokers = (repo: string) => Object.values(o.map.names?.[repo] ?? {}).filter((u) => node(`ds:${u}`)?.kind === 'queue');
  const topics = (repo: string, p: 'publishes' | 'consumes') => new Set(o.map.facts.filter((f) => f.p === p && node(f.s)?.repo === repo).map((f) => f.o));
  const share: Record<string, string> = {}, shareWhy: Record<string, string> = {};
  for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) {
    const [ba, bb] = [brokers(a.repo)[0], brokers(b.repo)[0]];
    if (!ba || !bb) continue;
    const t = [...topics(b.repo, 'consumes')].find((x) => topics(a.repo, 'publishes').has(x)) ?? [...topics(a.repo, 'consumes')].find((x) => topics(b.repo, 'publishes').has(x));
    if (!t) continue;
    share[bb] = ba;
    shareWhy[bb] = t.replace(/^topic:/, '');
  }
  const byName = new Map<string, Record<string, string>>();
  for (const m of members) for (const [c, u] of Object.entries(o.map.names?.[m.repo] ?? {})) byName.set(c, { ...(byName.get(c) ?? {}), [m.repo]: u });
  const collisions = [...byName].filter(([, as]) => Object.keys(as).length > 1).map(([name, as]) => ({ name, as }));
  const inJoint = new Set(members.map((m) => m.repo));
  const talks = o.map.facts.filter((f) => /across projects/.test(f.note ?? '') && inJoint.has(node(f.s)?.repo ?? '') && inJoint.has(node(f.o)?.repo ?? (node(`svc:${f.o.split(':')[1]}`)?.repo ?? '')))
    .map((f) => ({ from: f.s, to: f.o, note: f.note, at: f.anchor ? `${f.anchor.repo}:${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ''}` : undefined }));
  const yaml = `join: [${members.map((m) => m.env).join(', ')}]\n${Object.keys(share).length ? `share: { ${Object.entries(share).map(([a, b]) => `${a}: ${b}`).join(', ')} }\n` : ''}persistent: true\n`;
  return { name: o.name, members, share, collisions, talks, shareWhy, yaml };
}
