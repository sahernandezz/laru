/**
 * The vault on a real workspace: a vaultflow-shaped repo cloned from a bare remote and mapped by core, so
 * missingVars reads the same facts and extraction it will read on vaultflow. The key lives in a 0600 file
 * under a temp LARU_HOME: these tests never touch the real keychain.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, loadGraph, loadWorkspace, refreshMap } from '@laru/core';
import { makeFixture } from '../../core/test/fixture.ts';
import { ksVar } from '../src/types.ts';
import {
  effectiveVars, exportKey, flowsVars, importEnvFile, importKey, injection, loadVault, missingVars, revealVar, SECRET_KEY, setVar, unsetVar, varTable,
  vaultKey, type VaultService,
} from '../src/vault.ts';

process.env.LARU_VAULT_KEYSTORE = 'file';

const COMPOSE = `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
  api:
    build: ./api
    environment:
      JWT_SECRET: \${JWT_SECRET}
      SPRING_PROFILES_ACTIVE: docker
      CLAMAV_HOST: \${CLAMAV_HOST:-clamav}
    depends_on: [postgres]
  worker:
    build: ./worker
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
`;

const SHOP = {
  'docker-compose.yml': COMPOSE,
  'api/pom.xml': '<project><artifactId>api</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>',
  'api/src/main/resources/application.yml': 'jwt:\n  secret: ${JWT_SECRET:dev-secret}\napp:\n  region: ${REGION:eu}\n  max-upload: 10\nminio:\n  secret-key: minioadmin123\n',
  'api/src/main/resources/application-docker.yml': 'partner:\n  url: ${PARTNER_URL}\n',
  'api/src/main/resources/application-prod.yml': 'other:\n  thing: ${PROD_ONLY}\n',
  'api/src/main/java/shop/Storage.java': 'public class Storage {\n  @Value("${minio.secret-key}") String secretKey;\n  String flags = System.getenv("FEATURE_FLAGS");\n}\n',
  'worker/package.json': JSON.stringify({ name: 'worker', scripts: { start: 'node src/index.js' }, dependencies: { express: '^5.0.0' } }),
  'worker/src/index.js': 'const pw = process.env.DB_PASSWORD;\nconst level = process.env.LOG_LEVEL;\n',
  'example.env': 'JWT_SECRET=example-jwt-secret-value\nAPI_TOKEN=changeme\nLOG_LEVEL=info\n# a comment\nCLAMAV_PORT="3310"\nEMPTY=\nQUOTED_PASSWORD="s3cr3t-value" # prod\nGREETING=\'hello # world\' # x\n',
};

/** As compose.ts hands them over: the compose environment uninterpolated, and every `${…}` body. */
const services: VaultService[] = [
  { name: 'postgres', built: false, environment: { POSTGRES_PASSWORD: '${DB_PASSWORD}' }, interpolations: ['DB_PASSWORD'] },
  { name: 'api', built: true, environment: { JWT_SECRET: '${JWT_SECRET}', SPRING_PROFILES_ACTIVE: 'docker', CLAMAV_HOST: '${CLAMAV_HOST:-clamav}' }, interpolations: ['JWT_SECRET', 'CLAMAV_HOST:-clamav'] },
  { name: 'worker', built: true, environment: { DB_PASSWORD: '${DB_PASSWORD}' }, interpolations: ['DB_PASSWORD'] },
];
const composeLines = { file: 'shop:docker-compose.yml', lines: COMPOSE.split('\n') };
const lineOf = (text: string) => COMPOSE.split('\n').findIndex((l) => l.includes(text)) + 1;

const JWT = 'jwt-0123456789abcdef';
const DB = 'db-pass-9f8e7d6c';
const MINIO = 'minio-secret-5a4b3c';
const PGADMIN = 'pg-admin-1q2w3e4r';

