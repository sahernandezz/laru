import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { causes, chain, type Cause } from '../src/chain.ts';
import { shortId, summarize } from '../src/summarize.ts';
import { isBrowser, type Action, type Exchange, type RunInfo, type Trace } from '../src/trace.ts';

// Trimmed, already-masked copies of vaultflow runs: 42 and 44 (stories and cases), a window of 42's papelera, 31
// (latency), 32 (abortado), 4 (ECONNREFUSED; story and cases). They link exactly as the full traces do.
type T = Pick<Trace, 'test' | 'steps' | 'exchanges' | 'failure'> & { actions?: Action[] };
const load = (f: string): T[] => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FILES = ['limpio-42.json', 'infectado-44.json', 'papelera-42-window.json', 'limpio-31.json', 'limpio-32.json', 'registro-4.json'];
const [limpio, pendiente, sinSesion] = load('limpio-42.json');
const [infectado] = load('infectado-44.json');
const [papelera] = load('papelera-42-window.json');

/** An exchange by when it started, who sent it to whom and how its label begins (its SQL too, for statements). */
const at = (t: T, t0: number, from: string, to: string, label = '', sql = ''): Exchange => {
  const x = t.exchanges.filter((e) => e.t0 === t0 && e.from === from && e.to === to && e.label.startsWith(label) && (e.req?.text ?? '').includes(sql));
  assert.equal(x.length, 1, `${t0} ${from}→${to} ${label} ${sql}: ${x.length} matches`);
  return x[0];
};
const link = (c: Map<string, Cause>, e: Exchange) => c.get(e.id);
const parentIs = (c: Map<string, Cause>, e: Exchange, p: Exchange, how: string, certainty: string, by?: string) => {
  const l = link(c, e);
  assert.deepEqual([l?.parent, l?.how, l?.certainty, l?.why?.by], [p.id, how, certainty, by], `${e.t0} ${e.label}`);
};
const count = (c: Map<string, Cause>) => [...c.values()].reduce((m, l) => ({ ...m, [l.certainty]: (m[l.certainty] ?? 0) + 1 }), {} as Record<string, number>);

test('forward: the trio\'s hops sit under the browser request with the same path, sure', () => {
  const c = causes(limpio.exchanges);
  for (const path of ['/api/files/stats', '/api/files', '/api/files/folders']) {
    const browser = limpio.exchanges.find((e) => e.from === 'browser' && e.path === path && e.t0 < 1200)!;
    const front = limpio.exchanges.find((e) => e.from === 'frontend' && e.path === path && e.t0 < 1200)!;
    const gw = limpio.exchanges.find((e) => e.from === 'api-gateway' && e.to === 'file-service' && e.path === path && e.t0 < 1200)!;
    parentIs(c, front, browser, 'forward', 'sure');
    parentIs(c, gw, front, 'forward', 'sure');
  }
});

test('relay and stream: FILE_CLEAN climbs to the consume; a greeting hangs from its stream, even an unclosed one', () => {
  const c = causes(limpio.exchanges);
  const browser = at(limpio, 1722, 'browser', 'frontend', 'evento FILE_CLEAN');
  const front = at(limpio, 1721, 'frontend', 'api-gateway', 'evento FILE_CLEAN');
  const emit = at(limpio, 1721, 'api-gateway', 'notification-service', 'evento FILE_CLEAN');
  const consume = limpio.exchanges.find((e) => e.id.endsWith('>notification-service'))!;
  parentIs(c, browser, front, 'relay', 'sure');
  parentIs(c, front, emit, 'relay', 'sure');
  parentIs(c, emit, consume, 'consume', 'inferred');
  parentIs(c, at(limpio, 1136, 'api-gateway', 'notification-service', 'evento connected'), at(limpio, 1132, 'frontend', 'api-gateway', 'GET /api/notifications/stream'), 'stream', 'inferred');
  // R3: when the gateway→notification stream row exists, FILE_CLEAN still goes to the consume, never under the stream
  const stream: Exchange = { id: emit.id.replace(/\.\d+$/, ''), kind: 'http', from: 'api-gateway', to: 'notification-service', t0: 1133, t1: 7930, label: 'GET /api/notifications/stream', method: 'GET', path: '/api/notifications/stream', status: 200, ok: true, origin: 'observed', resHeaders: { 'content-type': 'text/event-stream' } };
  const c2 = causes([...limpio.exchanges, stream]);
  parentIs(c2, emit, consume, 'consume', 'inferred');
  parentIs(c2, at(limpio, 1136, 'api-gateway', 'notification-service', 'evento connected'), stream, 'stream', 'sure');
});

