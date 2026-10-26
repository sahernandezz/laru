import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { endpointMatcher } from '../src/assemble.ts';
import { flowLast, hopWhat, seenIn } from '../src/summarize.ts';
import type { Exchange, Trace } from '../src/trace.ts';

const ex = (id: string, from: string, to: string, step: number | undefined, extra: Partial<Exchange> = {}): Exchange =>
  ({ id, kind: 'http', from, to, t0: 0, label: `${extra.method ?? 'GET'} ${extra.path ?? '/'}`, ok: true, origin: 'observed', step, method: 'GET', path: '/', ...extra });
const trace = (exchanges: Exchange[], extra: Partial<Trace> = {}): Trace => ({
  v: 1, run: '42', flow: 'administrar-usuarios', test: 'historia', env: 'local', t0: 0, durationMs: 1, status: 'passed', story: true, steps: [], logs: [], exchanges,
  participants: [
    { id: 'runner', name: 'Prueba', type: 'runner' }, { id: 'browser', name: 'Navegador', type: 'browser' },
    { id: 'api-gateway', name: 'api-gateway', type: 'service', node: 'svc:api-gateway' }, { id: 'postgres', name: 'postgres', type: 'datastore', node: 'ds:postgres' },
  ],
  ...extra,
});
const match = endpointMatcher([
  { id: 'ep:api-gateway:PUT /api/admin/users/{userId}/role', type: 'endpoint', name: 'PUT /api/admin/users/{userId}/role', service: 'svc:api-gateway', attrs: { method: 'PUT', path: '/api/admin/users/{userId}/role' } },
  { id: 'ep:api-gateway:POST /api/auth/login', type: 'endpoint', name: 'POST /api/auth/login', service: 'svc:api-gateway', attrs: { method: 'POST', path: '/api/auth/login' } },
  { id: 'ep:api-gateway:GET /api/admin/users', type: 'endpoint', name: 'GET /api/admin/users', service: 'svc:api-gateway', attrs: { method: 'GET', path: '/api/admin/users' } },
]);

test('flowLast: the failing hop by name, endpoints matched at read time, setup left out', () => {
  const story = trace([
    ex('setup', 'runner', 'api-gateway', undefined, { method: 'GET', path: '/api/admin/users' }),
    ex('login', 'browser', 'api-gateway', 3, { method: 'POST', path: '/api/auth/login', status: 400, ok: false }),
    ex('role', 'runner', 'api-gateway', 4, { method: 'PUT', path: '/api/admin/users/8c7e/role', status: 400, ok: false }),
    ex('sql', 'api-gateway', 'postgres', 4, { kind: 'sql', method: undefined, path: undefined, label: 'SELECT gateway.users' }),
    // what the trace stored wins: this path matches nothing now
    ex('pre', 'runner', 'api-gateway', 2, { method: 'POST', path: '/api/v0/login', endpoint: 'ep:api-gateway:POST /api/auth/login' }),
  ], { status: 'failed', failure: { step: 4, message: 'boom', exchange: 'role' } });
  const cases = [trace([], { story: false, test: 'Un USER no entra', status: 'failed', participants: [{ id: 'file-service', name: 'file-service', type: 'service', node: 'svc:file-service' }] })];
  const last = flowLast(story, cases, match);
  assert.deepEqual(last.failure, { step: 4, message: 'boom', hop: { from: 'Prueba', to: 'api-gateway', what: 'PUT /api/admin/users/{userId}/role', status: 400, error: undefined } });
  assert.deepEqual(last.cases, [{ test: 'Un USER no entra', status: 'failed' }]);
  assert.deepEqual(last.nodes, ['svc:api-gateway', 'ds:postgres', 'svc:file-service'], 'a case touches nodes the story does not');
  assert.deepEqual(last.endpoints, [
    { id: 'ep:api-gateway:POST /api/auth/login', steps: [3, 2], ok: false },
    { id: 'ep:api-gateway:PUT /api/admin/users/{userId}/role', steps: [4], ok: false },
  ], 'the setup GET is not counted; a failed call makes the endpoint not ok');
});

test('flowLast: a failure on the page has no hop; a hop that matched nothing says its label', () => {
  assert.deepEqual(flowLast(trace([], { status: 'failed', failure: { step: 2, message: 'no se ve' } }), [], match).failure, { step: 2, message: 'no se ve' });
  const odd = flowLast(trace([ex('x', 'runner', 'api-gateway', 1, { method: 'DELETE', path: '/nada', label: 'DELETE /nada', ok: false, status: 404 })], { status: 'failed', failure: { step: 1, message: 'm', exchange: 'x' } }), [], match);
  assert.equal(odd.failure?.hop?.what, 'DELETE /nada');
  assert.deepEqual(odd.endpoints, []);
});

