/**
 * Fidelity: how much an env looks like production, measured and never assumed. What runs comes from the
 * env's rendered compose, its state, the tap's rules and its last run; what production does comes from the repos at
 * the commit the env ran (production profiles, Kubernetes manifests, Helm values, a production compose) or from what
 * an external or a runbook declares. Laru never connects to production. Whatever no source says is left without
 * a reference, never taken as equal.
 *
 * It is read as a contrast: each aspect that `infrastructure` declares of production against every env, with a verdict —
 * equal, different and accepted (a reason in findings.yaml), or different. The env card and the `infrastructure` sheet
 * show it; `GET /api/fidelity`, `laru fidelity` and the MCP tool carry the same table.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { appHome, loadAccepted, loadKnowledge, type Row, type Workspace } from '@laru/core';
import { parseAllDocuments, parse } from 'yaml';
import { LABEL } from './docker.ts';
import { envDir, loadEnvSpec, readState } from './env.ts';
import { mockContracts, readRules } from './rules.ts';
import { listRuns, runDir } from './runs.ts';
import type { TapConfig } from './types.ts';

export type Aspect = 'image' | 'profile' | 'memory' | 'cpus' | 'protocol' | 'auth' | 'mode' | 'upload-limit' | 'read-limit';
/** One thing production does, and where that is said: `<repo>@<sha>/<path>[:line]` or a piece's id. */
export interface ProdRef { participant: string; aspect: Aspect; value: string; source: string }
export type FidelityKind = 'service' | 'dependency' | 'external' | 'network' | 'resources' | 'security' | 'limits';
/** What a row says once production and this env are put side by side. */
export type Verdict = 'igual' | 'distinto' | 'aceptado' | 'sin referencia' | 'no aplica';
export interface FidelityRow {
  kind: FidelityKind;
  /** a participant, or an edge `a → b` */
  name: string;
  /** what is compared: a participant has two rows of resources (memory, cpus) and of security (protocol, auth) */
  aspect?: Aspect;
  local: string;
  /** what production does; null when no source says (`—` for the network: nothing in production to compare with) */
  prod: string | null;
  source: string | null;
  /** local and production differ, both said */
  gap?: boolean;
  verdict?: Verdict;
  /** the reason in findings.yaml, when the difference was accepted on purpose */
  accepted?: { reason: string; until?: string };
}
export interface Fidelity { env: string; sources: string[]; run?: string; rows: FidelityRow[] }

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', '.laru', '.keelson', '.gradle', '.idea', 'vendor']); // legacy-name
function* files(root: string, dir = root): Generator<string> {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    // a symbolic link is not followed: one to a parent folder would never end
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* files(root, p);
    else if (st.size < 512 * 1024) yield p;
  }
}
const yamlDocs = (text: string): any[] => { try { return parseAllDocuments(text).map((d) => d.toJS()).filter((d) => d && typeof d === 'object'); } catch { return []; } };
const lineOf = (text: string, needle: string) => text.slice(0, Math.max(0, text.indexOf(needle))).split('\n').length;
const PROFILE_VARS = ['SPRING_PROFILES_ACTIVE', 'QUARKUS_PROFILE', 'NODE_ENV', 'APP_ENV'];
const envList = (env: unknown): Record<string, string> => Array.isArray(env)
  ? Object.fromEntries(env.map((e: any) => (typeof e === 'string' ? [e.split('=')[0], e.split('=').slice(1).join('=')] : [e?.name, String(e?.value ?? '')])))
  : Object.fromEntries(Object.entries((env ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]));
const limitsOf = (r: any) => ({ memory: r?.memory ? String(r.memory) : undefined, cpus: r?.cpu ?? r?.cpus ? String(r.cpu ?? r.cpus) : undefined });

/**
 * What the files of one snapshot say about production. `dirs` maps each built service to its build context inside
 * the snapshot, so a production profile is the service's whose folder holds it.
 */
