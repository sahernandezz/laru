import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TrafficRecord } from '../src/trace.ts';
import { assemble, dynamoCall, endpointMatcher, parseKafkaDump, parsePgLog, sqlTarget, type AssembleInput } from '../src/assemble.ts';
import { anomalyChain, summarize } from '../src/summarize.ts';
import type { RunInfo, RunnerEvent } from '../src/trace.ts';

const T = 1_800_000_000_000;
const ip = { runner: '172.30.1.50', front: '172.30.1.10', gw: '172.30.1.11', files: '172.30.1.12', av: '172.30.1.13' };
const rec = (id: string, from: string, svc: string, t0: number, t1: number, extra: Partial<TrafficRecord> = {}): TrafficRecord =>
  ({ v: 1, id, kind: 'http', t0: T + t0, t1: T + t1, from, svc, port: 80, method: 'GET', path: '/', status: 200, ...extra });

const events: RunnerEvent[] = [
  { e: 'test-begin', t: T, test: 'a', title: 'subir fichero', file: 'x.spec.ts', story: true },
  { e: 'video-t0', t: T + 100, test: 'a' },
  { e: 'step-end', t: T + 1100, test: 'a', title: 'Abrir', t0: T + 100, status: 'passed' },
  { e: 'step-end', t: T + 3100, test: 'a', title: 'Subir', t0: T + 1100, status: 'failed', error: 'expect(…).toHaveText("Limpio") — recibido «Error»' },
  { e: 'test-end', t: T + 3200, test: 'a', status: 'failed', durationMs: 3200, error: 'boom' },
  { e: 'test-begin', t: T + 4000, test: 'b', title: 'otro', file: 'x.spec.ts', story: false },
  { e: 'test-end', t: T + 5000, test: 'b', status: 'passed', durationMs: 1000 },
];

