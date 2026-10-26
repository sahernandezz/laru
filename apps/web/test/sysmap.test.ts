/** A flow's map: how a trace folds into the system map's edges. Pure, so it is checked here instead of by eye. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Exchange, Participant, Trace } from '@laru/trace';
import type { Fact, MapNode, SystemMap } from '@laru/core';
import { archGraph, expectedGraph, flowGraph, homeOf, LABEL_H, layout, litBy, NODE_H, NODE_W, type MapEdge } from '../src/lib/sysmap.ts';

const nodes: MapNode[] = [
  { id: 'svc:frontend', type: 'service', name: 'frontend', kind: 'web' },
  { id: 'svc:api-gateway', type: 'service', name: 'api-gateway', kind: 'spring' },
  { id: 'svc:file-service', type: 'service', name: 'file-service', kind: 'spring' },
  { id: 'svc:antivirus-service', type: 'service', name: 'antivirus-service', kind: 'spring' },
  { id: 'svc:notification-service', type: 'service', name: 'notification-service', kind: 'spring' },
  { id: 'ds:postgres', type: 'datastore', name: 'postgres', kind: 'relational' },
  { id: 'ds:kafka', type: 'datastore', name: 'kafka', kind: 'queue' },
  { id: 'ep:file-service:GET /api/files', type: 'endpoint', name: 'GET /api/files', service: 'svc:file-service' },
  { id: 'topic:file.uploaded', type: 'topic', name: 'file.uploaded' },
];
// The code knows frontend → api-gateway → file-service, file-service using postgres and the upload event; not
// notification-service.
const facts: Fact[] = [
  { s: 'svc:file-service', p: 'publishes', o: 'topic:file.uploaded', origin: 'extracted' },
  { s: 'svc:antivirus-service', p: 'consumes', o: 'topic:file.uploaded', origin: 'extracted' },
  { s: 'svc:frontend', p: 'calls', o: 'svc:api-gateway', origin: 'extracted' },
  { s: 'svc:api-gateway', p: 'forwards-to', o: 'ep:file-service:GET /api/files', origin: 'extracted' },
  { s: 'svc:file-service', p: 'uses', o: 'ds:postgres', origin: 'extracted' },
];
const map: SystemMap = { version: 1, app: 'vaultflow', builtAt: '', repos: [], nodes, facts };
const g = {
  map, nodes: new Map(nodes.map((n) => [n.id, n])),
  out: (id: string) => facts.filter((f) => f.s === id), in: (id: string) => facts.filter((f) => f.o === id),
};
const P: Participant[] = [
  { id: 'browser', name: 'Navegador', type: 'browser' },
  { id: 'runner', name: 'Prueba', type: 'runner' },
  ...nodes.filter((n) => n.type !== 'endpoint').map((n): Participant => ({ id: n.name, name: n.name, type: n.type === 'datastore' ? 'datastore' : 'service', node: n.id })),
];
let t = 0;
const ex = (id: string, from: string, to: string, more: Partial<Exchange> = {}): Exchange => ({ id, kind: 'http', from, to, t0: t++, t1: t, label: id, ok: true, origin: 'observed', ...more });
const exchanges: Exchange[] = [
  ex('page', 'browser', 'frontend', { step: 1 }),
  ex('login', 'frontend', 'api-gateway', { step: 3, status: 400, ok: false }),
  ex('stream', 'frontend', 'api-gateway', { kind: 'sse', step: 1 }),
  ex('list', 'api-gateway', 'file-service', { step: 1 }),
  ex('q1', 'file-service', 'postgres', { kind: 'sql', table: 'file_service.files', step: 1 }),
  ex('q2', 'file-service', 'postgres', { kind: 'sql', table: 'file_service.folders', step: 1 }),
  ex('pub', 'file-service', 'kafka', { kind: 'kafka', topic: 'file.uploaded', origin: 'derived', step: 2 }),
  ex('sub', 'kafka', 'antivirus-service', { kind: 'kafka', topic: 'file.uploaded', origin: 'derived', step: 2 }),
  ex('role', 'runner', 'api-gateway', { step: 4, status: 400, ok: false }),
  ex('notify', 'api-gateway', 'notification-service', { kind: 'sse', step: 1 }),
];
const fg = flowGraph(g, { participants: P, exchanges, failure: { step: 4, message: 'boom', exchange: 'role' } });
const edge = (id: string) => fg.edges.find((e) => e.id === id)!;

test('a Kafka publish and its consume are one event edge, labelled with the topic', () => {
  const e = edge('event|svc:file-service|svc:antivirus-service');
  assert.deepEqual([e.label, e.ex], ['file.uploaded', ['pub', 'sub']]);
  // the broker in between is not drawn when every message it carried is paired
  assert.equal(fg.edges.some((x) => x.from === 'ds:kafka' || x.to === 'ds:kafka'), false);
});

test('SQL makes a store edge with its tables; a stream counts on the call that opened it', () => {
  const s = edge('store|svc:file-service|ds:postgres');
  assert.deepEqual([s.n, s.tables, s.label], [2, ['file_service.files', 'file_service.folders'], '2 SQL · files, folders']);
  const c = edge('call|svc:frontend|svc:api-gateway');
  assert.deepEqual([c.n, c.sse], [1, 1]);
  assert.match(c.label, /^1 · \+1 SSE/);
});

test('the test calling the gateway is an edge from the «Prueba» actor', () => {
  const e = edge('call|actor:runner|svc:api-gateway');
  assert.equal(fg.sub.nodes.get('actor:runner')?.name, 'Prueba');
  assert.equal(fg.sub.nodes.get('actor:runner')?.kind, 'actor');
  assert.equal(e.label, '1 · 1 falló');
});

test('only the failing hop, or a non-ok exchange of the failed step, is bad; an expected 400 elsewhere is an error', () => {
  assert.deepEqual(fg.edges.filter((e) => e.bad).map((e) => e.id), ['call|actor:runner|svc:api-gateway']);
  const login = edge('call|svc:frontend|svc:api-gateway');
  assert.deepEqual([login.errors, login.bad], [1, false]);
  assert.match(login.label, /1 con error$/);
});

test('an edge with the failing hop and an expected error elsewhere says each apart', () => {
  const x = flowGraph(g, { participants: P, exchanges: [
    ex('expected400', 'runner', 'api-gateway', { step: 2, status: 400, ok: false }),
    ex('fine', 'runner', 'api-gateway', { step: 3 }),
    ex('hop', 'runner', 'api-gateway', { step: 4, status: 400, ok: false }),
  ], failure: { step: 4, message: 'boom', exchange: 'hop' } }).edges[0];
  assert.deepEqual([x.label, x.failed, x.errors, x.bad], ['3 · 1 falló · 1 con error', 1, 1, true]);
});

test('a Kafka consume whose publisher was not seen stays on the broker', () => {
  const x = flowGraph(g, { participants: P, exchanges: [ex('sub', 'kafka', 'notification-service', { kind: 'kafka', topic: 'file.clean', origin: 'derived', step: 1 })] });
  assert.deepEqual(x.edges.map((e) => e.id), ['event|ds:kafka|svc:notification-service']);
  assert.match(x.edges[0].label, /^file\.clean/);
});

test('an edge the code does not have says so; edges from actors are never «not in the code»', () => {
  const n = edge('call|svc:api-gateway|svc:notification-service');
  assert.equal(n.inMap, false);
  assert.match(n.label, /^1 SSE · no está en el código$/);
  assert.equal(edge('call|svc:api-gateway|svc:file-service').inMap, true);
  assert.equal(edge('call|actor:browser|svc:frontend').inMap, true);
});

test('a flow that never ran expects what it needs and its steps’ services, with the code’s edges among them', () => {
  const x = expectedGraph(g, { needs: ['svc:frontend', 'ds:postgres', 'svc:nope'], steps: [{ step: 'Entrar', actor: 'Usuario', service: 'svc:api-gateway', expected: 'Entra' }, { step: 'Mirar', actor: 'Usuario', expected: 'Ve' }] });
  assert.deepEqual([...x.sub.nodes.keys()].sort(), ['ds:postgres', 'svc:api-gateway', 'svc:frontend']);
  assert.deepEqual(x.edges.map((e) => e.id), ['call|svc:frontend|svc:api-gateway']);
});

test('a non-ok exchange of the failed step is bad too, even when it is not the one the test failed on', () => {
  const x = flowGraph(g, { participants: P, exchanges: [
    ex('hop', 'runner', 'api-gateway', { step: 4, status: 400, ok: false }),
    ex('behind', 'api-gateway', 'file-service', { step: 4, status: 500, ok: false }),
    ex('earlier', 'api-gateway', 'file-service', { step: 2, status: 404, ok: false }),
  ], failure: { step: 4, message: 'boom', exchange: 'hop' } });
  const e = x.edges.find((y) => y.id === 'call|svc:api-gateway|svc:file-service')!;
  assert.deepEqual([e.bad, e.failed, e.errors, e.label], [true, 1, 1, '2 · 1 falló · 1 con error']);
});

/** A map index over a few nodes and facts, as the core builds it. */
const index = (ns: MapNode[], fs: Fact[]) => ({ map: { ...map, nodes: ns, facts: fs }, nodes: new Map(ns.map((n) => [n.id, n])), out: (id: string) => fs.filter((f) => f.s === id), in: (id: string) => fs.filter((f) => f.o === id) });

