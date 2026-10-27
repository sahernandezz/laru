/**
 * The vault: the variables an environment injects, per level (compose default < app < env < service <
 * personal; in a joint env, app < env.<member> < env.<joint> < service), with secrets encrypted at rest. `vault/vars.yaml` and `vault/secrets.enc` are versioned with
 * the workspace so the team shares them; the key that opens them never is: it lives in the OS keychain,
 * or a 0600 file. A value travels only on stdin and in the env of the `docker compose` process: never on
 * argv, never in a log, and what reports on the vault (varTable, missingVars) never carries one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appHome, envOf, git, gitOf, loadExtraction, stateDir, treeNow, WorkspaceError, type Graph, type Workspace } from '@laru/core';
import { isMap, parse, parseDocument, stringify } from 'yaml';
import { inWsl, withLock } from './docker.ts';
import { ENV_NAME, listEnvs, loadEnvSpec } from './env.ts';
import { ksVar, type VaultInjection } from './types.ts';

export type Level = 'app' | 'env' | 'service' | 'flows' | 'personal';

/** One compose service of the environment, as the render sees it. */
export interface VaultService {
  name: string;
  /** built from a repo of the app; false for an image (infrastructure) */
  built: boolean;
  /** compose `environment`, uninterpolated; null for a bare `- KEY` */
  environment: Record<string, string | null>;
  /** the body of every `${…}` in the service, as written: `JWT_SECRET`, `CLAMAV_HOST:-clamav` */
  interpolations: string[];
  /** joint envs: the member env it comes from, whose `env.<member>` level applies below the joint env's */
  env?: string;
  /** its name in its own compose file, when the unique name differs (`postgres` for `audit-postgres`) */
  compose?: string;
}

/** One value at one level. `section` is `app`, `env.<env>`, `service.<service>`, `flows` or `personal`. */
export interface VaultEntry { section: string; key: string; secret: boolean; value: string }
export interface VaultKey { key: Buffer; store: 'keychain' | 'secret-tool' | 'file'; /** a plain key file: doctor warns */ warning: boolean }
/** A row of the Vars screen. Never a value. */
export interface VarRow {
  key: string;
  /** the sections that set it, lowest precedence first: `compose` (the compose's own value), then the vault's */
  levels: string[];
  secret: boolean;
  /** the section that wins (`compose` included), null when nothing sets it */
  effective: string | null;
  /** services that read it, from the map */
  readers: string[];
  /** services whose compose sets or interpolates it */
  compose: string[];
}
export interface VarIssue {
  level: 'error' | 'warning';
  /** stable, for whoever groups or filters issues; `message` is for people */
  code: 'missing-var' | 'blank-override' | 'unused-var' | 'type' | 'plain-secret' | 'getenv';
  key: string;
  service?: string;
  message: string;
  at: string;
}
/** The repo compose file of the env, so a message can name `<repo>:<path>:<line>`. */
export interface ComposeLines { file: string; lines: string[] }

/**
 * Keys whose values must not be versioned in plain text: a name segment that is or ends in SECRET, PASSWORD, KEY,
 * TOKEN or CREDENTIAL (`JWT_SECRET`, `STRIPE_APIKEY`, `minio.secret-key`), or is PASS or PWD. The word has to end
 * its segment, so `KEYCLOAK_URL`, `PASSENGER_COUNT` and `TOKENIZER_MODEL` are not secrets.
 */