const input = (): AssembleInput => ({
  run: '12', flow: 'subir-fichero-limpio', env: 'local', events, runnerIp: ip.runner, gatewayIp: '172.30.1.1', videoOffsetMs: 50,
  peers: { [ip.front]: 'frontend', [ip.gw]: 'api-gateway', [ip.files]: 'file-service', [ip.av]: 'antivirus-service' },
  traffic: [
    rec('a1', ip.runner, 'frontend', 200, 260, { path: '/main.js', reqHeaders: { 'user-agent': 'Mozilla HeadlessChrome/140' } }),
    rec('a2', ip.runner, 'frontend', 210, 270, { path: '/styles.css', reqHeaders: { 'user-agent': 'Mozilla HeadlessChrome/140' } }),
    rec('up', ip.runner, 'frontend', 1200, 2900, { method: 'POST', path: '/api/files/upload', status: 502, reqHeaders: { 'user-agent': 'Mozilla HeadlessChrome/140' } }),
    rec('gw', ip.front, 'api-gateway', 1210, 2890, { method: 'POST', path: '/api/files/upload', status: 502 }),
    rec('fs', ip.gw, 'file-service', 1220, 2880, { method: 'POST', path: '/api/files/upload', status: 500 }),
    rec('mn', ip.files, 'minio', 1300, 2800, { method: 'PUT', path: '/files/x', status: undefined, error: 'socket hang up', fault: 'abortado' }),
    rec('late', ip.runner, 'frontend', 4500, 4600, { reqHeaders: { 'user-agent': 'Playwright/1.64' } }),
    rec('fo', ip.gw, 'file-service', 4610, 4620, { path: '/api/files/folders' }),
    rec('f7', ip.gw, 'file-service', 4630, 4640, { path: '/api/files/7f' }),
    rec('host', '172.30.1.1', 'frontend', 2000, 2010),
  ],
  sql: parsePgLog([
    '2026-10-22T04:14:48.000000000Z 2027-01-15 08:00:01.300 UTC|172.30.1.12|77|vaultflow|vaultflow|LOG:  duration: 1.000 ms  execute <unnamed>: insert into file_service.files (id,name) values ($1,$2)',
    '2027-01-15 08:00:01.300 UTC|172.30.1.12|77|vaultflow|vaultflow|DETAIL:  parameters: $1 = \'7f\', $2 = \'a.txt\'',
    '2027-01-15 08:00:01.301 UTC|172.30.1.12|77|vaultflow|vaultflow|LOG:  duration: 0.010 ms  statement: BEGIN',
  ].map((l) => l.replace('2027-01-15 08:00:01', new Date(T + 1300).toISOString().slice(0, 19).replace('T', ' '))), 'postgres'),
  kafka: [{ broker: 'kafka', topic: 'file.uploaded', partition: 0, offset: 3, t: T + 1400, value: '{"fileId":"7f"}' }],
  map: {
    nodes: [
      { id: 'svc:frontend', type: 'service', name: 'frontend', attrs: { tech: 'web' } }, { id: 'svc:api-gateway', type: 'service', name: 'api-gateway', kind: 'spring' },
      { id: 'svc:file-service', type: 'service', name: 'file-service', kind: 'spring' }, { id: 'ds:minio', type: 'datastore', name: 'minio', kind: 'file' },
      { id: 'ds:postgres', type: 'datastore', name: 'postgres', kind: 'relational' }, { id: 'ds:kafka', type: 'datastore', name: 'kafka', kind: 'queue' },
      { id: 'ep:file-service:POST /api/files/upload', type: 'endpoint', name: 'POST /api/files/upload', service: 'svc:file-service', attrs: { method: 'POST', path: '/api/files/upload' } },
      { id: 'ep:file-service:GET /api/files/{fileId}', type: 'endpoint', name: 'GET /api/files/{fileId}', service: 'svc:file-service', attrs: { method: 'GET', path: '/api/files/{fileId}' } },
      { id: 'ep:file-service:GET /api/files/folders', type: 'endpoint', name: 'GET /api/files/folders', service: 'svc:file-service', attrs: { method: 'GET', path: '/api/files/folders' } },
    ],
    facts: [{ s: 'svc:file-service', p: 'publishes', o: 'topic:file.uploaded' }, { s: 'svc:antivirus-service', p: 'consumes', o: 'topic:file.uploaded' }],
  },
});

test('Postgres log: execute with its parameters, noise dropped, docker timestamps stripped', () => {
  const lines = parsePgLog([
    '2027-01-15 08:00:01.300 UTC|172.30.1.12|77|u|d|LOG:  duration: 1.500 ms  execute <unnamed>: select *',
    'from t where a = $1',
    '2027-01-15 08:00:01.300 UTC|172.30.1.12|77|u|d|DETAIL:  parameters: $1 = \'x\'',
    '2027-01-15 08:00:01.400 UTC|172.30.1.12|77|u|d|LOG:  duration: 0.1 ms  statement: SET extra_float_digits = 3',
    '2027-01-15 08:00:01.500 UTC|172.30.1.13|78|u|d|ERROR:  duplicate key value violates unique constraint "u"',
    '2027-01-15 08:00:01.500 UTC|172.30.1.13|78|u|d|STATEMENT:  insert into gateway.users values (1)',
  ], 'postgres');
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].statement, lines[0].params, lines[0].durationMs, lines[0].ip, lines[0].t1], ['select *\nfrom t where a = $1', "$1 = 'x'", 1.5, '172.30.1.12', Date.parse('2027-01-15T08:00:01.300Z')]);
  assert.equal(lines[1].error, 'duplicate key value violates unique constraint "u"');
  assert.deepEqual(sqlTarget(lines[1].statement), { verb: 'INSERT', table: 'gateway.users', writes: true });
  assert.deepEqual(sqlTarget('select u1_0.id from "gateway"."users" u1_0 where u1_0.username=$1'), { verb: 'SELECT', table: 'gateway.users', writes: false });
});