test('relay: two notices of the same kind a moment apart, each relayed hop hangs from the one with its own data', () => {
  const ev = (id: string, from: string, to: string, t0: number, file: string): Exchange => ({ id, kind: 'sse', from, to, t0, label: 'evento FILE_CLEAN', ok: true, origin: 'observed', res: { bytes: 20, text: `{"fileName":"${file}"}` } });
  const c = causes([ev('a', 'api-gateway', 'notification-service', 100, 'a.pdf'), ev('b', 'api-gateway', 'notification-service', 110, 'b.pdf'), ev('b2', 'frontend', 'api-gateway', 112, 'b.pdf')]);
  assert.deepEqual(c.get('b2'), { parent: 'b', how: 'relay', certainty: 'sure' });
});

test('message and consume: a publish inside the upload, its delivery sure, the consumer\'s work inside the delivery', () => {
  const c = causes(limpio.exchanges);
  const upload = at(limpio, 1689, 'api-gateway', 'file-service', 'POST /api/files/upload');
  const pub = limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9')!;
  const consume = limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9>antivirus-service')!;
  parentIs(c, pub, upload, 'inside', 'inferred');
  parentIs(c, consume, pub, 'message', 'sure');
  for (const e of [at(limpio, 1706, 'antivirus-service', 'minio'), at(limpio, 1708, 'antivirus-service', 'clamav'), at(limpio, 1718, 'antivirus-service', 'kafka')]) parentIs(c, e, consume, 'consume', 'inferred');
});

test('tiers on 42 «limpio»: shape and id settle what the logs say; the SPA trio stays possible with the truth among its candidates', () => {
  const c = causes(limpio.exchanges);
  const files = at(limpio, 1726, 'api-gateway', 'file-service', 'GET /api/files');
  const clean = limpio.exchanges.find((e) => e.id === 'kafka:file.clean:1:8>file-service')!;
  const lone = at(limpio, 1708, 'file-service', 'postgres');
  parentIs(c, at(limpio, 1727, 'file-service', 'postgres'), files, 'inside', 'inferred', 'shape');
  assert.equal((link(c, at(limpio, 1727, 'file-service', 'postgres'))?.why as { like: string }).like, lone.id, 'the same statement GET /api/files ran alone');
  parentIs(c, at(limpio, 1728, 'file-service', 'minio', 'DELETE'), clean, 'consume', 'inferred', 'id');
  assert.deepEqual(link(c, at(limpio, 1728, 'file-service', 'minio', 'DELETE'))?.why, { by: 'id', id: '40fddd0c-1ec8-44e6-b2e4-e66b8f9e777a' });
  parentIs(c, at(limpio, 1730, 'file-service', 'postgres'), clean, 'consume', 'inferred', 'shape');
  parentIs(c, at(limpio, 1731, 'file-service', 'postgres', 'UPDATE'), clean, 'consume', 'inferred', 'id');
  // its parameters carry the storedName 40fd…_informe.pdf before the row's id: the reason names the fileId
  assert.deepEqual(link(c, at(limpio, 1731, 'file-service', 'postgres', 'UPDATE'))?.why, { by: 'id', id: '04a75e1f-0843-4735-9339-e8e9b85bc773' });
  const trio = Object.fromEntries(['/api/files', '/api/files/folders', '/api/files/stats'].map((p) => [p, limpio.exchanges.find((e) => e.t0 === 1125 && e.path === p)!.id]));
  parentIs(c, at(limpio, 1126, 'file-service', 'postgres', '', 'fm1_0.bucket'), limpio.exchanges.find((e) => e.id === trio['/api/files'])!, 'inside', 'inferred', 'shape');
  for (const [e, truth] of [[at(limpio, 1126, 'file-service', 'postgres', '', 'count('), '/api/files/stats'], [at(limpio, 1127, 'file-service', 'postgres'), '/api/files/folders'], [at(limpio, 1128, 'file-service', 'postgres'), '/api/files/stats']] as const) {
    const l = link(c, e)!;
    assert.equal(l.certainty, 'possible');
    assert.deepEqual(new Set([l.parent, ...l.alt!]), new Set(Object.values(trio)));
    assert.ok([l.parent, ...l.alt!].includes(trio[truth]));
  }
  assert.deepEqual(count(c), { sure: 28, inferred: 29, possible: 3 }, 'chain3.py\'s counts');
});

