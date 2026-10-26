/**
 * Several projects in one workspace: a git repo first, then a plain folder that talks to it. Names an earlier project
 * holds stay bare; hosts resolve as the projects reach each other side by side; the folder is read, never written.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  addRepo, changesFromWorktrees, evaluateConventions, freshness, initWorkspace, knowledgeWrite, linkRepo, loadGraph, loadKnowledge, loadWorkspace, preEdit, refreshMap, repoStatus, verify, WorkspaceError, writeAgentFiles,
} from '../src/index.ts';
import { locate } from '../src/hooks.ts';
import { BILLING, makeFixture, snapshotOf } from './fixture.ts';

const SHOP = {
  'docker-compose.yml': 'services:\n  postgres:\n    image: postgres:16\n  frontend:\n    build: ./frontend\n    ports: ["4200:80"]\n  api:\n    build: ./api\n    ports: ["18080:8080"]\n    depends_on: [postgres]\n',
  'frontend/Dockerfile': 'FROM nginx:alpine\n',
  'api/pom.xml': '<project><artifactId>shop-api</artifactId><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
  'api/src/main/resources/application.properties': 'quarkus.http.port=8080\nquarkus.datasource.jdbc.url=jdbc:postgresql://postgres:5432/shop\n',
  'api/src/main/java/shop/OrderResource.java': '@Path("/orders")\npublic class OrderResource {\n  @GET @Path("/{id}") public Order get(@PathParam("id") String id) { return null; }\n}\n',
};

const AUDIT = {
  'docker-compose.yml': 'services:\n  postgres:\n    image: postgres:16\n  frontend:\n    build: ./web\n    ports: ["4300:80"]\n  audit-api:\n    build: ./api\n    depends_on: [postgres]\n',
  'web/Dockerfile': 'FROM nginx:alpine\n',
  'api/pom.xml': '<project><artifactId>audit-api</artifactId><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
  'api/src/main/resources/application.properties': [
    'quarkus.http.port=8090',
    'quarkus.datasource.jdbc.url=jdbc:postgresql://postgres:5432/audit',
    'shop.orders.url=http://api:8080/orders',
    'shop.health.url=http://host.docker.internal:18080/health',
  ].join('\n') + '\n',
  'api/src/main/java/audit/AuditResource.java': '@Path("/audit")\npublic class AuditResource {\n  @GET public List<Entry> list() { return null; }\n}\n',
  '.env': 'AUDIT_TOKEN=s3cr3t-value\n',
  '.env.example': 'AUDIT_TOKEN=\n',
  'node_modules/left-pad/index.js': 'module.exports = 1;\n',
};


test('a git project and a folder project: names, hosts across projects, anchors and impact on the folder', async (t) => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda', title: 'Tienda' });
  // the shop as a git remote, the audit as a plain folder (no git)
  const shopWork = join(fx.tmp, 'seed', 'shop');
  fx.write(shopWork, SHOP);
  for (const a of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'first'], ['remote', 'add', 'origin', 'https://example.test/shop.git']]) fx.sh(shopWork, ...a);
  const audit = join(fx.tmp, 'code', 'vaultflow-audit');
  fx.write(audit, AUDIT);
  const before = snapshotOf(audit);

  await t.test('a folder without git is added as a folder project; laru.yaml has no url or branch for it', async () => {
    await addRepo(ws, shopWork);
    const r = await addRepo(ws, audit, { name: 'audit', title: 'Auditoría', ignore: ['data/'] });
    assert.deepEqual({ source: r.source, url: r.url, branch: r.branch }, { source: 'folder', url: '', branch: '' });
    const w = loadWorkspace(ws.root);
    assert.deepEqual(w.repos.map((x) => `${x.name}:${x.source}`), ['shop:git', 'audit:folder']);
    assert.deepEqual(w.repos[1].ignore, ['data/']);
    assert.equal(w.repos[1].title, 'Auditoría');
  });

  await t.test('overlapping folders are refused, naming both paths', async () => {
    mkdirSync(join(audit, 'tools'), { recursive: true });
    await assert.rejects(addRepo(ws, join(audit, 'tools'), { name: 'tools' }), (e: WorkspaceError) => e.message.includes(join(audit, 'tools')) && e.message.includes('audit'));
    await assert.rejects(addRepo(ws, join(fx.tmp, 'code')), /overlaps audit/);
    await assert.rejects(addRepo(ws, ws.root), /overlap/);
    await assert.rejects(linkRepo(ws, 'audit', fx.tmp), /overlap/);
    rmSync(join(audit, 'tools'), { recursive: true });
  });

  let g: ReturnType<typeof loadGraph>;
  await t.test('the earlier project keeps bare names; the later one gets its repo as prefix, and the map says so', async () => {
    const { map } = await refreshMap(ws);
    g = loadGraph(ws);
    const ids = new Set(map.nodes.map((n) => n.id));
    for (const id of ['svc:frontend', 'svc:api', 'ds:postgres', 'svc:audit-frontend', 'svc:audit-api', 'ds:audit-postgres']) assert.ok(ids.has(id), `missing ${id}`);
    assert.deepEqual(map.names?.shop, { postgres: 'postgres', frontend: 'frontend', api: 'api' });
    assert.deepEqual(map.names?.audit, { postgres: 'audit-postgres', frontend: 'audit-frontend', 'audit-api': 'audit-api' });
    assert.equal(map.nodes.find((n) => n.id === 'ds:audit-postgres')?.repo, 'audit');
    assert.equal(map.repos.find((r) => r.name === 'audit')?.ref, 'carpeta');
    assert.equal(map.nodes.find((n) => n.id === 'repo:audit')?.attrs?.source, 'folder');
    assert.deepEqual(snapshotOf(audit), before, 'reading it changed nothing in the folder');
    assert.ok(!existsSync(join(audit, '.git')));
  });

  await t.test('a host resolves in its own project first, then across, then by published host port', () => {
    const fact = (s: string, o: string) => g.map.facts.find((f) => f.s === s && f.o === o);
    assert.ok(fact('svc:audit-api', 'ds:audit-postgres'), 'postgres in audit is audit\'s own');
    assert.ok(!fact('svc:audit-api', 'ds:postgres'));
    assert.ok(fact('svc:api', 'ds:postgres'), 'and the shop keeps its own');
    const byName = g.map.facts.find((f) => f.s === 'svc:audit-api' && f.o === 'svc:api' && /shop\.orders\.url/.test(f.note ?? ''));
    assert.ok(byName, 'api is only the shop\'s: audit reaches it by name');
    assert.match(byName!.note!, /across projects/);
    assert.equal(byName!.origin, 'extracted');
    const byPort = g.map.facts.find((f) => f.s === 'svc:audit-api' && f.o === 'svc:api' && /shop\.health\.url/.test(f.note ?? ''));
    assert.ok(byPort, 'host.docker.internal:18080 is what the shop\'s api publishes');
    assert.match(byPort!.note!, /across projects/);
    assert.ok(!g.map.facts.some((f) => f.s === 'svc:audit-api' && f.o === 'ds:audit-postgres' && /across/.test(f.note ?? '')));
  });

  await t.test('what Laru reads of the folder leaves out .env, node_modules and the ignored paths', () => {
    const ex = JSON.parse(readFileSync(join(ws.root, '.laru', 'extract', 'audit.json'), 'utf8'));
    const files = Object.keys(ex.tree);
    assert.ok(files.includes('.env.example') && files.includes('docker-compose.yml'));
    assert.ok(!files.includes('.env') && !files.some((f) => f.startsWith('node_modules/')));
  });

  await t.test('a piece anchored in the folder goes stale after an edit and a map; impact sees M, A and D', async () => {
    const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g); assert.ok(r.ok, JSON.stringify(r.issues)); };
    w({ type: 'application', title: 'Tienda', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Auditoría'] } });
    w({ type: 'module', id: 'mod:auditoria', in: 'app:tienda', title: 'Auditoría', summary: 'Registro.', kind: 'area', anchors: ['audit:api/src/main/java/audit/**'], fields: { purpose: 'Auditar.' } });
    w({ type: 'convention', in: 'mod:auditoria', title: 'Sin System.out', summary: 'Logger.', fields: { rule: 'Nada de System.out.', rationale: 'Se pierde.', good: '`log.info(...)`', check: ['forbid: System\\.out\\.print'] } });
    assert.equal(freshness(ws, loadKnowledge(ws).byId.get('mod:auditoria')!), 'fresh');
    const file = join(audit, 'api/src/main/java/audit/AuditResource.java');
    writeFileSync(file, '@Path("/audit")\npublic class AuditResource {\n  @GET public List<Entry> list() { System.out.println("x"); return null; }\n}\n');
    writeFileSync(join(audit, 'api/src/main/java/audit/Entry.java'), 'public class Entry {}\n');
    rmSync(join(audit, 'web/Dockerfile'));
    const changes = await changesFromWorktrees(ws, ['audit']);
    assert.deepEqual(changes.map((c) => `${c.status} ${c.path}`).sort(), ['A api/src/main/java/audit/Entry.java', 'D web/Dockerfile', 'M api/src/main/java/audit/AuditResource.java']);
    assert.match(changes.find((c) => c.status === 'M')!.content!, /System\.out/, 'content is read from the folder');
    const st = await repoStatus(ws, ws.repos[1]);
    assert.equal(st.changed, 3);
    assert.equal(st.sinceVerified, null, 'never verified');
    await refreshMap(ws);
    assert.equal(freshness(ws, loadKnowledge(ws).byId.get('mod:auditoria')!), 'stale');
    const conv = [...(await evaluateConventions(ws, loadKnowledge(ws))).values()].flatMap((r) => r.violations);
    assert.deepEqual(conv.map((v) => `${v.file}:${v.line}`), ['audit:api/src/main/java/audit/AuditResource.java:3']);
    await verify(ws, loadGraph(ws).map);
    assert.equal((await repoStatus(ws, ws.repos[1])).sinceVerified, 0);
    writeFileSync(join(audit, 'api/src/main/java/audit/Entry.java'), 'public class Entry { int n; }\n');
    assert.equal((await repoStatus(ws, ws.repos[1])).sinceVerified, 1);
  });

  await t.test('hooks find the longest checkout holding a file', () => {
    const k = loadKnowledge(ws);
    assert.ok(k.byId.get('mod:auditoria'));
    const out = preEdit(ws, { session_id: 'p', tool_name: 'Edit', tool_input: { file_path: join(ws.checkouts.audit, 'api/src/main/java/audit/AuditResource.java') } }) as { hookSpecificOutput: { additionalContext: string } } | null;
    assert.match(out!.hookSpecificOutput.additionalContext, /Sin System\.out/);
    // checkouts never nest (add refuses it), but an older checkouts.yaml might: the longest wins
    const nested = { ...ws, checkouts: { outer: '/x', inner: '/x/y' } };
    assert.deepEqual(locate(nested, '/x/y/z.ts'), { repo: 'inner', path: 'z.ts' });
    assert.deepEqual(locate(nested, '/x/z.ts'), { repo: 'outer', path: 'z.ts' });
  });

  await t.test('the folder was never written: no .git, and only the files the test edited changed', () => {
    assert.ok(!existsSync(join(audit, '.git')));
    const edited = /^(api\/src\/main\/java\/audit|web)(\/|@)/;
    assert.deepEqual(snapshotOf(audit).filter((l) => !edited.test(l)), before.filter((l) => !edited.test(l)));
  });
});

test('a folder that is itself a git repo without a remote: its own .git is never read or written', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'solo', title: 'Solo' });
  const dir = join(fx.tmp, 'code', 'tool');
  fx.write(dir, { 'a.txt': 'a\n', 'b/c.txt': 'c\n' });
  fx.sh(dir, 'init', '--quiet', '-b', 'main');
  const marker = Date.now() / 1000 - 3600;
  utimesSync(join(dir, '.git', 'HEAD'), marker, marker);
  const r = await addRepo(ws, dir);
  assert.equal(r.source, 'folder', 'a work tree without origin is a folder project');
  assert.equal(r.name, 'tool');
  await refreshMap(ws);
  assert.ok(!existsSync(join(dir, '.git', 'index')), 'its index was never created');
  assert.equal(Math.round(statSync(join(dir, '.git', 'HEAD')).mtimeMs / 1000), Math.round(marker));
  const ex = loadGraph(ws).map.repos[0];
  assert.equal(ex.ref, 'carpeta');
});

test('two workspaces with one app id share checkouts.yaml: each sees only the projects its laru.yaml names', async () => {
  const fx = makeFixture();
  const a = initWorkspace(join(fx.tmp, 'a'), { app: 'shop', title: 'A' });
  const b = initWorkspace(join(fx.tmp, 'b'), { app: 'shop', title: 'B' });
  const tool = join(fx.tmp, 'code', 'tool'), audit = join(fx.tmp, 'code', 'audit');
  fx.write(tool, { 'a.txt': 'a\n' });
  fx.write(audit, { 'a.txt': 'a\n' });
  await addRepo(a, tool);
  await addRepo(b, audit);
  writeAgentFiles(loadWorkspace(a.root));
  assert.deepEqual(Object.keys(loadWorkspace(a.root).checkouts), ['tool']);
  assert.deepEqual(Object.keys(loadWorkspace(b.root).checkouts), ['audit']);
  const dirs = JSON.parse(readFileSync(join(a.root, '.claude', 'settings.local.json'), 'utf8')).permissions.additionalDirectories;
  assert.ok(!dirs.includes(realpathSync(audit)), 'the other workspace\'s folder is not granted to this one\'s agents');
  await linkRepo(loadWorkspace(a.root), 'tool', tool); // a save from A keeps B's entry
  assert.deepEqual(Object.keys(loadWorkspace(b.root).checkouts), ['audit']);
});

test('a single-project map is the one main built, plus the identity names table', async () => {
  // billing-map.main.json: main (1ceaa3a) mapping this same repo, with fixed commit dates so the hashes match.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-single-')));
  process.env.LARU_HOME = join(tmp, 'home');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const work = join(tmp, 'seed', 'billing');
  for (const [p, c] of Object.entries(BILLING)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'first']]) execFileSync('git', a, { cwd: work, stdio: 'pipe', env });
  execFileSync('git', ['clone', '-q', '--bare', work, join(tmp, 'remotes', 'billing.git')], { stdio: 'pipe', env });
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'acme', title: 'Acme' });
  await addRepo(ws, `file://${join(tmp, 'remotes', 'billing.git')}`, { name: 'billing' });
  await refreshMap(ws);
  const { builtAt: _b, names, ...now } = JSON.parse(readFileSync(join(ws.root, '.laru', 'map.json'), 'utf8').replaceAll(tmp, '<tmp>'));
  assert.deepEqual(now, JSON.parse(readFileSync(new URL('./fixtures/billing-map.main.json', import.meta.url), 'utf8')));
  assert.deepEqual(names, { billing: { 'billing-api': 'billing-api', kafka: 'kafka', postgres: 'postgres' } });
});

test('a base URL read from a variable its compose sets resolves like any host: by name across projects, by published port', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda', title: 'Tienda' });
  const shopWork = join(fx.tmp, 'seed', 'shop');
  fx.write(shopWork, SHOP);
  for (const a of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'first'], ['remote', 'add', 'origin', 'https://example.test/shop.git']]) fx.sh(shopWork, ...a);
  const ledger = join(fx.tmp, 'code', 'ledger');
  fx.write(ledger, {
    'docker-compose.yml': 'services:\n  ledger:\n    build: ./svc\n    environment:\n      ORDERS_URL: http://api:8080\n      HEALTH_URL: http://host.docker.internal:18080/q/health\n      STOCK_URL: ${STOCK_URL}\n',
    'svc/Dockerfile': 'FROM node:24-alpine\nCOPY . /srv\nCMD ["node", "/srv/server.js"]\n',
    'svc/package.json': JSON.stringify({ name: 'ledger', dependencies: { pg: '8.13.1' } }),
    'svc/server.js': [
      "const ORDERS = process.env.ORDERS_URL ?? 'http://localhost:8080';",
      "const HEALTH = process.env.HEALTH_URL ?? 'http://localhost:18080/q/health';",
      "const STOCK = process.env.STOCK_URL;",
      'async function sync(id) { await fetch(`${ORDERS}/orders/${id}`); await fetch(HEALTH); await fetch(`${STOCK}/items/${id}`); }',
    ].join('\n'),
  });
  await addRepo(ws, shopWork);
  await addRepo(ws, ledger, { name: 'ledger' });
  const { map } = await refreshMap(ws);
  const calls = map.facts.filter((f) => f.s === 'svc:ledger' && (f.p === 'calls' || f.p === 'uses')).map((f) => `${f.o} ${f.note}`);
  assert.ok(calls.some((c) => /^ep:api:GET \/orders\/\{id\} .*base URL from ORDERS_URL, across projects$/.test(c)), calls.join('\n'));
  assert.ok(calls.some((c) => /^svc:api .*base URL from HEALTH_URL, across projects$/.test(c)), 'host.docker.internal:18080 is what the shop publishes for api');
  assert.ok(calls.some((c) => /^ext:stock .*base URL from STOCK_URL$/.test(c)), 'a value its compose interpolates is no address: the name decides, as before');
});