test('kafka-dump-log output to messages', () => {
  const k = parseKafkaDump('baseOffset: 0 …\n| offset: 4 CreateTime: 1792643171284 keySize: 2 valueSize: 16 sequence: 0 headerKeys: [__TypeId__] key: k1 payload: {"fileId":"abc"}\n', 'kafka', 'file.clean', 1);
  assert.deepEqual(k, [{ broker: 'kafka', topic: 'file.clean', partition: 1, offset: 4, t: 1792643171284, key: 'k1', value: '{"fileId":"abc"}' }]);
});

test('one trace per test, its window clipped at the next test, times from video frame 0', () => {
  const { traces } = assemble(input());
  assert.equal(traces.length, 2);
  const [a, b] = traces;
  assert.equal(a.t0, T + 150, 'videoT0 plus the calibrated offset');
  assert.deepEqual(a.steps.map((s) => [s.n, s.t0, s.t1, s.status]), [[1, -50, 950, 'passed'], [2, 950, 2950, 'failed']]);
  assert.ok(!a.exchanges.some((e) => e.id === 'late'), 'the next test owns its traffic');
  assert.ok(b.exchanges.some((e) => e.id === 'late' && e.from === 'runner'), 'Playwright requests are the test, not the browser');
});

test('a request reaches the most literal endpoint that matches, by the map\'s own service ids', () => {
  const { traces: [, b], observed } = assemble(input());
  const by = Object.fromEntries(b.exchanges.map((e) => [e.id, e.endpoint]));
  assert.equal(by.fo, 'ep:file-service:GET /api/files/folders', 'the literal path beats the template listed before it');
  assert.equal(by.f7, 'ep:file-service:GET /api/files/{fileId}');
  assert.ok(observed.some((o) => o.s === 'svc:api-gateway' && o.p === 'calls' && o.o === 'ep:file-service:GET /api/files/folders'));
});

test('a gateway\'s Spring wildcards match, below every literal and {param} template', () => {
  const ep = (method: string, path: string) => ({ id: `ep:api-gateway:${method} ${path}`, type: 'endpoint', name: `${method} ${path}`, service: 'svc:api-gateway', attrs: { method, path } });
  const m = endpointMatcher([ep('GET', '/api/files/**'), ep('GET', '/api/files/{fileId}'), ep('GET', '/api/files/stats'), ep('GET', '/api/*/health'), ep('POST', '/api/files/**')]);
  assert.equal(m('api-gateway', 'GET', '/api/files'), 'ep:api-gateway:GET /api/files/**', '`/**` takes the bare prefix too');
  assert.equal(m('api-gateway', 'GET', '/api/files/folders/7f/children'), 'ep:api-gateway:GET /api/files/**');
  assert.equal(m('api-gateway', 'GET', '/api/files/7f'), 'ep:api-gateway:GET /api/files/{fileId}', 'a {param} beats the `**` listed before it');
  assert.equal(m('api-gateway', 'GET', '/api/files/stats'), 'ep:api-gateway:GET /api/files/stats');
  assert.equal(m('api-gateway', 'POST', '/api/files/upload'), 'ep:api-gateway:POST /api/files/**');
  assert.equal(m('api-gateway', 'GET', '/api/batch/health'), 'ep:api-gateway:GET /api/*/health', '`*` is one segment');
  assert.equal(m('api-gateway', 'GET', '/api/a/b/health'), undefined);
  assert.equal(m('api-gateway', 'GET', '/api/filesx'), undefined, '`/**` does not stretch a segment');
});

