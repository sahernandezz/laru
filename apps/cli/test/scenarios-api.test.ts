/**
 * What the local service says about scenarios and sessions: on a persistent env «Aplicar» is answered 409 with what
 * it would delete until the request says `confirm: true`, and no answer, whatever the route, carries a password of the
 * vault. Against a fake docker.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDir } from '@laru/core';
import { scenarioEnv } from '../../../packages/runtime/test/scenario-env.ts';
import { startDaemon } from '../src/daemon.ts';

const PASSWORD = 'vault-Passw0rd-zq81';

test('«Aplicar» on a persistent env is 409 with what it would delete until confirm: true; no /api/scenarios or /api/session answer carries a password', async () => {
  const env = await scenarioEnv({ secret: { key: 'ADMIN_PASSWORD', value: PASSWORD } });
  env.script({ 'pedido-pagado': { identities: [{ name: 'ana', username: 'ana', passwordVar: 'ADMIN_PASSWORD' }], pgWrite: true, signedIn: true } });
  const dist = join(env.ws.root, '..', 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Laru</title>');
  const d = await startDaemon(0, dist);
  try {
    const base = new URL(d.url).origin;
    const cookie = String((await fetch(d.url, { redirect: 'manual' })).headers.get('set-cookie')).split(';')[0];
    const bodies: string[] = [];
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const r = await fetch(`${base}/api/w/comercio${path}`, { method, headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
      const text = await r.text();
      bodies.push(text);
      return { status: r.status, body: JSON.parse(text) };
    };
    const runs = () => env.calls().filter((l) => l.startsWith('run ')).length;
    const apply = { name: 'scn:pedido-pagado', env: 'local' };

    assert.equal((await call('GET', '/scenarios?env=local')).status, 200);
    const asked = await call('POST', '/scenarios/apply', apply);
    assert.equal(asked.status, 409);
    assert.equal(asked.body.error, 'Se juega la preparación del escenario, que escribe sobre lo que hay y se reinicia billing-api; postgres conserva lo que tiene.');
    for (const confirm of ['yes', 1, 'true', null]) assert.equal((await call('POST', '/scenarios/apply', { ...apply, confirm })).status, 409, `confirm: ${JSON.stringify(confirm)} is not a yes`);
    assert.equal(runs(), 0, 'nothing ran');

    const done = await call('POST', '/scenarios/apply', { ...apply, confirm: true });
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.slug, done.body.provisioned, done.body.signedIn], ['pedido-pagado', true, true]);
    assert.deepEqual(done.body.identities, [{ name: 'ana', username: 'ana' }], 'who can sign in, without the password');
    assert.match(readFileSync(join(stateDir(env.ws), 'envs', 'local', 'scenarios', 'pedido-pagado.json'), 'utf8'), new RegExp(PASSWORD), 'the password did get as far as the state file');
    const list = await call('GET', '/scenarios?env=local');
    assert.deepEqual(list.body.scenarios.find((s: { slug: string }) => s.slug === 'pedido-pagado').state.identities, [{ name: 'ana', username: 'ana' }]);

    // a flow that starts from the scenario asks the same before a run exists
    const play = { env: 'local', flows: ['pagar-el-pedido'] };
    const runAsked = await call('POST', '/runs/start', play);
    assert.equal(runAsked.status, 409);
    assert.match(runAsked.body.error, /^scn:pedido-pagado: Se restaura postgres desde la instantánea del escenario \(se pierden las filas de hoy\)/);
    for (const confirm of ['yes', 1, 'true', null]) assert.equal((await call('POST', '/runs/start', { ...play, confirm })).status, 409, `confirm: ${JSON.stringify(confirm)} is not a yes`);
    assert.deepEqual((await call('GET', '/runs')).body, [], 'asking started no run');

    // a session that starts from the scenario asks the same, and its routes say nothing of the password either
    assert.equal((await call('POST', '/session/start', { env: 'local', scenario: 'scn:pedido-pagado' })).status, 409);
    const started = await call('POST', '/session/start', { env: 'local', scenario: 'scn:pedido-pagado', confirm: true });
    assert.equal(started.status, 200);
    const id = started.body.run.id;
    assert.equal((await call('POST', '/session/mark', { id, text: 'Pago' })).status, 200);
    assert.equal((await call('GET', `/session/trace?id=${id}&kafka=0`)).status, 200);
    assert.equal((await call('POST', '/session/stop', { id })).status, 200);

    assert.ok(bodies.length >= 12);
    assert.deepEqual(bodies.filter((b) => b.includes(PASSWORD)), [], 'no answer has the password');
    assert.deepEqual(bodies.filter((b) => /"password"/.test(b)), [], 'nor a password field, empty or not');
  } finally { await d.close(); }
});