test('a table is shown by the store that contains it, not by whoever else points at it; an endpoint by its service', () => {
  const x = index([...nodes, { id: 'tbl:file_service.files', type: 'table', name: 'file_service.files' }], [
    // the service mapping the table comes first: it must not win
    { s: 'svc:file-service', p: 'maps-table', o: 'tbl:file_service.files', origin: 'extracted' },
    { s: 'ds:postgres', p: 'contains', o: 'tbl:file_service.files', origin: 'extracted' },
  ]);
  assert.equal(homeOf(x, 'tbl:file_service.files'), 'ds:postgres');
  assert.equal(homeOf(x, 'ep:file-service:GET /api/files'), 'svc:file-service');
  assert.equal(homeOf(x, 'svc:frontend'), 'svc:frontend');
});

test('a store that only sends (a broker whose publisher was not seen) is placed, with its edge', () => {
  const x = flowGraph(g, { participants: P, exchanges: [ex('sub', 'kafka', 'notification-service', { kind: 'kafka', topic: 'file.clean', origin: 'derived', step: 1 })] });
  const lay = layout(x.sub, x.edges);
  assert.deepEqual(lay.nodes.map((n) => n.node.id).sort(), ['ds:kafka', 'svc:notification-service']);
  assert.deepEqual(lay.edges.map((e) => e.id), ['event|ds:kafka|svc:notification-service']);
});

