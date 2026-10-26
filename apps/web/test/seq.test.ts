/** The sequence layout of the Run screen: pure, so it is checked here instead of by eye. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Exchange, LogLine, Participant, Trace } from '@laru/trace';
import { chain } from '@laru/trace/chain';
import { CH, curl, expectedTrace, failTime, fit, hopLogs, labelRoom, laneOrder, layoutSeq, revealBy, route, rowState, sameStop, stepAt, stepOf, stepStop, stopId, stopOf, walk } from '../src/lib/seq.ts';

const P: Participant[] = [
  { id: 'postgres', name: 'postgres', type: 'datastore', kind: 'postgres' },
  { id: 'clamav', name: 'clamav', type: 'external' },
  { id: 'file-service', name: 'file-service', type: 'service', kind: 'spring' },
  { id: 'api-gateway', name: 'api-gateway', type: 'service', kind: 'spring' },
  { id: 'kafka', name: 'kafka', type: 'datastore', kind: 'queue' },
  { id: 'frontend', name: 'frontend', type: 'service', kind: 'web' },
  { id: 'runner', name: 'Prueba', type: 'runner' },
  { id: 'browser', name: 'Navegador', type: 'browser', kind: 'chromium' },
];
const ex = (id: string, from: string, to: string, t0: number, t1: number | undefined, more: Partial<Exchange> = {}): Exchange => ({ id, kind: 'http', from, to, t0, t1, label: id, ok: true, origin: 'observed', ...more });
const trace = (): Pick<Trace, 'participants' | 'steps' | 'exchanges' | 'failure' | 'durationMs'> => ({
  durationMs: 9000,
  participants: P,
  steps: [
    { n: 1, title: 'Entrar', t0: 0, t1: 1000, status: 'passed' },
    { n: 2, title: 'Subir', t0: 1000, t1: 8000, status: 'failed', error: 'boom' },
  ],
  exchanges: [
    ex('page', 'browser', 'frontend', 10, 40, { status: 200 }),
    ex('assets', 'browser', 'frontend', 50, 90, { asset: 10, label: 'GET 10 recursos', status: 200 }),
    ex('up', 'browser', 'frontend', 1100, 1900, { status: 502, ok: false }),
    ex('fwd', 'frontend', 'api-gateway', 1110, 1890, { status: 502, ok: false, parent: 'up' }),
    ex('sql', 'file-service', 'postgres', 1200, 1200, { kind: 'sql', label: 'INSERT file_service.files' }),
    ex('pub', 'file-service', 'kafka', 1300, undefined, { kind: 'kafka', origin: 'derived', label: 'file.uploaded' }),
    ex('evt', 'api-gateway', 'notification-service', 5000, undefined, { kind: 'sse', label: 'evento connected' }),
  ],
  failure: { step: 2, message: 'boom', exchange: 'up' },
});

test('lanes: browser, runner, front, gateway, other services, stores, externals', () => {
  assert.deepEqual(laneOrder(P).map((p) => p.id), ['browser', 'runner', 'frontend', 'api-gateway', 'file-service', 'kafka', 'postgres', 'clamav']);
  const l = layoutSeq(trace());
  // within stores, the one that takes part first
  assert.deepEqual(l.lanes.filter((x) => x.type === 'datastore').map((x) => x.id), ['postgres', 'kafka']);
  // a lane the participants missed is still drawn, after the services it came with
  assert.ok(l.lanes.some((x) => x.id === 'notification-service'));
  assert.deepEqual(l.lanes.map((x) => x.x), [...l.lanes.keys()].map((i) => l.lanes[0].x + i * (l.lanes[1].x - l.lanes[0].x)));
});

test('the layout is deterministic, whatever order the participants come in', () => {
  const a = layoutSeq(trace());
  const b = layoutSeq({ ...trace(), participants: [...P].reverse() });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.deepEqual(layoutSeq(trace()), a);
});

test('a band per step, before the rows that happen in it; responses are rows of their own', () => {
  const l = layoutSeq(trace());
  const order = l.items.map((i) => (i.type === 'band' ? `#${i.step.n}` : `${i.ex.id}${i.reply ? '<' : ''}`));
  assert.deepEqual(order, ['#1', 'page', 'page<', 'assets', '#2', 'up', 'fwd', 'sql', 'pub', 'fwd<', 'up<', 'evt']);
  // assets are one collapsed row, with no response; a SQL statement is one row
  assert.equal(l.rows.filter((r) => r.ex.id === 'assets').length, 1);
  assert.equal(l.rows.filter((r) => r.ex.id === 'sql').length, 1);
  const ys = l.items.map((i) => i.y);
  assert.deepEqual(ys, [...ys].sort((p, q) => p - q));
});

test('async and derived exchanges are dashed; an SSE event goes back up the stream', () => {
  const l = layoutSeq(trace());
  const row = (id: string, reply = false) => l.rows.find((r) => r.ex.id === id && r.reply === reply)!;
  assert.equal(row('page').async || row('page').derived, false);
  assert.equal(row('pub').async && row('pub').derived, true);
  assert.equal(row('evt').async, true);
  const lane = (id: string) => l.lanes.find((x) => x.id === id)!.x;
  assert.deepEqual([row('evt').x1, row('evt').x2], [lane('notification-service'), lane('api-gateway')]);
  assert.deepEqual([row('page', true).x1, row('page', true).x2], [lane('frontend'), lane('browser')]);
});

test('the bad event is the failed exchange\'s response', () => {
  const l = layoutSeq(trace());
  assert.equal(l.rows[l.bad].ex.id, 'up');
  assert.equal(l.rows[l.bad].reply, true);
  assert.equal(layoutSeq({ ...trace(), failure: undefined }).bad, -1);
  // only the response of a failed exchange is red, not its request
  assert.deepEqual(l.rows.filter((r) => r.bad).map((r) => `${r.ex.id}${r.reply ? '<' : ''}`), ['fwd<', 'up<']);
});

test('row state follows the clock', () => {
  const l = layoutSeq(trace());
  const up = l.rows.find((r) => r.ex.id === 'up' && !r.reply)!;
  assert.equal(rowState(up, 1000), 'future');
  assert.equal(rowState(up, 1500), 'now', 'open while the exchange runs');
  assert.equal(rowState(up, 2500), 'past');
  // an SSE stream is open the whole run: it flashes when it opens, then reads as past
  const sse = { ...up, ex: { ...up.ex, resHeaders: { 'content-type': 'text/event-stream;charset=UTF-8' } } };
  assert.equal(rowState(sse, up.t + 100), 'now');
  assert.equal(rowState(sse, 1500), 'past');
});

test('cURL from the masked trace, with shell quoting', () => {
  const c = curl(ex('x', 'frontend', 'api-gateway', 0, 1, { method: 'POST', path: '/api/auth/login', query: 'a=1', reqHeaders: { host: 'frontend', authorization: 'Bearer …yoXd' }, req: { bytes: 20, text: `{"name":"O'Neil"}` } }))!;
  assert.equal(c, `curl -X POST 'http://api-gateway/api/auth/login?a=1' \\\n  -H 'authorization: Bearer …yoXd' \\\n  --data-raw '{"name":"O'\\''Neil"}'`);
  assert.equal(curl(ex('q', 'a', 'postgres', 0, 0, { kind: 'sql' })), null);
});

test('at a seam between steps, the step that began last is the current one', () => {
  const steps = [{ n: 3, title: 'c', t0: 3464, t1: 5828, status: 'passed' as const }, { n: 4, title: 'd', t0: 5827, t1: 5990, status: 'failed' as const }];
  assert.equal(stepAt(steps, 5827)?.n, 4);
  assert.equal(stepAt(steps, 4000)?.n, 3);
  assert.equal(stepAt(steps, 6000), undefined);
});

test('a label is cut to its room, never inside a mask mark', () => {
  const two = 128 * 2 - 16; // two lanes: 36 characters, the narrowest a label gets
  assert.equal(fit('GET /a', two), 'GET /a');
  assert.equal(fit('PUT /api/users/me/avatars/files/…k9D2/x', two), 'PUT /api/users/me/avatars/files/…');
  assert.equal(fit('DELETE /api/files/shared/links/…AbC-/revoke', two), 'DELETE /api/files/shared/links/…');
  assert.equal(fit(`${'x'.repeat(30)}…k9D2${'y'.repeat(9)}`, two), `${'x'.repeat(30)}…k9D2…`, 'a mark that fits stays whole');
  assert.equal(fit(`${'x'.repeat(31)}… /${'y'.repeat(9)}`, two), `${'x'.repeat(31)}… /y…`, 'a bare … is no mark');
  // a mark that starts on the last one or two characters the cut keeps goes whole to the cut
  assert.equal(fit(`${'x'.repeat(34)}…k9D2${'y'.repeat(9)}`, two), `${'x'.repeat(34)}…`);
  assert.equal(fit(`${'x'.repeat(33)}…k9D2${'y'.repeat(9)}`, two), `${'x'.repeat(33)}…`);
});

test('what a flow that never ran should look like: lanes, a band per step, a derived message per step with a service', async () => {
  const { expectedTrace } = await import('../src/lib/seq.ts');
  const x = expectedTrace({ steps: [
    { step: 'Iniciar sesión', actor: 'Usuario', service: 'svc:api-gateway', expected: 'Entra' },
    { step: 'Pensar', actor: 'Usuario', expected: 'Nada se mueve' },
    { step: 'Escanear', actor: 'antivirus-service', service: 'svc:antivirus-service', expected: 'ClamAV dice OK' },
  ] });
  // the actor named like a service shares that service's lane
  assert.deepEqual(x.participants.map((p) => [p.id, p.type]), [['svc:api-gateway', 'service'], ['svc:antivirus-service', 'service'], ['actor:Usuario', 'browser']]);
  assert.deepEqual(x.steps.map((s) => [s.n, s.status]), [[1, 'todo'], [2, 'todo'], [3, 'todo']]);
  const l = layoutSeq(x);
  // a step without a service is a band only; rows are derived, with no reply
  assert.equal(l.items.filter((i) => i.type === 'band').length, 3);
  assert.deepEqual(l.rows.map((r) => [r.ex.from, r.ex.to, r.derived, r.reply]), [['actor:Usuario', 'svc:api-gateway', true, false], ['svc:antivirus-service', 'svc:antivirus-service', true, false]]);
  assert.equal(l.rows[0].label, 'Se espera: Entra');
  assert.equal(l.lanes.find((p) => p.id === 'actor:Usuario')?.sub, 'actor');
  assert.equal(l.bad, -1);
});

test('an arrow to the last lane keeps its label inside the drawing, cut where the drawing ends', () => {
  // a draft flow: Administrador and file-service, 288px wide; the label would run past the edge at two lanes' room
  const l = layoutSeq(expectedTrace({ steps: [{ step: 'Ver', actor: 'Administrador', service: 'svc:file-service', expected: 'Ve el fichero cifrado' }] }));
  const [r] = l.rows;
  const shown = fit(r.label, labelRoom(r, l.width));
  assert.equal(l.width, 288);
  assert.ok(Math.min(r.x1, r.x2) + 8 + shown.length * CH <= l.width, `«${shown}» ends inside the drawing`);
  assert.match(shown, /^Se espera: Ve el.*…$/);
  // between two lanes with room to spare, at least two lanes wide, as before
  assert.equal(labelRoom({ x1: 80, x2: 208 }, 1000), 128 * 2 - 16);
});

test('several projects: lanes grouped by project in the order each takes part, a band over each; one project lays out as before', () => {
  const ps: Participant[] = [
    { id: 'browser', name: 'Navegador', type: 'browser' },
    { id: 'audit-api', name: 'audit-api', type: 'service', project: 'audit' },
    { id: 'audit-web', name: 'audit-web', type: 'service', kind: 'web', project: 'audit' },
    { id: 'audit-postgres', name: 'audit-postgres', type: 'datastore', kind: 'postgres', project: 'audit' },
    { id: 'frontend', name: 'frontend', type: 'service', kind: 'web', project: 'vaultflow' },
    { id: 'api-gateway', name: 'api-gateway', type: 'service', project: 'vaultflow' },
    { id: 'postgres', name: 'postgres', type: 'datastore', kind: 'postgres', project: 'vaultflow' },
    { id: 'stripe', name: 'stripe', type: 'external' },
  ];
  const exs = [ex('a', 'browser', 'frontend', 10, 20), ex('b', 'frontend', 'api-gateway', 11, 19), ex('c', 'api-gateway', 'postgres', 12, 12, { kind: 'sql' }),
    ex('d', 'browser', 'audit-web', 30, 40), ex('e', 'audit-web', 'audit-api', 31, 39), ex('f', 'audit-api', 'api-gateway', 32, 38), ex('g', 'audit-api', 'audit-postgres', 33, 33, { kind: 'sql' })];
  const l = layoutSeq({ participants: ps, exchanges: exs, steps: [], durationMs: 100 });
  assert.deepEqual(l.lanes.map((x) => x.id), ['browser', 'frontend', 'api-gateway', 'postgres', 'audit-web', 'audit-api', 'audit-postgres', 'stripe']);
  assert.deepEqual(l.projects.map((b) => [b.project, Math.round((b.x2 - b.x1) / (l.lanes[1].x - l.lanes[0].x))]), [['vaultflow', 3], ['audit', 3]]);
  // one project: no bands, and the lanes are those of a trace without projects
  const one = ps.filter((p) => p.project !== 'audit');
  const tagged = layoutSeq({ participants: one, exchanges: exs.slice(0, 3), steps: [], durationMs: 100 });
  const bare = layoutSeq({ participants: one.map(({ project: _p, ...p }) => p), exchanges: exs.slice(0, 3), steps: [], durationMs: 100 });
  assert.deepEqual(tagged.projects, []);
  assert.deepEqual(tagged.lanes.map(({ project: _p, ...x }) => x), bare.lanes);
  assert.deepEqual(tagged.items, bare.items);
});

// run 42 «Subir un fichero limpio», trimmed and masked
const [limpio] = JSON.parse(readFileSync(new URL('../../../packages/trace/test/fixtures/limpio-42.json', import.meta.url), 'utf8')) as Trace[];

test('«Paso a paso» walks 42 «limpio» in 116 stops: 107 rows that do not fold, 8 act headers and the failure', () => {
  const l = layoutSeq(limpio), c = chain(limpio);
  const w = walk(l, c, limpio);
  const kinds = (k: string) => w.filter((x) => x.s.kind === k).length;
  assert.deepEqual([w.length, kinds('row'), kinds('act'), kinds('fail')], [116, 107, 8, 1]);
  const rows = w.flatMap((x) => (x.s.kind === 'row' ? [x.s.i] : []));
  assert.ok(rows.every((i) => !c.noise.has(l.rows[i].ex.id)), 'a folded row is never a stop');
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b), 'rows come in Secuencia’s order');
  for (const [i, x] of w.entries()) if (i) assert.ok(w[i - 1].t <= x.t, 'in time order');
  // an act’s header comes before the rows of its moment
  for (const a of c.acts) { const at = w.findIndex((x) => x.s.kind === 'act' && x.s.act === a); assert.ok(!w.slice(0, at).some((x) => x.s.kind === 'row' && x.t === a.t0 && c.actOf.get(l.rows[x.s.i].ex.id) === a.id), a.id); }
  // «Mostrar lo plegado» adds the folded rows
  assert.equal(walk(l, c, limpio, () => true).length, 116 + l.rows.filter((r) => c.noise.has(r.ex.id)).length);
  // a test that passed has no failure stop
  assert.equal(walk(l, c, { ...limpio, status: 'passed', failure: undefined }).filter((x) => x.s.kind === 'fail').length, 0);
});

test('a Pasos step goes to its own first stop: «Recibir el aviso» has none, so it is not «Descargarlo»’s first', () => {
  const l = layoutSeq(limpio), c = chain(limpio), w = walk(l, c, limpio);
  const goal = limpio.steps.map((s) => stepStop(w, limpio.steps, s));
  // step 3 «Escanear el fichero» (3.744–7.088 s): its act at 6.732 s; step 4 (7.088–7.192 s) has no stop of its own
  assert.deepEqual(goal.map((g) => g && [g.s.kind, g.t]), [['act', 507], ['act', 1687], ['act', 6732], undefined, ['act', 7448]]);
  for (const [i, g] of goal.entries()) if (g) assert.equal(stepOf(limpio.steps, g.t)?.n, limpio.steps[i].n, 'the card names the same step');
  for (const [i, g] of goal.entries()) if (g?.s.kind === 'act') assert.equal(g.s.act.step, limpio.steps[i].n, 'an act of that step');
  // after the last step, its moments are the last step’s, as the card says
  assert.equal(stepOf(limpio.steps, limpio.steps.at(-1)!.t1 + 500)?.n, 5);
});

test('«Cadena» shows a node in the part of the tree on screen: the tree scrolls when it runs past the page', () => {
  // 1440×900, story 42: the tree at 723–1147 inside a page shown from 48 to 900; ↓ put the node at 943–1001
  assert.equal(revealBy({ top: 723, bottom: 1147 }, { top: 48, bottom: 900 }, { top: 943, bottom: 1001 }), 101);
  // 375×812: the tree at 400–860, the node at 734–860
  assert.equal(revealBy({ top: 400, bottom: 860 }, { top: 48, bottom: 812 }, { top: 734, bottom: 860 }), 48);
  // a node taller than what shows: its top first
  assert.equal(revealBy({ top: 723, bottom: 1147 }, { top: 48, bottom: 900 }, { top: 880, bottom: 1060 }), 157);
  // the tree's top under the page's edge: up to the first line on screen
  assert.equal(revealBy({ top: -100, bottom: 324 }, { top: 48, bottom: 900 }, { top: 0, bottom: 58 }), -48);
  // what the tree could not cover at its end: the scroller moves by the rest (the review's End on 42 «limpio»)
  assert.equal(revealBy({ top: -Infinity, bottom: Infinity }, { top: 48, bottom: 900 }, { top: 1121, bottom: 1179 }), 279);
  assert.equal(revealBy({ top: -Infinity, bottom: Infinity }, { top: 328, bottom: 812 }, { top: 207, bottom: 285 }), -121, 'under the sheet\'s top, not #main\'s');
  assert.equal(revealBy({ top: 723, bottom: 1147 }, { top: 48, bottom: 900 }, { top: 760, bottom: 818 }), 0);
  assert.equal(revealBy({ top: 870, bottom: 1330 }, { top: 48, bottom: 900 }, { top: 1000, bottom: 1058 }), 130);
  // none of the tree on screen: the tree's own view, for when the page comes to it
  assert.equal(revealBy({ top: 950, bottom: 1410 }, { top: 48, bottom: 900 }, { top: 1000, bottom: 1058 }), 0);
  assert.equal(revealBy({ top: 950, bottom: 1410 }, { top: 48, bottom: 900 }, { top: 1400, bottom: 1458 }), 48);
});

test('the failure stop comes after the rows of its moment, and an act header before them', () => {
  const t = trace(), l = layoutSeq(t), c = chain(t);
  const w = walk(l, c, { ...t, status: 'failed' }).map((x) => (x.s.kind === 'row' ? `${l.rows[x.s.i].ex.id}${l.rows[x.s.i].reply ? '<' : ''}` : x.s.kind));
  // the failing response and the failure share 1900 ms; the header shares 1100 ms with the upload it starts
  assert.deepEqual(w.slice(w.indexOf('fail') - 1, w.indexOf('fail') + 1), ['up<', 'fail']);
  assert.equal(w[w.indexOf('up') - 1], 'act');
});

test('a failure with no failing hop is 300 ms before its step ended, never before the step began', () => {
  const t = { ...trace(), status: 'failed' as const, failure: { step: 2, message: 'boom' } };
  assert.equal(failTime(layoutSeq(t), t), 8000 - 300);
  const short = { ...t, steps: [t.steps[0], { ...t.steps[1], t0: 7900 }] };
  assert.equal(failTime(layoutSeq(short), short), 7900);
  assert.equal(failTime(layoutSeq(t), { ...t, status: 'passed' }), null);
});

test('an address resolves a row by its exact short id before an id that only starts with it', () => {
  const uuid = '5e9e9366-e89c-4e8b-8f9e-c43475fa4e6d';
  // the stream's row is `5e9e9366`; its events (`<uuid>.1`) are `5e9e9366.1`, which also start with `5e9e9366`
  const t = { ...trace(), exchanges: [ex(`${uuid}.1`, 'api-gateway', 'notification-service', 100, undefined, { kind: 'sse', label: 'evento x', res: { bytes: 2, text: '{}' } }), ex(uuid, 'frontend', 'api-gateway', 200, 300)] };
  const l = layoutSeq(t), c = chain(t);
  const s = stopOf('5e9e9366', l, c, false);
  assert.equal(s?.kind === 'row' && l.rows[s.i].ex.id, uuid);
});

test('a hop as a route, sender first: the FILE_CLEAN notice runs down from notification-service to the browser', () => {
  const name = (id: string) => limpio.participants.find((p) => p.id === id)?.name ?? id;
  const notice = limpio.exchanges.filter((e) => e.kind === 'sse' && e.label === 'evento FILE_CLEAN').sort((a, b) => a.t0 - b.t0 || (a.from === 'api-gateway' ? -1 : 1));
  assert.deepEqual(notice.map((e) => route(e, name)), ['notification-service ⇢ api-gateway', 'api-gateway ⇢ frontend', 'frontend ⇢ Navegador']);
  assert.equal(route(limpio.exchanges.find((e) => e.from === 'browser' && e.label === 'POST /api/files/upload')!, name), 'Navegador → frontend');
  assert.equal(route(limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9')!, name), 'file-service ⇢ kafka');
});

test('every stop of 42 «limpio» has an address that leads back to it', () => {
  const l = layoutSeq(limpio), c = chain(limpio);
  const all = walk(l, c, limpio, () => true);
  for (const { s } of all) {
    const id = stopId(s, l);
    assert.ok(sameStop(stopOf(id, l, c, true), s), id);
  }
  assert.equal(stopId({ kind: 'act', act: c.acts.find((a) => a.id === 'preparacion')! }, l), 'preparacion');
  assert.match(stopId({ kind: 'row', i: l.rows.findIndex((r) => r.reply) }, l), /\/respuesta$/);
  assert.equal(stopOf('fallo', l, c, false), undefined, 'a test that did not fail has no «fallo»');
  assert.equal(stopOf('accion-nada', l, c, true), undefined);
});

test('a hop’s logs are its actor’s within its own span: the consumer’s lines a few ms later stay out', () => {
  const at = (t: number, service: string, line: string): LogLine => ({ id: String(t), t, service, level: 'INFO', line });
  const logs = [at(1680, 'file-service', 'antes'), at(1698, 'file-service', '[cat-handler-501] upload'), at(1701, 'file-service', '[cat-handler-501] stored'), at(1699, 'api-gateway', 'Forwarding POST'),
    at(1721, 'file-service', '[kafka-1] consumer'), at(1729, 'file-service', '[kafka-1] moved')];
  const fwd = ex('fwd', 'api-gateway', 'file-service', 1689, 1701, { method: 'POST' });
  assert.deepEqual(hopLogs(fwd, logs).map((x) => x.line), ['[cat-handler-501] upload', '[cat-handler-501] stored', 'Forwarding POST']);
  // an instant row: ±10 ms; a consume row: the consumer’s
  assert.deepEqual(hopLogs(ex('del', 'file-service', 'minio', 1728, 1728), logs).map((x) => x.line), ['[kafka-1] consumer', '[kafka-1] moved']);
  assert.deepEqual(hopLogs(ex('kafka:file.clean:0:1>file-service', 'kafka', 'file-service', 1715, undefined, { kind: 'kafka', origin: 'derived' }), logs).map((x) => x.line), ['[kafka-1] consumer']);
  assert.equal(hopLogs(fwd, [...logs, ...logs, ...logs]).length, 5, 'at most five');
});