test('the vault of a workspace', async (t) => {
  const fx = makeFixture();
  const work = join(fx.tmp, 'seed', 'shop');
  fx.write(work, SHOP);
  fx.sh(work, 'init', '--quiet', '-b', 'main');
  fx.sh(work, 'add', '-A');
  fx.sh(work, 'commit', '--quiet', '-m', 'first');
  fx.sh(fx.tmp, 'clone', '--quiet', '--bare', work, join(fx.tmp, 'remotes', 'shop.git'));
  await addRepo(initWorkspace(join(fx.tmp, 'ws'), { app: 'shop' }), `file://${join(fx.tmp, 'remotes', 'shop.git')}`);
  const ws = loadWorkspace(join(fx.tmp, 'ws'));
  await refreshMap(ws);
  const g = loadGraph(ws);
  const enc = join(ws.root, 'vault', 'secrets.enc');
  const keyFile = join(fx.home, 'shop', 'vault.key');

  await t.test('a literal under a secret-looking key is refused; secrets never reach the versioned files', async () => {
    await assert.rejects(setVar(ws, { key: 'JWT_SECRET', value: JWT, level: 'app' }), /JWT_SECRET: looks like a secret/);
    await assert.rejects(setVar(ws, { key: 'X', value: 'v', level: 'env' }), /needs the env name/);
    await setVar(ws, { key: 'JWT_SECRET', value: JWT, level: 'app', secret: true });
    await setVar(ws, { key: 'LOG_LEVEL', value: 'debug', level: 'app' });
    const vars = readFileSync(join(ws.root, 'vault', 'vars.yaml'), 'utf8');
    assert.match(vars, /JWT_SECRET: secret:\/\/app\.JWT_SECRET/);
    assert.match(vars, /LOG_LEVEL: debug/);
    assert.ok(!vars.includes(JWT) && !readFileSync(enc, 'utf8').includes(JWT));
  });

  await t.test('the key is 32 random bytes; without a keychain it sits in a 0600 file, flagged', async () => {
    const k = (await vaultKey(ws))!;
    assert.equal(k.key.length, 32);
    assert.equal(k.store, 'file');
    assert.equal(k.warning, true);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  });

  await t.test('AES-256-GCM: round trip, a fresh IV per write, a wrong key and a tampered tag refused', async () => {
    const first = JSON.parse(readFileSync(enc, 'utf8'));
    assert.deepEqual(Object.keys(first), ['v', 'iv', 'tag', 'data']);
    assert.equal(Buffer.from(first.iv, 'base64').length, 12);
    await setVar(ws, { key: 'DB_PASSWORD', value: DB, level: 'app', secret: true });
    const good = readFileSync(enc, 'utf8');
    const second = JSON.parse(good);
    assert.notEqual(second.iv, first.iv);
    const vault = await loadVault(ws);
    assert.equal(vault.find((e) => e.key === 'JWT_SECRET')!.value, JWT);
    assert.equal(vault.find((e) => e.key === 'DB_PASSWORD')!.value, DB);

    const tag = Buffer.from(second.tag, 'base64');
    tag[0] ^= 1;
    writeFileSync(enc, JSON.stringify({ ...second, tag: tag.toString('base64') }));
    await assert.rejects(loadVault(ws), /secrets\.enc: cannot be opened/);
    writeFileSync(enc, good);

    const key = readFileSync(keyFile, 'utf8');
    const other = randomBytes(32).toString('hex');
    writeFileSync(keyFile, other);
    await assert.rejects(loadVault(ws), /cannot be opened/);
    writeFileSync(keyFile, key);
    await assert.rejects(importKey(ws, other), /cannot be opened/, 'a key that does not open secrets.enc is not stored');
    await importKey(ws, await exportKey(ws));
    assert.equal((await loadVault(ws)).find((e) => e.key === 'DB_PASSWORD')!.value, DB);
  });

  await t.test('precedence: compose default < app < env < service < personal', async () => {
    await setVar(ws, { key: 'REGION', value: 'from-app', level: 'app' });
    await setVar(ws, { key: 'REGION', value: 'from-env', level: 'env', scope: 'local' });
    await setVar(ws, { key: 'REGION', value: 'from-svc', level: 'service', scope: 'api' });
    let eff = await effectiveVars(ws, 'local', ['api', 'worker']);
    assert.equal(eff.api.REGION.value, 'from-svc');
    assert.equal(eff.worker.REGION.value, 'from-env');
    assert.equal((await effectiveVars(ws, 'ci', ['worker'])).worker.REGION.value, 'from-app');

    await setVar(ws, { key: 'REGION', value: 'from-me', level: 'personal' });
    const personal = join(fx.home, 'shop', 'overrides.yaml');
    assert.equal(statSync(personal).mode & 0o777, 0o600);
    eff = await effectiveVars(ws, 'local', ['api']);
    assert.deepEqual(eff.api.REGION, { section: 'personal', key: 'REGION', secret: false, value: 'from-me' });
    chmodSync(personal, 0o644);
    await assert.rejects(loadVault(ws), /chmod 600/);
    chmodSync(personal, 0o600);
    assert.equal(await unsetVar(ws, { key: 'REGION', level: 'personal' }), true);
    assert.equal(await revealVar(ws, 'local', 'REGION', 'api'), 'from-svc');

    let inj = await injection(ws, 'local', services, g);
    assert.ok(!(ksVar('api', 'CLAMAV_HOST') in inj.values), 'no vault value: compose keeps its own default');
    await setVar(ws, { key: 'CLAMAV_HOST', value: 'av', level: 'app' });
    inj = await injection(ws, 'local', services, g);
    assert.equal(inj.values[ksVar('api', 'CLAMAV_HOST')], 'av');

    for (const [level, scope] of [['app'], ['env', 'local'], ['service', 'api']] as const) assert.equal(await unsetVar(ws, { key: 'REGION', level, scope }), true);
    assert.equal(await unsetVar(ws, { key: 'CLAMAV_HOST', level: 'app' }), true);
    assert.equal(await unsetVar(ws, { key: 'CLAMAV_HOST', level: 'app' }), false);
  });

  await t.test('least privilege: a secret reaches only who interpolates it, reads it or has it at its level', async () => {
    await setVar(ws, { key: 'MINIO_SECRET_KEY', value: MINIO, level: 'app', secret: true });
    await setVar(ws, { key: 'PG_ADMIN_PASSWORD', value: PGADMIN, level: 'service', scope: 'postgres', secret: true });
    const inj = await injection(ws, 'local', services, g);
    const api = inj.perService.api, worker = inj.perService.worker;
    for (const k of ['JWT_SECRET', 'MINIO_SECRET_KEY', 'LOG_LEVEL']) assert.ok(api.includes(k), `api gets ${k}`);
    assert.ok(!api.includes('DB_PASSWORD') && !(ksVar('api', 'DB_PASSWORD') in inj.values), 'api neither reads nor interpolates DB_PASSWORD');
    assert.ok(worker.includes('DB_PASSWORD') && worker.includes('LOG_LEVEL'));
    assert.ok(!worker.includes('JWT_SECRET') && !(ksVar('worker', 'JWT_SECRET') in inj.values));
    assert.ok(!worker.includes('MINIO_SECRET_KEY'));
    assert.deepEqual(inj.perService.postgres, ['PG_ADMIN_PASSWORD'], 'an image gets its own level only');
    assert.equal(inj.values[ksVar('postgres', 'DB_PASSWORD')], DB, '…plus what its compose interpolates');
    assert.ok(!(ksVar('postgres', 'LOG_LEVEL') in inj.values));
    assert.equal(inj.values[ksVar('api', 'JWT_SECRET')], JWT);
    assert.deepEqual([...inj.secrets].sort(), [DB, JWT, MINIO, PGADMIN].sort());
    assert.equal(await unsetVar(ws, { key: 'MINIO_SECRET_KEY', level: 'app' }), true);
  });

  await t.test('missingVars: what would make up start a service wrong', async () => {
    await unsetVar(ws, { key: 'JWT_SECRET', level: 'app' });
    assert.ok(!(await loadVault(ws)).some((e) => e.key === 'JWT_SECRET'));
    await setVar(ws, { key: 'CLAMAV_PORT', value: 'abc', level: 'env', scope: 'local' });
    await setVar(ws, { key: 'NOBODY_READS', value: 'x', level: 'app' });
    await setVar(ws, { key: 'APP_MAX_UPLOAD', value: '20', level: 'app' });
    const issues = missingVars(ws, 'local', services, g, composeLines);
    const firstWarning = issues.findIndex((i) => i.level === 'warning');
    assert.ok(issues.slice(firstWarning).every((i) => i.level === 'warning'), 'errors first');

    const jwt = issues.find((i) => i.key === 'JWT_SECRET')!;
    assert.equal(jwt.level, 'error');
    assert.equal(jwt.code, 'missing-var');
    assert.equal(jwt.service, 'api');
    assert.equal(jwt.at, `shop:docker-compose.yml:${lineOf('JWT_SECRET: ${JWT_SECRET}')}`);
    assert.match(jwt.message, /interpolates it for api and no vault level sets it → laru vars set JWT_SECRET --secret/);
    assert.match(jwt.message, /overrides any default in the code/, 'blank override, though application.yml has a default');
    assert.ok(!issues.some((i) => i.key === 'DB_PASSWORD'), 'set at app level');

    const partner = issues.find((i) => i.key === 'PARTNER_URL')!;
    assert.equal(partner.level, 'error');
    assert.match(partner.at, /^shop:api\/src\/main\/resources\/application-docker\.yml:2$/);
    assert.match(partner.message, /profile docker/);
    assert.ok(!issues.some((i) => i.key === 'PROD_ONLY'), 'an inactive profile is not required');
    assert.ok(!issues.some((i) => i.key === 'REGION'), 'a placeholder with a default is fine');
    assert.ok(g.outOf('svc:api').some((f) => f.o === 'var:MINIO_SECRET_KEY' && f.note === 'overrides minio.secret-key'));
    assert.ok(!issues.some((i) => i.key === 'MINIO_SECRET_KEY'), 'a relaxed-binding read is never required');

    assert.equal(partner.code, 'missing-var');
    assert.equal(issues.find((i) => i.key === 'FEATURE_FLAGS')?.level, 'warning', 'getenv with no default');
    assert.equal(issues.find((i) => i.key === 'FEATURE_FLAGS')?.code, 'getenv');
    assert.ok(issues.some((i) => i.key === 'CLAMAV_PORT' && i.level === 'warning' && i.code === 'type' && /env\.local sets a value that is not a number/.test(i.message)));
    assert.match(issues.find((i) => i.key === 'NOBODY_READS')!.message, /nothing in local reads it/);
    assert.equal(issues.find((i) => i.key === 'NOBODY_READS')!.code, 'unused-var');
    assert.ok(!issues.some((i) => i.key === 'APP_MAX_UPLOAD'), 'app.max-upload binds it');
    assert.ok(!issues.some((i) => i.key === 'PG_ADMIN_PASSWORD'), 'what an image reads is not in the map');
    assert.ok(!issues.some((i) => i.message.includes('abc')), 'no value in a message');

    const namesOnly = services.map((s) => ({ ...s, interpolations: s.interpolations.map((b) => b.split(':')[0]) }));
    assert.ok(!missingVars(ws, 'local', namesOnly, g, composeLines).some((i) => i.key === 'CLAMAV_HOST'), 'the compose default is found in the file');
    assert.equal(missingVars(ws, 'local', services, null).find((i) => i.key === 'JWT_SECRET')?.level, 'error', 'no map: compose still checked');

    const vars = join(ws.root, 'vault', 'vars.yaml');
    const before = readFileSync(vars, 'utf8');
    writeFileSync(vars, before + 'flows:\n  ADMIN_TOKEN: plain\n');
    assert.equal(missingVars(ws, 'local', services, g).find((i) => i.key === 'ADMIN_TOKEN')?.level, 'error', 'a hand-written literal secret');
    assert.equal(missingVars(ws, 'local', services, g).find((i) => i.key === 'ADMIN_TOKEN')?.code, 'plain-secret');
    writeFileSync(vars, before);

    await setVar(ws, { key: 'MY_OWN_THING', value: 'x', level: 'personal' });
    const mine = missingVars(ws, 'local', services, g).find((i) => i.key === 'MY_OWN_THING')!;
    assert.equal(mine.code, 'unused-var');
    assert.match(mine.at, /shop\/overrides\.yaml: MY_OWN_THING$/, 'a personal value is not in vault/vars.yaml');
    await unsetVar(ws, { key: 'MY_OWN_THING', level: 'personal' });
  });

  await t.test('varTable says who sets and reads each key, never a value', async () => {
    const rows = varTable(ws, 'local', services, g);
    const text = JSON.stringify(rows);
    for (const v of [DB, PGADMIN, 'debug', 'abc']) assert.ok(!text.includes(v));
    const db = rows.find((r) => r.key === 'DB_PASSWORD')!;
    assert.deepEqual(db, { key: 'DB_PASSWORD', levels: ['app'], secret: true, effective: 'app', readers: ['worker'], compose: ['postgres', 'worker'] });
    const jwt = rows.find((r) => r.key === 'JWT_SECRET')!;
    assert.equal(jwt.effective, null);
    assert.deepEqual(jwt.readers, ['api']);
    assert.deepEqual(rows.find((r) => r.key === 'CLAMAV_PORT')!.levels, ['env.local']);
  });

  await t.test('importEnvFile reads the committed file and leaves the checkout untouched', async () => {
    const checkout = ws.checkouts.shop;
    assert.equal(fx.sh(checkout, 'status', '--porcelain'), '');
    const index = statSync(join(checkout, '.git', 'index')).mtimeMs;
    const r = await importEnvFile(ws, 'shop:example.env');
    assert.equal(statSync(join(checkout, '.git', 'index')).mtimeMs, index);
    assert.equal(fx.sh(checkout, 'status', '--porcelain'), '');
    assert.deepEqual(r.imported, [
      { key: 'JWT_SECRET', secret: true }, { key: 'API_TOKEN', secret: true }, { key: 'CLAMAV_PORT', secret: false },
      { key: 'QUOTED_PASSWORD', secret: true }, { key: 'GREETING', secret: false },
    ]);
    assert.equal(await revealVar(ws, 'ci', 'QUOTED_PASSWORD'), 's3cr3t-value', 'quotes first, then the comment');
    assert.equal(await revealVar(ws, 'ci', 'GREETING'), 'hello # world', 'a # inside quotes is the value');
    assert.deepEqual(r.skipped, ['LOG_LEVEL']);
    assert.match(r.warnings.join('\n'), /API_TOKEN: the value is a plain word/);
    assert.ok(!r.warnings.join('\n').includes('changeme'));
    assert.equal(await revealVar(ws, 'ci', 'CLAMAV_PORT'), '3310');
    assert.equal(await revealVar(ws, 'local', 'JWT_SECRET', 'api'), 'example-jwt-secret-value');

    writeFileSync(join(checkout, 'example.env'), SHOP['example.env'] + 'ONLY_IN_WORKTREE=1\n');
    await importEnvFile(ws, 'shop:example.env');
    assert.ok(!(await loadVault(ws)).some((e) => e.key === 'ONLY_IN_WORKTREE'), 'never the working copy');
    fx.sh(checkout, 'checkout', '--', 'example.env');
    await assert.rejects(importEnvFile(ws, 'nope:example.env'), /expected <repo>:<path>/);
  });
});