// vaultflow's pieces and the facts the code gives between them: what the full map of a flow's page draws.
const VF_SERVICES = ['frontend', 'api-gateway', 'file-service', 'antivirus-service', 'notification-service', 'batch-service'];
const VF_STORES: Array<[string, MapNode['type'], string]> = [['ds:postgres', 'datastore', 'relational'], ['ds:kafka', 'datastore', 'queue'], ['ds:minio', 'datastore', 'file'], ['ext:clamav', 'external', 'tcp']];
const VF_USES: Array<[string, string]> = [['api-gateway', 'ds:postgres'], ['file-service', 'ds:postgres'], ['file-service', 'ds:kafka'], ['file-service', 'ds:minio'], ['batch-service', 'ds:postgres'], ['batch-service', 'ds:kafka'], ['batch-service', 'ds:minio'],
  ['antivirus-service', 'ds:kafka'], ['antivirus-service', 'ext:clamav'], ['antivirus-service', 'ds:minio'], ['notification-service', 'ds:kafka'], ['antivirus-service', 'ds:postgres']];
const vfNodes: MapNode[] = [
  ...VF_SERVICES.map((n): MapNode => ({ id: `svc:${n}`, type: 'service', name: n, kind: 'spring' })),
  ...VF_STORES.map(([id, type, kind]): MapNode => ({ id, type, name: id.slice(id.indexOf(':') + 1), kind })),
  ...['file.uploaded', 'file.clean', 'file.infected'].map((n): MapNode => ({ id: `topic:${n}`, type: 'topic', name: n })),
];
const vfFacts: Fact[] = [
  ...VF_USES.map(([a, b]): Fact => ({ s: `svc:${a}`, p: 'uses', o: b, origin: 'extracted' })),
  ...[['frontend', 'api-gateway'], ['api-gateway', 'file-service'], ['api-gateway', 'batch-service'], ['api-gateway', 'antivirus-service'], ['api-gateway', 'notification-service']].map(([a, b]): Fact => ({ s: `svc:${a}`, p: 'calls', o: `svc:${b}`, origin: 'extracted' })),
  ...[['file-service', 'file.uploaded'], ['antivirus-service', 'file.clean'], ['antivirus-service', 'file.infected']].map(([a, t]): Fact => ({ s: `svc:${a}`, p: 'publishes', o: `topic:${t}`, origin: 'extracted' })),
  ...[['antivirus-service', 'file.uploaded'], ['file-service', 'file.clean'], ['file-service', 'file.infected'], ['notification-service', 'file.clean'], ['notification-service', 'file.infected']].map(([a, t]): Fact => ({ s: `svc:${a}`, p: 'consumes', o: `topic:${t}`, origin: 'extracted' })),
];
const vf = { map: { version: 1, app: 'vaultflow', builtAt: '', repos: [], nodes: vfNodes, facts: vfFacts } as SystemMap, nodes: new Map(vfNodes.map((n) => [n.id, n])), out: (id: string) => vfFacts.filter((f) => f.s === id), in: (id: string) => vfFacts.filter((f) => f.o === id) };
const fixture = (f: string): Trace[] => JSON.parse(readFileSync(new URL(`../../../packages/trace/test/fixtures/${f}`, import.meta.url), 'utf8'));
const PAGES: Array<[string, Trace[]]> = [['42 subir-fichero-limpio', fixture('limpio-42.json')], ['44 subir-fichero-infectado', fixture('infectado-44.json')]];