test('participants come from the map, in lane order; assets collapse; parents nest', () => {
  const { traces: [a], observed } = assemble(input());
  assert.deepEqual(a.participants.map((p) => `${p.id}:${p.type}`), ['browser:browser', 'host:host', 'frontend:service', 'api-gateway:service', 'file-service:service', 'antivirus-service:service', 'postgres:datastore', 'minio:datastore', 'kafka:datastore']);
  const assets = a.exchanges.find((e) => e.asset);
  assert.equal(assets?.asset, 2);
  assert.equal(assets?.label, 'GET 2 recursos');
  const by = Object.fromEntries(a.exchanges.map((e) => [e.id, e]));
  assert.equal(by.gw.parent, 'up');
  assert.equal(by.fs.parent, 'gw');
  assert.equal(by.mn.parent, 'fs');
  assert.equal(by.fs.endpoint, 'ep:file-service:POST /api/files/upload');
  const sql = a.exchanges.find((e) => e.kind === 'sql')!;
  assert.deepEqual([sql.from, sql.to, sql.label, sql.parent], ['file-service', 'postgres', 'INSERT file_service.files', 'fs']);
  const pub = a.exchanges.filter((e) => e.kind === 'kafka');
  assert.deepEqual(pub.map((e) => `${e.from}→${e.to}:${e.origin}`), ['file-service→kafka:derived', 'kafka→antivirus-service:derived']);
  assert.equal(a.foreign, 1, 'a request from the host during the run is flagged');
  assert.ok(observed.some((o) => o.s === 'svc:file-service' && o.p === 'writes' && o.o === 'tbl:file_service.files'));
  assert.ok(observed.some((o) => o.s === 'svc:api-gateway' && o.p === 'calls' && o.o === 'ep:file-service:POST /api/files/upload'));
});

test('the failure points at the first bad exchange of the failed step; the chain goes deepest first', () => {
  const { traces: [a] } = assemble(input());
  assert.equal(a.failure?.step, 2);
  assert.equal(a.failure?.exchange, 'up');
  const chain = anomalyChain(a);
  assert.equal(chain[0].e?.id, 'mn', 'the aborted call to minio explains the 502s above it');
  assert.equal(chain[0].why, 'transport error');
  assert.deepEqual(chain.slice(1).map((c) => c.e?.id), ['fs', 'gw', 'up']);
  // through the consumer: the scan's refused connection, under the delivery of the upload's publish, is deeper still
  const x = input();
  x.traffic.push(rec('cv', ip.av, 'clamav', 1450, 1460, { kind: 'tcp', method: undefined, path: undefined, status: undefined, error: 'ECONNRESET' }));
  const deep = anomalyChain(assemble(x).traces[0]);
  assert.deepEqual(deep.map((c) => c.e?.id), ['cv', 'mn', 'fs', 'gw', 'up'], 'cv ← consume ← publish ← fs: depth 5, the aborted PUT 3');
});

test('the default evidence fits its budget and says what it left out', () => {
  const { traces } = assemble(input());
  const run: RunInfo = { id: '12', env: 'local', ephemeral: false, flows: ['subir-fichero-limpio'], phase: 'done', status: 'failed', startedAt: '', pid: 1, results: { 'subir-fichero-limpio': { status: 'failed' } } };
  const text = summarize(run, traces);
  assert.ok(text.length / 4 < 800, `${text.length / 4} tokens`);
  assert.match(text, /failed at step 2\/2 «Subir»/);
  assert.match(text, /1\. transport error: mn/);
  assert.match(text, /next: run_evidence/);
  const small = summarize(run, traces, { budget: 60 });
  assert.match(small, /left out/);
  assert.match(summarize(run, traces, { exchange: 'fs' }), /caused by gw/);
  assert.match(summarize(run, traces, { flow: 'subir-fichero-limpio', step: 2 }), /step 2\/2 «Subir» failed/);
});

test('a request an injected abort left unanswered is not ok; a delayed tcp exchange, with no status either, is', () => {
  const x = input();
  x.traffic.push(
    rec('ab', ip.gw, 'notification-service', 1500, 1500, { path: '/api/notifications/stream', status: undefined, fault: 'abortado' }),
    rec('cl', ip.av, 'clamav', 1600, 2400, { kind: 'tcp', method: undefined, path: undefined, status: undefined, fault: 'latencia +800 ms inyectada' }),
  );
  const ex = assemble(x).traces.flatMap((t) => t.exchanges);
  assert.equal(ex.find((e) => e.id === 'ab')?.ok, false);
  assert.equal(ex.find((e) => e.id === 'cl')?.ok, true);
});