test('chain order: a possible link\'s parent is the latest started, then the one ending first, then the id; alt keeps that order', () => {
  const order = (t: T) => { const c = causes(t.exchanges), by = new Map(t.exchanges.map((e) => [e.id, e])); return [...c.values()].filter((l) => l.certainty === 'possible').map((l) => [l.parent, ...l.alt!].map((id) => `${by.get(id)!.path}@${by.get(id)!.t0}`).join(' ')); };
  const trio = (...xs: string[]) => xs.join(' ');
  // 42 «limpio»: all three start at 1125; files and folders end at 1128 (by id), stats at 1129
  assert.deepEqual(new Set(order(limpio)), new Set([trio('/api/files@1125', '/api/files/folders@1125', '/api/files/stats@1125')]));
  // 44 «infectado»: at 1540 stats and files tie on start and end (by id), folders started a millisecond earlier; at 9116–9119 the latest first
  assert.deepEqual(new Set(order(infectado)), new Set([trio('/api/files/stats@1540', '/api/files@1540', '/api/files/folders@1539'), trio('/api/files/folders@9119', '/api/files@9117', '/api/files/stats@9116')]));
  assert.equal(order(infectado).length, 6);
});

test('the write tier: a write leaves the reads among its candidates, as long as another one remains', () => {
  const req = (id: string, method: string, path: string): Exchange => ({ id, kind: 'http', from: 'api-gateway', to: 'file-service', t0: 1000, t1: 1010, label: `${method} ${path}`, method, path, status: 200, ok: true, origin: 'observed' });
  const sql = (id: string, label: string, text: string): Exchange => ({ id, kind: 'sql', from: 'file-service', to: 'postgres', t0: 1005, t1: 1005, label, ok: true, origin: 'observed', req: { bytes: text.length, text } });
  const ins = sql('ins', 'INSERT file_service.files', 'insert into file_service.files (id) values ($1)'), sel = sql('sel', 'SELECT file_service.files', 'select f from file_service.files');
  const c = causes([req('get', 'GET', '/api/files'), req('post', 'POST', '/api/files/upload'), ins, sel]);
  assert.deepEqual(c.get('ins'), { parent: 'post', how: 'inside', certainty: 'inferred', why: { by: 'write' } });
  assert.deepEqual(c.get('sel'), { parent: 'get', how: 'inside', certainty: 'possible', alt: ['post'] }, 'a read says nothing');
  assert.equal(causes([req('get', 'GET', '/api/files'), req('get2', 'GET', '/api/files/stats'), ins]).get('ins')?.certainty, 'possible', 'only reads: nothing left to keep');
});

test('the papelera window: the second upload keeps its writes, the first file\'s consumer keeps its work, a later consume takes over', () => {
  const c = causes(papelera.exchanges);
  const upload = at(papelera, 561, 'api-gateway', 'file-service', 'POST /api/files/upload');
  const clean = papelera.exchanges.find((e) => e.id === 'kafka:file.clean:2:1>file-service')!;
  const uploaded = papelera.exchanges.find((e) => e.id === 'kafka:file.uploaded:2:3>antivirus-service')!;
  for (const e of [at(papelera, 563, 'file-service', 'minio'), at(papelera, 567, 'file-service', 'postgres', 'INSERT'), at(papelera, 570, 'file-service', 'kafka')]) assert.equal(link(c, e)?.parent, upload.id, `${e.t0} ${e.label}`);
  for (const e of [at(papelera, 567, 'file-service', 'postgres', 'SELECT'), at(papelera, 569, 'file-service', 'minio'), at(papelera, 574, 'file-service', 'minio'), ...papelera.exchanges.filter((e) => e.t0 === 578 && e.kind === 'sql'), at(papelera, 579, 'file-service', 'postgres')])
    assert.equal(link(c, e)?.parent, clean.id, `${e.t0} ${e.label}`);
  assert.equal(link(c, at(papelera, 574, 'antivirus-service', 'minio'))?.parent, uploaded.id, 'the next consume took over');
});

