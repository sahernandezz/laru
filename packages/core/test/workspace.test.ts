import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addRepo, context, estimateTokens, initWorkspace, loadGraph, loadWorkspace, path, refreshMap, repoStatus, syncRepos, verify, WorkspaceError,
} from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('a workspace around two repos: one added by URL, one by an existing clone', async (t) => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });

  await t.test('repos are referenced by URL and branch; checkouts live outside the workspace', async () => {
    await addRepo(ws, fx.billingUrl);
    const mine = join(fx.tmp, 'code', 'portal');
    fx.sh(fx.tmp, 'clone', '--quiet', fx.portalUrl, mine);
    await addRepo(ws, mine, { role: 'frontend' });

    const reloaded = loadWorkspace(ws.root);
    assert.deepEqual(reloaded.repos.map((r) => `${r.name} ${r.branch} ${r.role}`), ['billing main service', 'portal main frontend']);
    assert.equal(reloaded.repos[0].url, fx.billingUrl);
    assert.equal(reloaded.checkouts.billing, join(fx.home, 'comercio', 'repos', 'billing'), 'a URL is cloned under ~/.laru/<app>');
    assert.equal(reloaded.checkouts.portal, realpathSync(mine), 'a folder is linked where it is');
    assert.ok(!readFileSync(join(ws.root, 'laru.yaml'), 'utf8').includes(fx.home), 'machine paths never reach laru.yaml');
    const settings = JSON.parse(readFileSync(join(ws.root, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(Array.isArray(settings.permissions.additionalDirectories));
    assert.ok(JSON.parse(readFileSync(join(ws.root, '.mcp.json'), 'utf8')).mcpServers.laru);
  });

  await t.test('the map ties services through config, env vars and compose', async () => {
    const { map, stats } = await refreshMap(ws);
    const ids = new Set(map.nodes.map((n) => n.id));
    for (const id of ['svc:billing-api', 'svc:portal', 'ep:billing-api:POST /refunds', 'ep:billing-api:GET /orders/{id}/payment', 'ep:portal:POST /api/refunds', 'tbl:billing.refunds', 'topic:refund.requested', 'ds:postgres', 'ds:kafka', 'ext:api.stripe.com', 'var:STRIPE_WEBHOOK_SECRET', 'var:BILLING_API_URL'])
      assert.ok(ids.has(id), `missing ${id}`);
    const has = (s: string, p: string, o: string) => map.facts.some((f) => f.s === s && f.p === p && f.o === o);
    assert.ok(has('svc:portal', 'calls', 'ep:billing-api:POST /refunds'), 'portal → billing through BILLING_API_URL');
    assert.ok(has('svc:billing-api', 'uses', 'ext:api.stripe.com'), 'the rest client default URL');
    assert.ok(has('svc:billing-api', 'uses', 'ds:postgres'), 'localhost:5432 is the compose postgres');
    assert.ok(has('ds:postgres', 'contains', 'tbl:billing.refunds'));
    assert.ok(has('ds:kafka', 'contains', 'topic:refund.requested'));
    assert.ok(has('svc:portal', 'depends-on', 'dep:npm:shared-model'));
    const anchor = map.facts.find((f) => f.p === 'exposes' && f.o === 'ep:billing-api:POST /refunds')!.anchor!;
    assert.equal(anchor.path, 'api/src/main/java/acme/RefundResource.java');
    assert.equal(anchor.commit.length, 40, 'anchors carry the full commit');
    assert.equal(map.nodes.find((n) => n.id === 'svc:billing-api')!.attrs!.tests && (map.nodes.find((n) => n.id === 'svc:billing-api')!.attrs!.tests as any).integration, 2);
    assert.ok(stats.every((s) => s.read === s.files));
  });

  await t.test('a second read reuses every unchanged file', async () => {
    const { stats } = await refreshMap(ws);
    assert.deepEqual(stats.map((s) => s.read), [0, 0]);
  });

  await t.test('context fits its budget, answers fast and names its anchors', async () => {
    const g = loadGraph(ws);
    const t0 = performance.now();
    const out = context(g, ws, 'svc:billing-api', 2000);
    assert.ok(performance.now() - t0 < 300);
    assert.ok(estimateTokens(out) <= 2000);
    assert.match(out, /svc:portal → POST \/refunds/);
    assert.match(out, /RefundResource\.java:\d+ RefundResource\.create/);
    const tiny = context(g, ws, 'svc:billing-api', 300);
    assert.ok(estimateTokens(tiny) <= 300 && /Left out for the budget|more/.test(tiny), tiny);
    assert.match(context(g, ws, 'billing:api/src/main/java/acme/RefundResource.java'), /Part of svc:billing-api/);
    assert.match(context(g, ws, 'nope-nothing'), /Nothing in the map/);
    assert.match(path(g, ws, 'svc:portal', 'tbl:billing.refunds'), /maps table tbl:billing\.refunds/);
  });

  await t.test('status knows what moved since the verified commit, and the repos stay untouched', async () => {
    verify(ws, loadGraph(ws).map);
    const seed = join(fx.tmp, 'seed', 'billing');
    fx.write(seed, { 'api/src/main/java/acme/HealthResource.java': '@Path("/health") public class HealthResource { @GET public String ok() { return "ok"; } }' });
    fx.sh(seed, 'add', '-A'); fx.sh(seed, 'commit', '--quiet', '-m', 'health');
    fx.sh(seed, 'push', '--quiet', fx.billingUrl.replace('file://', ''), 'main');
    const st = await syncRepos(ws);
    const billing = st.find((s) => s.name === 'billing')!;
    assert.equal(billing.sinceVerified, 1);
    assert.equal(billing.behind, 1, 'the working copy is behind the remote: sync fetched, it did not pull');
    const { map, stats } = await refreshMap(ws);
    assert.equal(stats.find((s) => s.repo === 'billing')!.read, 1);
    assert.ok(map.nodes.some((n) => n.id === 'ep:billing-api:GET /health'));
    for (const name of ['billing', 'portal']) assert.equal(fx.sh(ws.checkouts[name], 'status', '--porcelain'), '', `${name} has no new files`);
    assert.equal((await repoStatus(ws, ws.repos[1])).sinceVerified, 0);
  });

  await t.test('a teammate who clones the workspace gets every repo from sync alone', async () => {
    const other = join(fx.tmp, 'teammate-home');
    process.env.LARU_HOME = other;
    const mate = loadWorkspace(ws.root);
    assert.deepEqual(mate.checkouts, {});
    const st = await syncRepos(mate);
    assert.ok(st.every((s) => !s.problem && s.checkout?.startsWith(other)));
    process.env.LARU_HOME = fx.home;
  });
});

test('laru.yaml errors name the field', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'bad'), { app: 'ok-app' });
  const file = join(ws.root, 'laru.yaml');
  const write = (s: string) => writeFileSync(file, s);
  write('app: Bad App\n');
  assert.throws(() => loadWorkspace(ws.root), (e: WorkspaceError) => e.at === 'app');
  write('app: ok\nrepos:\n  billing: { branch: main }\n');
  assert.throws(() => loadWorkspace(ws.root), (e: WorkspaceError) => e.at === 'repos.billing.url');
  assert.ok(existsSync(join(ws.root, '.gitignore')));
});

test('an agent finds the same guide in CLAUDE.md and AGENTS.md: the loop, the standard of the documentation, and the shell commands for one with no MCP client', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { initWorkspace, writeAgentFiles } = await import('../src/index.ts');
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-agents-')), 'ws'), { app: 'shop', title: 'Tienda' });
  writeAgentFiles(ws);
  const claude = readFileSync(join(ws.root, 'CLAUDE.md'), 'utf8'), agents = readFileSync(join(ws.root, 'AGENTS.md'), 'utf8');
  for (const f of [claude, agents]) {
    assert.equal(f.split('<!-- laru:start -->').length, 2, 'one block, written again in place');
    for (const w of ['knowledge_shape', 'knowledge_write', 'flow_run', 'guide:flujos-e2e', 'session_start', 'scenario_apply']) assert.ok(f.includes(w), w);
  }
  assert.ok(agents.includes('`laru docs shape <type>`') && agents.includes('`laru test --affected`'), 'AGENTS.md says the shell commands too');
  assert.ok(!claude.includes('`laru docs shape'), 'CLAUDE.md keeps to the tools');
});
