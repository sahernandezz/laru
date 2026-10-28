/**
 * The workspace: a folder outside the repos, with its own git. `laru.yaml` says which repos make the
 * application (by URL and branch); where each one is cloned on this machine lives in
 * `~/.laru/<app>/checkouts.yaml`, which is never versioned; `laru.lock` says at which commit each
 * repo was last verified.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isMap, isSeq, parse, parseDocument, stringify } from 'yaml';

export const ROLES = ['service', 'frontend', 'library', 'infra', 'docs'] as const;
export type RepoRole = (typeof ROLES)[number];

/**
 * A project: a git repo (by URL and branch) or a plain folder (`source: folder`). A folder has no URL and no branch:
 * both are `''`, so every `r.url`/`r.branch` stays typed and the UI branches on `source`.
 */
export interface RepoConfig { name: string; source: 'git' | 'folder'; url: string; branch: string; role: RepoRole; title?: string; ignore?: string[]; group?: string }
/**
 * A service said by hand, for what the code does not show (a Lambda's own router, a gateway that is only an image):
 * `kind` its technology, `endpoints` «GET /x» (or just «/x»), `calls` the names it reaches («pagos», «pagos POST /cobros»,
 * «postgres», «api.vendor.example»). Without `dir`, a name the project's compose runs is that container.
 */
export interface ServiceOverride { name: string; repo: string; dir: string; kind?: string; endpoints?: string[]; calls?: string[] }
export interface Workspace {
  root: string;
  app: string;
  title: string;
  docsLanguage: string;
  repos: RepoConfig[];
  services: ServiceOverride[];
  /** repo name → absolute path of its checkout on this machine */
  checkouts: Record<string, string>;
  /** repo name → last verified commit */
  lock: Record<string, string>;
  /** which lifecycle stages each container class must cover; merged over the default */
  profile?: Record<string, Array<'plan' | 'design' | 'build' | 'test' | 'deploy' | 'operate'>>;
  /** minimum notes that make `laru check` fail; both off unless the workspace turns them on */
  policies?: { documento?: number; hoja?: number };
  /** hosts the code names that are not part of the system (a search engine, a vendor's API): left off the map; `*` stands for any part */
  ignoreExternals?: string[];
}

export class WorkspaceError extends Error {
  readonly at?: string;
  constructor(message: string, at?: string) { super(at ? `${at}: ${message}` : message); this.at = at; }
}

export const CONFIG_FILE = 'laru.yaml';
export const LOCK_FILE = 'laru.lock';
/**
 * The names from before the product was called Laru. A workspace and a machine set up then keep their files and
 * folders: each is used where it is the only one there, and the new name everywhere else.
 */
const LEGACY = { config: 'keelson.yaml', lock: 'keelson.lock', state: '.keelson', env: 'KEELSON_' }; // legacy-name
const either = (fresh: string, old: string) => (!existsSync(fresh) && existsSync(old) ? old : fresh);
/** The workspace's config file: `laru.yaml`, or its old name when only that one exists. */
export const configFile = (root: string): string => either(join(root, CONFIG_FILE), join(root, LEGACY.config));
export const isWorkspace = (root: string): boolean => existsSync(configFile(root));
/** `LARU_<name>` from the environment, or the variable's old name. */
export const envOf = (name: string): string | undefined => process.env[`LARU_${name}`] ?? process.env[`${LEGACY.env}${name}`];
export const laruHome = (): string => envOf('HOME') ?? either(join(homedir(), '.laru'), join(homedir(), LEGACY.state));
export const appHome = (app: string): string => join(laruHome(), app);
export const stateDir = (ws: Pick<Workspace, 'root'>): string => either(join(ws.root, '.laru'), join(ws.root, LEGACY.state));
/** The copy of each folder project that git shares with the team (folder.ts). */
export const sharedFolder = (ws: Pick<Workspace, 'root'>, repo: string): string => join(ws.root, 'projects', repo);
/**
 * `base/…parts` as a real path when nothing below `base` is a link, else undefined: git checks a link out as one, and a
 * link anywhere in the way would make Laru read or write outside the workspace.
 * Known limit: a check, then a use, as runner-file.ts; a folder swapped for a link in between gets through.
 */
export function plainPath(base: string, ...parts: string[]): string | undefined {
  try { const path = join(realpathSync(base), ...parts); return realpathSync(path) === path ? path : undefined; } catch { return undefined; }
}
/** A short, stable id of the workspace on this machine: two clones of the same app never share containers. */
export const workspaceKey = (ws: Pick<Workspace, 'root'>): string => createHash('sha1').update(ws.root).digest('hex').slice(0, 10);