test('conn (synthetic pids): exclusion settles only when every other candidate holds another connection, and never says sure', () => {
  const req = (id: string, path: string): Exchange => ({ id, kind: 'http', from: 'api-gateway', to: 'file-service', t0: 1000, t1: 1010, label: `GET ${path}`, method: 'GET', path, status: 200, ok: true, origin: 'observed' });
  const sql = (id: string, t0: number, text: string, conn: string): Exchange => ({ id, kind: 'sql', from: 'file-service', to: 'postgres', t0, t1: t0, label: 'SELECT file_service.files', ok: true, origin: 'observed', req: { bytes: text.length, text }, conn });
  const LIST = 'select f from files where owner_id=$1', FOLDERS = 'select f from folders where owner_id=$1';
  const lone = (id: string, path: string, t0: number, text: string): Exchange[] => [{ ...req(id, path), t0, t1: t0 + 5 }, sql(`${id}-q`, t0 + 1, text, 'postgres#9')];
  const trio = [req('files', '/api/files'), req('folders', '/api/files/folders'), req('stats', '/api/files/stats'),
    sql('list', 1001, LIST, 'postgres#1'), sql('fold', 1002, FOLDERS, 'postgres#2'), sql('count', 1003, 'select count(f)', 'postgres#3'), sql('sum', 1004, 'select sum(f)', 'postgres#3')];
  const ex = [...lone('l1', '/api/files', 100, LIST), ...trio];
  // Only the list is anchored: nobody holds #3, and two candidates hold no other connection.
  const one = causes(ex, { conn: true });
  assert.equal(one.get('list')?.why?.by, 'shape');
  assert.deepEqual(['count', 'sum'].map((id) => one.get(id)?.certainty), ['possible', 'possible']);
  // The folders' statement anchored on #2 too: count and sum go to stats, inferred by connection.
  const two = causes([...ex, ...lone('l2', '/api/files/folders', 200, FOLDERS)], { conn: true });
  assert.equal(two.get('fold')?.parent, 'folders');
  assert.deepEqual(['count', 'sum'].map((id) => [two.get(id)?.parent, two.get(id)?.certainty, two.get(id)?.why?.by]), [['stats', 'inferred', 'conn'], ['stats', 'inferred', 'conn']]);
  assert.ok(![...two.values()].some((l) => l.why?.by === 'conn' && l.certainty === 'sure'));
  assert.deepEqual(['count', 'sum'].map((id) => causes([...ex, ...lone('l2', '/api/files/folders', 200, FOLDERS)]).get(id)?.certainty), ['possible', 'possible'], 'off by default');
});

test('reaction: the browser\'s list right after the notice hangs from it, unless the person acted in between', () => {
  const ev = at(limpio, 1722, 'browser', 'frontend', 'evento FILE_CLEAN'), list = at(limpio, 1724, 'browser', 'frontend', 'GET /api/files');
  parentIs(causes(limpio.exchanges), list, ev, 'reaction', 'inferred');
  assert.equal(causes(limpio.exchanges, { actions: [{ t0: 1723, t1: 1723, kind: 'click', target: "getByText('x')" }] }).get(list.id), undefined);
  // two notices before it: the later one
  const notice = (id: string, t0: number): Exchange => ({ id, kind: 'sse', from: 'browser', to: 'frontend', t0, label: 'evento FILE_CLEAN', ok: true, origin: 'observed', res: { bytes: 12, text: `{"id":"${id}"}` } });
  const get: Exchange = { id: 'list', kind: 'http', from: 'browser', to: 'frontend', t0: 180, t1: 190, label: 'GET /api/files', method: 'GET', path: '/api/files', status: 200, ok: true, origin: 'observed' };
  assert.deepEqual(causes([notice('a', 100), notice('b', 150), get]).get('list'), { parent: 'b', how: 'reaction', certainty: 'inferred' });
});

