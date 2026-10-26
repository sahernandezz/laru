import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { knowledgeWrite, loadGraph, loadWorkspace } from '@laru/core';
import { listFlows, loadEnvSpec } from '@laru/runtime';
import { run } from '../src/cli.ts';
import { findingsOf, runEnv, writeJoint } from '../src/env-cli.ts';
import { createServer } from '../src/mcp.ts';

const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { io: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
};

test('the CLI from init to context, with exit codes', async () => {
  const fx = makeFixture();
  const root = join(fx.tmp, 'ws');
  const c = capture();
  assert.equal(await run(['init', root, '--app', 'comercio'], c.io), 0);
  assert.equal(await run(['repo', 'add', fx.billingUrl], c.io, root), 0);
  assert.equal(await run(['repo', 'add', fx.portalUrl, '--role', 'frontend'], c.io, root), 0);
  assert.equal(await run(['map'], c.io, root), 0);
  assert.match(c.out.at(-1)!, /2 services, \d+ endpoints/);

  const ctx = capture();
  assert.equal(await run(['context', 'billing-api'], ctx.io, join(root)), 0);
  assert.match(ctx.out.join('\n'), /# svc:billing-api/);

  const bad = capture();
  assert.equal(await run(['repo', 'add', fx.billingUrl, '--role', 'nope'], bad.io, root), 2);
  assert.equal(await run(['bogus'], bad.io, root), 2);
  assert.equal(await run(['status'], bad.io, fx.tmp), 1, 'outside a workspace');
  assert.match(bad.err.at(-1)!, /not inside a Laru workspace/);
});

test('the MCP server answers through the real SDK client', async () => {
  const fx = makeFixture();
  const root = join(fx.tmp, 'ws');
  const c = capture();
  await run(['init', root, '--app', 'comercio'], c.io);
  await run(['repo', 'add', fx.billingUrl], c.io, root);
  await run(['repo', 'add', fx.portalUrl], c.io, root);
  await run(['map'], c.io, root);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(root).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const listed = (await client.listTools()).tools, tools = listed.map((t) => t.name).sort();
  const peek = listed.find((t) => t.name === 'queue_peek')!;
  assert.deepEqual([peek.annotations?.readOnlyHint, /marks each one redelivered/.test(peek.description ?? '')], [false, true], 'a RabbitMQ peek is not a pure read, and says so');
  assert.deepEqual(tools, ['ask', 'behavior_approve', 'behavior_diff', 'check', 'context', 'db_query', 'db_schema', 'db_write', 'env_down', 'env_list', 'env_logs', 'env_reset', 'env_status', 'env_up', 'fault_set', 'fidelity', 'findings', 'flow_env', 'flow_list', 'flow_run', 'flow_scaffold', 'impact', 'knowledge_shape', 'knowledge_verify', 'knowledge_write', 'mail_clear', 'mail_enable', 'mail_list', 'map_refresh', 'mock_list', 'mock_mode', 'mongo_collections', 'mongo_dbs', 'mongo_find', 'mongo_get', 'path', 'queue_peek', 'queue_publish', 'queue_topics', 'redis_del', 'redis_get', 'redis_keys', 'repo_status', 'repo_sync', 'run_cancel', 'run_evidence', 'run_status', 'scenario_apply', 'scenario_list', 'service_exec', 'session_events', 'session_mark', 'session_start', 'session_stop', 'session_to_flow', 'session_to_scenario', 'sms', 'storage_ls', 'tree', 'vars_list', 'where']);
  const text = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text;
  assert.match(await text('tree', {}), /svc:billing-api \(quarkus, api\)/);
  assert.match(await text('context', { target: 'ep:billing-api:POST /refunds' }), /is called by svc:portal/);
  assert.match(await text('path', { from: 'portal', to: 'tbl:billing.refunds' }), /maps table/);
  await client.close();
});

test('two projects from the CLI: a folder project, a joint env written validated, the env a flow runs on, a flow no env covers', async () => {
  const fx = makeFixture();
  const root = join(fx.tmp, 'ws');
  const ledger = join(fx.tmp, 'code', 'ledger');
  fx.write(ledger, {
    'docker-compose.yml': 'services:\n  ledger:\n    build: ./api\n    depends_on: [postgres]\n  postgres:\n    image: postgres:16\n',
    'api/package.json': JSON.stringify({ name: 'ledger', dependencies: { express: '^5.0.0' } }),
    'api/server.js': "const app = require('express')();\napp.get('/entries', async (_q, r) => r.json(await (await fetch('http://billing-api:8081/orders/1/payment')).json()));\napp.listen(3000);\n",
  });
  const c = capture();
  assert.equal(await run(['init', root, '--app', 'libro'], c.io), 0);
  assert.equal(await run(['repo', 'add', fx.billingUrl], c.io, root), 0);
  assert.equal(await run(['repo', 'add', ledger, '--name', 'ledger', '--title', 'Libro'], c.io, root), 0);
  assert.equal(await run(['map'], c.io, root), 0);
  const w = loadWorkspace(root);
  assert.deepEqual(w.repos.map((r) => [r.name, r.source]), [['billing', 'git'], ['ledger', 'folder']]);
  const g = loadGraph(w);
  assert.deepEqual(g.map.names?.ledger, { ledger: 'ledger', postgres: 'ledger-postgres' });
  const ok = (r: ReturnType<typeof knowledgeWrite>) => assert.ok(r.ok, JSON.stringify(r.issues));
  ok(knowledgeWrite(w, { type: 'application', title: 'Libro', kind: 'product', status: 'active', summary: 'Cobros y libro.', fields: { purpose: 'Cobrar y asentar.', users: [{ actor: 'Cliente', need: 'Pagar' }], scope: ['Cobros'] } }, g));
  ok(knowledgeWrite(w, { type: 'module', id: 'mod:cobros', in: 'app:libro', title: 'Cobros', summary: 'Cobrar.', kind: 'area', fields: { purpose: 'Cobrar.' } }, g));
  ok(knowledgeWrite(w, { type: 'flow', id: 'flow:cobrar-y-asentar', in: 'mod:cobros', title: 'Cobrar y asentar', summary: 'Un cobro llega al libro.', meta: { needs: ['svc:billing-api', 'svc:ledger', 'ds:ledger-postgres'] },
    fields: { goal: 'El cobro queda asentado.', actors: ['Cliente'], steps: [{ step: 'Cobrar', actor: 'Cliente', service: 'svc:billing-api', expected: 'Cobrado' }] } }, g));
  writeFileSync(join(root, listFlows(w)[0].spec), "import { story } from '@laru/flow';\nstory('Cobrar y asentar', async () => {});\n");

  assert.equal(await run(['env', 'init', 'local', '--from', 'billing:docker-compose.yml'], c.io, root), 0);
  assert.equal(await run(['env', 'init', 'ledger-local', '--from', 'ledger:docker-compose.yml'], c.io, root), 0);
  const gaps = await findingsOf(loadWorkspace(root));
  assert.deepEqual(gaps.filter((f) => f.type === 'flow-env-missing').map((f) => [f.subject, f.message]), [['flow:cobrar-y-asentar', 'flow:cobrar-y-asentar necesita billing y ledger; ningún entorno los tiene']]);

  const bad = capture();
  assert.equal(await run(['env', 'init', 'both', '--join', 'local,ledger-local', '--share', 'ledger-postgres=nope'], bad.io, root), 1);
  assert.match(bad.err.join('\n'), /share\.ledger-postgres: "nope" is not a service of local or ledger-local/);
  assert.ok(!existsSync(join(root, 'envs', 'both.yaml')), 'nothing written when it does not validate');
  assert.equal(await run(['env', 'init', 'both', '--join', 'local,ledger-local'], c.io, root), 0);
  assert.match(readFileSync(join(root, 'envs', 'both.yaml'), 'utf8'), /^join: \[local, ledger-local\]$/m);
  assert.deepEqual((await findingsOf(loadWorkspace(root))).filter((f) => f.type === 'flow-env-missing'), []);
  assert.equal(await runEnv(loadWorkspace(root), ['cobrar-y-asentar']), 'both', 'the only env that runs both projects');

  // an env named that does not run the flow's projects: reported, not played (nothing reaches Docker)
  const t = capture();
  assert.equal(await run(['test', 'cobrar-y-asentar', '--env', 'local', '--json'], t.io, root), 1);
  const r = JSON.parse(t.out.join('\n'));
  assert.equal(r.status, 'error');
  assert.deepEqual(r.results, { 'cobrar-y-asentar': { status: 'error' } });
  assert.match(r.error, /cobrar-y-asentar necesita ledger; local no lo tiene/);

  // «Nuevo entorno conjunto» writes through writeJoint too: names stay in envs/, share ends are checked, and an error
  // leaves the disk as it was, the member env it would have created included
  const envs = () => readdirSync(join(root, 'envs')).sort();
  const before = envs();
  const refuse = (re: RegExp, ...a: Parameters<typeof writeJoint> extends [unknown, ...infer R] ? R : never) => assert.throws(() => writeJoint(loadWorkspace(root), ...a), re);
  refuse(/: name: env names are kebab-case/, '../../outside-joint', ['local', 'ledger-local']);
  refuse(/: name: env names are kebab-case/, 'Joint Bad', ['local', 'ledger-local']);
  refuse(/: create\[0\]\.env: env names are kebab-case/, 'pair', ['local', '../../outside-member'], {}, [{ env: '../../outside-member', from: 'ledger:docker-compose.yml' }]);
  refuse(/share\.nope: "nope" is not a service of local or ledger-local/, 'pair', ['local', 'ledger-local'], { nope: 'also-nope' });
  refuse(/share\.ledger-postgres: "nope" is not a service/, 'pair', ['local', 'ledger-two'], { 'ledger-postgres': 'nope' }, [{ env: 'ledger-two', from: 'ledger:docker-compose.yml' }]);
  refuse(/join\[1\]: env names are kebab-case/, 'pair', ['local', '../x']);
  assert.deepEqual(envs(), before);
  assert.ok(!existsSync(join(fx.tmp, 'outside-joint.yaml')) && !existsSync(join(fx.tmp, 'outside-member.yaml')));
  assert.deepEqual(writeJoint(loadWorkspace(root), 'pair', ['local', 'ledger-two'], { 'ledger-postgres': 'postgres' }, [{ env: 'ledger-two', from: 'ledger:docker-compose.yml' }]), ['envs/ledger-two.yaml', 'envs/pair.yaml']);
  assert.deepEqual(loadEnvSpec(loadWorkspace(root), 'pair').share, { 'ledger-postgres': 'postgres' });
  assert.equal(loadEnvSpec(loadWorkspace(root), 'ledger-two').from?.repo, 'ledger');
  const named = capture();
  assert.equal(await run(['env', 'init', '../escape', '--from', 'ledger:docker-compose.yml'], named.io, root), 1);
  assert.match(named.err.join('\n'), /env names are kebab-case/);
});