test('a DynamoDB call reads as its operation and table, like a SQL row', () => {
  const target = (op: string) => ({ 'x-amz-target': `DynamoDB_20120810.${op}`, authorization: 'AWS4-HMAC-SHA256 …x1y2' });
  assert.deepEqual(dynamoCall(target('PutItem'), '{"TableName":"users","Item":{"id":{"S":"1"}}}'), { op: 'PutItem', table: 'users' });
  assert.deepEqual(dynamoCall(target('BatchWriteItem'), '{"RequestItems": {"orders": [{"PutRequest":{}}]}}'), { op: 'BatchWriteItem', table: 'orders' });
  assert.deepEqual(dynamoCall(target('ListTables'), '{}'), { op: 'ListTables', table: undefined });
  assert.deepEqual(dynamoCall(target('Query'), '{"TableName":"ord'), { op: 'Query', table: undefined }, 'a body cut before the name says nothing');
  // A table given by its ARN, as SDKs and DynamoDB Local accept it, and PartiQL's target.
  const arn = 'arn:aws:dynamodb:us-east-1:000000000000:table';
  assert.deepEqual(dynamoCall(target('GetItem'), `{"TableName":"${arn}/users","Key":{}}`), { op: 'GetItem', table: 'users' });
  assert.deepEqual(dynamoCall(target('BatchGetItem'), `{"RequestItems":{"${arn}/orders":{"Keys":[]}}}`), { op: 'BatchGetItem', table: 'orders' });
  assert.deepEqual(dynamoCall(target('Query'), `{"TableName":"${arn}/users/index/byEmail"}`), { op: 'Query', table: 'users' });
  assert.deepEqual(dynamoCall(target('GetItem'), `{"TableName":"${arn}/us`), { op: 'GetItem', table: undefined }, 'an ARN cut before its end says nothing');
  const partiql = (statement: string) => dynamoCall(target('ExecuteStatement'), JSON.stringify({ Statement: statement, Parameters: [{ S: '1' }] }))?.table;
  assert.deepEqual(['SELECT * FROM "users" WHERE id = ?', 'select name, "from" from users.byEmail where id = ?', 'INSERT INTO "orders" VALUE {\'id\': ?}', 'UPDATE users SET n = ? WHERE id = ?', 'DELETE FROM "my.table" WHERE id = ?'].map(partiql),
    ['users', 'users', 'orders', 'users', 'my.table']);
  // Written across lines: the SDK sends a newline or tab as the two characters `\n` or `\t`.
  assert.deepEqual(['SELECT id, name\nFROM users\nWHERE id = ?', '\n  SELECT * FROM users WHERE id = ?', 'SELECT * FROM\n  users WHERE id = ?', 'SELECT * FROM\tusers',
    'DELETE FROM\nusers WHERE id = ?', 'DELETE\r\nFROM "users"', 'INSERT\nINTO orders VALUE {}', 'UPDATE\tusers SET n = ?', 'SELECT * FROM\r\n"users"'].map(partiql),
    ['users', 'users', 'users', 'users', 'users', 'users', 'orders', 'users', 'users']);
  assert.equal(partiql('SELECT a\\nFROM users'), undefined, 'a backslash and an n written in the statement are not a newline');
  assert.equal(dynamoCall(target('BatchExecuteStatement'), '{"Statements":[{"Statement":"SELECT * FROM \\"users\\""}]}')?.table, 'users', 'a batch: its first statement');
  assert.equal(dynamoCall(target('ExecuteStatement'), '{"Statement":"SELECT * FROM ord')?.table, undefined, 'a statement cut inside the name says nothing');
  assert.equal(dynamoCall({ 'x-amz-target': 'Kinesis_20131202.PutRecord' }, '{"TableName":"x"}'), undefined);
  assert.equal(dynamoCall(undefined, '{"TableName":"x"}'), undefined, 'a body alone is not a DynamoDB call');
  const x = input();
  x.peers['172.30.1.14'] = 'orders-service';
  x.traffic.push(
    rec('pi', '172.30.1.14', 'dynamodb', 1400, 1410, { method: 'POST', path: '/', reqHeaders: target('PutItem'), req: { bytes: 40, text: '{"TableName":"users","Item":{}}' } }),
    rec('gi', '172.30.1.14', 'dynamodb', 1420, 1425, { method: 'POST', path: '/', status: 400, reqHeaders: target('GetItem'), req: { bytes: 40, text: '{"TableName":"users","Key":{}}' } }),
  );
  const ex = assemble(x).traces.flatMap((t) => t.exchanges);
  assert.deepEqual(['pi', 'gi'].map((id) => { const e = ex.find((y) => y.id === id)!; return [e.from, e.to, e.label, e.table, e.ok]; }),
    [['orders-service', 'dynamodb', 'PutItem users', 'users', true], ['orders-service', 'dynamodb', 'GetItem users', 'users', false]]);
  assert.equal(ex.find((e) => e.id === 'gw')?.table, undefined, 'any other http call keeps its method and path');
});