test('screens: a notice reaches one screen, and only that screen\'s next request reacts to it', () => {
  const notice = (from: string): Exchange => ({ id: `n-${from}`, kind: 'sse', from, to: 'frontend', t0: 100, label: 'evento FILE_CLEAN', ok: true, origin: 'observed', res: { bytes: 12, text: '{"id":"a"}' } });
  const get = (from: string): Exchange => ({ id: `get-${from}`, kind: 'http', from, to: 'frontend', t0: 140, t1: 150, label: 'GET /api/files', method: 'GET', path: '/api/files', status: 200, ok: true, origin: 'observed' });
  const c = causes([notice('browser'), get('browser'), get('browser:luis')]);
  assert.deepEqual(c.get('get-browser'), { parent: 'n-browser', how: 'reaction', certainty: 'inferred' }, 'Ana\'s page asks after Ana\'s notice');
  assert.equal(c.get('get-browser:luis'), undefined, 'Luis\'s does not hang from a notice that was Ana\'s');
  // and each screen's own notice is its own
  const both = causes([notice('browser'), notice('browser:luis'), get('browser:luis')]);
  assert.equal(both.get('get-browser:luis')?.parent, 'n-browser:luis');
  assert.deepEqual([isBrowser('browser'), isBrowser('browser:luis'), isBrowser('runner'), isBrowser('browserx')], [true, true, false, false]);
});

const kinds = (t: T, o = {}) => chain(t, o).acts.map((a) => `${a.kind}@${a.step ?? '-'}${a.n ? `×${a.n}` : ''}`);
test('acts without marks: bursts per step, assets and streams never stretch one; cases are one act per call', () => {
  assert.deepEqual(kinds(limpio), ['setup@-', 'burst@1', 'burst@1', 'burst@2', 'burst@3', 'check@3', 'burst@5', 'burst@5']);
  const l = chain(limpio);
  assert.equal(l.acts[3].roots.length, 2, 'the upload and the list after its 201');
  assert.equal(kinds(infectado).filter((k) => k === 'burst@1').length, 3, 'the stream does not swallow the upload 357 ms later');
  assert.ok(!FILES.flatMap(load).some((t) => chain(t).acts.some((a) => a.kind === 'page')), 'no page act without marks');
  assert.deepEqual(kinds(pendiente), ['check@-', 'check@-', 'check@-', 'check@-×2'], 'register, upload, the 403 download, two GETs of the file');
  assert.deepEqual(kinds(sinSesion), ['check@-']);
});

/** 42 «limpio» as the reporter would mark it (N2), from support/vaultflow.ts and the spec. */
const MARKS: Action[] = [
  { t0: 500, t1: 506, kind: 'navigate', path: '/login' },
  { t0: 990, t1: 1000, kind: 'fill', target: "getByPlaceholder('Ingresa tu usuario')" },
  { t0: 1005, t1: 1015, kind: 'fill', target: "getByPlaceholder('Ingresa tu contraseña')" },
  { t0: 1020, t1: 1031, kind: 'click', target: "getByRole('button', { name: 'Iniciar Sesión', exact: true })" },
  { t0: 1300, t1: 1320, kind: 'click', target: "getByRole('button', { name: 'Subir', exact: true })" },
  { t0: 1400, t1: 1420, kind: 'click', target: "getByText('explora', { exact: true })" },
  { t0: 1670, t1: 1686, kind: 'files', target: "locator('input[type=file]')" },
  { t0: 7100, t1: 7110, kind: 'click', target: "getByRole('button').filter({ has: locator('svg.lucide-bell') })" },
  { t0: 7180, t1: 7185, kind: 'click' },
  { t0: 7200, t1: 7450, kind: 'click', target: "getByRole('main').getByText('informe.pdf', { exact: true })" },
  { t0: 7460, t1: 7850, kind: 'click', target: "getByRole('button', { name: 'Descargar' }).first()" },
];
test('acts with marks: input folds into the next mark of its step, clicks that send nothing stay, the page asks on its own', () => {
  const marked = { ...limpio, actions: MARKS };
  const c = chain(marked);
  const person = c.acts.filter((a) => a.kind === 'person');
  const step = (n: number) => c.acts.filter((a) => a.step === n);
  assert.deepEqual(step(1).map((a) => a.marks.map((m) => m.kind).join('+')), ['navigate', 'fill+fill+click'], 'goto, fill, fill, click: 2 acts');
  assert.deepEqual(step(1).map((a) => a.roots.length), [2, 6]);
  assert.deepEqual(step(2).map((a) => [a.marks.map((m) => m.kind).join('+'), a.roots.length]), [['click', 0], ['click', 0], ['files', 2]], 'Subir, explora, the file: 3 acts');
  assert.equal(step(2)[0].id, 'm4', 'an act that sent nothing is named by its mark');
  assert.deepEqual(step(4).map((a) => [a.kind, a.roots.length]), [['person', 0], ['person', 0]], 'the bell and the click outside never fold into step 5');
  assert.equal(c.acts.find((a) => a.roots.includes(at(limpio, 6732, 'browser', 'frontend').id))?.kind, 'page');
  assert.ok(!c.acts.some((a) => a.roots.includes(at(limpio, 1724, 'browser', 'frontend').id)), 'the reaction stays under its notice');
  assert.ok(person.every((a) => a.marks.length));
  const browserRoots = limpio.exchanges.filter((e) => e.from === 'browser' && !c.cause.has(e.id));
  assert.ok(browserRoots.every((r) => c.acts.some((a) => (a.kind === 'person' || a.kind === 'page') && a.roots.includes(r.id))), 'every browser root belongs to a mark or the page');
});