test('the full map of a flow’s page has every piece for the story and each case; batch-service is never used by the uploads', () => {
  for (const [name, tests] of PAGES) {
    const a = archGraph(vf, tests);
    assert.equal(a.pieces.length, 10, name);
    for (const id of a.pieces.map((p) => p.id)) assert.ok(a.sub.nodes.has(id), `${name}: ${id} is on the map`);
    assert.deepEqual([...a.sub.nodes.keys()].filter((id) => id.startsWith('actor:')).sort(), ['actor:browser', 'actor:runner'], name);
    assert.equal(a.lits.length, tests.length);
    for (const l of a.lits) assert.ok(!l.nodes.has('svc:batch-service'), `${name}: batch-service untouched`);
    // the story goes through the other nine
    assert.equal(a.pieces.filter((p) => a.lits[0].nodes.has(p.id)).length, 9, name);
  }
});

test('«Subir sin sesión» lights only the test’s call to the gateway, red: it was refused there', () => {
  const [, , sinSesion] = fixture('limpio-42.json');
  const l = litBy(vf, sinSesion);
  assert.deepEqual([...l.edges.keys()], ['call|actor:runner|svc:api-gateway']);
  assert.equal(l.edges.get('call|actor:runner|svc:api-gateway')!.bad, true);
  assert.deepEqual([...l.nodes].filter((id) => !id.startsWith('actor:')), ['svc:api-gateway']);
});

test('a Kafka publish lights the code’s edge from its service to the broker; a delivery that caused nothing says so and lights no node', () => {
  const [limpio, pendiente] = fixture('limpio-42.json');
  const l = litBy(vf, limpio);
  assert.ok(l.edges.has('store|svc:file-service|ds:kafka'));
  assert.ok(l.edges.has('store|svc:antivirus-service|ds:kafka'));
  assert.ok(!l.edges.has('store|svc:batch-service|ds:kafka'));
  // «Descargar mientras está pendiente»: notification-service only receives file.clean, and does nothing visible with it
  const p = litBy(vf, pendiente);
  assert.deepEqual([...p.quiet], ['event|svc:antivirus-service|svc:notification-service']);
  assert.match(p.edges.get('event|svc:antivirus-service|svc:notification-service')!.label, /· sin efecto visible$/);
  assert.ok(!p.nodes.has('svc:notification-service'));
  assert.ok(!p.edges.has('store|svc:notification-service|ds:kafka'), 'nor the way to it');
});

test('laid out once, the page keeps every node in place from the story to its cases, and each test’s label fits the room kept for it', () => {
  for (const [name, tests] of PAGES) {
    const a = archGraph(vf, tests);
    const lay = layout(a.sub, a.edges, { keep: true });
    // the same tests in another order lay out the same nodes in the same place
    const b = archGraph(vf, [...tests].reverse());
    const lay2 = layout(b.sub, b.edges, { keep: true });
    assert.deepEqual(lay2.nodes.map((n) => [n.node.id, n.x, n.y]).sort(), lay.nodes.map((n) => [n.node.id, n.x, n.y]).sort(), name);
    const room = new Map(lay.edges.map((e) => [e.id, e.label.length]));
    for (const [i, l] of a.lits.entries()) for (const e of l.edges.values()) assert.ok(e.label.length <= (room.get(e.id) ?? -1), `${name} · ${tests[i].test}: «${e.label}» fits ${e.id}`);
  }
});

test('`keep` places every store, with edges or not; without it only the stores an edge reaches', () => {
  const calls = fg.edges.filter((e) => e.kind === 'call' && !e.from.startsWith('actor:') && !e.to.startsWith('ds:'));
  const stores = (o = {}) => layout(g, calls, o).nodes.map((n) => n.node.id).filter((id) => id.startsWith('ds:')).sort();
  assert.deepEqual(stores(), []);
  assert.deepEqual(stores({ keep: true }), ['ds:kafka', 'ds:postgres']);
});