const SECRET_WORD = /(^|[_.-])([a-z0-9]*(secret|password|passwd|token|credential)s?|(api|access|secret|private|signing|encryption|master|license)?keys?|pass|pwd)([_.-]|$)/i;
/** …_HEADER, …_SERIALIZER and the like name or describe a key; they are not one. */
const ABOUT_A_KEY = /[_.-](header|name|serializer|deserializer|field|param|prefix|algorithm|type|size|length|path|file|id|url|uri|store|alias)$/i;
export const SECRET_KEY = { test: (k: string) => SECRET_WORD.test(k) && !ABOUT_A_KEY.test(k) } as const;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What compose accepts as a service name (the compose spec's own pattern). */
const SERVICE_NAME = /^[A-Za-z0-9._-]+$/;
const REF = /^secret:\/\/(.+)$/;
/** `${X:-default}` or `${X-default}`, as an interpolation body */
const DEFAULT = /^([A-Za-z_]\w*):?-(.*)$/s;
const NUMERIC = /(^|_)(PORT|TIMEOUT|MS|SIZE)(_|$)/i;
const URLISH = /(^|_)(URL|URI|ENDPOINT)(_|$)/i;
const CONFIG_FILE = /(^|\/)(application|bootstrap)(-[\w-]+)?\.(ya?ml|properties)$/;
const TEST_PATH = /(^|\/)src\/test\//;
/** Read by the runtime, not by code: never reported as unused. */
const RUNTIME_VARS = ['JAVA_TOOL_OPTIONS', 'JAVA_OPTS', 'NODE_OPTIONS', 'SPRING_PROFILES_ACTIVE', 'QUARKUS_PROFILE', 'TZ'];
const SERVICE = 'laru-vault';
const LEGACY_SERVICE = 'keelson-vault'; // legacy-name
const LEVELS: Level[] = ['app', 'env', 'service', 'personal', 'flows'];

const varsFile = (ws: Workspace) => join(ws.root, 'vault', 'vars.yaml');
const encFile = (ws: Workspace) => join(ws.root, 'vault', 'secrets.enc');
const personalFile = (ws: Workspace) => join(appHome(ws.app), 'overrides.yaml');
const keyFile = (ws: Workspace) => join(appHome(ws.app), 'vault.key');
const lockFile = (ws: Workspace) => join(stateDir(ws), 'vault.lock');

const varName = (body: string) => body.match(/^[A-Za-z_]\w*/)?.[0] ?? body;
/** Spring relaxed binding, as `envName` in @laru/detect: `minio.secret-key` → `MINIO_SECRET_KEY`. */
const envName = (key: string) => key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
const fix = (key: string) => `laru vars set ${key}${SECRET_KEY.test(key) ? ' --secret' : ''}`;
/** A joint env's own level sits just above its members'. */
const rank = (section: string, env?: string) => (env && section === `env.${env}` ? 1.5 : LEVELS.indexOf(section.split('.')[0] as Level));
const applies = (section: string, env: string, svc?: string, member?: string) =>
  section === 'app' || section === 'personal' || section === `env.${env}` || (member !== undefined && section === `env.${member}`) || (svc !== undefined && section === `service.${svc}`);
const readsOf = (g: Graph | null, svc: string) => new Set((g?.outOf(`svc:${svc}`) ?? []).filter((f) => f.p === 'reads-var').map((f) => f.o.slice(4)));
/** One rule for a section, whether setVar writes it or readEntries reads it back. */
const isSection = (s: string) =>
  s === 'app' || s === 'flows' || (s.startsWith('env.') && ENV_NAME.test(s.slice(4))) || (s.startsWith('service.') && SERVICE_NAME.test(s.slice(8)));

function sectionOf(level: Level, scope?: string): string {
  if (!LEVELS.includes(level)) throw new WorkspaceError(`one of ${LEVELS.join(', ')}`, 'level');
  if (level !== 'env' && level !== 'service') {
    if (scope) throw new WorkspaceError(`the ${level} level takes no scope`, 'scope');
    return level;
  }
  if (!scope || !isSection(`${level}.${scope}`)) throw new WorkspaceError(`the ${level} level needs the ${level} name${level === 'env' ? ', in kebab-case' : ''}`, 'scope');
  return `${level}.${scope}`;
}

/** YAML errors quote the source, and these files hold values: only the file and line:column survive. */
function yamlError(file: string, e: unknown): WorkspaceError {
  const p = (e as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
  return new WorkspaceError('not valid YAML', p ? `${file}:${p.line}:${p.col}` : file);
}

function readYaml(text: string, file: string): Record<string, unknown> {
  let doc: unknown;
  try { doc = parse(text, { logLevel: 'error' }); } catch (e) { throw yamlError(file, e); }
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc))) throw new WorkspaceError('must be a map', file);
  return (doc ?? {}) as Record<string, unknown>;
}

/** A temp file renamed over the old one: a reader, or a crash, sees the old file or the new one, never half of one. */
function writeAtomic(file: string, text: string, mode = 0o666): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, text, { mode }); renameSync(tmp, file); }
  catch (e) { rmSync(tmp, { force: true }); throw e; }
}

// ---------- encryption ----------

const aad = (app: string) => Buffer.from(`laru:${app}:v1`);

function seal(app: string, key: Buffer, secrets: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(aad(app));
  const data = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n';
}

function unseal(app: string, key: Buffer, text: string): Record<string, string> {
  try {
    const f = JSON.parse(text) as { v: number; iv: string; tag: string; data: string };
    if (f.v !== 1) throw new Error('version');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'), { authTagLength: 16 }).setAAD(aad(app));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new WorkspaceError('cannot be opened with this key: the key is wrong or the file was altered', 'vault/secrets.enc');
  }
}

// ---------- files only this user may read ----------

function readPrivate(file: string): string | null {
  if (!existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (process.platform !== 'win32' && mode & 0o077) throw new WorkspaceError(`other users can read it (mode ${mode.toString(8)}); run \`chmod 600 ${file}\``, file);
  return readFileSync(file, 'utf8');
}

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, text, 0o600);
  chmodSync(file, 0o600);
}

// ---------- the key ----------

type Store = VaultKey['store'];

const FILE_STORE = 'set LARU_VAULT_KEYSTORE=file to keep the vault key in a 0600 file';
let detected: Store | undefined;

/** `LARU_VAULT_KEYSTORE` forces one (tests use `file`); otherwise the OS keychain when there is one, looked up once. */
export function keyStore(): Store {
  const forced = envOf('VAULT_KEYSTORE');
  if (forced) {
    if (forced !== 'keychain' && forced !== 'secret-tool' && forced !== 'file') throw new WorkspaceError('one of keychain, secret-tool, file', 'LARU_VAULT_KEYSTORE');
    return forced;
  }
  detected ??= process.platform === 'darwin' ? 'keychain'
    // WSL2 rarely runs a secret service: secret-tool installed there with no session bus to reach one fails every lookup
    : process.platform === 'linux' && !(inWsl() && !process.env.DBUS_SESSION_BUS_ADDRESS) && !spawnSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 10_000 }).error ? 'secret-tool'
    : 'file';
  return detected;
}