test('input marks fold forward within their step only: a fill at the end of one step is its own act, not the next step\'s click', () => {
  const steps = [{ n: 1, title: 'a', t0: 0, t1: 1000, status: 'passed' as const }, { n: 2, title: 'b', t0: 1000, t1: 2000, status: 'passed' as const }];
  const actions: Action[] = [{ t0: 900, t1: 910, kind: 'fill', target: "getByLabel('Nombre')" }, { t0: 1100, t1: 1110, kind: 'click', target: "getByRole('button', { name: 'Guardar' })" }];
  assert.deepEqual(chain({ exchanges: [], steps, actions }).acts.map((a) => [a.step, a.marks.map((m) => m.kind).join('+')]), [[1, 'fill'], [2, 'click']]);
});

test('noise: assets, the stream open, its greetings; preflights and host rows', () => {
  const c = chain(limpio);
  const of = (n: string) => limpio.exchanges.filter((e) => c.noise.get(e.id) === n);
  assert.deepEqual(of('asset').map((e) => e.asset), [10, 5]);
  assert.deepEqual(of('stream').map((e) => `${e.from}→${e.to}`), ['browser→frontend', 'frontend→api-gateway']);
  assert.equal(of('hello').length, 3, 'one «connected» per hop of the stream chain');
  const extra: Exchange[] = [
    { id: 'pre', kind: 'http', from: 'frontend', to: 'api-gateway', t0: 6000, t1: 6001, label: 'OPTIONS /api/files', method: 'OPTIONS', path: '/api/files', status: 204, ok: true, origin: 'observed' },
    { id: 'h1', kind: 'http', from: 'host', to: 'frontend', t0: 6100, t1: 6101, label: 'GET /', method: 'GET', path: '/', status: 200, ok: true, origin: 'observed' },
    // an event with no data greets, whatever its name
    { id: 'blank', kind: 'sse', from: 'frontend', to: 'api-gateway', t0: 6200, label: 'evento message', ok: true, origin: 'observed', res: { bytes: 0 } },
  ];
  const d = chain({ ...limpio, exchanges: [...limpio.exchanges, ...extra] });
  assert.deepEqual([d.noise.get('pre'), d.noise.get('h1'), d.noise.get('blank')], ['preflight', 'foreign', 'hello']);
  assert.deepEqual(d.orphans.find((o) => o.id === 'h1')?.reason, 'host');
});

test('invariants on every fixture: one act or the orphans each, no cycles, nothing real under noise, order does not matter', () => {
  for (const t of FILES.flatMap(load)) {
    const c = chain(t);
    const orphan = new Set(c.orphans.map((o) => o.id));
    const roots = c.acts.flatMap((a) => a.roots);
    assert.equal(new Set(roots).size, roots.length, `${t.test}: a root in two acts`);
    for (const e of t.exchanges) {
      const seen = new Set<string>();
      let x = e.id, real = !c.noise.has(e.id);
      while (c.cause.has(x)) {
        assert.ok(!seen.has(x), `${t.test}: a cycle at ${x}`);
        seen.add(x);
        x = c.cause.get(x)!.parent;
        if (real) assert.ok(!c.noise.has(x), `${t.test}: ${e.label} under noise ${x}`);
      }
      assert.ok(c.actOf.has(e.id) !== orphan.has(x), `${t.test}: ${e.id} in exactly one of an act or the orphans`);
    }
    const shuffled = [...t.exchanges].reverse();
    if (shuffled.length) shuffled.push(shuffled.shift()!);
    assert.deepEqual([...causes(shuffled)].sort(), [...c.cause].sort(), `${t.test}: input order`);
  }
});