test('a flow that never ran lights what it expects on the same full map', () => {
  const e = expectedGraph(vf, { needs: ['svc:file-service', 'ds:postgres'], steps: [{ step: 'Subir', service: 'svc:api-gateway' }] });
  const a = archGraph(vf, []);
  assert.equal(a.pieces.length, 10);
  assert.ok(e.edges.every((x) => a.edges.some((y) => y.id === x.id)), 'every expected edge has its place on the full map');
});

// The flow maps of runs 42 and 44 as vaultflow drew them, and its system map: their nodes, and their edges with labels
// in flowGraph's (or edgesOf's) order.
const MAPS: Array<[string, string[], Array<[MapEdge['kind'], string, string, string]>]> = [
  // run 42, administrar-usuarios, the story
  ['42 administrar-usuarios', ['actor:browser', 'actor:runner', 'svc:api-gateway', 'svc:frontend', 'svc:file-service', 'svc:notification-service', 'ds:postgres'], [
    ['call', 'actor:runner', 'svc:api-gateway', '6 · 1 falló'],
    ['store', 'svc:api-gateway', 'ds:postgres', '20 SQL · users'],
    ['call', 'actor:browser', 'svc:frontend', '28 · +4 SSE · 1 con error'],
    ['call', 'svc:frontend', 'svc:api-gateway', '23 · +4 SSE · 1 con error'],
    ['call', 'svc:api-gateway', 'svc:file-service', '10'],
    ['store', 'svc:file-service', 'ds:postgres', '14 SQL · files, folders'],
    ['call', 'svc:api-gateway', 'svc:notification-service', '4 SSE'],
  ]],
  // run 42, generar-informe, the story
  ['42 generar-informe', ['actor:browser', 'actor:runner', 'svc:api-gateway', 'svc:file-service', 'svc:antivirus-service', 'svc:notification-service', 'svc:frontend', 'svc:batch-service', 'ds:postgres', 'ds:minio', 'ext:clamav'], [
    ['call', 'actor:runner', 'svc:api-gateway', '7'],
    ['store', 'svc:api-gateway', 'ds:postgres', '5 SQL · users'],
    ['call', 'svc:api-gateway', 'svc:file-service', '6'],
    ['store', 'svc:file-service', 'ds:minio', '3 HTTP · quarantine, files'],
    ['store', 'svc:file-service', 'ds:postgres', '10 SQL · files, folders'],
    ['store', 'svc:antivirus-service', 'ds:minio', '1 HTTP · quarantine'],
    ['store', 'svc:antivirus-service', 'ext:clamav', '1 conexión'],
    ['call', 'actor:browser', 'svc:frontend', '13 · +1 SSE'],
    ['call', 'svc:frontend', 'svc:api-gateway', '9 · +1 SSE'],
    ['call', 'svc:api-gateway', 'svc:notification-service', '1 SSE'],
    ['call', 'svc:api-gateway', 'svc:batch-service', '6'],
    ['store', 'svc:batch-service', 'ds:postgres', '66 SQL · storage_reports, batch_job_instance +6'],
    ['store', 'svc:batch-service', 'ds:minio', '16 HTTP · reports'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.clean'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.clean'],
  ]],
  // run 44, subir-fichero-limpio, the story
  ['44 subir-fichero-limpio', ['actor:browser', 'actor:runner', 'svc:api-gateway', 'svc:frontend', 'svc:file-service', 'svc:notification-service', 'svc:antivirus-service', 'ds:postgres', 'ds:minio', 'ext:clamav'], [
    ['call', 'actor:runner', 'svc:api-gateway', '2'],
    ['store', 'svc:api-gateway', 'ds:postgres', '4 SQL · users'],
    ['call', 'actor:browser', 'svc:frontend', '14 · +2 SSE'],
    ['call', 'svc:frontend', 'svc:api-gateway', '11 · +2 SSE'],
    ['call', 'svc:api-gateway', 'svc:file-service', '10'],
    ['store', 'svc:file-service', 'ds:postgres', '16 SQL · files, folders'],
    ['call', 'svc:api-gateway', 'svc:notification-service', '2 SSE'],
    ['store', 'svc:file-service', 'ds:minio', '6 HTTP · quarantine, files'],
    ['store', 'svc:antivirus-service', 'ds:minio', '1 HTTP · quarantine'],
    ['store', 'svc:antivirus-service', 'ext:clamav', '1 conexión'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.clean'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.clean'],
  ]],
  // run 44, subir-fichero-limpio, «Descargar mientras está pendiente»
  ['44 subir-fichero-limpio · Descargar mientras está pendiente', ['actor:runner', 'svc:api-gateway', 'svc:file-service', 'svc:antivirus-service', 'svc:notification-service', 'ds:postgres', 'ds:minio', 'ext:clamav'], [
    ['call', 'actor:runner', 'svc:api-gateway', '7 · 2 con error'],
    ['store', 'svc:api-gateway', 'ds:postgres', '3 SQL · users'],
    ['call', 'svc:api-gateway', 'svc:file-service', '6 · 2 con error'],
    ['store', 'svc:file-service', 'ds:minio', '6 HTTP · quarantine, files'],
    ['store', 'svc:file-service', 'ds:postgres', '12 SQL · files'],
    ['store', 'svc:antivirus-service', 'ds:minio', '2 HTTP · quarantine'],
    ['store', 'svc:antivirus-service', 'ext:clamav', '2 conexiones'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.clean'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.clean'],
  ]],
  // run 44, subir-fichero-infectado, «Restaurar el infectado desde la papelera»
  ['44 subir-fichero-infectado · Restaurar el infectado desde la papelera', ['actor:runner', 'svc:api-gateway', 'svc:file-service', 'svc:antivirus-service', 'svc:notification-service', 'ds:postgres', 'ds:minio', 'ext:clamav'], [
    ['call', 'actor:runner', 'svc:api-gateway', '6 · 1 falló'],
    ['store', 'svc:api-gateway', 'ds:postgres', '3 SQL · users'],
    ['call', 'svc:api-gateway', 'svc:file-service', '5 · 1 con error'],
    ['store', 'svc:file-service', 'ds:minio', '4 HTTP · quarantine'],
    ['store', 'svc:file-service', 'ds:postgres', '8 SQL · files'],
    ['store', 'svc:antivirus-service', 'ds:minio', '1 HTTP · quarantine'],
    ['store', 'svc:antivirus-service', 'ext:clamav', '1 conexión'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.infected'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.infected'],
  ]],
  // run 42, the full map of the page (the story and its cases): every piece, each edge as wide as its widest label
  ['42 subir-fichero-limpio · mapa completo', ['svc:antivirus-service', 'svc:api-gateway', 'svc:batch-service', 'svc:file-service', 'svc:frontend', 'svc:notification-service', 'ds:postgres', 'ds:kafka', 'ds:minio', 'ext:clamav', 'actor:browser', 'actor:runner'], [
    ['store', 'svc:api-gateway', 'ds:postgres', '4 SQL · users'],
    ['store', 'svc:file-service', 'ds:postgres', '16 SQL · files, folders'],
    ['store', 'svc:file-service', 'ds:kafka', ''],
    ['store', 'svc:file-service', 'ds:minio', '5 HTTP · quarantine, files'],
    ['store', 'svc:batch-service', 'ds:postgres', ''],
    ['store', 'svc:batch-service', 'ds:kafka', ''],
    ['store', 'svc:batch-service', 'ds:minio', ''],
    ['store', 'svc:antivirus-service', 'ds:kafka', ''],
    ['store', 'svc:antivirus-service', 'ext:clamav', '1 conexión'],
    ['store', 'svc:antivirus-service', 'ds:minio', '1 HTTP · quarantine'],
    ['store', 'svc:notification-service', 'ds:kafka', ''],
    ['store', 'svc:antivirus-service', 'ds:postgres', ''],
    ['call', 'svc:api-gateway', 'svc:file-service', '4 · 1 con error'],
    ['call', 'svc:api-gateway', 'svc:batch-service', ''],
    ['call', 'svc:api-gateway', 'svc:antivirus-service', ''],
    ['call', 'svc:api-gateway', 'svc:notification-service', '2 SSE'],
    ['call', 'svc:frontend', 'svc:api-gateway', '11 · +2 SSE'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.clean'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.clean · sin efecto visible'],
    ['call', 'actor:runner', 'svc:api-gateway', '5 · 1 con error'],
    ['call', 'actor:browser', 'svc:frontend', '14 · +2 SSE'],
  ]],
  // run 44, the full map of the page (the story and its cases): every piece, each edge as wide as its widest label
  ['44 subir-fichero-infectado · mapa completo', ['svc:antivirus-service', 'svc:api-gateway', 'svc:batch-service', 'svc:file-service', 'svc:frontend', 'svc:notification-service', 'ds:postgres', 'ds:kafka', 'ds:minio', 'ext:clamav', 'actor:browser', 'actor:runner'], [
    ['store', 'svc:api-gateway', 'ds:postgres', '5 SQL · users'],
    ['store', 'svc:file-service', 'ds:postgres', '22 SQL · files, folders +1'],
    ['store', 'svc:file-service', 'ds:kafka', ''],
    ['store', 'svc:file-service', 'ds:minio', '6 HTTP · quarantine'],
    ['store', 'svc:batch-service', 'ds:postgres', ''],
    ['store', 'svc:batch-service', 'ds:kafka', ''],
    ['store', 'svc:batch-service', 'ds:minio', ''],
    ['store', 'svc:antivirus-service', 'ds:kafka', ''],
    ['store', 'svc:antivirus-service', 'ext:clamav', '1 conexión'],
    ['store', 'svc:antivirus-service', 'ds:minio', '2 HTTP · quarantine'],
    ['store', 'svc:notification-service', 'ds:kafka', ''],
    ['store', 'svc:antivirus-service', 'ds:postgres', ''],
    ['call', 'svc:api-gateway', 'svc:file-service', '1 · 1 con error'],
    ['call', 'svc:api-gateway', 'svc:batch-service', ''],
    ['call', 'svc:api-gateway', 'svc:antivirus-service', ''],
    ['call', 'svc:api-gateway', 'svc:notification-service', '3 SSE'],
    ['call', 'svc:frontend', 'svc:api-gateway', '17 · +3 SSE'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.infected'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.infected · sin efecto visible'],
    ['call', 'actor:runner', 'svc:api-gateway', '2 · 1 con error'],
    ['call', 'actor:browser', 'svc:frontend', '21 · +3 SSE'],
  ]],
  // vaultflow's system map: three events within one column, two of them both ways between the same pair, and twelve
  // store edges turning in the same gap
  ['vaultflow, system map', ['svc:antivirus-service', 'svc:api-gateway', 'svc:batch-service', 'svc:file-service', 'svc:frontend', 'svc:notification-service', 'ds:postgres', 'ds:kafka', 'ds:minio', 'ext:clamav'], [
    ...([['api-gateway', 'postgres'], ['file-service', 'postgres'], ['file-service', 'kafka'], ['file-service', 'minio'], ['batch-service', 'postgres'], ['batch-service', 'kafka'], ['batch-service', 'minio'], ['antivirus-service', 'kafka'], ['antivirus-service', 'clamav'], ['antivirus-service', 'minio'], ['notification-service', 'kafka'], ['antivirus-service', 'postgres']] as const)
      .map(([a, b]): [MapEdge['kind'], string, string, string] => ['store', `svc:${a}`, b === 'clamav' ? 'ext:clamav' : `ds:${b}`, '']),
    ['call', 'svc:api-gateway', 'svc:file-service', '24 endpoints'],
    ['call', 'svc:api-gateway', 'svc:batch-service', '5 endpoints'],
    ['call', 'svc:api-gateway', 'svc:antivirus-service', '1 endpoints'],
    ['call', 'svc:api-gateway', 'svc:notification-service', '1 endpoints'],
    ['call', 'svc:frontend', 'svc:api-gateway', '17 endpoints'],
    ['event', 'svc:file-service', 'svc:antivirus-service', 'file.uploaded'],
    ['event', 'svc:antivirus-service', 'svc:file-service', 'file.clean, file.infected'],
    ['event', 'svc:antivirus-service', 'svc:notification-service', 'file.clean, file.infected'],
  ]],
  // a long label into a column two edges come back to from under the drawing: it keeps left of their lanes
  ['back into a column', ['svc:a', 'svc:b', 'svc:c', 'svc:d'], [
    ['event', 'svc:c', 'svc:b', 'c.done'],
    ['event', 'svc:d', 'svc:b', 'd.done'],
    ['call', 'svc:a', 'svc:b', '40 · +12 SSE · 3 fallaron · 9 con error · no está en el código'],
    ['call', 'svc:b', 'svc:c', '1'],
    ['call', 'svc:b', 'svc:d', '1'],
  ]],
];
const ACTOR_NAME: Record<string, string> = { 'actor:browser': 'Navegador', 'actor:runner': 'Prueba' };
/** 10.5px of Geist Mono, as the browser measures it: 0.6em a character, 10.5px above its baseline and 3px below. */
const CH = 6.3;

