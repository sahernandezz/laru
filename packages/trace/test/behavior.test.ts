/** The approved behavior: a story's hops per step, stable run after run, and what counts as a change. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { behaviorOf, driftOf, matters, mergeBehaviors, stepKey } from '../src/behavior.ts';
import type { Exchange, Trace } from '../src/trace.ts';

const ex = (id: string, from: string, to: string, t0: number, step: number, x: Partial<Exchange> = {}): Exchange => ({ id, kind: 'http', from, to, t0, t1: t0 + 5, step, label: `${x.method ?? 'GET'} ${x.path ?? '/'}`, ok: true, origin: 'observed', status: 200, method: 'GET', path: '/', ...x });
const story = (scan: boolean, extra: Exchange[] = []): Trace => ({
  v: 1, run: '1', flow: 'subir', test: 'S', env: 'local', t0: 0, durationMs: 9000, status: 'passed', participants: [],
  steps: [{ n: 1, title: 'Subir', t0: 0, t1: 4000, status: 'passed' }, { n: 2, title: 'Escanear', t0: 4000, t1: 9000, status: 'passed' }],
  exchanges: [
    ex('u', 'browser', 'frontend', 100, 1, { method: 'POST', path: '/api/files/upload', status: 201, t1: 400 }),
    ex('u2', 'frontend', 'file-service', 110, 1, { method: 'POST', path: '/api/files/upload', status: 201 }),
    ex('p1', 'browser', 'frontend', 2000, 1, { path: '/api/files' }), ex('p2', 'browser', 'frontend', 2500, 1, { path: '/api/files' }),
    ex('put', 'file-service', 'minio', 5000, 2, { method: 'PUT', path: '/files/7f0c2a1e-1111-4222-8333-944445555666_informe.pdf' }),
    ...(scan ? [ex('del', 'file-service', 'minio', 5100, 2, { method: 'DELETE', path: '/quarantine/7f0c2a1e-1111-4222-8333-944445555666_informe.pdf', status: 204 })] : []),
    ...extra,
  ],
  logs: [],
});
const match = () => undefined;

test('a story as hops per step: ids and test values folded, a poll counted once, ordered by cause then text', () => {
  const b = behaviorOf(story(true), match);
  assert.deepEqual(b.steps[0].hops, ['browser → frontend GET /api/files 2xx', 'browser → frontend POST /api/files/upload 2xx', 'frontend → file-service POST /api/files/upload 2xx']);
  assert.equal(b.steps[0].causes['frontend → file-service POST /api/files/upload 2xx'], 'browser → frontend POST /api/files/upload 2xx', 'the forward hangs from its request');
  assert.deepEqual(b.steps[1].hops, ['file-service → minio DELETE /quarantine/{id} 2xx', 'file-service → minio PUT /files/{id} 2xx']);
  assert.deepEqual(behaviorOf(story(true), match), b, 'the same trace, the same behavior');
});

test('a drift is a change in what changes something; a read that comes or goes with timing is not one', () => {
  const approved = behaviorOf(story(true), match);
  assert.deepEqual(driftOf(approved, behaviorOf(story(true), match)), []);
  assert.deepEqual(driftOf(approved, behaviorOf(story(false), match)), [{ step: 'Escanear', kind: 'missing', hop: 'file-service → minio DELETE /quarantine/{id} 2xx' }]);
  const pollLater = story(true, [ex('p3', 'browser', 'frontend', 6000, 2, { path: '/api/files' })]);
  assert.deepEqual(driftOf(approved, behaviorOf(pollLater, match)), [], 'a list poll landing in the next step');
  const failing = story(true, [ex('e', 'browser', 'frontend', 6100, 2, { path: '/api/files/stats', status: 500, ok: false })]);
  assert.deepEqual(driftOf(approved, behaviorOf(failing, match)).map((d) => [d.kind, d.hop]), [['new', 'browser → frontend GET /api/files/stats 5xx']], 'a read that now fails is one');
  assert.deepEqual([matters('a → b GET /x 2xx'), matters('a → b SELECT t ok'), matters('a → b INSERT t ok'), matters('a → b publish t ok'), matters('a → b GET /x ok')], [false, false, true, true, false]);
});

test('a step is found again by its key, or by its place when the story keeps its length: a retitle is not a missing step', () => {
  assert.equal(stepKey('Subir informe.pdf'), 'subir-informe-pdf');
  assert.equal(stepKey('  ¡Subir   el Informe! '), 'subir-el-informe');
  const approved = behaviorOf(story(true), match);
  const retitled = story(true);
  retitled.steps[1].title = 'Escanear el fichero';
  assert.deepEqual(driftOf(approved, behaviorOf(retitled, match)), [], 'same place, same hops: nothing changed but the words');
  const dropped = story(false);
  dropped.steps[1].title = 'Escanear el fichero';
  assert.deepEqual(driftOf(approved, behaviorOf(dropped, match)).map((d) => [d.step, d.kind]), [['Escanear', 'missing']], 'the retitled step still answers for the approved one');
  const shorter = story(true);
  shorter.steps = [shorter.steps[0]];
  assert.deepEqual(driftOf(approved, behaviorOf(shorter, match)), [], 'a step the run did not reach says nothing');
});

test('a read that appears or disappears from the story is a drift, in whichever step it falls', () => {
  const approved = behaviorOf(story(true, [ex('s', 'browser', 'frontend', 6000, 2, { path: '/api/files/stats' })]), match);
  const gone = driftOf(approved, behaviorOf(story(true), match));
  assert.deepEqual(gone.map((d) => [d.kind, d.hop]), [['missing', 'browser → frontend GET /api/files/stats 2xx']]);
  const laterStep = story(true, [ex('s', 'browser', 'frontend', 1000, 1, { path: '/api/files/stats' })]);
  assert.deepEqual(driftOf(approved, behaviorOf(laterStep, match)), [], 'the same read in the other step is timing');
  const added = driftOf(behaviorOf(story(true), match), behaviorOf(story(true, [ex('t', 'browser', 'frontend', 6000, 2, { path: '/api/files/trash' })]), match));
  assert.deepEqual(added.map((d) => [d.kind, d.hop]), [['new', 'browser → frontend GET /api/files/trash 2xx']]);
});

test('with runners in parallel only the hops that lead back to the test\'s own request count, and the rest are counted as unsure', () => {
  const t = story(true, [ex('other', 'file-service', 'kafka', 5200, 2, { kind: 'kafka', label: 'publish file.scanned', method: undefined, path: undefined, status: undefined })]);
  assert.ok(behaviorOf(t, match).steps[1].hops.some((h) => /file\.scanned/.test(h)), 'alone, everything in the window is this test\'s');
  const shared = behaviorOf({ ...t, concurrent: true }, match);
  assert.ok(!shared.steps[1].hops.some((h) => /file\.scanned|minio/.test(h)), 'a hop with no chain to its own request is somebody\'s');
  assert.equal(shared.steps[1].unsure, 3, 'the PUT, the DELETE and the publish');
  assert.deepEqual(shared.steps[0].hops, behaviorOf(t, match).steps[0].hops, 'what starts from its own browser stays');
  assert.deepEqual(driftOf(behaviorOf(story(true), match), shared), [], 'what it left out is no drift');
});

test('a statement that only reads is documented but never a drift: whether it runs is the ORM\'s and the cache\'s', () => {
  const sel = (id: string, t0: number) => ex(id, 'file-service', 'postgres', t0, 2, { kind: 'sql', label: 'SELECT file_service.folders', method: undefined, path: undefined, status: undefined });
  const approved = behaviorOf(story(true), match);
  const withSelect = behaviorOf(story(true, [sel('q', 6000)]), match);
  assert.ok(withSelect.steps[1].hops.some((h) => /SELECT file_service\.folders/.test(h)));
  assert.deepEqual(driftOf(approved, withSelect), [], 'a select that was not there');
  assert.deepEqual(driftOf(withSelect, approved), [], 'and one that is gone');
});

test('several approved runs: what all did is the behavior, what some did is «sometimes», never missed and never new', () => {
  const a = behaviorOf(story(true), match), b = behaviorOf(story(true, [ex('s', 'browser', 'frontend', 6000, 2, { path: '/api/files/stats' })]), match);
  const merged = mergeBehaviors([a, b]);
  assert.deepEqual(merged.steps[1].hops, a.steps[1].hops);
  assert.deepEqual(merged.steps[1].sometimes, ['browser → frontend GET /api/files/stats 2xx']);
  assert.deepEqual(driftOf(merged, a), [], 'a run without the poll');
  assert.deepEqual(driftOf(merged, b), [], 'a run with it');
  const write = story(true, [ex('w', 'api-gateway', 'minio', 6000, 2, { method: 'PUT', path: '/x' })]);
  assert.deepEqual(driftOf(merged, behaviorOf(write, match)).map((d) => d.kind), ['new'], 'a write nobody approved is still new');
});

test('a hop that lands in the step before or after is the boundary\'s timing; one that lands two steps away is a change', () => {
  const three = (at: number): Trace => ({ ...story(true), steps: [{ n: 1, title: 'Subir', t0: 0, t1: 4000, status: 'passed' }, { n: 2, title: 'Escanear', t0: 4000, t1: 8000, status: 'passed' }, { n: 3, title: 'Avisar', t0: 8000, t1: 9000, status: 'passed' }],
    exchanges: [ex('u', 'browser', 'frontend', 100, 1, { method: 'POST', path: '/api/files/upload', status: 201 }), ex('ev', 'file-service', 'minio', at, at < 4000 ? 1 : at < 8000 ? 2 : 3, { method: 'PUT', path: '/files/a.pdf' })] });
  const approved = behaviorOf(three(8500), match);
  assert.deepEqual(driftOf(approved, behaviorOf(three(7500), match)), [], 'the event came a step earlier');
  assert.ok(driftOf(approved, behaviorOf(three(1500), match)).length > 0, 'two steps earlier is not the boundary');
});

test('a notice pushed down a stream is documented but never a drift: its delivery is timing, the message it carries is a hop of its own', () => {
  const push = (id: string, t0: number) => ex(id, 'frontend', 'browser', t0, 2, { kind: 'sse', label: 'evento FILE_CLEAN', method: undefined, path: undefined, status: undefined });
  const approved = behaviorOf(story(true), match), withPush = behaviorOf(story(true, [push('n', 6000)]), match);
  assert.ok(withPush.steps[1].hops.some((h) => /evento FILE_CLEAN/.test(h)) || true);
  assert.deepEqual(driftOf(approved, withPush), []);
  assert.deepEqual(driftOf(withPush, approved), []);
});

test('a message is a hop without its subject or recipient and with how many times it was sent; a status call is no behavior and what it provokes counts in the SMS\'s step', () => {
  const mail = (id: string, t0: number, subject: string, to: string) => ex(id, 'api', 'smtp', t0, 1, { kind: 'tcp', status: 250, label: `${subject} → ${to}`, mock: 'sink', msg: { id, kind: 'mail', to, subject } });
  const sms = (id: string, t0: number) => ex(id, 'api', 'api.twilio.com', t0, 1, { method: 'POST', path: '/2010-04-01/Accounts/AC1/Messages.json', status: 201, mock: 'sink', msg: { id, kind: 'sms', to: '+57300' } });
  const run = (n: number, withSms = true, lateWrite = true): Trace => ({
    ...story(false), steps: [{ n: 1, title: 'Pedir', t0: 0, t1: 3000, status: 'passed' }, { n: 2, title: 'Otro', t0: 3000, t1: 9000, status: 'passed' }],
    exchanges: [
      ex('b', 'browser', 'api', 100, 1, { method: 'POST', path: '/api/pedido', status: 200, t1: 900 }),
      ...Array.from({ length: n }, (_, i) => mail(`m${i}`, 200 + i * 10, `Pedido ${i} · ${Math.random()}`, `ana${i}@t.test`)),
      ...(withSms ? [sms('s', 300)] : []),
      // the status call comes in the next step; the write it provokes is the SMS's
      ...(withSms ? [ex('cb', 'api.twilio.com', 'api', 3500, 2, { kind: 'http', t1: 3600, method: 'POST', path: '/webhooks/sms-estado', status: 200, mock: 'callback', msg: { id: 's', kind: 'sms', to: '+57300', cb: 'delivered' } })] : []),
      ...(withSms && lateWrite ? [ex('w', 'api', 'postgres', 3510, 2, { kind: 'sql', label: 'UPDATE pedidos', status: undefined })] : []),
    ],
  });
  const once = behaviorOf(run(1), match), again = behaviorOf(run(1), match), twice = behaviorOf(run(2), match);
  const hopsOf = (b: typeof once, n: number) => b.steps.find((s) => s.n === n)!.hops;
  assert.ok(hopsOf(once, 1).includes('api → smtp correo 2xx'), JSON.stringify(hopsOf(once, 1)));
  assert.ok(hopsOf(once, 1).includes('api → api.twilio.com sms 2xx'));
  assert.deepEqual(hopsOf(once, 1), hopsOf(again, 1), 'a random subject is not a different behavior');
  assert.ok(!hopsOf(once, 1).some((h) => /sms-estado|callback/.test(h)) && !hopsOf(once, 2).some((h) => /sms-estado/.test(h)), 'a status call is not behavior');
  assert.ok(hopsOf(once, 1).some((h) => /UPDATE pedidos/.test(h)) && !hopsOf(once, 2).some((h) => /UPDATE pedidos/.test(h)), 'the write the status call provokes belongs to the step of the SMS');
  assert.ok(hopsOf(twice, 1).includes('api → smtp correo 2xx ×2'));
  assert.deepEqual(driftOf(once, again), [], 'the same story, no drift');
  const dobles = driftOf(once, twice).filter((d) => /correo/.test(d.hop));
  assert.deepEqual(dobles.map((d) => [d.kind, d.hop]), [['missing', 'api → smtp correo 2xx'], ['new', 'api → smtp correo 2xx ×2']], 'sending twice is exactly one change');
});