test('knobs: the burst gap changes the acts, never the causes', () => {
  const base = chain(limpio);
  for (const BURST_GAP_MS of [0, Infinity]) {
    const c = chain(limpio, { BURST_GAP_MS });
    assert.deepEqual([...c.cause], [...base.cause]);
    assert.notDeepEqual(c.acts.length, base.acts.length);
  }
});

test('ground truth: 42 «limpio» labelled by hand from the trace and the service-log threads', () => {
  const truth: Record<string, string | null> = JSON.parse(readFileSync(new URL('./fixtures/limpio-42.causes.json', import.meta.url), 'utf8'));
  const c = causes(limpio.exchanges);
  assert.equal(Object.keys(truth).length, 75);
  let possible = 0;
  for (const [id, parent] of Object.entries(truth)) {
    const l = c.get(id);
    if (l?.certainty === 'possible') { possible++; assert.ok([l.parent, ...l.alt!].includes(parent!), id); continue; }
    assert.equal(l?.parent ?? null, parent, id);
  }
  assert.ok(possible <= 3);
});

test('counts across the fixtures match chain3.py; on 42 and 44 nothing but the browser, the test or the host is a root', () => {
  const tot = { sure: 0, inferred: 0, possible: 0 } as Record<string, number>;
  for (const f of FILES.filter((x) => !x.startsWith('papelera'))) for (const t of load(f)) {
    const c = causes(t.exchanges);
    for (const l of c.values()) tot[l.certainty]++;
    if (/-4[24]\.json$/.test(f)) assert.deepEqual(t.exchanges.filter((e) => !c.has(e.id) && !['browser', 'runner', 'host'].includes(e.from)).map((e) => e.label), [], t.test);
  }
  assert.deepEqual(count(causes(infectado.exchanges)), { sure: 41, inferred: 36, possible: 6 });
  // chain3.py says 161 sure: in run 31 (latency +800 ms) the gateway's forwarded download outlives the frontend's call,
  // and only the forward rule's fallback (open when it started) keeps it under that call instead of leaving a root.
  // Run 4's cases add 4 sure and 1 inferred, as chain3.py counts them.
  assert.deepEqual(tot, { sure: 162, inferred: 157, possible: 15 });
});