test('a proxied call takes the request it forwards as its parent, never the stream open around it', () => {
  const x = input();
  x.traffic.push(
    rec('st', ip.front, 'api-gateway', 100, 9000, { path: '/api/notifications/stream', resHeaders: { 'content-type': 'text/event-stream;charset=UTF-8' } }),
    rec('in', ip.front, 'api-gateway', 3000, 3050, { path: '/api/files/stats' }),
    rec('fw', ip.gw, 'file-service', 3005, 3056, { path: '/api/files/stats' }),
  );
  const ex = assemble(x).traces.flatMap((t) => t.exchanges);
  assert.equal(ex.find((e) => e.id === 'fw')?.parent, 'in', 'the gateway answered 6 ms before its own call ended');
});

test('a joint env: several IPs per service, a gateway per network, lanes by project, a chain across projects, SQL on each Postgres', () => {
  // ks 172.30.7.x (runner, tap), app 172.30.8.x, ledger 172.30.9.x; kafka is shared, so it is on both project networks
  const pg = (ip: string, store: string, sql: string) => parsePgLog([`${new Date(T + 1500).toISOString().slice(0, 23).replace('T', ' ')} UTC|${ip}|9|u|d|LOG:  duration: 1.000 ms  statement: ${sql}`], store);
  const ev: RunnerEvent[] = [
    { e: 'test-begin', t: T, test: 'x', title: 'comprar y asentar', file: 'comprar-y-asentar.spec.ts', story: true },
    { e: 'step-end', t: T + 3000, test: 'x', title: 'Comprar', t0: T, status: 'passed' },
    { e: 'test-end', t: T + 3100, test: 'x', status: 'passed', durationMs: 3100 },
  ];
  const traffic = [
    rec('b1', '172.30.7.50', 'ledger-web', 100, 2900, { path: '/api/entries', reqHeaders: { 'user-agent': 'HeadlessChrome' } }),
    rec('b2', '172.30.9.20', 'ledger', 110, 2800, { path: '/api/entries' }),
    rec('b3', '172.30.9.21', 'api', 200, 2500, { path: '/orders/7' }),
    rec('b4', '172.30.8.10', 'file-service', 210, 2400, { path: '/orders/7' }),
    rec('h1', '172.30.9.1', 'api', 2950, 2960, { path: '/health' }),
  ];
  const out = assemble({
    run: '3', flow: 'comprar-y-asentar', env: 'both', events: ev, runnerIp: '172.30.7.50', gatewayIp: '172.30.7.1', gatewayIps: ['172.30.7.1', '172.30.8.1', '172.30.9.1'],
    peers: { '172.30.9.20': 'ledger-web', '172.30.9.21': 'ledger', '172.30.8.10': 'api', '172.30.8.11': 'postgres', '172.30.9.22': 'ledger-postgres', '172.30.8.12': 'kafka', '172.30.9.23': 'kafka', '172.30.8.13': 'file-service' },
    traffic,
    sql: [...pg('172.30.8.13', 'postgres', 'select * from orders'), ...pg('172.30.9.21', 'ledger-postgres', 'insert into entries values (1)')],
    map: {
      repos: [{ name: 'app' }, { name: 'ledger' }],
      nodes: [
        { id: 'svc:api', type: 'service', name: 'api', repo: 'app' }, { id: 'svc:file-service', type: 'service', name: 'file-service', repo: 'app' },
        { id: 'svc:ledger', type: 'service', name: 'ledger', repo: 'ledger' }, { id: 'svc:ledger-web', type: 'service', name: 'ledger-web', repo: 'ledger' },
        { id: 'ds:postgres', type: 'datastore', name: 'postgres', repo: 'app' }, { id: 'ds:ledger-postgres', type: 'datastore', name: 'ledger-postgres', repo: 'ledger' },
      ],
      facts: [],
    },
  }).traces[0];
  const by = new Map(out.exchanges.map((e) => [e.id, e]));
  assert.equal(by.get('b2')!.from, 'ledger-web', 'its IP on the ledger network');
  assert.equal(by.get('b3')!.from, 'ledger');
  assert.equal(by.get('b4')!.from, 'api', 'its IP on the app network');
  assert.equal(by.get('h1')!.from, 'host', 'every network\'s gateway is the host');
  // the parent chain: browser → ledger-web → ledger → api → file-service
  assert.equal(by.get('b2')!.parent, 'b1');
  assert.equal(by.get('b3')!.parent, 'b2');
  assert.equal(by.get('b4')!.parent, 'b3');
  const sql = out.exchanges.filter((e) => e.kind === 'sql');
  assert.deepEqual(sql.map((e) => `${e.from}→${e.to}`).sort(), ['file-service→postgres', 'ledger→ledger-postgres'], 'each statement on its own Postgres');
  assert.equal(out.participants.find((p) => p.id === 'ledger')?.project, 'ledger');
  assert.equal(out.participants.find((p) => p.id === 'postgres')?.project, 'app');
  assert.equal(out.participants.find((p) => p.id === 'browser')?.project, undefined);
  // one project: no project on any participant
  const single = assemble({ ...input(), map: { ...input().map!, repos: [{ name: 'vaultflow' }] } }).traces[0];
  assert.ok(single.participants.every((p) => p.project === undefined));
});