export function prodRefs(root: string, label: string, dirs: Record<string, string>): ProdRef[] {
  const out: ProdRef[] = [];
  const add = (participant: string, aspect: Aspect, value: string | undefined, file: string, line?: number) => {
    if (participant && value) out.push({ participant, aspect, value, source: `${label}/${relative(root, file)}${line ? `:${line}` : ''}` });
  };
  const owner = (file: string) => Object.entries(dirs).filter(([, d]) => file.startsWith(d + '/')).sort(([, a], [, b]) => b.length - a.length)[0]?.[0];
  for (const f of files(root)) {
    const name = basename(f);
    const prof = /^application-(prod\w*)\.(ya?ml|properties)$/.exec(name);
    if (prof) {
      const svc = owner(f), text = readFileSync(f, 'utf8');
      if (!svc) continue;
      add(svc, 'profile', prof[1], f);
      const ssl = /ssl[\s\S]{0,80}?enabled\s*[:=]\s*true/.exec(text);
      if (ssl) add(svc, 'protocol', 'HTTPS', f, lineOf(text, ssl[0]));
      continue;
    }
    if (name === 'application.properties') {
      const text = readFileSync(f, 'utf8'), svc = owner(f), m = /^%prod\./m.exec(text);
      if (svc && m) add(svc, 'profile', 'prod', f, lineOf(text, m[0]));
      const ssl = /^%prod\.quarkus\.http\.(ssl|insecure-requests\s*=\s*disabled)/m.exec(text);
      if (svc && ssl) add(svc, 'protocol', 'HTTPS', f, lineOf(text, ssl[0]));
      continue;
    }
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(f, 'utf8');
    // a production compose: its services as production runs them
    if (/^(docker-)?compose[.-]prod(uction)?\.ya?ml$/.test(name)) {
      for (const doc of yamlDocs(text)) for (const [svc, s] of Object.entries((doc.services ?? {}) as Record<string, any>)) {
        const at = lineOf(text, `${svc}:`), lim = limitsOf(s?.deploy?.resources?.limits);
        add(svc, 'image', s?.image, f, at);
        add(svc, 'memory', lim.memory ?? s?.mem_limit, f, at);
        add(svc, 'cpus', lim.cpus ?? (s?.cpus !== undefined ? String(s.cpus) : undefined), f, at);
        const e = envList(s?.environment);
        add(svc, 'profile', PROFILE_VARS.map((k) => e[k]).find(Boolean), f, at);
      }
      continue;
    }
    // Helm: a chart's values say its image and limits; the chart's name is the participant
    if (/^values[\w.-]*\.ya?ml$/.test(name) && existsSync(join(dirname(f), 'Chart.yaml'))) {
      let chart = basename(dirname(f));
      try { chart = String(parse(readFileSync(join(dirname(f), 'Chart.yaml'), 'utf8'))?.name ?? chart); } catch { /* the folder's name */ }
      const v = yamlDocs(text)[0] ?? {}, lim = limitsOf(v.resources?.limits);
      if (v.image?.repository) add(chart, 'image', `${v.image.repository}${v.image.tag ? `:${v.image.tag}` : ''}`, f, lineOf(text, 'repository'));
      add(chart, 'memory', lim.memory, f, lineOf(text, 'limits'));
      add(chart, 'cpus', lim.cpus, f, lineOf(text, 'limits'));
      continue;
    }
    // Kubernetes manifests (Helm templates do not parse and are skipped): each container as production runs it
    for (const doc of yamlDocs(text)) {
      if (/^(Deployment|StatefulSet|DaemonSet)$/.test(doc.kind)) {
        for (const c of doc.spec?.template?.spec?.containers ?? []) {
          const svc = String(c.name ?? doc.metadata?.name), at = lineOf(text, `name: ${c.name}`), lim = limitsOf(c.resources?.limits), e = envList(c.env);
          for (const p of new Set([svc, String(doc.metadata?.name ?? svc)])) {
            add(p, 'image', c.image, f, at);
            add(p, 'memory', lim.memory, f, at);
            add(p, 'cpus', lim.cpus, f, at);
            add(p, 'profile', PROFILE_VARS.map((k) => e[k]).find(Boolean), f, at);
          }
        }
      }
      if (doc.kind === 'Ingress' && doc.spec?.tls?.length) {
        for (const r of doc.spec.rules ?? []) for (const p of r.http?.paths ?? []) add(String(p.backend?.service?.name ?? p.backend?.serviceName ?? ''), 'protocol', 'HTTPS', f, lineOf(text, 'tls'));
      }
    }
  }
  return out;
}