type Box = { x: number; y: number; w: number; h: number };
const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The segments of a path (M, then H and V only), as boxes with no thickness. */
const segments = (d: string) => {
  const out: Box[] = [];
  let x = 0, y = 0;
  for (const [, c, v] of d.matchAll(/([MHV])([\d.-]+(?: [\d.-]+)?)/g)) {
    const [a, b] = v.split(' ').map(Number);
    if (c === 'M') { x = a; y = b; continue; }
    const [nx, ny] = c === 'H' ? [a, y] : [x, a];
    out.push({ x: Math.min(x, nx), y: Math.min(y, ny), w: Math.abs(nx - x), h: Math.abs(ny - y) });
    [x, y] = [nx, ny];
  }
  return out;
};

test('on the flow maps of runs 42 and 44 and the system map, no line runs behind a node it does not join, and every edge label is whole, by its own line, and hides no node, no other label and no other edge’s line', () => {
  for (const [name, ids, es] of MAPS) {
    const ns = ids.map((id): MapNode => ({ id, type: id.startsWith('ds:') ? 'datastore' : id.startsWith('ext:') ? 'external' : 'service', name: ACTOR_NAME[id] ?? id.replace(/^\w+:/, ''), kind: id.startsWith('actor:') ? 'actor' : undefined }));
    const lay = layout(index(ns, []), es.map(([kind, from, to, label]): MapEdge => ({ id: `${kind}|${from}|${to}`, kind, from, to, label, origin: 'observed', facts: [] })));
    assert.equal(lay.edges.length, es.length, name);
    const back = lay.edges.map((e): Box => ({ x: e.lx - e.lw / 2, y: e.ly - 11, w: e.lw, h: LABEL_H }));
    const lines = lay.edges.map((e) => segments(e.d));
    // each edge turns in a lane of its own, however many turn in one gap
    for (const [i, ss] of lines.entries()) for (const s of ss.filter((s) => !s.w)) for (const o of lines.slice(i + 1).flat().filter((o) => !o.w && o.x === s.x)) assert.ok(Math.min(s.y + s.h, o.y + o.h) - Math.max(s.y, o.y) <= 0, `${name}: ${lay.edges[i].id} shares a lane at x=${s.x}`);
    // a long edge crosses the columns between above or below their nodes, never behind one it does not join
    for (const [i, e] of lay.edges.entries()) for (const s of lines[i]) for (const n of lay.nodes) if (n.node.id !== e.from && n.node.id !== e.to) assert.ok(!meets(s, { x: n.x, y: n.y, w: NODE_W, h: NODE_H }), `${name}: ${e.id} runs behind ${n.node.id}`);
    for (const [i, e] of lay.edges.entries()) {
      const b = back[i], t = { x: e.lx - (e.label.length * CH) / 2, y: e.ly - 10.5, w: e.label.length * CH, h: 13.5 };
      assert.ok(b.x <= t.x && t.x + t.w <= b.x + b.w && b.y <= t.y && t.y + t.h <= b.y + b.h, `${name}: the backdrop of «${e.label}» holds its words`);
      assert.ok(b.x >= 0 && b.x + b.w <= lay.width && b.y >= 0 && b.y + b.h <= lay.height, `${name}: «${e.label}» is inside the drawing`);
      assert.ok(lines[i].some((s) => meets({ x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 }, s)), `${name}: «${e.label}» is by its own line`);
      for (const n of lay.nodes) assert.ok(!meets(b, { x: n.x, y: n.y, w: NODE_W, h: NODE_H }), `${name}: «${e.label}» runs under ${n.node.id}`);
      for (const [j, o] of back.entries()) if (j > i) assert.ok(!meets(b, o), `${name}: «${e.label}» and «${lay.edges[j].label}» overlap`);
      // its own line is strictly the nearest, so it never reads as the caption of another
      const dist = (s: Box) => Math.hypot(Math.max(0, s.x - (b.x + b.w), b.x - (s.x + s.w)), Math.max(0, s.y - (b.y + b.h), b.y - (s.y + s.h)));
      const own = Math.min(...lines[i].map(dist));
      for (const [j, ss] of lines.entries()) if (j !== i) for (const s of ss) assert.ok(dist(s) >= own + 2, `${name}: «${e.label}» is nearer ${lay.edges[j].id} than its own line`);
      // hiding a stretch of another edge, above all its last one into an arrowhead, reads as that edge's label
      for (const [j, ss] of lines.entries()) if (j !== i) for (const s of ss) assert.ok(!meets(b, s), `${name}: «${e.label}» hides a stretch of ${lay.edges[j].id}`);
    }
  }
});