test('Postgres log: a bind line\'s parameters never reach the statement before it; each statement keeps its backend pid', () => {
  const at = (ms: number, pid: number, rest: string) => `2027-01-15 08:00:01.${ms} UTC|172.30.1.12|${pid}|u|d|${rest}`;
  const lines = parsePgLog([
    at(300, 77, 'LOG:  duration: 0.500 ms  execute <unnamed>: select * from a where id = $1'),
    at(300, 77, "DETAIL:  parameters: $1 = 'A'"),
    at(301, 77, 'LOG:  duration: 0.010 ms  bind <unnamed>: update b set s = $1 where id = $2'),
    at(301, 77, "DETAIL:  parameters: $1 = 'CLEAN', $2 = 'B'"),
    at(302, 77, 'LOG:  duration: 0.300 ms  execute <unnamed>: update b set s = $1 where id = $2'),
    at(302, 77, "DETAIL:  parameters: $1 = 'CLEAN', $2 = 'B'"),
    at(303, 78, 'LOG:  duration: 0.100 ms  execute <unnamed>: select 2 from c where x = $1'),
    at(303, 79, "DETAIL:  parameters: $1 = 'other backend'"),
    at(304, 78, "DETAIL:  parameters: $1 = 'C'"),
  ], 'postgres');
  assert.deepEqual(lines.map((l) => [l.params, l.pid]), [["$1 = 'A'", 77], ["$1 = 'CLEAN', $2 = 'B'", 77], ["$1 = 'C'", 78]], 'another backend\'s line in between changes nothing');
  // two backends interleaved: each DETAIL goes to its own backend's statement, not to the latest one
  const crossed = parsePgLog([
    at(400, 80, 'LOG:  duration: 0.100 ms  execute <unnamed>: select * from d where id = $1'),
    at(400, 81, 'LOG:  duration: 0.100 ms  execute <unnamed>: select * from e where id = $1'),
    at(401, 80, "DETAIL:  parameters: $1 = 'D'"),
    at(401, 81, "DETAIL:  parameters: $1 = 'E'"),
  ], 'postgres');
  assert.deepEqual(crossed.map((l) => [l.statement.split(' ')[3], l.params]), [['d', "$1 = 'D'"], ['e', "$1 = 'E'"]]);
});