/** Runs a key-store tool with `input` on stdin, so the key never shows up in argv. A prompt nobody answers is killed at 10 s. */
function tool(cmd: string, args: string[], input = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000, killSignal: 'SIGKILL' });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c; });
    p.stdin.on('error', () => {});
    p.on('error', () => reject(new WorkspaceError(`\`${cmd}\` is not available; ${FILE_STORE}`)));
    p.on('close', (code, signal) => {
      if (signal) reject(new WorkspaceError(`\`${cmd}\` did not answer within 10 s (${signal}); ${FILE_STORE}`));
      else resolve({ code: code ?? 1, out: out.trim() });
    });
    p.stdin.end(input);
  });
}

async function readKey(ws: Workspace, store: Store): Promise<string | null> {
  if (store === 'file') return readPrivate(keyFile(ws))?.trim() || null;
  // a key kept before the rename is still under the old service name
  for (const service of [SERVICE, LEGACY_SERVICE]) {
    const r = store === 'keychain'
      ? await tool('security', ['find-generic-password', '-s', service, '-a', ws.app, '-w'])
      : await tool('secret-tool', ['lookup', 'service', service, 'account', ws.app]);
    if (r.code === 0 && r.out) return r.out;
    // 44 is "not found"; anything else (a denied prompt) must not lead to a new key overwriting the old one.
    if (store === 'keychain' && r.code !== 44) throw new WorkspaceError(`the macOS keychain did not give the vault key (security exited ${r.code})`);
  }
  return null;
}