test('hopWhat: any hop, of a case or of an old run, reads as its endpoint’s template once the map has it', () => {
  const proxy = endpointMatcher([{ id: 'ep:api-gateway:DELETE /api/files/**', type: 'endpoint', name: 'DELETE /api/files/**', service: 'svc:api-gateway', attrs: { method: 'DELETE', path: '/api/files/**' } }]);
  // a case's hop, recorded with no endpoint: the raw path never shows
  const del = ex('d', 'runner', 'api-gateway', 1, { method: 'DELETE', path: '/api/files/ef72fda0-aaae-4ba7-abce-68b715562946', label: 'DELETE /api/files/ef72fda0-aaae-…', status: 500, ok: false });
  assert.equal(hopWhat(del, proxy), 'DELETE /api/files/**');
  assert.equal(hopWhat({ ...del, endpoint: 'ep:api-gateway:DELETE /api/files/{fileId}' }, proxy), 'DELETE /api/files/{fileId}', 'what the trace recorded wins');
  assert.equal(hopWhat({ ...del, path: '/otra/cosa' }, proxy), 'DELETE /api/files/ef72fda0-aaae-…', 'nothing matched: its label');
});

test('seenIn: statuses and counts per endpoint, the newest example with a body, topics by direction, externals', () => {
  const old = trace([ex('a', 'runner', 'api-gateway', 1, { method: 'POST', path: '/api/auth/login', status: 200, res: { bytes: 9, text: '{"t":"…x"}' } })], { run: '41' });
  const story = trace([
    ex('b', 'browser', 'api-gateway', 1, { method: 'POST', path: '/api/auth/login', status: 200, res: { bytes: 0 } }),
    ex('c', 'browser', 'api-gateway', 2, { method: 'POST', path: '/api/auth/login', status: 401, ok: false, drift: ['body.username is required'] }),
    ex('d', 'browser', 'api-gateway', 2, { method: 'PUT', path: '/api/admin/users/1/role', error: 'socket hang up', ok: false }),
    ex('assets', 'browser', 'api-gateway', 1, { method: 'POST', path: '/api/auth/login', asset: 5 }),
    { id: 'k1', kind: 'kafka', from: 'api-gateway', to: 'postgres', t0: 0, label: 'user.created', topic: 'user.created', ok: true, origin: 'derived', req: { bytes: 2, text: '{}' } },
    { id: 'k1>file-service', kind: 'kafka', from: 'postgres', to: 'file-service', t0: 0, label: 'user.created', topic: 'user.created', ok: true, origin: 'derived' },
    ex('x', 'api-gateway', 'clamav', 2, { kind: 'tcp', method: undefined, path: undefined, label: 'tcp', mock: 'hit' }),
  ], { participants: [...trace([]).participants, { id: 'clamav', name: 'clamav', type: 'external', node: 'ext:clamav' }, { id: 'file-service', name: 'file-service', type: 'service' }] });
  const seen = seenIn([{ trace: story, at: 'T42' }, { trace: old, at: 'T41' }], match);
  const login = seen.endpoints['ep:api-gateway:POST /api/auth/login'];
  assert.deepEqual([login.count, login.statuses, login.run, login.at, login.flows, login.drift], [3, { 200: 2, 401: 1 }, '42', 'T42', ['administrar-usuarios'], ['body.username is required']], 'assets are not calls');
  assert.equal(login.samples['200'].id, 'a', 'run 42 answered no body: the example stays the one from run 41');
  assert.equal(login.samples['401'].id, 'c');
  assert.deepEqual(seen.endpoints['ep:api-gateway:PUT /api/admin/users/{userId}/role'].statuses, { error: 1 });
  assert.deepEqual(seen.topics['user.created'], { count: 1, run: '42', at: 'T42', flows: ['administrar-usuarios'], publishers: ['api-gateway'], consumers: ['file-service'], sample: seen.topics['user.created'].sample });
  assert.equal(seen.topics['user.created'].sample?.req?.text, '{}');
  assert.deepEqual(seen.targets.clamav, { count: 1, run: '42', at: 'T42', kinds: ['tcp'], mock: 'hit', drift: [] });
});