test('the drill-down says how sure each link is: nothing when sure, the reason when inferred, the others when possible', () => {
  const run = { id: '42', env: 'local', ephemeral: false, flows: [], phase: 'done', status: 'failed', startedAt: '', pid: 1, results: {} } as RunInfo;
  const caused = (e: Exchange) => summarize(run, [{ ...limpio, flow: 'subir-fichero-limpio', logs: [] } as unknown as Trace], { exchange: e.id, budget: 4000 }).split('\n')[1];
  const c = causes(limpio.exchanges);
  const of = (e: Exchange) => c.get(e.id)!;
  assert.match(caused(at(limpio, 1727, 'file-service', 'postgres')), new RegExp(`\\(inferred: same statement as ${shortId(at(limpio, 1708, 'file-service', 'postgres').id)}\\)$`));
  assert.match(caused(at(limpio, 1728, 'file-service', 'minio', 'DELETE')), /\(inferred: only it carries 40fddd0c\)$/);
  assert.match(caused(limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9')!), /\(inferred: inside\)$/, 'one candidate: how it was linked');
  const trio = at(limpio, 1127, 'file-service', 'postgres');
  assert.ok(caused(trio).endsWith(`(possible; also ${of(trio).alt!.map(shortId).join(', ')})`), caused(trio));
  assert.doesNotMatch(caused(limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9>antivirus-service')!), /\((inferred|possible)/, 'a sure link says nothing more');
});

test('a stream whose forward failed stays unfolded, so the failure shows (run 32, abortado)', () => {
  const [t] = load('limpio-32.json');
  const c = chain(t);
  const bad = t.exchanges.filter((e) => e.fault === 'abortado');
  assert.ok(bad.length);
  for (const e of bad) for (let x = c.cause.get(e.id)?.parent; x; x = c.cause.get(x)?.parent) assert.ok(!c.noise.has(x), `${e.label} hides under ${x}`);
});

test('performance: 5,000 exchanges under 100 ms; the largest fixture under 10 ms', () => {
  const ex: Exchange[] = [];
  const svc = ['file-service', 'folder-service', 'share-service', 'report-service'];
  for (let i = 0; i < 1000; i++) {
    const t = i * 7, path = `/api/x/${i}`, to = svc[i % 4];
    const h = (id: string, from: string, dest: string, d: number): Exchange => ({ id: `${id}${i}`, kind: 'http', from, to: dest, t0: t + d, t1: t + 6 - d, label: `GET ${path}`, method: 'GET', path, status: 200, ok: true, origin: 'observed' });
    ex.push(h('b', 'browser', 'frontend', 0), h('f', 'frontend', 'api-gateway', 1), h('g', 'api-gateway', to, 2));
    for (const d of [3, 3]) ex.push({ id: `q${d}${i}${ex.length}`, kind: 'sql', from: to, to: 'postgres', t0: t + d, t1: t + d, label: 'SELECT t', ok: true, origin: 'observed', req: { bytes: 1, text: `select ${i % 3}` } });
  }
  // the best of three, so a busy machine does not fail it
  const best = (f: () => unknown) => Math.min(...[0, 1, 2].map(() => { const t0 = performance.now(); f(); return performance.now() - t0; }));
  const big = best(() => chain({ exchanges: ex, steps: [] })), fixture = best(() => chain(infectado));
  assert.ok(big < 100, `${Math.round(big)} ms`);
  assert.ok(fixture < 10, `${Math.round(fixture)} ms`);
});

test('callback: a message hangs from the request that sent it, and its status calls hang from the message however late they come; a mail sent after the answer has no cause to hang from', () => {
  const ex = (id: string, o: Partial<Exchange>): Exchange => ({ id, kind: 'http', from: 'api', to: 'x', t0: 0, label: id, ok: true, origin: 'observed', ...o });
  const all: Exchange[] = [
    ex('b', { from: 'browser', to: 'api', t0: 0, t1: 300, method: 'POST', path: '/api/verificar' }),
    ex('m', { from: 'api', to: 'smtp', kind: 'tcp', t0: 100, t1: 120, label: 'Tu pedido → ana@t.test', mock: 'sink', msg: { id: 'MAIL1', kind: 'mail', to: 'ana@t.test', subject: 'Tu pedido' } }),
    ex('s', { from: 'api', to: 'api.twilio.com', t0: 150, t1: 180, method: 'POST', path: '/2010-04-01/Accounts/AC/Messages.json', mock: 'sink', msg: { id: 'SM1', kind: 'sms', to: '+57300' } }),
    // the status calls arrive after the request has been answered (it closed at 300 ms): no open request to hang from
    ex('c1', { from: 'api.twilio.com', to: 'api', t0: 700, t1: 710, method: 'POST', path: '/webhooks/sms-estado', mock: 'callback', msg: { id: 'SM1', kind: 'sms', to: '+57300', cb: 'sent' } }),
    ex('c2', { from: 'api.twilio.com', to: 'api', t0: 1000, t1: 1010, method: 'POST', path: '/webhooks/sms-estado', mock: 'callback', msg: { id: 'SM1', kind: 'sms', to: '+57300', cb: 'delivered' } }),
    // a mail sent after the answer, on a timer: nothing was open and nothing was consumed
    ex('late', { from: 'api', to: 'smtp', kind: 'tcp', t0: 900, t1: 920, label: 'Tardío → ana@t.test', mock: 'sink', msg: { id: 'MAIL2', kind: 'mail', to: 'ana@t.test', subject: 'Tardío' } }),
  ];
  const c = causes(all);
  assert.deepEqual([c.get('m')?.parent, c.get('m')?.how], ['b', 'inside']);
  assert.deepEqual([c.get('s')?.parent, c.get('s')?.how], ['b', 'inside']);
  for (const id of ['c1', 'c2']) assert.deepEqual([c.get(id)?.parent, c.get(id)?.how, c.get(id)?.certainty], ['s', 'callback', 'sure'], id);
  assert.equal(c.get('late'), undefined, 'a late mail is a root of its own, which the screen says plainly');
});