/** Each case below failed before its fix; a bare workspace (no repos, no map) is enough for all of them. */
test('the vault under a skeptical review', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'laru-vault-'));
  process.env.LARU_HOME = join(tmp, 'home');
  const ws = loadWorkspace(initWorkspace(join(tmp, 'ws'), { app: 'shop' }).root);
  const dir = join(ws.root, 'vault');
  const vars = join(dir, 'vars.yaml');
  const personal = join(tmp, 'home', 'shop', 'overrides.yaml');
  const writePersonal = (text: string) => { mkdirSync(join(tmp, 'home', 'shop'), { recursive: true }); writeFileSync(personal, text, { mode: 0o600 }); };

  await t.test('SECRET_KEY: compound names are secrets, words that only start like one are not', async () => {
    for (const k of ['JWT_SECRET', 'DB_PASSWORD', 'API_TOKEN', 'PRIVATE_KEY', 'APIKEY', 'STRIPE_APIKEY', 'MINIO_ACCESSKEY', 'SECRETKEY', 'DB_PASS', 'POSTGRES_PWD', 'AUTH_CREDENTIALS', 'minio.secret-key']) {
      assert.ok(SECRET_KEY.test(k), k);
    }
    for (const k of ['KEYCLOAK_URL', 'KEYBOARD_LAYOUT', 'PASSENGER_COUNT', 'TOKENIZER_MODEL', 'LOG_LEVEL', 'MINIO_ROOT_USER', 'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP', 'JWT_EXPIRATION_MS']) {
      assert.ok(!SECRET_KEY.test(k), k);
    }
    await assert.rejects(setVar(ws, { key: 'DB_PASS', value: 'hunter2hunter2', level: 'app' }), /DB_PASS: looks like a secret/);
    mkdirSync(dir, { recursive: true });
    writeFileSync(vars, 'app:\n  STRIPE_APIKEY: plain\n');
    assert.equal(missingVars(ws, 'local', [], null).find((i) => i.key === 'STRIPE_APIKEY')?.code, 'plain-secret');
    writeFileSync(vars, '');
  });

  await t.test('the masker gets a literal over a secret and the compose default of a secret-looking key', async () => {
    await setVar(ws, { key: 'DATABASE_URL', value: 'postgres://u:teamsecret@db/x', level: 'app', secret: true });
    await setVar(ws, { key: 'DATABASE_URL', value: 'postgres://u:mylocalpw@db/x', level: 'personal' });
    const inj = await injection(ws, 'local', [
      { name: 'api', built: true, environment: { DATABASE_URL: '${DATABASE_URL}' }, interpolations: ['DATABASE_URL'] },
      { name: 'postgres', built: false, environment: { POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:-vaultflow_secret}', POSTGRES_USER: '${POSTGRES_USER:-vaultflow}' }, interpolations: ['POSTGRES_PASSWORD:-vaultflow_secret', 'POSTGRES_USER:-vaultflow'] },
    ], null);
    assert.equal(inj.values[ksVar('api', 'DATABASE_URL')], 'postgres://u:mylocalpw@db/x');
    assert.ok(inj.secrets.includes('postgres://u:mylocalpw@db/x'), 'a literal over a secret is still a secret');
    assert.ok(inj.secrets.includes('vaultflow_secret'), 'a compose default of a secret-looking key');
    assert.ok(!inj.secrets.includes('vaultflow'));
    await unsetVar(ws, { key: 'DATABASE_URL', level: 'personal' });
    await unsetVar(ws, { key: 'DATABASE_URL', level: 'app' });
  });

  await t.test('one rule for scopes: what setVar writes, the vault reads back', async () => {
    for (const scope of ['Local', 'my_env', 'a.b']) await assert.rejects(setVar(ws, { key: 'FOO', value: 'x', level: 'env', scope }), /needs the env name/, scope);
    await assert.rejects(setVar(ws, { key: 'FOO', value: 'x', level: 'service', scope: 'a/b' }), /needs the service name/);
    await setVar(ws, { key: 'FOO', value: 'x', level: 'service', scope: 'api_v2.internal' });
    assert.equal(await revealVar(ws, 'local', 'FOO', 'api_v2.internal'), 'x');
    assert.equal(await unsetVar(ws, { key: 'FOO', level: 'service', scope: 'api_v2.internal' }), true);
  });

  await t.test('a YAML error names the file and line:column, never the source line', async () => {
    const quiet = (file: RegExp) => (e: Error) => file.test(e.message) && !e.message.includes('s3cr3t');
    writePersonal('MY_TOKEN: {secret: s3cr3t-personal-value\nOTHER: x\n');
    await assert.rejects(loadVault(ws), quiet(/overrides\.yaml:\d+:\d+: not valid YAML$/));
    writePersonal('');
    writeFileSync(vars, 'app:\n  A: "unterminated s3cr3t\n');
    await assert.rejects(loadVault(ws), quiet(/^vault\/vars\.yaml:\d+:\d+: not valid YAML$/));
    await assert.rejects(setVar(ws, { key: 'B', value: 'x', level: 'app' }), quiet(/^vault\/vars\.yaml:\d+:\d+: not valid YAML$/));
    writeFileSync(vars, '');
  });

  await t.test('overrides.yaml is validated like vars.yaml', async () => {
    for (const text of ['bad-key: x\n', 'K: {value: x}\n', 'K: [1, 2]\n', 'K: {secret: {a: 1}}\n']) {
      writePersonal(text);
      await assert.rejects(loadVault(ws), /overrides\.yaml: (bad-key|K): a variable name with a literal or \{secret: <value>\}/, text);
    }
    writePersonal('K: {secret: mine-123456}\n');
    assert.deepEqual((await loadVault(ws)).find((e) => e.key === 'K'), { section: 'personal', key: 'K', secret: true, value: 'mine-123456' });
    writePersonal('');
  });

  await t.test('a failed vars.yaml write leaves the vault as it was', async () => {
    await setVar(ws, { key: 'A_SECRET', value: 'aaaaaaaa', level: 'app', secret: true });
    await setVar(ws, { key: 'B_SECRET', value: 'bbbbbbbb', level: 'app', secret: true });
    chmodSync(vars, 0o444);
    chmodSync(dir, 0o555);
    try { await assert.rejects(unsetVar(ws, { key: 'A_SECRET', level: 'app' })); }
    finally { chmodSync(dir, 0o755); chmodSync(vars, 0o644); }
    assert.deepEqual((await loadVault(ws)).map((e) => e.value).sort(), ['aaaaaaaa', 'bbbbbbbb']);
    assert.deepEqual(readdirSync(dir).sort(), ['secrets.enc', 'vars.yaml'], 'no temp file left behind');
  });

  await t.test('concurrent writes keep every secret', async () => {
    await Promise.all([
      setVar(ws, { key: 'C_SECRET', value: 'cccccccc', level: 'app', secret: true }),
      setVar(ws, { key: 'D_SECRET', value: 'dddddddd', level: 'app', secret: true }),
    ]);
    assert.deepEqual((await loadVault(ws)).map((e) => e.key).sort(), ['A_SECRET', 'B_SECRET', 'C_SECRET', 'D_SECRET']);
  });

  await t.test('a bare `- KEY` gets the vault value, and is missing when no level sets it', async () => {
    await setVar(ws, { key: 'POSTGRES_PASSWORD', value: 'pgpw-123456', level: 'app', secret: true });
    const pg: VaultService[] = [{ name: 'pg', built: false, environment: { POSTGRES_PASSWORD: null, PGDATA: null }, interpolations: [] }];
    const inj = await injection(ws, 'local', pg, null);
    assert.deepEqual(inj.perService.pg, ['POSTGRES_PASSWORD'], 'the compose asks for it by name, image or not');
    assert.equal(inj.values[ksVar('pg', 'POSTGRES_PASSWORD')], 'pgpw-123456');
    const lines = ['services:', '  pg:', '    image: postgres:16', '    environment:', '      - POSTGRES_PASSWORD', '      - PGDATA'];
    const issues = missingVars(ws, 'local', pg, null, { file: 'shop:compose.yml', lines });
    assert.deepEqual(issues.map((i) => [i.code, i.level, i.key, i.service, i.at]), [['missing-var', 'error', 'PGDATA', 'pg', 'shop:compose.yml:6']]);
    await unsetVar(ws, { key: 'POSTGRES_PASSWORD', level: 'app' });
  });

  await t.test('an empty value is a blank override; ${X:+alt} and ${X+alt} need nothing', async () => {
    await setVar(ws, { key: 'JWT_SIGNING', value: '', level: 'app' });
    const svcs: VaultService[] = [{
      name: 'api', built: true,
      environment: { JWT_SIGNING: '${JWT_SIGNING}', OPT: '${OPTIONAL_FLAG:+on}', OTHER: '${OTHER_FLAG+on}' },
      interpolations: ['JWT_SIGNING', 'OPTIONAL_FLAG:+on', 'OTHER_FLAG+on'],
    }];
    const issues = missingVars(ws, 'local', svcs, null);
    assert.deepEqual(issues.map((i) => [i.code, i.level, i.key]), [['blank-override', 'error', 'JWT_SIGNING']]);
    await unsetVar(ws, { key: 'JWT_SIGNING', level: 'app' });
  });

  await t.test('varTable: the compose level at the bottom, only this env\'s services, a service-only key wins where it is read', async () => {
    await setVar(ws, { key: 'ONLY_SVC', value: 'w', level: 'service', scope: 'worker' });
    await setVar(ws, { key: 'ONLY_SVC', value: 'a', level: 'service', scope: 'api' });
    await setVar(ws, { key: 'ONLY_SVC', value: 'g', level: 'service', scope: 'gone' });
    await setVar(ws, { key: 'AV_HOST', value: 'av', level: 'app' });
    const rows = varTable(ws, 'local', [
      { name: 'api', built: true, environment: { MODE: 'docker', AV_HOST: '${AV_HOST:-clamav}', ONLY_SVC: '${ONLY_SVC}' }, interpolations: ['AV_HOST:-clamav', 'ONLY_SVC'] },
      { name: 'worker', built: true, environment: { ONLY_SVC: '${ONLY_SVC}' }, interpolations: ['ONLY_SVC'] },
    ], null);
    const row = (k: string) => rows.find((r) => r.key === k)!;
    assert.deepEqual([row('MODE').levels, row('MODE').effective], [['compose'], 'compose']);
    assert.deepEqual([row('AV_HOST').levels, row('AV_HOST').effective], [['compose', 'app'], 'app']);
    assert.deepEqual([[...row('ONLY_SVC').levels].sort(), row('ONLY_SVC').effective], [['service.api', 'service.worker'], 'service.api']);
    for (const scope of ['worker', 'api', 'gone']) await unsetVar(ws, { key: 'ONLY_SVC', level: 'service', scope });
    await unsetVar(ws, { key: 'AV_HOST', level: 'app' });
  });

  await t.test('the flows level, decrypted, for the runner', async () => {
    await setVar(ws, { key: 'ADMIN_PASSWORD', value: 'flows-pw-123', level: 'flows', secret: true });
    await setVar(ws, { key: 'BASE_URL', value: 'http://frontend', level: 'flows' });
    assert.deepEqual(await flowsVars(ws), { ADMIN_PASSWORD: 'flows-pw-123', BASE_URL: 'http://frontend' });
    assert.equal(await revealVar(ws, 'local', 'ADMIN_PASSWORD', 'flows'), 'flows-pw-123');
    assert.equal(await revealVar(ws, 'local', 'ADMIN_PASSWORD'), null, 'never a container\'s');
  });

  await t.test('a key store that does not answer fails with the way out', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
    const { PATH, LARU_VAULT_KEYSTORE } = process.env;
    process.env.PATH = `${bin}:${PATH}`;
    process.env.LARU_VAULT_KEYSTORE = 'secret-tool';
    try { await assert.rejects(vaultKey(ws), /LARU_VAULT_KEYSTORE=file/); }
    finally { process.env.PATH = PATH; process.env.LARU_VAULT_KEYSTORE = LARU_VAULT_KEYSTORE; }
  });
});

