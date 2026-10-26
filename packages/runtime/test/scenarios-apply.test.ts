/**
 * Provisioning, applying and detecting scenarios, against a fake docker (scenario-env.ts): which stores are put back
 * from which snapshot, when a setup is played again, what a persistent env is told before anything is deleted.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDir } from '@laru/core';
import { applyPlan, applyScenario, planText, provisionScenario, runFlows, scenarioState, ScenarioConfirm, ScenarioError, setupResult, shown, startRun, startSession, storesWritten, type Store } from '../src/index.ts';
import { scenarioEnv } from './scenario-env.ts';

const PASSWORD = 'vault-Passw0rd-zq81';
const store = (service: string) => ({ service }) as Store;
const ONLY = (ps: string[], prefix: string) => ps.filter((l) => l.startsWith(prefix));

test('the words of the confirmation: what is put back and from where, what is played, what restarts, what keeps its data, how long it took', () => {
  const none = { plays: false, restores: [], restarts: [], keeps: [] };
  assert.equal(planText({ ...none, restores: [{ x: store('postgres'), from: 'scenario' }], restarts: ['file-service'], keeps: ['kafka', 'minio'], lastMs: 1234 }),
    'Se restaura postgres desde la instantánea del escenario (se pierden las filas de hoy) y se reinicia file-service; kafka y minio conservan lo que tienen. La última vez tardó 1,2 s.');
  assert.equal(planText({ ...none, restores: [{ x: store('postgres'), from: 'scenario' }, { x: store('audit'), from: 'base' }, { x: store('orders'), from: 'base' }] }),
    'Se restauran postgres desde la instantánea del escenario y audit y orders desde la instantánea «base» (se pierden las filas de hoy).');
  assert.equal(planText({ ...none, plays: true, restores: [{ x: store('postgres'), from: 'base' }], restarts: ['api', 'worker'], keeps: ['minio'] }),
    'Se restaura postgres desde la instantánea «base» (se pierden las filas de hoy), se juega la preparación del escenario, que escribe sobre lo que hay y se reinician api y worker; minio conserva lo que tiene.');
  assert.equal(planText(none), 'No se borra ni se reinicia nada.');
});

test('which stores a setup wrote: SQL that writes, a write or any conversation with a datastore, a message on a broker; reads and other services are not', () => {
  const sql = (store: string, statement: string) => ({ store, statement }) as never;
  const http = (svc: string, method: string) => ({ svc, kind: 'http', method }) as never;
  const tcp = (svc: string) => ({ svc, kind: 'tcp' }) as never;
  const datastores = new Set(['postgres', 'minio', 'redis', 'kafka']);
  const written = (c: { sql?: never[]; traffic?: never[]; kafka?: never[] }) => storesWritten({ sql: [], traffic: [], kafka: [], ...c }, datastores);
  assert.deepEqual(written({ sql: [sql('postgres', 'select * from orders'), sql('audit', 'insert into log values (1)')] }), ['audit'], 'a select writes nothing; an insert does');
  assert.deepEqual(written({ traffic: [http('minio', 'GET'), http('minio', 'HEAD'), http('minio', 'OPTIONS')] }), [], 'reads over HTTP');
  assert.deepEqual(written({ traffic: [http('minio', 'PUT')] }), ['minio']);
  assert.deepEqual(written({ traffic: [http('billing-api', 'POST')] }), [], 'a write to a service that is not a datastore is the service\'s business');
  assert.deepEqual(written({ traffic: [tcp('redis'), tcp('billing-api')] }), ['redis'], 'a TCP conversation cannot be told a read from a write');
  assert.deepEqual(written({ kafka: [{ broker: 'kafka' }] as never[] }), ['kafka']);
  assert.deepEqual(written({ sql: [sql('postgres', 'update t set a = 1')], traffic: [http('minio', 'PUT'), http('minio', 'POST')], kafka: [{ broker: 'kafka' }, { broker: 'kafka' }] as never[] }), ['kafka', 'minio', 'postgres'], 'sorted, each once');
});

test('applying a scenario on a persistent env: it says what it would do and does nothing until it is told yes; then provisions, and next time restores from its snapshot', async () => {
  const env = await scenarioEnv({ secret: { key: 'ADMIN_PASSWORD', value: PASSWORD } });
  const { ws } = env;
  env.script({ 'pedido-pagado': { identities: [{ name: 'ana', username: 'ana', passwordVar: 'ADMIN_PASSWORD' }], pgWrite: true, signedIn: true } });

  const first = await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' });
  assert.deepEqual([first.persistent, first.plays, first.restores.length], [true, true, 0], 'never provisioned: its setup is played; no «base» yet, so nothing to put back');
  assert.equal(first.text, 'Se juega la preparación del escenario, que escribe sobre lo que hay y se reinicia billing-api; postgres conserva lo que tiene.');
  await assert.rejects(applyScenario(ws, 'scn:pedido-pagado', { env: 'local' }), (e: Error) => e instanceof ScenarioConfirm && e.message === first.text);
  await assert.rejects(applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: false }), ScenarioConfirm);
  assert.deepEqual([env.dbs(), ONLY(env.calls(), 'run '), ONLY(env.calls(), 'restart ')], [['shop'], [], []], 'refused: no runner, no restart, no snapshot');
  assert.equal(scenarioState(ws, 'local', 'pedido-pagado'), null);

  const a = await applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true });
  assert.deepEqual([a.provisioned, a.mode, a.keeps, a.signedIn], [true, 'snapshot', [], true]);
  assert.equal(env.dbs().length, 3, 'shop, its «base» (taken now: the setup is about to write) and the scenario\'s own snapshot');
  const st = scenarioState(ws, 'local', 'pedido-pagado')!;
  assert.deepEqual([st.touched, st.mode], [['postgres'], 'snapshot']);
  assert.equal(st.identities[0].password, PASSWORD, 'the setup got the password from the vault (the state file is 0600); only shown() keeps it from a page');
  assert.equal('password' in shown(a).identities[0], false);
  assert.equal(JSON.stringify(shown(st)).includes(PASSWORD), false);

  const second = await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' });
  assert.deepEqual([second.plays, second.restores.map((r) => [r.x.service, r.from])], [false, [['postgres', 'scenario']]]);
  assert.match(second.text, /^Se restaura postgres desde la instantánea del escenario \(se pierden las filas de hoy\) y se reinicia billing-api\. La última vez tardó \d+,\d s\.$/);
  const mark = env.calls().length;
  await assert.rejects(applyScenario(ws, 'scn:pedido-pagado', { env: 'local' }), (e: Error) => e instanceof ScenarioConfirm && e.message === second.text);
  assert.deepEqual([ONLY(env.calls().slice(mark), 'run ').length, ONLY(env.calls().slice(mark), 'restart ').length], [0, 0], 'asking changes nothing');
  const b = await applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true });
  assert.deepEqual([b.provisioned, ONLY(env.calls().slice(mark), 'run ').length, ONLY(env.calls().slice(mark), 'restart ').length], [false, 0, 1], 'from the snapshot: no runner, the service restarted');
  const scn = env.dbs().find((d) => /__ks_s/.test(d))!;
  assert.equal(env.creates().at(-1), `shop from ${scn}`, 'the database came back from the scenario\'s snapshot');
  assert.ok(scenarioState(ws, 'local', 'pedido-pagado')!.applyMs !== undefined);

  // what it depends on changed (the setup): the snapshot is stale, so the setup is played again from «base»
  appendFileSync(join(ws.root, 'docs/scenarios/pedido-pagado/pedido-pagado.setup.ts'), '\n// changed');
  const stale = await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' });
  assert.deepEqual([stale.plays, stale.restores.map((r) => r.from)], [true, ['base']]);
  assert.match(stale.text, /^Se restaura postgres desde la instantánea «base» \(se pierden las filas de hoy\), se juega la preparación del escenario, que escribe sobre lo que hay y se reinicia billing-api\./);
  const mark2 = env.calls().length;
  const c = await applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true });
  assert.deepEqual([c.provisioned, ONLY(env.calls().slice(mark2), 'run ').length], [true, 1]);
  assert.equal(env.creates().some((l) => l === 'shop from shop__ks_base'), true, 'played from «base»');
});

test('a store its setup wrote that has no snapshot keeps what it has, and the scenario plays its setup again on every apply; a scenario that writes nothing goes back to «base»', async () => {
  const env = await scenarioEnv();
  const { ws } = env;
  env.script({
    'pedido-publicado': { pgWrite: true, traffic: [{ svc: 'kafka', kind: 'tcp' }] },
    'pedido-vacio': {},
  });
  const a = await applyScenario(ws, 'scn:pedido-publicado', { env: 'local', confirm: true });
  assert.deepEqual([a.mode, a.keeps, scenarioState(ws, 'local', 'pedido-publicado')!.touched], ['replay', ['kafka'], ['kafka', 'postgres']]);
  const plan = await applyPlan(ws, 'scn:pedido-publicado', { env: 'local' });
  assert.deepEqual([plan.plays, plan.restores.map((r) => [r.x.service, r.from])], [true, [['postgres', 'base']]], 'replay: from «base», then its setup');
  assert.match(plan.text, /^Se restaura postgres desde la instantánea «base» \(se pierden las filas de hoy\) y se juega la preparación del escenario, que escribe sobre lo que hay; kafka conserva lo que tiene\./);
  const mark = env.calls().length;
  const b = await applyScenario(ws, 'scn:pedido-publicado', { env: 'local', confirm: true });
  assert.deepEqual([b.provisioned, ONLY(env.calls().slice(mark), 'run ').length], [true, 1], 'its setup again');

  // nothing written: snapshot mode, and its «restore» is «base»
  const v = await applyScenario(ws, 'scn:pedido-vacio', { env: 'local', confirm: true });
  assert.deepEqual([v.mode, scenarioState(ws, 'local', 'pedido-vacio')!.touched], ['snapshot', []]);
  const again = await applyPlan(ws, 'scn:pedido-vacio', { env: 'local' });
  assert.deepEqual([again.plays, again.restores.map((r) => r.from)], [false, ['base']]);
  assert.equal(again.text.startsWith('Se restaura postgres desde la instantánea «base» (se pierden las filas de hoy)'), true);
});

test('a setup that fails leaves the scenario broken: applying says why, and the next apply plays it again', async () => {
  const env = await scenarioEnv();
  const { ws } = env;
  env.script({ 'pedido-pagado': { exit: 1 } });
  await assert.rejects(applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true }), (e: Error) => e instanceof ScenarioError && /is broken: its setup failed\nError: expect\(received\)\.toBe\(201\)/.test(e.message));
  assert.match(scenarioState(ws, 'local', 'pedido-pagado')!.broken!, /expect\(received\)/);
  assert.equal((await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' })).plays, true);
  env.script({ 'pedido-pagado': {} });
  assert.equal((await applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true })).provisioned, true);
  const ok = scenarioState(ws, 'local', 'pedido-pagado')!;
  assert.equal(ok.broken, undefined);
  assert.equal((await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' })).plays, false, 'a good state restores from its snapshot');
  // a state that says it is broken is not trusted, whatever else it says
  writeFileSync(join(stateDir(ws), 'envs', 'local', 'scenarios', 'pedido-pagado.json'), JSON.stringify({ ...ok, broken: 'expect(received).toBe(201)' }));
  assert.equal((await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' })).plays, true);
});

test('an env that is not persistent needs no confirmation, and a session with a scenario asks like «Aplicar» does', async () => {
  const env = await scenarioEnv();
  const { ws } = env;
  env.script({ 'pedido-vacio': {}, 'pedido-publicado': {} });
  await assert.rejects(startSession(ws, { env: 'local', scenario: 'scn:pedido-vacio' }), ScenarioConfirm);
  assert.equal(ONLY(env.calls(), 'run ').length, 0);
  const s = await startSession(ws, { env: 'local', scenario: 'scn:pedido-vacio', confirm: true });
  assert.deepEqual([s.kind, s.scenario], ['session', 'pedido-vacio']);

  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'persistent: false\n');
  const plan = await applyPlan(ws, 'scn:pedido-publicado', { env: 'local' });
  assert.equal(plan.persistent, false);
  const a = await applyScenario(ws, 'scn:pedido-publicado', { env: 'local' });
  assert.equal(a.provisioned, true, 'applied with nobody saying yes');
  assert.equal(readFileSync(join(ws.root, 'envs', 'local.yaml'), 'utf8'), 'persistent: false\n');
});

test("a flow that starts from a scenario asks like «Aplicar» before anything runs on a persistent env, and plays it once told yes", async () => {
  const env = await scenarioEnv();
  const { ws } = env;
  env.script({ 'pedido-pagado': { pgWrite: true } });
  const runs = () => (existsSync(join(stateDir(ws), 'runs')) ? readdirSync(join(stateDir(ws), 'runs')).filter((d) => /^\d+$/.test(d)) : []);
  await applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true }); // today's rows have a snapshot to be lost to
  const mark = env.calls().length;

  const plan = await applyPlan(ws, 'scn:pedido-pagado', { env: 'local' });
  for (const start of [(o: object) => runFlows(ws, { env: 'local', flows: ['pagar-el-pedido'], cache: false, ...o }), (o: object) => startRun(ws, { env: 'local', flows: ['pagar-el-pedido'], ...o })]) {
    await assert.rejects(start({}), (e: Error) => e instanceof ScenarioConfirm && e.message === `scn:pedido-pagado: ${plan.text}`);
    await assert.rejects(start({ confirm: false }), ScenarioConfirm);
  }
  await assert.rejects(runFlows(ws, { env: 'local', cache: false }), ScenarioConfirm, 'no flows named: all of them');
  assert.deepEqual([ONLY(env.calls().slice(mark), 'run ').length, ONLY(env.calls().slice(mark), 'restart ').length, runs()], [0, 0, []], 'asking plays nothing and leaves no run behind');

  const run = await runFlows(ws, { env: 'local', flows: ['pagar-el-pedido'], cache: false, confirm: true });
  assert.equal(run.error, undefined);
  assert.deepEqual(ONLY(env.calls().slice(mark), 'run ').map((l) => /keelson\.run=(\S+)/.exec(l)![1]), [run.id], 'the scenario came back from its snapshot, then the flow');

  // nothing to lose, or nothing to apply: no question
  const ephemeral = await runFlows(ws, { env: 'local', flows: ['pagar-el-pedido'], ephemeral: true, cache: false }).catch((e: Error) => e);
  assert.equal(ephemeral instanceof ScenarioConfirm, false, 'an ephemeral env keeps nothing worth asking about (it refuses such flows for its own reason)');
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'persistent: false\n');
  assert.equal((await runFlows(ws, { env: 'local', flows: ['pagar-el-pedido'], cache: false })).error, undefined);
});

test('a persistent env that is down is asked about in general words: it has no stores to describe', async () => {
  const env = await scenarioEnv();
  env.down();
  await assert.rejects(runFlows(env.ws, { env: 'local', flows: ['pagar-el-pedido'] }), (e: Error) => e instanceof ScenarioConfirm && /^local está parado y se levanta para jugar los flujos: scn:pedido-pagado se aplican antes/.test(e.message));
});

test('provisioning resets the stores to «base» like applying does, so it asks the same on a persistent env and does nothing until told yes', async () => {
  const env = await scenarioEnv();
  const { ws } = env;
  env.script({ 'pedido-pagado': { pgWrite: true } });
  await applyScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true }); // «base» exists now: a provision would put today's rows back to it
  const mark = env.calls().length, made = env.creates().length;
  await assert.rejects(provisionScenario(ws, 'scn:pedido-pagado', { env: 'local' }), (e: Error) => e instanceof ScenarioConfirm
    && e.message.startsWith('Se restaura postgres desde la instantánea «base» (se pierden las filas de hoy), se juega la preparación del escenario'));
  assert.deepEqual([ONLY(env.calls().slice(mark), 'run ').length, ONLY(env.calls().slice(mark), 'restart ').length], [0, 0], 'asking changes nothing');
  assert.deepEqual([env.creates().length, env.dbs().length], [made, 3], 'no database was made or dropped for the question');
  const st = await provisionScenario(ws, 'scn:pedido-pagado', { env: 'local', confirm: true });
  assert.equal(st.broken, undefined);
  assert.equal(ONLY(env.calls().slice(mark), 'run ').length, 1, 'its setup was played');

  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'persistent: false\n');
  assert.equal((await provisionScenario(ws, 'scn:pedido-pagado', { env: 'local' })).broken, undefined, 'an env that keeps nothing worth asking about needs no yes');
});

test('applying on an env that is down says so before asking for a yes it could not honour', async () => {
  const env = await scenarioEnv();
  env.script({ 'pedido-pagado': {} });
  env.down();
  await assert.rejects(applyScenario(env.ws, 'scn:pedido-pagado', { env: 'local' }), (e: Error) => !(e instanceof ScenarioConfirm) && e instanceof ScenarioError && /^local is stopped; bring it up first: laru up local$/.test(e.message));
  await assert.rejects(provisionScenario(env.ws, 'scn:pedido-pagado', { env: 'local' }), (e: Error) => !(e instanceof ScenarioConfirm) && /bring it up first/.test(e.message));
});

test('who can sign in is a name and what it signs in with: nothing else a setup writes goes past the runner\'s door or into an answer', () => {
  const out = mkdtempSync(join(tmpdir(), 'laru-setup-'));
  const result = (scenario: unknown) => { writeFileSync(join(out, 'scenario.json'), typeof scenario === 'string' ? scenario : JSON.stringify(scenario)); return setupResult(out); };
  const odd = { name: 'ana', username: 'ana', password: 'P-secret', token: 'T-extra', pass: 'P2', email: 7 };
  assert.deepEqual(result({ identities: [odd, null, 'x', {}, { name: 3 }] })!.identities, [{ name: 'ana', username: 'ana', password: 'P-secret' }], 'a name, and the strings it signs in with');
  for (const bad of [{}, { identities: 'x' }, { identities: null }, { identities: { name: 'a' } }]) assert.deepEqual(result(bad)!.identities, [], JSON.stringify(bad));
  assert.equal(result('not json {'), undefined, 'a setup that wrote garbage did not finish: the same as writing nothing');
  assert.equal(setupResult(join(out, 'nowhere')), undefined);
  mkdirSync(join(out, 'real'));
  symlinkSync(join(out, 'scenario.json'), join(out, 'real', 'scenario.json'));
  assert.equal(setupResult(join(out, 'real')), undefined, 'a link is not the runner\'s word');

  // a state kept before this check may still hold such fields: they stay on this side
  assert.deepEqual(shown({ identities: [odd as never] }).identities, [{ name: 'ana', username: 'ana' }]);
  assert.equal(JSON.stringify(shown({ identities: [odd as never] })).includes('secret'), false);
});