async function writeKey(ws: Workspace, store: Store, hex: string): Promise<void> {
  if (store === 'file') return writePrivate(keyFile(ws), hex + '\n');
  if (store === 'keychain') await tool('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ws.app} -w ${hex}\n`);
  else await tool('secret-tool', ['store', '--label', `Laru vault ${ws.app}`, 'service', SERVICE, 'account', ws.app], hex);
  if ((await readKey(ws, store)) !== hex) throw new WorkspaceError(`the ${store} did not keep the vault key`);
}

const noKey = () => new WorkspaceError('this machine has no key for it: run `laru vault key import` with the output of `laru vault key export` from a machine that has it', 'vault/secrets.enc');

/** The 32-byte key of this app's vault. With `create`, makes one when there is none and nothing is encrypted yet. */
export async function vaultKey(ws: Workspace, opts: { create?: boolean } = {}): Promise<VaultKey | null> {
  const store = keyStore();
  let hex = await readKey(ws, store);
  if (!hex) {
    if (!opts.create) return null;
    if (existsSync(encFile(ws))) throw noKey();
    hex = randomBytes(32).toString('hex');
    await writeKey(ws, store, hex);
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new WorkspaceError(`the vault key in the ${store} is not 32 bytes of hex`);
  return { key: Buffer.from(hex, 'hex'), store, warning: store === 'file' };
}

/** The key as text, to carry to another machine (`laru vault key export`). */
export async function exportKey(ws: Workspace): Promise<string> {
  const k = await vaultKey(ws);
  if (!k) throw new WorkspaceError('this machine has no vault key yet', 'vault');
  return k.key.toString('hex');
}

/** Stores a key from `exportKey`, after checking it opens `vault/secrets.enc`. */
export async function importKey(ws: Workspace, text: string): Promise<VaultKey> {
  const hex = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new WorkspaceError('a vault key is 64 hex characters, as `laru vault key export` prints it', 'key');
  const key = Buffer.from(hex, 'hex');
  if (existsSync(encFile(ws))) unseal(ws.app, key, readFileSync(encFile(ws), 'utf8'));
  const store = keyStore();
  await writeKey(ws, store, hex);
  return { key, store, warning: store === 'file' };
}

// ---------- reading ----------

/** An entry as stored: a secret of vars.yaml carries `ref` (its name in secrets.enc) and no value. */
type RawEntry = VaultEntry & { ref?: string };

function readEntries(ws: Workspace): RawEntry[] {
  const out: RawEntry[] = [];
  const file = varsFile(ws);
  const doc = existsSync(file) ? readYaml(readFileSync(file, 'utf8'), 'vault/vars.yaml') : {};
  for (const [section, vars] of Object.entries(doc)) {
    if (!isSection(section)) throw new WorkspaceError('a level is app, flows, env.<env> or service.<service>', `vault/vars.yaml: ${section}`);
    if (vars !== null && (typeof vars !== 'object' || Array.isArray(vars))) throw new WorkspaceError('a level is a map of variables', `vault/vars.yaml: ${section}`);
    for (const [key, v] of Object.entries((vars ?? {}) as Record<string, unknown>)) {
      if (!NAME.test(key) || (v !== null && typeof v === 'object')) throw new WorkspaceError('a variable name with a literal or secret:// value', `vault/vars.yaml: ${section}.${key}`);
      const ref = String(v ?? '').match(REF)?.[1];
      out.push(ref ? { section, key, secret: true, value: '', ref } : { section, key, secret: false, value: String(v ?? '') });
    }
  }
  const pfile = personalFile(ws);
  const personal = readPrivate(pfile);
  for (const [key, v] of Object.entries(personal ? readYaml(personal, pfile) : {})) {
    const secret = v !== null && typeof v === 'object';
    const value = secret ? (v as { secret?: unknown }).secret : v;
    if (!NAME.test(key) || (secret && (Array.isArray(v) || Object.keys(v).join() !== 'secret' || (value !== null && typeof value === 'object')))) {
      throw new WorkspaceError('a variable name with a literal or {secret: <value>}', `${pfile}: ${key}`);
    }
    out.push({ section: 'personal', key, secret, value: String(value ?? '') });
  }
  return out;
}

async function readSecrets(ws: Workspace, key?: Buffer): Promise<Record<string, string>> {
  if (!existsSync(encFile(ws))) return {};
  const k = key ?? (await vaultKey(ws))?.key;
  if (!k) throw noKey();
  return unseal(ws.app, k, readFileSync(encFile(ws), 'utf8'));
}

/** Every entry of every level, secrets decrypted. */
export async function loadVault(ws: Workspace): Promise<VaultEntry[]> {
  const raw = readEntries(ws);
  const secrets = raw.some((e) => e.ref) ? await readSecrets(ws) : {};
  return raw.map(({ ref, ...e }) => {
    if (ref === undefined) return e;
    if (secrets[ref] === undefined) throw new WorkspaceError(`secret://${ref} is not in vault/secrets.enc`, `vault/vars.yaml: ${e.section}.${e.key}`);
    return { ...e, value: secrets[ref] };
  });
}

/** Key → the entry that wins for one service of one env. A key secret at any level stays secret above it. */
function effective<E extends VaultEntry>(entries: E[], env: string, svc?: string, member?: string): Map<string, E> {
  const out = new Map<string, E>();
  for (const e of entries.filter((x) => applies(x.section, env, svc, member)).sort((a, b) => rank(a.section, env) - rank(b.section, env))) {
    out.set(e.key, out.get(e.key)?.secret && !e.secret ? { ...e, secret: true } : e);
  }
  return out;
}

/** Service → key → the entry that wins for it. Every level, before least privilege. */
export async function effectiveVars(ws: Workspace, env: string, services: string[]): Promise<Record<string, Record<string, VaultEntry>>> {
  const entries = await loadVault(ws);
  return Object.fromEntries(services.map((s) => [s, Object.fromEntries(effective(entries, env, s))]));
}

/** The effective value of one key, for the UI's reveal. `scope` is a service, or `flows` for the runner's level. */
export async function revealVar(ws: Workspace, env: string, key: string, scope?: string): Promise<string | null> {
  const entries = await loadVault(ws);
  if (scope === 'flows') return entries.find((e) => e.section === 'flows' && e.key === key)?.value ?? null;
  return effective(entries, env, scope).get(key)?.value ?? null;
}

/** Every level's value for one env, decrypted: the Variables screen shows and edits them (it is the person's own machine). */
export async function varValues(ws: Workspace, env: string): Promise<VaultEntry[]> {
  return (await loadVault(ws)).filter((e) => !e.section.startsWith('env.') || e.section === `env.${env}`);
}

/** The flows level, decrypted: what the runner gets. No container ever does. */
export async function flowsVars(ws: Workspace): Promise<Record<string, string>> {
  return Object.fromEntries((await loadVault(ws)).filter((e) => e.section === 'flows').map((e) => [e.key, e.value]));
}

// ---------- writing ----------

const HEADER = '# Laru vault, versioned: variables per level (app, env.<env>, service.<service>, flows).\n# A value is a literal or secret://<name>, whose value is encrypted in secrets.enc.\n';

/** Sets (or, with null, removes) one key of vars.yaml; secrets.enc is re-encrypted and pruned when a secret is involved. */
async function saveVault(ws: Workspace, section: string, key: string, value: string | null, secret = false): Promise<boolean> {
  const file = varsFile(ws);
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : HEADER, { logLevel: 'error' });
  if (doc.errors.length) throw yamlError('vault/vars.yaml', doc.errors[0]);
  const prev = doc.getIn([section, key]);
  if (value === null) {
    if (prev === undefined) return false;
    doc.deleteIn([section, key]);
    const rest = doc.get(section);
    if (isMap(rest) && !rest.items.length) doc.delete(section);
  } else doc.setIn([section, key], secret ? `secret://${section}.${key}` : value);
  let sealed: string | undefined;
  if (secret || (typeof prev === 'string' && REF.test(prev))) {
    const k = await vaultKey(ws, { create: secret });
    if (k) {
      const secrets = await readSecrets(ws, k.key);
      if (secret) secrets[`${section}.${key}`] = value!;
      const used = new Set(Object.values((doc.toJS() ?? {}) as Record<string, Record<string, unknown>>).flatMap((m) => Object.values(m ?? {}).map((v) => String(v).match(REF)?.[1])));
      for (const name of Object.keys(secrets)) if (!used.has(name)) delete secrets[name];
      sealed = seal(ws.app, k.key, secrets);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  // Whichever file drops a reference goes last: a new secret is stored before vars.yaml names it, and an old one is
  // pruned only once vars.yaml no longer names it. A failure in between leaves an unused value, never a dangling name.
  const writes = [() => writeAtomic(file, doc.toString()), () => sealed !== undefined && writeAtomic(encFile(ws), sealed)];
  for (const write of secret ? writes.reverse() : writes) write();
  return true;
}

/** One writer at a time per workspace: a write reads both files, changes them and writes them back. */
const locked = <T>(ws: Workspace, fn: () => Promise<T>) => withLock(`vault ${ws.app}`, fn, undefined, lockFile(ws));

function savePersonal(ws: Workspace, key: string, value: string | { secret: string } | null): boolean {
  const file = personalFile(ws);
  const text = readPrivate(file);
  const map = text ? readYaml(text, file) : {};
  if (value === null && !(key in map)) return false;
  if (value === null) delete map[key]; else map[key] = value;
  writePrivate(file, '# Personal overrides of the vault: this machine only, never versioned.\n' + stringify(map));
  return true;
}

/** Sets a key at one level. A literal under a secret-looking key is refused: it would be versioned in plain text. */
export async function setVar(ws: Workspace, o: { key: string; value: string; level: Level; scope?: string; secret?: boolean }): Promise<void> {
  const section = sectionOf(o.level, o.scope);
  if (!NAME.test(o.key)) throw new WorkspaceError('a variable name is letters, digits and _', o.key);
  if (!o.secret && SECRET_KEY.test(o.key)) throw new WorkspaceError('looks like a secret: set it with --secret (the value is read from stdin)', o.key);
  if (!o.secret && REF.test(o.value)) throw new WorkspaceError('secret:// references are written by --secret, not by hand', o.key);
  await locked(ws, async () => {
    if (section === 'personal') savePersonal(ws, o.key, o.secret ? { secret: o.value } : o.value);
    else await saveVault(ws, section, o.key, o.value, !!o.secret);
  });
}

/** Removes a key from one level. False when that level did not set it. */
export async function unsetVar(ws: Workspace, o: { key: string; level: Level; scope?: string }): Promise<boolean> {
  const section = sectionOf(o.level, o.scope);
  return locked(ws, async () => (section === 'personal' ? savePersonal(ws, o.key, null) : saveVault(ws, section, o.key, null)));
}

// ---------- what an environment gets ----------

/**
 * Least privilege for secrets: a secret reaches a service when its compose interpolates it, the map says
 * the service reads it, or it is set at that service's level. Other values reach every built service.
 * Images get only their service level and what their compose interpolates. A bare `- KEY` asks for the key by
 * name, so every service gets it: compose runs with an empty env, and only the vault can fill it. A key reached
 * only through interpolation fills `${KS_<SVC>__KEY}` and is not added to the service's environment.
 */
export async function injection(ws: Workspace, env: string, services: VaultService[], g: Graph | null): Promise<VaultInjection> {
  const entries = await loadVault(ws);
  const out: VaultInjection = { perService: {}, values: {}, secrets: [] };
  // For the masker: every secret of this env, every value under a secret-looking name, the literal a service gets
  // over a lower-level secret, and what compose itself sets under a secret-looking name (a literal or a default).
  const members = new Set(services.map((s) => s.env).filter(Boolean));
  const secrets = new Set(entries.filter((e) => (e.secret || SECRET_KEY.test(e.key)) && (!e.section.startsWith('env.') || e.section === `env.${env}` || members.has(e.section.slice(4)))).map((e) => e.value));
  for (const s of services) {
    const reads = readsOf(g, s.name);
    const interpolated = new Set(s.interpolations.map(varName));
    const keys: string[] = [];
    for (const [key, e] of effective(entries, env, s.name, s.env)) {
      if (e.secret) secrets.add(e.value);
      const own = s.environment[key] === null || entries.some((x) => x.section === `service.${s.name}` && x.key === key);
      const listed = own || (s.built && (!e.secret || reads.has(key)));
      if (!listed && !interpolated.has(key)) continue;
      out.values[ksVar(s.name, key)] = e.value;
      if (listed) keys.push(key);
    }
    for (const b of s.interpolations) { const d = b.match(DEFAULT); if (d && SECRET_KEY.test(d[1])) secrets.add(d[2]); }
    for (const [k, v] of Object.entries(s.environment)) if (v && SECRET_KEY.test(k) && !v.includes('${')) secrets.add(v);
    out.perService[s.name] = keys.sort();
  }
  out.secrets = [...secrets].filter(Boolean);
  return out;
}

/**
 * Every key the env touches: what the vault sets, what compose expects and what the map says is read. Never a value.
 * `compose` heads `levels` when a service's compose sets the key itself (a literal or a default): it is the lowest.
 */
export function varTable(ws: Workspace, env: string, services: VaultService[], g: Graph | null): VarRow[] {
  const names = new Set(services.map((s) => s.name));
  const members = new Set(services.map((s) => s.env).filter(Boolean));
  // Another env's level never applies (a joint env's members' do); a service level only for a service of this env (any, before its first up).
  const entries = readEntries(ws)
    .filter((e) => (e.section.startsWith('env.') ? e.section === `env.${env}` || members.has(e.section.slice(4)) : !e.section.startsWith('service.') || !names.size || names.has(e.section.slice(8))))
    .sort((a, b) => rank(a.section, env) - rank(b.section, env));
  const keys = new Set(entries.map((e) => e.key));
  for (const s of services) {
    for (const k of Object.keys(s.environment)) keys.add(k);
    for (const b of s.interpolations) keys.add(varName(b));
    for (const k of readsOf(g, s.name)) keys.add(k);
  }
  const composeSets = (key: string) =>
    services.some((s) => (typeof s.environment[key] === 'string' && !s.environment[key]!.includes('${')) || s.interpolations.some((b) => b.match(DEFAULT)?.[1] === key));
  return [...keys].sort().map((key) => {
    const mine = entries.filter((e) => e.key === key);
    const readers = g ? [...new Set(g.inOf(`var:${key}`).filter((f) => f.p === 'reads-var' && f.s.startsWith('svc:')).map((f) => f.s.slice(4)))].sort() : [];
    const compose = services.filter((s) => key in s.environment || s.interpolations.some((b) => varName(b) === key)).map((s) => s.name);
    const set = mine.filter((e) => e.section !== 'flows');
    let effective = (set.at(-1) ?? mine.at(-1))?.section ?? null;
    // Set only per service: the level of the first service that reads it, not whichever the file lists last.
    if (set.length && set.every((e) => e.section.startsWith('service.'))) {
      const first = [...readers, ...compose].find((s) => set.some((e) => e.section === `service.${s}`));
      if (first) effective = `service.${first}`;
    }
    const fromCompose = composeSets(key);
    // A literal (or a template) in compose's environment is what the container gets: the repo decides it.
    const literal = services.some((s) => typeof s.environment[key] === 'string' && !/^\$\{[^}]+\}$/.test(s.environment[key]!.trim()));
    if (literal || (effective === 'flows' && fromCompose)) effective = 'compose';
    return {
      key,
      levels: [...(fromCompose || literal ? ['compose'] : []), ...mine.map((e) => e.section)],
      secret: mine.length ? mine.some((e) => e.secret) : SECRET_KEY.test(key),
      effective: effective ?? (fromCompose ? 'compose' : null),
      readers,
      compose,
    };
  });
}

/** The lines of a service's block in the compose file, and the index of its first line (-1 when not found). */
function blockOf(c: ComposeLines, svc: string): { start: number; block: string[] } {
  const start = c.lines.findIndex((l) => new RegExp(`^\\s{2}${svc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(l));
  if (start < 0) return { start, block: [] };
  const end = c.lines.findIndex((l, i) => i > start && /^\s{0,2}[^\s#]/.test(l));
  return { start, block: c.lines.slice(start, end > 0 ? end : undefined) };
}

/** The line of the first `${name}` with no default inside the service's block; 'default' when it only appears with one. */
function composeLine(c: ComposeLines | undefined, svc: string, name: string): number | 'default' | undefined {
  if (!c) return undefined;
  const bare = new RegExp(`\\$\\{${name}(:?\\?[^}]*)?\\}|(?<!\\$)\\$${name}(?!\\w)`);
  const withDefault = new RegExp(`\\$\\{${name}:?[-+]`);
  const { start, block } = blockOf(c, svc);
  const inBlock = block.findIndex((l) => bare.test(l));
  if (inBlock >= 0) return start + inBlock + 1;
  if (block.some((l) => withDefault.test(l))) return 'default';
  const anywhere = c.lines.findIndex((l) => bare.test(l));
  return anywhere >= 0 ? anywhere + 1 : c.lines.some((l) => withDefault.test(l)) ? 'default' : undefined;
}

/** The line of a bare `- KEY` (or a `KEY:` with no value) inside the service's block. */
function bareLine(c: ComposeLines | undefined, svc: string, name: string): number | undefined {
  if (!c) return undefined;
  const { start, block } = blockOf(c, svc);
  const i = block.findIndex((l) => new RegExp(`^\\s*(-\\s*)?["']?${name}["']?\\s*(:\\s*(null|~)?)?\\s*$`).test(l));
  return i >= 0 ? start + i + 1 : undefined;
}

/**
 * What would make `up` start a service with a missing or wrong variable. Errors block `up`; warnings are
 * shown. Relaxed-binding reads (`overrides <key>`) are optional by nature and never required.
 */
export function missingVars(ws: Workspace, env: string, services: VaultService[], g: Graph | null, compose?: ComposeLines): VarIssue[] {
  const entries = readEntries(ws);
  const out: VarIssue[] = [];
  const seen = new Set<string>();
  const push = (i: VarIssue) => { if (!seen.has(i.message)) { seen.add(i.message); out.push(i); } };
  const names = new Set(services.map((s) => s.name));
  const members = new Set(services.map((s) => s.env).filter(Boolean));
  const inEnv = entries.filter((e) => applies(e.section, env) || members.has(e.section.slice(4)) || (e.section.startsWith('service.') && names.has(e.section.slice(8))));
  const atOf = (e: VaultEntry) => (e.section === 'personal' ? `${personalFile(ws)}: ${e.key}` : `vault/vars.yaml: ${e.section}.${e.key}`);

  for (const e of entries) {
    if (e.section !== 'personal' && !e.secret && SECRET_KEY.test(e.key)) {
      push({ level: 'error', code: 'plain-secret', key: e.key, at: atOf(e), message: `${e.key}: vault/vars.yaml holds it in plain text under ${e.section}, and it is versioned → ${fix(e.key)}` });
    }
  }

  for (const s of services) {
    const eff = effective(entries, env, s.name, s.env);
    const inCompose = s.compose ?? s.name;
    // compose `${X}` with no default and no value: compose would blank it. `${X:+alt}` and `${X+alt}` need nothing.
    for (const body of s.interpolations) {
      const key = varName(body);
      const e = eff.get(key);
      const blankable = s.environment[key] === `\${${key}}`;
      // An empty value is a value, except as `X: ${X}`: there it blanks whatever default the code has.
      if (/^[A-Za-z_]\w*:?[-+]/.test(body) || (e && (!blankable || e.ref !== undefined || e.value !== ''))) continue;
      const line = composeLine(compose, inCompose, key);
      if (line === 'default') continue;
      const at = line ? `${compose!.file}:${line}` : `${compose?.file ?? 'compose'} (${s.name})`;
      if (e) {
        push({ level: 'error', code: 'blank-override', key, service: s.name, at, message: `${key}: ${at} passes it to ${s.name} as \`${key}: \${${key}}\` and ${e.section} sets it empty, which overrides any default in the code → ${fix(key)}` });
        continue;
      }
      const blank = blankable ? ` As \`${key}: \${${key}}\` it would be blank, which overrides any default in the code.` : '';
      push({ level: 'error', code: 'missing-var', key, service: s.name, at, message: `${key}: ${at} interpolates it for ${s.name} and no vault level sets it → ${fix(key)}.${blank}` });
    }
    // A bare `- KEY` asks for the value by name; compose runs with an empty env, so without the vault it is not there.
    for (const [key, v] of Object.entries(s.environment)) {
      if (v !== null || eff.has(key)) continue;
      const line = bareLine(compose, inCompose, key);
      const at = line ? `${compose!.file}:${line}` : `${compose?.file ?? 'compose'} (${s.name})`;
      push({ level: 'error', code: 'missing-var', key, service: s.name, at, message: `${key}: ${at} asks for it by name for ${s.name} and no vault level sets it → ${fix(key)}` });
    }
  }

  if (g) {
    const extractions = new Map<string, ReturnType<typeof loadExtraction>>();
    const extraction = (repo: string) => {
      if (!extractions.has(repo)) extractions.set(repo, loadExtraction(ws, repo));
      return extractions.get(repo) ?? null;
    };

    // Reads with no default, from the map. Placeholders in an active profile's config file are errors.
    for (const s of services) {
      const eff = effective(entries, env, s.name, s.env);
      const literal = (k: string) => { const e = eff.get(k); return e && !e.secret ? e.value : undefined; };
      const value = (k: string) => literal(k) ?? (s.environment[k] ?? '').replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (_m, n: string, d?: string) => literal(n) ?? d ?? '');
      const profiles = new Set(value('SPRING_PROFILES_ACTIVE').split(',').map((p) => p.trim()).filter(Boolean));
      if (g.nodes.get(`svc:${s.name}`)?.kind === 'quarkus') profiles.add(value('QUARKUS_PROFILE') || 'prod');
      for (const f of g.outOf(`svc:${s.name}`)) {
        if (f.p !== 'reads-var' || f.note || !f.anchor || TEST_PATH.test(f.anchor.path)) continue;
        const key = f.o.slice(4);
        if (eff.has(key) || key in s.environment) continue;
        const where = `${f.anchor.repo}:${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ''}`;
        if (!CONFIG_FILE.test(f.anchor.path)) {
          push({ level: 'warning', code: 'getenv', key, service: s.name, at: where, message: `${key}: ${s.name} reads it with no default at ${where}, and neither compose nor the vault sets it` });
          continue;
        }
        const found = extraction(f.anchor.repo)?.files[f.anchor.path]?.findings.find((x) => x.kind === 'config' && x.line === f.anchor!.line);
        const profile = found?.kind === 'config' ? found.profile : f.anchor.path.match(/(?:application|bootstrap)-([\w-]+)\.\w+$/)?.[1];
        if (profile && !profiles.has(profile)) continue;
        push({ level: 'error', code: 'missing-var', key, service: s.name, at: where, message: `${key}: ${where} needs it for ${s.name}${profile ? ` (profile ${profile})` : ''} with no default, and neither compose nor the vault sets it → ${fix(key)}` });
      }
    }

    // A key nothing reads: not the map, not compose, not a config key under relaxed binding.
    const read = new Set(RUNTIME_VARS);
    for (const f of g.map.facts) if (f.p === 'reads-var') read.add(f.o.slice(4));
    for (const s of services) { for (const k of Object.keys(s.environment)) read.add(k); for (const b of s.interpolations) read.add(varName(b)); }
    for (const r of ws.repos) {
      for (const file of Object.values(extraction(r.name)?.files ?? {})) {
        for (const x of file.findings) if (x.kind === 'config') { read.add(envName(x.key)); read.add(envName(x.key.replace(/-/g, ''))); }
      }
    }
    // What an image reads is not in the map: its own level is never "unused".
    const images = new Set(services.filter((s) => !s.built).map((s) => `service.${s.name}`));
    for (const e of inEnv) {
      if (!read.has(e.key) && !images.has(e.section)) push({ level: 'warning', code: 'unused-var', key: e.key, at: atOf(e), message: `${e.key}: set at ${e.section}, but nothing in ${env} reads it` });
    }
  }

  // Types by name. Only literals: a secret is never inspected.
  for (const e of inEnv) {
    if (e.secret) continue;
    const at = atOf(e);
    if (NUMERIC.test(e.key) && !/^-?\d+(\.\d+)?$/.test(e.value.trim())) push({ level: 'warning', code: 'type', key: e.key, at, message: `${e.key}: ${e.section} sets a value that is not a number` });
    else if (URLISH.test(e.key) && !URL.canParse(e.value)) push({ level: 'warning', code: 'type', key: e.key, at, message: `${e.key}: ${e.section} sets a value that is not a URL` });
  }

  return out.sort((a, b) => Number(a.level === 'warning') - Number(b.level === 'warning'));
}

// ---------- import ----------

/**
 * Imports an example env file as committed on the repo's reference branch (`git show`, never the working copy), or
 * as a folder project holds it now (through its shadow), into the app level; with several projects, into the
 * project's env level (`--env` when the repo has more than one). Secret-looking keys become secrets; keys already set
 * at that level are kept.
 */
export async function importEnvFile(ws: Workspace, spec: string, opts: { env?: string } = {}): Promise<{ imported: Array<{ key: string; secret: boolean }>; skipped: string[]; warnings: string[]; level: string }> {
  const m = spec.match(/^([a-z0-9][a-z0-9-]*):(.+)$/);
  const repo = m ? ws.repos.find((r) => r.name === m[1]) : undefined;
  if (!m || !repo) throw new WorkspaceError('expected <repo>:<path>, with a repo of this workspace', spec);
  const { cwd: checkout, env: gitEnv } = gitOf(ws, repo.name);
  let text: string;
  if (repo.source === 'folder') {
    const tree = await treeNow(ws, repo.name);
    text = await git(checkout, ['show', `${tree}:${m[2]}`], gitEnv).catch(() => {
      throw new WorkspaceError(/(^|\/)\.env(\.[^/]+)?$/.test(m[2]) && !/\.(example|sample|template)$/.test(m[2]) ? `${m[2].split('/').pop()} no está en lo que Laru lee de ${repo.name} (se excluye por seguridad); usa .env.example o laru vars set` : `not in ${repo.name} (read at ${tree.slice(0, 7)})`, spec);
    });
  } else {
    const rev = (ref: string) => git(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => null);
    const commit = (await rev(`origin/${repo.branch}`)) ?? (await rev(repo.branch));
    if (!commit) throw new WorkspaceError(`branch "${repo.branch}" not found in ${checkout}`, spec);
    text = await git(checkout, ['show', `${commit}:${m[2]}`]).catch(() => { throw new WorkspaceError(`not found at ${repo.branch} (${commit.slice(0, 7)})`, spec); });
  }
  let level: Level = 'app', scope: string | undefined;
  if (ws.repos.length > 1) {
    const own = listEnvs(ws).filter((e) => { try { return loadEnvSpec(ws, e).from?.repo === repo.name; } catch { return false; } });
    if (opts.env && !own.includes(opts.env)) throw new WorkspaceError(`${opts.env} is not an env of ${repo.name}${own.length ? `; its envs are ${own.join(', ')}` : ''}`, '--env');
    scope = opts.env ?? (own.length === 1 ? own[0] : undefined);
    if (!scope) throw new WorkspaceError(own.length ? `${repo.name} has ${own.length} envs (${own.join(', ')}): say which with --env` : `${repo.name} has no env yet: create it with laru env init ${repo.name}-local --from ${repo.name}:<compose file>`, spec);
    level = 'env';
  }
  const section = scope ? `env.${scope}` : 'app';
  const existing = new Set(readEntries(ws).filter((e) => e.section === section).map((e) => e.key));
  const imported: Array<{ key: string; secret: boolean }> = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const line of text.split('\n')) {
    const kv = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    // Quotes first, so a `#` inside them is the value's; a comment is a `#` after whitespace outside them.
    const quoted = rawValue.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$|^'([^']*)'\s*(?:#.*)?$/);
    const value = quoted ? (quoted[1]?.replace(/\\(["\\])/g, '$1') ?? quoted[2]) : rawValue.replace(/(^|\s+)#.*$/, '');
    if (!value) continue;
    if (existing.has(key)) { skipped.push(key); continue; }
    const secret = SECRET_KEY.test(key);
    if (secret && value.length < 6) warnings.push(`${key}: shorter than 6 characters, so traces cannot mask it`);
    else if (secret && /^[A-Za-z]+\d*$/.test(value)) warnings.push(`${key}: the value is a plain word; masking will hide that word wherever it appears in traces`);
    await setVar(ws, { key, value, level, scope, secret });
    imported.push({ key, secret });
  }
  return { imported, skipped, warnings, level: section };
}