const ID = /^[a-z0-9][a-z0-9-]*$/;
/**
 * A repo URL and a branch reach git as arguments, from a laru.yaml anyone on the team may have written: one that starts
 * with `-` would be read as an option (`--upload-pack=<command>` runs that command), and `<transport>::` URLs call
 * a program. Neither is a place to clone from, so neither gets that far.
 */
export const gitUrlError = (url: string): string | undefined =>
  !url.trim() ? 'required' : /^\s*-/.test(url) ? 'a URL cannot start with "-"' : /^[a-z][a-z0-9+.-]*::/i.test(url) ? 'a remote-helper transport (<name>::) is not a repository address' : /[\0-\x1f]/.test(url) ? 'a URL has no control characters' : undefined;
/** Only what would reach git as something else: any name git itself accepts (`release/1.2`, `feat/ñandú+x`) still loads. */
export const branchError = (branch: string): string | undefined =>
  !branch.trim() ? 'required' : /^\s*-/.test(branch) ? 'a branch cannot start with "-"' : /[\0-\x1f\x7f]/.test(branch) ? 'a branch has no control characters' : undefined;

export function findWorkspace(from: string = process.cwd()): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (isWorkspace(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Reads and validates `laru.yaml`. Errors name the field that fails: `repos.billing.url`. */
export function loadWorkspace(root: string): Workspace {
  const file = configFile(root);
  if (!existsSync(file)) throw new WorkspaceError(`no ${CONFIG_FILE} here; run \`laru init\``);
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const app = String(raw.app ?? '');
  if (!ID.test(app)) throw new WorkspaceError('must be kebab-case, e.g. `my-app`', 'app');
  const repos: RepoConfig[] = Object.entries((raw.repos as Record<string, Record<string, unknown>>) ?? {}).map(([name, r]) => {
    if (!ID.test(name)) throw new WorkspaceError('repo names are kebab-case', `repos.${name}`);
    const source = r?.source ?? 'git';
    if (source !== 'git' && source !== 'folder') throw new WorkspaceError('git or folder', `repos.${name}.source`);
    if (source === 'folder' && r.url !== undefined) throw new WorkspaceError('a folder project has no url', `repos.${name}.url`);
    if (source === 'folder' && r.branch !== undefined) throw new WorkspaceError('a folder project has no branch', `repos.${name}.branch`);
    if (source === 'git' && r?.ignore !== undefined) throw new WorkspaceError('only a folder project ignores paths', `repos.${name}.ignore`);
    const urlIssue = source === 'git' ? gitUrlError(String(r?.url ?? '')) : undefined;
    if (urlIssue) throw new WorkspaceError(urlIssue, `repos.${name}.url`);
    const branchIssue = source === 'git' && r?.branch !== undefined ? branchError(String(r.branch)) : undefined;
    if (branchIssue) throw new WorkspaceError(branchIssue, `repos.${name}.branch`);
    const ignore = r?.ignore;
    if (ignore !== undefined && (!Array.isArray(ignore) || ignore.some((x) => typeof x !== 'string'))) throw new WorkspaceError('a list of paths in gitignore syntax', `repos.${name}.ignore`);
    if (r?.group !== undefined && (typeof r.group !== 'string' || !r.group.trim())) throw new WorkspaceError('the name of the application it belongs to, e.g. `Tienda`', `repos.${name}.group`);
    const role = (r?.role ?? 'service') as RepoRole;
    if (!ROLES.includes(role)) throw new WorkspaceError(`one of ${ROLES.join(', ')}`, `repos.${name}.role`);
    return {
      name, source, url: source === 'git' ? String(r.url) : '', branch: source === 'git' ? String(r.branch ?? 'main') : '', role,
      ...(r?.title ? { title: String(r.title) } : {}), ...(ignore ? { ignore: ignore as string[] } : {}),
      ...(r?.group ? { group: String(r.group).trim() } : {}),
    };
  });
  const services: ServiceOverride[] = Object.entries((raw.services as Record<string, { repo?: string; dir?: string; kind?: string; endpoints?: unknown; calls?: unknown }>) ?? {}).map(([name, s]) => {
    if (!s?.repo || !repos.some((r) => r.name === s.repo)) throw new WorkspaceError(`unknown repo "${s?.repo}"`, `services.${name}.repo`);
    const strings = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
    const endpoints = strings(s.endpoints), calls = strings(s.calls);
    return { name, repo: s.repo, dir: (s.dir ?? '').replace(/^\.?\/|\/$/g, ''), ...(s.kind ? { kind: String(s.kind) } : {}), ...(endpoints.length ? { endpoints } : {}), ...(calls.length ? { calls } : {}) };
  });
  // Only the projects this laru.yaml names: another workspace with this app id shares the file.
  const checkouts = Object.fromEntries(Object.entries(readCheckouts(app)).filter(([name]) => repos.some((r) => r.name === name)));
  // A folder not linked on this machine is read from the copy the workspace carries, as a teammate's clone has it.
  for (const r of repos) {
    const copy = r.source === 'folder' && !(checkouts[r.name] && existsSync(checkouts[r.name])) ? plainPath(root, 'projects', r.name) : undefined;
    if (copy) checkouts[r.name] = copy;
  }
  const lockFile = either(join(root, LOCK_FILE), join(root, LEGACY.lock));
  const lock = existsSync(lockFile) ? (((parse(readFileSync(lockFile, 'utf8')) ?? {}) as { repos?: Record<string, string> }).repos ?? {}) : {};
  const stages = ['plan', 'design', 'build', 'test', 'deploy', 'operate'];
  const profile = (raw.profile ?? undefined) as Workspace['profile'];
  for (const [cls, list] of Object.entries(profile ?? {})) {
    if (!Array.isArray(list) || list.some((s) => !stages.includes(s))) throw new WorkspaceError(`a list of ${stages.join(', ')}`, `profile.${cls}`);
  }
  const policies = (raw.policies ?? undefined) as Workspace['policies'];
  for (const [name, v] of Object.entries(policies ?? {})) {
    if (!['documento', 'hoja'].includes(name)) throw new WorkspaceError('policies are documento and hoja', `policies.${name}`);
    if (typeof v !== 'number' || v < 0 || v > 100) throw new WorkspaceError('a note between 0 and 100', `policies.${name}`);
  }
  const ignoreExternals = raw['ignore-externals'];
  if (ignoreExternals !== undefined && (!Array.isArray(ignoreExternals) || ignoreExternals.some((x) => typeof x !== 'string' || !x.trim()))) throw new WorkspaceError('a list of hosts; * stands for any part, e.g. `*.example.com`', 'ignore-externals');
  return {
    root, app, title: String(raw.title ?? app), docsLanguage: String(raw['docs-language'] ?? 'en'), repos, services, checkouts, lock, profile, policies,
    ...(ignoreExternals ? { ignoreExternals: ignoreExternals as string[] } : {}),
  };
}

/** Adds or replaces one repo in `laru.yaml`, keeping the file's comments and order. */
export function saveRepo(ws: Workspace, repo: RepoConfig): void {
  // the application a project belongs to is set by hand in laru.yaml: adding the project again keeps it
  const group = repo.group ?? ws.repos.find((r) => r.name === repo.name)?.group;
  if (group) repo = { ...repo, group };
  const file = configFile(ws.root);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const entry: Record<string, unknown> = repo.source === 'folder'
    ? { source: 'folder', role: repo.role, ...(repo.title ? { title: repo.title } : {}), ...(repo.ignore?.length ? { ignore: repo.ignore } : {}), ...(group ? { group } : {}) }
    : { url: repo.url, branch: repo.branch, role: repo.role, ...(repo.title ? { title: repo.title } : {}), ...(group ? { group } : {}) };
  doc.setIn(['repos', repo.name], doc.createNode(entry));
  const repos = doc.get('repos', true);
  if (isMap(repos)) {
    repos.flow = false;
    for (const it of repos.items) {
      if (!isMap(it.value)) continue;
      it.value.flow = false;
      const ignore = it.value.get('ignore', true);
      if (isSeq(ignore)) ignore.flow = true; // ignore: [data/, "*.zip"]
    }
  }
  writeFileSync(file, doc.toString());
  const i = ws.repos.findIndex((r) => r.name === repo.name);
  if (i >= 0) ws.repos[i] = repo; else ws.repos.push(repo);
}

const readCheckouts = (app: string): Record<string, string> => {
  const file = join(appHome(app), 'checkouts.yaml');
  return existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, string>) : {};
};

/** Writes this workspace's checkouts over the file's, keeping the entries of another workspace with the same app id. */
export function saveCheckouts(ws: Workspace): void {
  const dir = appHome(ws.app);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkouts.yaml'), '# Where each repo of this application is cloned on this machine. Not versioned.\n' + stringify({ ...readCheckouts(ws.app), ...ws.checkouts }));
}

export function saveLock(ws: Workspace): void {
  writeFileSync(either(join(ws.root, LOCK_FILE), join(ws.root, LEGACY.lock)), '# Commit at which each repo was last verified. Written by `laru verify`.\n' + stringify({ repos: ws.lock }));
}