test('a joint env\'s levels: each member env under its own services, the joint env on top; an import lands on the project\'s env', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'dos', title: 'Dos' });
  await addRepo(ws, fx.billingUrl);
  const folder = join(fx.tmp, 'code', 'audit');
  fx.write(folder, { 'docker-compose.yml': 'services:\n  audit-api:\n    build: ./api\n', '.env.example': 'AUDIT_URL=http://audit-api:3000\n' });
  await addRepo(ws, folder, { name: 'audit' });
  mkdirSync(join(ws.root, 'envs'), { recursive: true });
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: billing:docker-compose.yml\n');
  writeFileSync(join(ws.root, 'envs', 'audit-local.yaml'), 'from: audit:docker-compose.yml\n');
  writeFileSync(join(ws.root, 'envs', 'all.yaml'), 'join: [local, audit-local]\n');
  await setVar(ws, { key: 'MODE', value: 'billing-own', level: 'env', scope: 'local' });
  await setVar(ws, { key: 'MODE', value: 'audit-own', level: 'env', scope: 'audit-local' });
  await setVar(ws, { key: 'REGION', value: 'app-wide', level: 'app' });
  await setVar(ws, { key: 'REGION', value: 'joint', level: 'env', scope: 'all' });
  await setVar(ws, { key: 'ONLY', value: 'local-only', level: 'env', scope: 'local' });
  const svc = (name: string, env: string): VaultService => ({ name, built: true, environment: {}, interpolations: [], env });
  const inj = await injection(ws, 'all', [svc('billing-api', 'local'), svc('audit-api', 'audit-local')], null);
  assert.equal(inj.values[ksVar('billing-api', 'MODE')], 'billing-own');
  assert.equal(inj.values[ksVar('audit-api', 'MODE')], 'audit-own');
  assert.equal(inj.values[ksVar('billing-api', 'REGION')], 'joint', 'env.all over app');
  assert.equal(inj.values[ksVar('audit-api', 'REGION')], 'joint');
  assert.equal(inj.values[ksVar('audit-api', 'ONLY')], undefined, 'a member\'s level reaches only its own services');
  await setVar(ws, { key: 'MODE', value: 'joint-wins', level: 'env', scope: 'all' });
  assert.equal((await injection(ws, 'all', [svc('billing-api', 'local')], null)).values[ksVar('billing-api', 'MODE')], 'joint-wins', 'the joint env sits above its members');
  const r = await importEnvFile(ws, 'audit:.env.example');
  assert.equal(r.level, 'env.audit-local', 'with several projects, a project\'s import goes to its env');
  assert.ok((await loadVault(ws)).some((e) => e.section === 'env.audit-local' && e.key === 'AUDIT_URL'));
  await assert.rejects(importEnvFile(ws, 'audit:.env.example', { env: 'local' }), /local is not an env of audit; its envs are audit-local/);
});