/** What the infrastructure declares about production (`production` rows; older externals and runbooks carried them too), for what no file of the repos says. */
export function declaredRefs(ws: Workspace): ProdRef[] {
  return loadKnowledge(ws).pieces.filter((p) => p.type === 'external' || p.type === 'runbook' || p.type === 'infrastructure').flatMap((p) =>
    ((Array.isArray(p.fields.production) ? p.fields.production : []) as Row[]).map((r) => ({
      participant: String(r.service || (p.type === 'external' ? p.title : '')).replace(/^(svc|ext|ds):/, ''), aspect: String(r.aspect) as Aspect, value: String(r.value), source: p.id,
    })).filter((r) => r.participant && r.value));
}

const BYTES: Record<string, number> = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, ki: 1024, mi: 1024 ** 2, gi: 1024 ** 3, ti: 1024 ** 4, b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
/** `1g`, `1Gi`, `1024M` and `1073741824` as bytes; docker's units are binary */
export const bytesOf = (s: string) => { const m = /^([\d.]+)\s*([a-z]*)$/i.exec(s.trim()); if (!m) return NaN; const u = m[2].toLowerCase(); return Number(m[1]) * (/^[kmgt]$/.test(u) ? 1024 ** ' kmgt'.indexOf(u) : BYTES[u] ?? NaN); };
const cpusOf = (s: string) => (s.endsWith('m') ? Number(s.slice(0, -1)) / 1000 : Number(s));
/** two values of one aspect that say the same thing (a memory in other units, an image's `docker.io/library/` prefix) */
export function same(aspect: Aspect, a: string, b: string): boolean {
  if (aspect === 'memory') return Math.abs(bytesOf(a) - bytesOf(b)) < 0.02 * bytesOf(b);
  if (aspect === 'cpus') return cpusOf(a) === cpusOf(b);
  if (aspect === 'upload-limit' || aspect === 'read-limit') return Number.isFinite(bytesOf(a)) && Number.isFinite(bytesOf(b)) ? Math.abs(bytesOf(a) - bytesOf(b)) < 0.02 * bytesOf(b) : a.trim().toLowerCase() === b.trim().toLowerCase();
  if (aspect === 'image') { const n = (s: string) => s.replace(/^(docker\.io\/)?(library\/)?/, '').replace(/^([^:@]+)$/, '$1:latest'); return n(a) === n(b); }
  if (aspect === 'auth') { const x = authClass(a), y = authClass(b); return x === 'other' || y === 'other' ? a.trim().toLowerCase() === b.trim().toLowerCase() : x === y; }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const FIDELITY_KINDS: Record<FidelityKind, string> = { service: 'Servicio', dependency: 'Dependencia', external: 'Externo', network: 'Red', resources: 'Recursos', security: 'Seguridad', limits: 'Límites' };
export const NO_REF = 'sin referencia de producción';
const UNLIMITED = 'sin límite';
/** The table as text, for the CLI and the MCP: one line per row, the gaps marked. */
export function fidelityText(f: Fidelity): string {
  const out = [`${f.env}: ${f.sources.join(' · ') || 'sin fuente'}${f.run ? `, tap medido en el run ${f.run}` : ''}`];
  for (const k of Object.keys(FIDELITY_KINDS) as FidelityKind[]) {
    const rows = f.rows.filter((r) => r.kind === k);
    if (!rows.length) continue;
    out.push(FIDELITY_KINDS[k]);
    for (const r of rows) out.push(`  ${r.gap ? '≠' : ' '} ${r.name}${r.aspect ? ` (${r.aspect})` : ''}: ${r.local}${r.prod === '—' ? '' : ` | producción: ${r.prod ?? NO_REF}`}${r.verdict && r.prod !== '—' ? ` → ${r.verdict}${r.accepted ? ` (${r.accepted.reason})` : ''}` : ''}${r.source ? ` (${r.source})` : ''}`);
  }
  return out.join('\n');
}

/**
 * Authentication by what it is, not how it is written: a declared `Keycloak` and a local `idp` (from `KEYCLOAK_URL`)
 * are the same. `on` is only «enabled» with no mechanism said; a text of no known class compares as written.
 */
export type AuthClass = 'off' | 'idp' | 'jwt' | 'basic' | 'apikey' | 'mtls' | 'on' | 'other';
export function authClass(s: string): AuthClass {
  const t = s.trim();
  if (/^(off|none|disabled|false|no|desactivada|sin autenticación)$/i.test(t)) return 'off';
  if (/keycloak|oidc|oauth|\bidp\b|saml|issuer|auth0|okta|cognito|entra/i.test(t)) return 'idp';
  if (/jwt/i.test(t)) return 'jwt';
  if (/mtls|mutual tls|client cert/i.test(t)) return 'mtls';
  if (/api[- ]?key/i.test(t)) return 'apikey';
  if (/\bbasic\b|básica/i.test(t)) return 'basic';
  return /^(on|enabled|true|yes|activa|activada|sí)$/i.test(t) ? 'on' : 'other';
}

/**
 * What a service's variables say of its authentication: a class to compare, and the words for the table. A flag that
 * turns it off wins over any IdP setting; a flag the vault hands over could, so it leaves the class unknown; nothing
 * seen is unknown too, never «off».
 */
export function authOf(e: Record<string, string>): { known?: AuthClass; auth: string } {
  const keys = Object.keys(e);
  const idp = keys.find((k) => /KEYCLOAK|OIDC|OAUTH2|ISSUER/.test(k)), off = keys.find((k) => /(AUTH|SECURITY)_(ENABLED|DISABLED)$/.test(k));
  if (off && e[off].startsWith('${')) return { auth: `autenticación según ${off} (del vault)` };
  const flag = off ? (/DISABLED/.test(off) === (e[off] === 'true') ? 'off' : 'on') : undefined;
  if (flag === 'off') return { known: 'off', auth: `autenticación desactivada (${off})` };
  if (idp) return { known: 'idp', auth: `autenticación con IdP (${idp})` };
  if (keys.some((k) => /JWT_SECRET/.test(k))) return { known: 'jwt', auth: 'autenticación propia (JWT)' };
  return flag ? { known: 'on', auth: `autenticación activa (${off})` } : { auth: '' };
}

/** What an image does when nothing configures it, for the limits a declaration can name. Extend it as images are met. */
const IMAGE_DEFAULTS: Array<{ image: RegExp; aspect: Aspect; value: string; why: string }> = [
  { image: /clamav/i, aspect: 'read-limit', value: '100MB', why: 'StreamMaxLength por defecto de clamd 1.5 (100M si no se configura)' },
];

/** The upload limit a build folder configures for the profile the env runs: Spring's multipart, or nginx's body size. */
function uploadLimitOf(dir: string, profile: string | undefined): { value: string; at: string } | null {
  const text = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
  const nginx = text(join(dir, 'nginx.conf'));
  const ng = nginx && /client_max_body_size\s+(\S+?);/.exec(nginx);
  if (ng) return { value: ng[1], at: `nginx.conf:${lineOf(nginx!, ng[0])}` };
  const res = join(dir, 'src/main/resources');
  const tries = [...(profile && profile !== 'default' ? [`application-${profile}.yml`, `application-${profile}.yaml`] : []), 'application.yml', 'application.yaml'];
  for (const name of tries) {
    const t = text(join(res, name));
    const m = t && /max-file-size:\s*(\S+)/.exec(t);
    if (m) return { value: m[1], at: `${name}:${lineOf(t!, m[0])}` };
  }
  return null;
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const ms = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`;

/** The tap's own cost per edge in a run's traces: p50 and p95 of what it added to each forwarded http hop. */
export function tapCost(ws: Workspace, run: string): Record<string, { n: number; p50: number; p95: number }> {
  const by = new Map<string, number[]>();
  const dir = join(runDir(ws, run), 'flows');
  for (const flow of existsSync(dir) ? readdirSync(dir) : []) for (const f of ['trace.json', 'cases.json']) {
    const file = join(dir, flow, f);
    if (!existsSync(file)) continue;
    const traces = ([] as any[]).concat(JSON.parse(readFileSync(file, 'utf8')));
    for (const t of traces) for (const e of t.exchanges ?? []) if (typeof e.tap === 'number') { const k = `${e.from} → ${e.to}`; by.set(k, [...(by.get(k) ?? []), e.tap]); }
  }
  return Object.fromEntries([...by].map(([k, xs]) => { xs.sort((a, b) => a - b); return [k, { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }]; }));
}

/** The env's fidelity table. Needs the env to have been started once (its rendered compose); a run measures the tap. */
export function fidelity(ws: Workspace, env: string): Fidelity {
  const spec = loadEnvSpec(ws, env), state = readState(ws, env);
  const composeFile = join(envDir(ws, env), 'compose.yml');
  if (!existsSync(composeFile) || !state) throw new Error(`${env} has never been started: its fidelity is read from what it runs (laru up ${env})`);
  const compose = parse(readFileSync(composeFile, 'utf8')) as { services: Record<string, any> };
  const routes = (existsSync(join(envDir(ws, env), 'tap', 'routes.json')) ? (JSON.parse(readFileSync(join(envDir(ws, env), 'tap', 'routes.json'), 'utf8')) as TapConfig).routes : []);
  const rules = readRules(ws, env);
  const sources = state.sources ?? (state.source ? [state.source] : []);
  // the snapshots the env ran, and an infra repo no env runs (its manifests), as checked out on this machine
  const roots = [...sources.map((s) => ({ label: s, root: join(appHome(ws.app), 'snapshots', s) })),
    ...ws.repos.filter((r) => r.role === 'infra' && !sources.some((s) => s.startsWith(`${r.name}@`)) && ws.checkouts[r.name]).map((r) => ({ label: r.name, root: ws.checkouts[r.name] }))].filter((r) => existsSync(r.root));

  // participants: compose's services by their own name (the tap's and one-shot jobs' too, as they run)
  const svcs = Object.entries(compose.services).filter(([n]) => n !== 'ks-tap').map(([n, s]) => ({ name: String(s.labels?.[LABEL.service] ?? n.replace(/-real$/, '')), s }));
  const dirs: Record<string, string> = {};
  for (const { name, s } of svcs) if (s.build?.context) dirs[name] = s.build.context;
  const refs = [...roots.flatMap((r) => prodRefs(r.root, r.label, dirs)), ...declaredRefs(ws)];
  const ref = (who: string, aspect: Aspect) => refs.find((r) => r.participant === who && r.aspect === aspect);
  const externals = new Set(loadKnowledge(ws).pieces.filter((p) => p.type === 'external').map((p) => p.title));
  const hybrid = new Set(state.hybrid ?? []);
  const rows: FidelityRow[] = [];
  const row = (kind: FidelityKind, name: string, local: string, aspect: Aspect, value?: string) => {
    const r = ref(name, aspect);
    rows.push({ kind, name, aspect, local, prod: r?.value ?? null, source: r?.source ?? null, ...(r && value !== undefined && !same(aspect, value, r.value) ? { gap: true } : {}) });
  };

  for (const { name, s } of svcs) {
    const e = envList(s.environment), key = PROFILE_VARS.find((k) => e[k]), profile = key ? e[key] : undefined;
    // a profile the vault hands over is not known here: said as such, and never compared
    const vault = profile?.startsWith('${');
    if (s.build) row('service', name, `${hybrid.has(name) ? 'en tu máquina' : sources.find((x) => s.build.context.includes(`/${x}/`)) ?? 'construido'} · perfil ${vault ? `del vault (${key})` : profile ?? 'por defecto'}`, 'profile', vault ? undefined : profile ?? 'default');
    else if (!externals.has(name)) row('dependency', name, String(s.image), 'image', String(s.image));
  }
  for (const name of hybrid) if (!svcs.some((x) => x.name === name)) row('service', name, 'en tu máquina', 'profile');

  // externals: those documented, and anything the tap answers for
  const contracts = mockContracts(ws);
  const dated = (svc: string) => {
    const c = contracts[svc]; if (!c) return '';
    const t = Math.max(0, ...c.files.map((f) => { try { return statSync(join(ws.root, c.dir, f)).mtimeMs; } catch { return 0; } }));
    return t ? `, ${c.dir} del ${new Date(t).toISOString().slice(0, 10)}` : `, ${c.dir}`;
  };
  for (const name of new Set([...externals, ...Object.keys(rules.mocks)])) {
    const mock = rules.mocks[name], s = svcs.find((x) => x.name === name)?.s;
    if (!mock && !s) continue; // documented but not part of this env
    const mode = mock ? mock.mode : 'real';
    row('external', name, mock ? `${mock.mode}${dated(name)}` : `real (${s.image})`, 'mode', mode);
  }

  // the network: each edge the last run crossed, with the faults on its target and what the tap added
  const run = listRuns(ws, 200).find((r) => r.env === env && r.phase === 'done' && existsSync(join(runDir(ws, r.id), 'flows')));
  const cost = run ? tapCost(ws, run.id) : {};
  const faulted = Object.entries(rules.faults).filter(([, f]) => f.length);
  const fdesc = (svc: string) => (rules.faults[svc] ?? []).map((f) => [f.latency && `+${f.latency} ms`, f.status && `${f.status}`, f.abort && 'corta', f.timeout && 'nunca responde', f.bandwidth && `${f.bandwidth} B/s`].filter(Boolean).join(' ') + (f.from ? ` desde ${f.from}` : '') + (f.p !== undefined && f.p < 1 ? ` (p ${f.p})` : '')).join('; ');
  for (const [edge, c] of Object.entries(cost).sort(([a], [b]) => a.localeCompare(b))) {
    const to = edge.split(' → ')[1];
    rows.push({ kind: 'network', name: edge, local: `tap p50 ${ms(c.p50)} · p95 ${ms(c.p95)} (${c.n} ${c.n === 1 ? 'salto' : 'saltos'})${fdesc(to) ? ` · fallos: ${fdesc(to)}` : ''}`, prod: '—', source: `run ${run!.id}` });
  }
  for (const [svc] of faulted) if (!Object.keys(cost).some((e) => e.endsWith(` → ${svc}`))) rows.push({ kind: 'network', name: `→ ${svc}`, local: `fallos: ${fdesc(svc)}`, prod: '—', source: 'reglas del tap' });
  if (!Object.keys(cost).length) rows.push({ kind: 'network', name: 'tap', local: run ? `run ${run.id} sin saltos HTTP medidos` : 'sin medir: ningún run en este entorno', prod: '—', source: null });

  // resources and security, container by container
  for (const { name, s } of svcs) {
    const lim = limitsOf(s.deploy?.resources?.limits), mem = lim.memory ?? s.mem_limit, cpus = lim.cpus ?? (s.cpus !== undefined ? String(s.cpus) : undefined);
    if (hybrid.has(name)) continue;
    // no limit here against a limit in production is a difference too
    row('resources', name, `memoria ${mem ?? UNLIMITED}`, 'memory', mem ?? UNLIMITED);
    if (cpus || ref(name, 'cpus')) row('resources', name, `cpus ${cpus ?? UNLIMITED}`, 'cpus', cpus ?? UNLIMITED);
  }
  for (const r of routes.filter((x) => x.proto !== 'tcp' && x.proto !== 'pg')) {
    const { known, auth } = authOf(envList(svcs.find((x) => x.name === r.svc)?.s.environment));
    row('security', r.svc, `${r.proto.toUpperCase()}${auth ? `, ${auth}` : ''}`, 'protocol', r.proto.toUpperCase());
    // «enabled» with no mechanism seen says nothing against a declared mechanism: only against off, or a plain «on»
    const said = ref(r.svc, 'auth');
    if (said) row('security', r.svc, auth || 'sin autenticación vista', 'auth', known === 'on' && !['off', 'on'].includes(authClass(said.value)) ? undefined : known);
  }
  // limits: what production declares, against what this env's configuration says for the profile it runs
  for (const r of refs.filter((x) => x.aspect === 'upload-limit' || x.aspect === 'read-limit')) {
    const mine = svcs.find((x) => x.name === r.participant);
    if (hybrid.has(r.participant)) continue;
    // a mocked external does not read the file at all
    if (r.aspect === 'read-limit' && rules.mocks[r.participant]) {
      rows.push({ kind: 'limits', name: r.participant, aspect: r.aspect, local: `imitado (${rules.mocks[r.participant].mode}): no lee el fichero`, prod: r.value, source: r.source, verdict: 'no aplica' });
      continue;
    }
    if (!mine) continue;
    const e = envList(mine.s.environment), key = PROFILE_VARS.find((k) => e[k]), profile = key && !e[key].startsWith('${') ? e[key] : undefined;
    let local: string, value: string | undefined, source = r.source;
    if (r.aspect === 'upload-limit') {
      const dir = dirs[r.participant], got = dir ? uploadLimitOf(dir, profile) : null;
      local = got ? `${got.value} (${got.at})` : 'sin límite propio'; value = got?.value ?? 'sin límite propio';
    } else {
      const set = Object.entries(e).find(([k]) => /StreamMaxLength$/i.test(k))?.[1], def = IMAGE_DEFAULTS.find((d) => d.aspect === 'read-limit' && d.image.test(String(mine.s.image ?? '')));
      value = set ?? def?.value; local = set ? `${set} (configurado)` : def ? `${def.value} (${def.why})` : 'sin dato';
    }
    rows.push({ kind: 'limits', name: r.participant, aspect: r.aspect, local, prod: r.value, source, ...(value !== undefined && !same(r.aspect, value, r.value) ? { gap: true } : {}) });
  }

  // verdicts: equal, different, or different and accepted on purpose (findings.yaml, which reopens it when it expires)
  const accepted = loadAccepted(ws), today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    if (row.verdict) continue;
    if (row.prod === '—') continue;
    if (row.prod === null) { row.verdict = 'sin referencia'; continue; }
    const a = accepted[`fidelity-gap:env:${env}:${row.kind}:${row.name}${row.aspect ? `:${row.aspect}` : ''}`];
    if (row.gap && a && !(a.until && a.until < today)) { row.verdict = 'aceptado'; row.accepted = { reason: a.reason, until: a.until }; }
    else row.verdict = row.gap ? 'distinto' : 'igual';
  }
  const order = Object.keys(FIDELITY_KINDS);
  return { env, sources, ...(run ? { run: run.id } : {}), rows: rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)) };
}
