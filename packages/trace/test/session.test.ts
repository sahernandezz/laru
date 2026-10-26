/** A session assembles like a run: its marks are the steps, the host's browser is the person, the AI reads it by cursor. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TrafficRecord } from '../src/trace.ts';
import { assemble, sessionEvents } from '../src/assemble.ts';
import { sessionSummary } from '../src/summarize.ts';
import type { RunInfo } from '../src/trace.ts';

const T = 1_800_000_000_000;
const host = '172.30.1.1', front = '172.30.1.10', gw = '172.30.1.11', files = '172.30.1.12';
const rec = (id: string, from: string, svc: string, t0: number, t1: number, extra: Partial<TrafficRecord> = {}): TrafficRecord =>
  ({ v: 1, id, kind: 'http', t0: T + t0, t1: T + t1, from, svc, port: 80, method: 'GET', path: '/', status: 200, ...extra });
const chrome = { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36' };

test('marks become steps from one mark to the next; before the first, nothing is a step; the open one is todo', () => {
  const ev = sessionEvents('Probar la subida', T, [{ t: T + 3000, text: 'Subir' }, { t: T + 1000, text: 'Entrar' }], T + 5000, true);
  assert.deepEqual(ev.map((e) => e.e), ['test-begin', 'step-begin', 'step-end', 'step-begin', 'step-end', 'test-end']);
  const ends = ev.filter((e) => e.e === 'step-end') as Array<{ title: string; t0: number; t: number; status: string }>;
  assert.deepEqual(ends.map((e) => [e.title, e.t0 - T, e.t - T, e.status]), [['Entrar', 1000, 3000, 'passed'], ['Subir', 3000, 5000, 'todo']], 'sorted by time, the last open while live');
  assert.equal(sessionEvents('x', T, [{ t: T + 1, text: 'a' }], T + 2).filter((e) => e.e === 'step-end').every((e) => (e as { status: string }).status === 'passed'), true, 'saved: every step passed');
});

test("in a session the host's browser is the person; in a run it stays someone else's (foreign)", () => {
  const traffic = [
    rec('b1', host, 'frontend', 1200, 1300, { method: 'POST', path: '/api/files/upload', status: 500, reqHeaders: chrome }),
    rec('f1', front, 'api-gateway', 1205, 1295, { method: 'POST', path: '/api/files/upload', status: 500 }),
    rec('g1', gw, 'file-service', 1210, 1290, { method: 'POST', path: '/api/files/upload', status: 500 }),
    rec('cli', host, 'frontend', 1500, 1510, { reqHeaders: { 'user-agent': 'curl/8.7' } }),
    rec('a1', host, 'frontend', 200, 210, { path: '/main.js', reqHeaders: chrome }),
  ];
  const base = { run: '7', flow: 'session', env: 'local', traffic, peers: { [front]: 'frontend', [gw]: 'api-gateway', [files]: 'file-service' }, gatewayIp: host };
  const events = sessionEvents('Sesión 7', T, [{ t: T + 1000, text: 'Subir informe.pdf' }], T + 4000);
  const [s] = assemble({ ...base, events, person: true }).traces;
  const from = Object.fromEntries(s.exchanges.map((e) => [e.id, e.from]));
  assert.equal(from.b1, 'browser');
  assert.equal(from.cli, 'host', 'a non-browser client on the host is still the host');
  assert.equal(s.participants.find((p) => p.id === 'browser')?.kind, undefined, 'the person\'s browser is not claimed to be Chromium');
  assert.equal(s.exchanges.find((e) => e.id === 'b1')?.step, 1);
  assert.equal(s.steps[0].title, 'Subir informe.pdf');
  const [r] = assemble({ ...base, events }).traces;
  assert.equal(r.exchanges.find((e) => e.id === 'b1')?.from, 'host', 'without person, unchanged');

  // what the AI reads: the 500s as anomalies, the mark, the hops; then the cursor past the newest one
  const run = { id: '7', kind: 'session', title: 'Sesión 7', env: 'local', phase: 'tests' } as RunInfo;
  const out = sessionSummary(run, s);
  assert.match(out, /^session 7 «Sesión 7» on local, open: 3 exchanges, 1 marks/, 'the asset burst and curl are noise');
  assert.match(out, /anomalies:\n {2}1\. status 500: g1 api-gateway→file-service POST \/api\/files\/upload 500 ✕/);
  assert.match(out, /«Subir informe\.pdf» at 1\.0 s\n {2}b1 browser→frontend/);
  assert.match(out, /next: session_events\(\{session:"7", since:1211\}\)$/);
  assert.match(sessionSummary(run, s, 1211), /: 0 exchanges from 1\.2 s, 1 marks\nnext: session_events\(\{session:"7", since:1211\}\)$/, 'nothing new: the same cursor');
  assert.match(sessionSummary({ ...run, phase: 'done' }, s), /saved: .*\n[\s\S]*drill: run_evidence\(\{run:"7", exchange:"<id>"\}\)$/);
});

test("with the session's browser its actions are the person's marks and its video is the clock", () => {
  const actions = [{ t0: T + 1500, kind: 'click' as const, target: "getByRole('button', { name: 'Iniciar Sesión' })" }, { t0: T + 900, kind: 'navigate' as const, path: '/login' }];
  const events = sessionEvents('S', T, [{ t: T + 1000, text: 'Entrar' }], T + 4000, false, { actions, videoT0: T + 500 });
  const traffic = [rec('b1', host, 'frontend', 1520, 1600, { method: 'POST', path: '/api/auth/login', status: 403, reqHeaders: chrome })];
  const [s] = assemble({ run: '9', flow: 'session', env: 'local', events, traffic, peers: {}, gatewayIp: host, person: true }).traces;
  assert.equal(s.t0, T + 500, 'frame 0 of the video is time 0');
  assert.deepEqual(s.actions?.map((a) => [a.kind, a.t0, a.step]), [['navigate', 400, undefined], ['click', 1000, 1]], 'in time order, each in its mark');
  assert.equal(s.exchanges[0].t0, 1020);
  assert.equal(s.steps[0].t0, 500);
});

test('a session drafts a flow: marks are its Pasos, actions its code, hops between services its observed.wait', async () => {
  const { draftFromSession } = await import('../src/draft.ts');
  const ux = (id: string, from: string, to: string, t0: number, step: number, extra = {}) => ({ id, kind: 'http' as const, from, to, t0, t1: t0 + 5, step, label: '', ok: true, origin: 'observed' as const, method: 'POST', path: '/api/auth/login', ...extra });
  const trace = {
    v: 1, run: '9', flow: 'session', test: 'S', env: 'local', t0: 0, durationMs: 9000, status: 'passed', participants: [{ id: 'api-gateway', name: 'api-gateway', type: 'service', node: 'svc:api-gateway' }, { id: 'browser', name: 'Navegador', type: 'browser' }],
    steps: [{ n: 1, title: 'Abrir la entrada', t0: 500, t1: 3000, status: 'passed' }, { n: 2, title: 'Entrar con una contraseña mala', t0: 3000, t1: 9000, status: 'passed' }],
    actions: [
      { t0: 100, t1: 100, kind: 'navigate', path: '/' }, { t0: 180, t1: 180, kind: 'navigate', path: '/login' },
      { t0: 3100, t1: 3100, kind: 'click', target: "getByRole('textbox', { name: 'Ingresa tu usuario' })", step: 2 },
      { t0: 3500, t1: 3500, kind: 'fill', target: "getByRole('textbox', { name: 'Ingresa tu usuario' })", step: 2 },
      { t0: 4000, t1: 4000, kind: 'press', key: 'Enter', target: "getByRole('textbox', { name: 'Ingresa tu contraseña' })", step: 2 },
      { t0: 4003, t1: 4003, kind: 'click', target: "getByRole('button', { name: 'Iniciar Sesión' })", step: 2 },
    ],
    exchanges: [ux('b', 'browser', 'frontend', 4010, 2, { status: 403, ok: false }), ux('f', 'frontend', 'api-gateway', 4012, 2, { status: 403, ok: false }), ux('u', 'api-gateway', 'file-service', 4020, 2, { method: 'GET', path: '/api/files/7f0c2a1e-1111-4222-8333-944445555666' })],
    logs: [],
  } as unknown as import('../src/trace.ts').Trace;
  const d = draftFromSession(trace, { session: '9', title: 'Entrar mal', nodes: new Set(['svc:api-gateway', 'svc:file-service']) });
  assert.deepEqual(d.fields.steps.map((s) => [s.step, s.service, s.expected]), [['Abrir la entrada', undefined, '…'], ['Entrar con una contraseña mala', 'svc:api-gateway', '…']]);
  assert.deepEqual(d.needs, ['svc:api-gateway']);
  const spec = d.spec('Entrar mal');
  assert.match(spec, /step\('Abrir la entrada', async \(\) => \{\n {4}await page\.goto\('\/'\);\n {4}await expect/, 'the redirect to /login is not a step of its own');
  assert.doesNotMatch(spec, /Ingresa tu usuario' \}\)\.click/, 'the click that focuses the field typed into is left out');
  assert.match(spec, /getByRole\('textbox', \{ name: 'Ingresa tu usuario' \}\)\.fill\('…'\)/);
  assert.match(spec, /\.press\('Enter'\);\n {4}await expect/, "the click the form's Enter made is not repeated");
  assert.match(spec, /observed\.wait\(\{ from: 'frontend', to: 'api-gateway', method: 'POST', path: \/\^\\\/api\\\/auth\\\/login\$\/ \}\); \/\/ it answered 403/);
  assert.match(spec, /path: \/\^\\\/api\\\/files\\\/\[\^\/\]\+\$\/ \}\)/, 'an id is any segment');
  assert.doesNotMatch(spec, /from: 'browser'/, "the browser's own requests are what the steps do, not a wait");
});

test('two runners at once: each test keeps the chains its own runner started, and what no runner started stays in both', () => {
  const A = '172.30.1.50', B = '172.30.1.51', front = '172.30.1.10', gw = '172.30.1.11', job = '172.30.1.20';
  const ua = { 'user-agent': 'Mozilla/5.0 HeadlessChrome/141' };
  const ev = [
    { e: 'test-begin', t: T, test: 'a', title: 'A', file: '/ks/ws/a.spec.ts', story: true }, { e: 'test-begin', t: T + 100, test: 'b', title: 'B', file: '/ks/ws/b.spec.ts', story: true },
    { e: 'test-end', t: T + 3000, test: 'a', status: 'passed', durationMs: 3000 }, { e: 'test-end', t: T + 3100, test: 'b', status: 'passed', durationMs: 3000 },
  ] as import('../src/trace.ts').RunnerEvent[];
  const traffic = [
    rec('a1', A, 'frontend', 500, 600, { method: 'POST', path: '/api/files/upload', reqHeaders: ua }), rec('a2', front, 'api-gateway', 510, 590, { method: 'POST', path: '/api/files/upload' }),
    rec('b1', B, 'frontend', 520, 640, { method: 'DELETE', path: '/api/files/7', reqHeaders: ua }), rec('b2', front, 'api-gateway', 530, 630, { method: 'DELETE', path: '/api/files/7' }),
    rec('j1', job, 'api-gateway', 1500, 1510, { path: '/api/health' }),
  ];
  const input = { run: '9', flow: 'x', env: 'local', events: ev, traffic, peers: { [front]: 'frontend', [gw]: 'api-gateway', [job]: 'batch-service' }, runnerIps: [A, B], runnerIpOf: (t: string) => (t === 'a' ? A : B) };
  const [a, b] = assemble(input).traces;
  assert.deepEqual(a.exchanges.map((e) => e.id).sort(), ['a1', 'a2', 'j1']);
  assert.deepEqual(b.exchanges.map((e) => e.id).sort(), ['b1', 'b2', 'j1']);
  assert.equal(a.exchanges.find((e) => e.id === 'a1')?.from, 'browser', 'every runner is the browser');
  const [one] = assemble({ ...input, runnerIps: [A], runnerIpOf: undefined, events: ev.filter((e) => 'test' in e && e.test === 'a') }).traces;
  assert.equal(one.exchanges.length, 5, 'one runner: nothing is left out, as before');
});

test("Laru's own statements over a store's local socket (a reset between groups) are nobody's evidence", () => {
  const ev = sessionEvents('S', T, [], T + 4000);
  const sql = [
    { store: 'postgres', t1: T + 1000, durationMs: 1, ip: '[local]', user: 'vaultflow', db: 'template1', statement: 'ALTER DATABASE "vaultflow" ALLOW_CONNECTIONS false' },
    { store: 'postgres', t1: T + 1100, durationMs: 1, ip: '172.30.1.12', user: 'vaultflow', db: 'vaultflow', statement: 'select * from file_service.files' },
  ];
  const [s] = assemble({ run: '9', flow: 'session', env: 'local', events: ev, traffic: [], sql, peers: { '172.30.1.12': 'file-service' } }).traces;
  assert.deepEqual(s.exchanges.map((e) => [e.from, e.label]), [['file-service', 'SELECT file_service.files']]);
});

test('a session drafts a scenario: its marks are the state it leaves, its actions the preparation, and what was typed stays a …', async () => {
  const { scenarioFromSession } = await import('../src/draft.ts');
  const trace = {
    v: 1, run: '9', flow: 'session', test: 'S', env: 'local', t0: 0, durationMs: 9000, status: 'passed', participants: [{ id: 'api-gateway', name: 'api-gateway', type: 'service', node: 'svc:api-gateway' }],
    steps: [{ n: 1, title: 'Registrar a Ana', t0: 0, t1: 3000, status: 'passed' }, { n: 2, title: 'Subir un informe', t0: 3000, t1: 9000, status: 'passed' }],
    actions: [
      { t0: 100, t1: 100, kind: 'fill', target: "getByRole('textbox', { name: 'Usuario' })", step: 1 },
      { t0: 200, t1: 200, kind: 'click', target: "getByRole('button', { name: 'Registrarse' })", step: 1 },
      { t0: 3100, t1: 3100, kind: 'files', target: "getByRole('button', { name: 'Subir' })", step: 2 },
    ],
    exchanges: [], logs: [],
  } as unknown as import('../src/trace.ts').Trace;
  const d = scenarioFromSession(trace, { session: '9', title: 'Ana con un informe', nodes: new Set(['svc:api-gateway']) });
  assert.deepEqual(d.fields.given.map((g) => g.kind), ['data', 'data']);
  assert.match(d.fields.given[1].what, /Subir un informe/);
  assert.deepEqual(d.needs, ['svc:api-gateway']);
  const setup = d.setup('Ana con un informe');
  assert.match(setup, /scenario\('Ana con un informe', async \(\{ page, api, uniq \}\) => \{/);
  assert.match(setup, /\/\/ Registrar a Ana\n {4}await page\.getByRole\('textbox', \{ name: 'Usuario' \}\)\.fill\('…'\); \/\/ what was typed is never kept/);
  assert.match(setup, /\/\/ Subir un informe\n {4}await page\.getByRole\('button', \{ name: 'Subir' \}\)\.setInputFiles\('…'\)/);
  assert.match(setup, /todo: who can sign in/);
});