test('a statement\'s connection is its store and pid; the person\'s actions become relative, with their step and never a value', () => {
  const x = input();
  x.events = [...events.slice(0, 3),
    { e: 'action', t: T + 300, test: 'a', t0: T + 250, ms: 40, kind: 'navigate', path: '/login' },
    { e: 'action', t: T + 1500, test: 'a', t0: T + 1400, ms: 30, kind: 'fill', target: "getByPlaceholder('Ingresa tu contraseña')" },
    { e: 'action', t: T + 4500, test: 'b', t0: T + 4400, ms: 10, kind: 'click', target: "getByText('x')" },
    ...events.slice(3)];
  const { traces: [a, b] } = assemble(x);
  assert.equal(a.exchanges.find((e) => e.kind === 'sql')?.conn, 'postgres#77');
  assert.deepEqual(a.actions, [{ t0: 100, t1: 140, kind: 'navigate', path: '/login', step: 1 }, { t0: 1250, t1: 1280, kind: 'fill', target: "getByPlaceholder('Ingresa tu contraseña')", step: 2 }]);
  assert.equal(b.actions?.length, 1);
  assert.equal(assemble(input()).traces[0].actions, undefined, 'no marks, no field');
});

test('Postgres behind the tap: a statement is its connection opener\'s, and carries what it returned', () => {
  const at = new Date(T + 1500).toISOString().slice(0, 23).replace('T', ' ');
  const x = input();
  // the server sees the tap (172.30.1.254); the tap saw file-service open backend 88 and what the statement returned
  x.sql = parsePgLog([`${at} UTC|172.30.1.254|88|u|d|LOG:  duration: 1.000 ms  execute S_1: select id, name from file_service.files where owner = $1`], 'postgres');
  x.traffic.push({ v: 1, id: 'pg1', kind: 'pg', t0: T + 1500, t1: T + 1500, from: ip.files, svc: 'postgres', port: 5432,
    pg: { pid: 88, stmt: 'select id, name\n  from file_service.files where owner = $1', cols: ['id', 'name'], rows: [['7f', 'a.txt']], more: 0, tag: 'SELECT 1' } });
  // another Postgres with a backend of the same pid, opened by someone else: never mixed with this one
  x.traffic.push({ v: 1, id: 'pg2', kind: 'pg', t0: T + 1500, t1: T + 1500, from: ip.gw, svc: 'audit-postgres', port: 5432,
    pg: { pid: 88, stmt: 'select id, name from file_service.files where owner = $1', cols: ['x'], rows: [['other']], more: 0, tag: 'SELECT 1' } });
  const ex = assemble(x).traces[0].exchanges;
  const sql = ex.find((e) => e.kind === 'sql')!;
  assert.equal(sql.from, 'file-service', 'by the backend pid, not by the address the server saw');
  assert.deepEqual(sql.result, { cols: ['id', 'name'], rows: [['7f', 'a.txt']], more: 0, tag: 'SELECT 1' });
  assert.equal(ex.some((e) => e.id === 'pg1'), false, 'a result is never a hop of its own');
});
