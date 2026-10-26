/** The sentences of «Paso a paso» and «Cadena»: one case per row of the spec's tables, on vaultflow's own traces. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Fact, MapNode } from '@laru/core';
import type { Action, Exchange, Participant } from '@laru/trace';
import { chain, type Act } from '@laru/trace/chain';
import type { DocPiece } from '../src/api.ts';
import { layoutSeq } from '../src/lib/seq.ts';
import { actSummary, at as atMs, chip, markSaid, say, sayCause, sayCtx, sayOrphan, statusText, targetOf, type SayCtx, type SayTrace } from '../src/lib/say.ts';

type T = SayTrace & { test: string; durationMs: number };
const load = (f: string): T[] => JSON.parse(readFileSync(new URL(`../../../packages/trace/test/fixtures/${f}`, import.meta.url), 'utf8'));
const FILES = ['limpio-42.json', 'infectado-44.json', 'papelera-42-window.json', 'limpio-31.json', 'limpio-32.json', 'registro-4.json'];
const [limpio, pendiente, sinSesion] = load('limpio-42.json');
const [infectado] = load('infectado-44.json');

// The part of vaultflow's map and knowledge the sentences read.
const ep = (service: string, method: string, path: string, handler?: string): MapNode => ({ id: `ep:${service}:${method} ${path}`, type: 'endpoint', name: `${method} ${path}`, service: `svc:${service}`, attrs: { method, path, ...(handler ? { handler } : {}) } });
const fact = (s: string, p: string, o: string, more: Partial<Fact> = {}) => ({ s, p, o, origin: 'extracted', ...more }) as Fact;
const MAP = {
  nodes: [
    ep('file-service', 'POST', '/api/files/upload', 'FileController.upload'), ep('file-service', 'GET', '/api/files', 'FileController.listFiles'),
    ep('file-service', 'GET', '/api/files/{fileId}', 'FileController.getFileInfo'), ep('file-service', 'GET', '/api/files/{fileId}/download', 'FileController.download'),
    ep('file-service', 'GET', '/api/files/quarantine', 'FileController.listQuarantine'), ep('file-service', 'GET', '/api/files/folders', 'FileController.listFolders'),
    ep('file-service', 'GET', '/api/files/stats', 'FileController.stats'), ep('api-gateway', 'GET', '/api/files/**', 'ProxyController.proxyFiles'),
    ep('api-gateway', 'POST', '/api/files/**', 'ProxyController.proxyFiles'), ep('api-gateway', 'POST', '/api/auth/register', 'AuthController.register'),
    { id: 'ds:minio', type: 'datastore', name: 'minio', kind: 'file' }, { id: 'ds:postgres', type: 'datastore', name: 'postgres', kind: 'relational' }, { id: 'ds:kafka', type: 'datastore', name: 'kafka', kind: 'queue' },
  ] as MapNode[],
  facts: [
    fact('svc:frontend', 'calls', 'ep:api-gateway:GET /api/files/**', { note: 'via proxy /api/' }),
    fact('svc:antivirus-service', 'consumes', 'topic:file.uploaded', { anchor: { repo: 'v', commit: 'c', path: 'ScanConsumer.java', line: 24, symbol: 'ScanConsumer.onFileUploaded' } }),
    fact('svc:file-service', 'consumes', 'topic:file.clean', { anchor: { repo: 'v', commit: 'c', path: 'ScanResultConsumer.java', line: 9, symbol: 'ScanResultConsumer.onFileClean' } }),
    fact('svc:file-service', 'publishes', 'topic:file.uploaded'), fact('svc:a', 'publishes', 'topic:x.shared'), fact('svc:b', 'publishes', 'topic:x.shared'),
  ],
};
const piece = (id: string, type: string, title: string, fields: Record<string, unknown>) => ({ id, type, title, status: 'active', summary: '', fields }) as unknown as DocPiece;
const PIECES = [
  piece('ctr:api-de-ficheros', 'contract', 'API de subida y descarga', {
    operations: [{ method: 'GET', path: '/api/files', service: 'svc:file-service', summary: 'Ficheros del usuario, opcionalmente de una carpeta' }, { method: 'GET', path: '/api/files/{fileId}/download', service: 'svc:file-service', summary: '403 si no está limpio' },
      { method: 'POST', path: '/api/files/upload', service: 'svc:file-service', summary: 'Un fichero, multipart, con folderId opcional' }],
    events: [{ topic: 'file.uploaded', direction: 'publishes', service: 'svc:file-service', payload: 'fileId, storedName, originalName, bucket, ownerId' }],
    errors: [{ status: '400', when: 'Cualquier error de negocio' }, { status: '403', when: 'El fichero no está limpio, o no es tuyo ni compartido contigo' }],
  }),
  piece('dm:datos', 'data-model', 'Datos de VaultFlow', { entities: [{ entity: 'Usuario', table: 'gateway.users', owner: 'svc:api-gateway' }, { entity: 'Fichero', table: 'file_service.files', owner: 'svc:file-service' }] }),
];
const ctxOf = (t: SayTrace, more: { map?: typeof MAP | null; pieces?: DocPiece[] } = {}): SayCtx => sayCtx({ trace: t, rows: layoutSeq({ durationMs: 0, ...t }).rows, map: 'map' in more ? more.map : MAP, pieces: more.pieces ?? PIECES });
/** The sentence of an exchange's request row (or its response row). */
const row = (ctx: SayCtx, e: Exchange, reply = false) => say({ kind: 'row', i: ctx.rows.find((r) => r.ex.id === e.id && r.reply === reply)!.i }, ctx);
const at = (t: SayTrace, t0: number, from: string, to: string, label = '') => {
  const x = t.exchanges.filter((e) => e.t0 === t0 && e.from === from && e.to === to && e.label.startsWith(label));
  assert.equal(x.length, 1, `${t0} ${from}→${to} ${label}`);
  return x[0];
};
const act = (ctx: SayCtx, a: Act) => say({ kind: 'act', act: a }, ctx);
const L = ctxOf(limpio);

test('acts without marks: preparation, bursts by step, a page opened, the test\'s checks, a case\'s calls ×N', () => {
  assert.deepEqual(L.chain.acts.map((a) => act(L, a)), [
    'La prueba prepara datos por la API antes del primer paso: POST /api/auth/register.',
    'El navegador abre /login (paso 1, «Iniciar sesión»).',
    'El navegador envía POST /api/auth/login (paso 1, «Iniciar sesión»).',
    'El navegador envía POST /api/files/upload (paso 2, «Subir informe.pdf»).',
    'El navegador envía GET /api/files (paso 3, «Escanear el fichero»).',
    'La prueba comprueba por la API: GET /api/files/{fileId} (no lo hace la persona).',
    'El navegador envía GET /api/files/{fileId}/download (paso 5, «Descargarlo»).',
    'El navegador envía GET /api/files/{fileId}/download (paso 5, «Descargarlo»).',
  ]);
  const P = ctxOf(pendiente);
  assert.equal(act(P, P.chain.acts.at(-1)!), 'El caso llama a la API: GET /api/files/{fileId} ×2.');
  const S = ctxOf(sinSesion);
  assert.equal(act(S, S.chain.acts[0]), 'El caso llama a la API: POST /api/files/upload.', 'the call\'s own path, not the gateway\'s wildcard rule');
});

const MARKS: Action[] = [
  { t0: 500, t1: 506, kind: 'navigate', path: '/login' },
  { t0: 990, t1: 1000, kind: 'fill', target: "getByPlaceholder('Ingresa tu usuario')" },
  { t0: 1005, t1: 1015, kind: 'fill', target: "getByPlaceholder('Ingresa tu contraseña')" },
  { t0: 1020, t1: 1031, kind: 'click', target: "getByRole('button', { name: 'Iniciar Sesión', exact: true })" },
  { t0: 1300, t1: 1320, kind: 'click', target: "getByRole('button', { name: 'Subir', exact: true })" },
  { t0: 1400, t1: 1420, kind: 'click', target: "getByText('explora', { exact: true })" },
  { t0: 1670, t1: 1686, kind: 'files' },
  { t0: 7100, t1: 7110, kind: 'click', target: 'getByRole(\'button\').filter({ has: locator(\'path[d^="M14.857 17.082"]\') })' },
  { t0: 7180, t1: 7185, kind: 'click' },
  { t0: 7200, t1: 7450, kind: 'click', target: "getByRole('main').getByText('informe.pdf', { exact: true })" },
  { t0: 7460, t1: 7850, kind: 'click', target: "getByRole('button', { name: 'Descargar' }).first()" },
];
test('acts with marks: what the person does, a click that sends nothing, the file picked, the page on its own', () => {
  const M = ctxOf({ ...limpio, actions: MARKS });
  assert.deepEqual(M.chain.acts.filter((a) => a.kind === 'person' || a.kind === 'page').map((a) => act(M, a)), [
    'La persona abre /login.',
    'La persona escribe en «Ingresa tu usuario» y en «Ingresa tu contraseña» y pulsa el botón «Iniciar Sesión».',
    'La persona pulsa el botón «Subir». No sale ninguna petición: solo cambia la página.',
    'La persona pulsa «explora». No sale ninguna petición: solo cambia la página.',
    'La persona elige informe.pdf (602 B).',
    'La página pide GET /api/files por su cuenta: la persona no hizo nada en el último segundo.',
    'La persona pulsa un botón sin nombre. No sale ninguna petición: solo cambia la página.',
    'La persona pulsa en un punto de la página. No sale ninguna petición: solo cambia la página.',
    'La persona pulsa «informe.pdf».',
    'La persona pulsa el botón «Descargar».',
  ]);
  const upload = at(limpio, 1687, 'browser', 'frontend');
  assert.equal(sayCause(upload, M), 'Lo pide el navegador tras «elige informe.pdf (602 B)».');
  const keys = chain({ exchanges: [], steps: [], actions: [{ t0: 1, t1: 2, kind: 'press', key: 'Enter', target: 'x' }, { t0: 3, t1: 4, kind: 'click', target: 'x' }, { t0: 5, t1: 6, kind: 'press', target: 'x' }] });
  const K = { ...M, chain: keys };
  assert.deepEqual(keys.acts.map((a) => act(K, a)), ['La persona pulsa la tecla Enter y pulsa un elemento sin nombre. No sale ninguna petición: solo cambia la página.', 'La persona pulsa una tecla. No sale ninguna petición: solo cambia la página.']);
});

test('targetOf: the last naming segment, in the locator form Playwright reports and the internal selector form', () => {
  assert.deepEqual(targetOf("getByRole('button', { name: 'Subir', exact: true })"), { role: 'button', name: 'Subir' });
  assert.deepEqual(targetOf('internal:role=button[name="Subir"i]'), { role: 'button', name: 'Subir' });
  assert.deepEqual(targetOf("getByRole('row').filter({ hasText: 'eicar.txt' }).getByRole('button', { name: 'ZIP' })"), { role: 'button', name: 'ZIP' });
  assert.deepEqual(targetOf("getByLabel('Correo')"), { role: 'textbox', name: 'Correo' });
  assert.deepEqual(targetOf('internal:attr=[placeholder="Ingresa tu usuario"i]'), { role: 'textbox', name: 'Ingresa tu usuario' });
  assert.deepEqual(targetOf("getByText('it\\'s')"), { role: undefined, name: "it's" });
  assert.deepEqual(targetOf("locator('input[type=file]')"), {});
});

test('http requests: a page, an API call with its contract and handler, the proxy, the gateway\'s rule, service to service', () => {
  assert.equal(row(L, at(limpio, 507, 'browser', 'frontend')), 'El navegador pide la página /login a frontend.');
  assert.equal(row(L, at(limpio, 1123, 'browser', 'frontend', 'GET /api/files')), 'El navegador llama a GET /api/files: «Ficheros del usuario, opcionalmente de una carpeta». La atiende file-service (FileController.listFiles).');
  assert.equal(row(L, at(limpio, 1688, 'frontend', 'api-gateway')), 'frontend la pasa tal cual a api-gateway (proxy /api/).');
  assert.equal(row(L, at(limpio, 1689, 'api-gateway', 'file-service')), 'api-gateway la reenvía a file-service, por la regla POST /api/files/**, que la atiende con FileController.upload.');
  assert.equal(row(L, at(limpio, 417, 'runner', 'api-gateway')), 'La prueba llama a POST /api/auth/register. La atiende api-gateway (AuthController.register).');
  const svc: Participant[] = [...limpio.participants, { id: 'report-service', name: 'report-service', type: 'service' }];
  const call = (path: string): Exchange => ({ id: 's2s', kind: 'http', from: 'file-service', to: 'report-service', t0: 9000, t1: 9001, label: `POST ${path}`, method: 'POST', path, status: 200, ok: true, origin: 'observed' });
  const S = ctxOf({ ...limpio, participants: svc, exchanges: [call('/x/7')] }, { map: { ...MAP, nodes: [...MAP.nodes, ep('report-service', 'POST', '/x/{id}')] } });
  assert.equal(row(S, call('/x/7')), 'file-service llama a report-service: POST /x/{id}.');
  const U = ctxOf({ ...limpio, participants: svc, exchanges: [call('/y')] });
  assert.equal(row(U, call('/y')), 'file-service llama a report-service: POST /y (report-service no tiene ese endpoint entre los extraídos del código).');
  const noMap = ctxOf(limpio, { map: null, pieces: [] });
  assert.equal(row(noMap, at(limpio, 1123, 'browser', 'frontend', 'GET /api/files')), 'El navegador llama a GET /api/files. La atiende file-service.');
});

test('object stores, the stream, assets; DynamoDB and WebSocket on synthetic rows', () => {
  assert.equal(row(L, at(limpio, 1691, 'file-service', 'minio')), 'file-service sube 40fd…_informe.pdf al bucket quarantine de minio (602 B).');
  assert.equal(row(L, at(limpio, 1723, 'file-service', 'minio')), 'file-service copia quarantine/40fd…_informe.pdf a files/40fd…_informe.pdf.');
  assert.equal(row(L, at(limpio, 1706, 'antivirus-service', 'minio')), 'antivirus-service lee 40fd…_informe.pdf del bucket quarantine de minio.');
  assert.equal(row(L, at(limpio, 1728, 'file-service', 'minio')), 'file-service borra 40fd…_informe.pdf del bucket quarantine de minio.');
  const I = ctxOf(infectado);
  assert.equal(row(I, at(infectado, 2082, 'file-service', 'minio')), 'file-service comprueba el bucket quarantine de minio.');
  assert.equal(row(L, at(limpio, 1132, 'browser', 'frontend')), 'El navegador abre el canal de avisos con frontend (SSE, /api/notifications/stream).');
  assert.equal(row(L, at(limpio, 1132, 'frontend', 'api-gateway')), 'frontend abre el canal de avisos con api-gateway (SSE, /api/notifications/stream).');
  assert.equal(row(L, at(limpio, 513, 'browser', 'frontend')), '10 recursos estáticos (JS, CSS, imágenes) en 23 ms.');
  const base = { kind: 'http', from: 'orders-service', t0: 1, t1: 2, ok: true, origin: 'observed', status: 200, method: 'POST', path: '/' } as const;
  const dyn: Exchange[] = [['Query', 'lee de'], ['PutItem', 'escribe en'], ['UpdateItem', 'actualiza en'], ['DeleteItem', 'borra de'], ['ExecuteStatement', 'ejecuta PartiQL sobre']]
    .map(([op], i) => ({ ...base, id: `d${i}`, to: 'dynamodb', label: `${op} users`, table: 'users', reqHeaders: { 'x-amz-target': `DynamoDB_20120810.${op}` } }));
  const ws: Exchange = { ...base, id: 'ws', kind: 'ws', to: 'chat', label: 'GET /ws', method: 'GET', path: '/ws', status: 101 };
  const D = ctxOf({ ...limpio, exchanges: [...dyn, ws] });
  assert.deepEqual(dyn.map((e) => row(D, e)), ['lee de', 'escribe en', 'actualiza en', 'borra de', 'ejecuta PartiQL sobre'].map((v, i) => `orders-service ${v} la tabla users de dynamodb (${['Query', 'PutItem', 'UpdateItem', 'DeleteItem', 'ExecuteStatement'][i]}).`));
  assert.equal(row(D, ws), 'orders-service abre un WebSocket con chat en /ws.');
});

test('http responses: an object\'s status, an array\'s, an error\'s message, the contract hint only from the operation\'s service', () => {
  assert.equal(row(L, at(limpio, 1689, 'api-gateway', 'file-service'), true), 'file-service responde 201 (creado) en 12 ms, con scanStatus PENDING.');
  assert.equal(row(L, at(limpio, 1724, 'browser', 'frontend'), true), 'frontend responde 200 (correcto) en 6 ms, con 1 elemento: scanStatus PENDING.');
  const P = ctxOf(pendiente);
  const down = pendiente.exchanges.filter((e) => e.status === 403);
  assert.equal(row(P, down.find((e) => e.to === 'file-service')!, true), 'file-service responde 403 (prohibido). El contrato «API de subida y descarga» lo prevé: «El fichero no está limpio, o no es tuyo ni compartido contigo».');
  assert.equal(row(P, down.find((e) => e.to === 'api-gateway')!, true), 'api-gateway responde 403 (prohibido).');
  const S = ctxOf(sinSesion);
  assert.equal(row(S, sinSesion.exchanges[0], true), 'api-gateway responde 403 (prohibido).', '«Subir sin sesión»: the gateway refused it, file-service\'s contract does not apply');
  const fs = at(limpio, 1689, 'api-gateway', 'file-service');
  const conflict = { ...fs, id: 'c', status: 409, ok: false, res: { bytes: 30, text: '{"error":"Ya existe","timestamp":"x"}' } };
  assert.equal(row(ctxOf({ ...limpio, exchanges: [conflict] }), conflict, true), 'file-service responde 409 (conflicto): «Ya existe». El contrato no lo lista entre sus errores.');
  const [reg] = load('registro-4.json');
  const refused = reg.exchanges.find((e) => e.error)!;
  assert.equal(row(ctxOf(reg), refused, true), 'La llamada falla sin respuesta: connect ECONNREFUSED 0.250.250.254:8084.', 'run 4: the tap answers 502 for a refused connection');
  const open = { ...fs, id: 'o', t1: undefined };
  assert.match(row(ctxOf({ ...limpio, exchanges: [open] }), open), /file-service no responde dentro de la ventana de la prueba\.$/);
  assert.deepEqual([200, 201, 204, 302, 401, 403, 404, 500, 502, 504, 418].map(statusText), ['200 (correcto)', '201 (creado)', '204 (sin contenido)', '302 (redirige)', '401 (sin sesión)', '403 (prohibido)', '404 (no existe)', '500 (error interno)', '502 (pasarela sin respuesta válida)', '504 (pasarela sin respuesta a tiempo)', '418']);
});

test('mock suffixes: who answered, a miss, a broken contract', () => {
  const I = ctxOf(infectado);
  assert.equal(row(I, at(infectado, 2412, 'antivirus-service', 'clamav')), 'antivirus-service manda 86 B a clamav para analizarlo y clamav responde: infectado (Eicar-Test-Signature). Responde el mock de Laru (script), no clamav real.');
  const base: Exchange = { id: 'm', kind: 'http', from: 'file-service', to: 'pagos', t0: 1, t1: 2, label: 'POST /pay', method: 'POST', path: '/pay', status: 200, ok: true, origin: 'observed' };
  const miss = { ...base, id: 'miss', mock: 'miss', ok: false, status: 404 }, drift = { ...base, id: 'drift', mock: 'contract', drift: ['falta el campo amount'] };
  const M = ctxOf({ ...limpio, exchanges: [miss, drift] });
  assert.match(row(M, miss, true), /El mock no tiene respuesta para esto\.$/);
  assert.match(row(M, drift, true), /Responde el mock de Laru \(contract\), no pagos real\. No cumple el contrato del mock: falta el campo amount\.$/);
});

test('sql: an entity read, another service\'s table, a new row, the status an UPDATE leaves, a refusal', () => {
  assert.equal(row(L, at(limpio, 1708, 'file-service', 'postgres')), 'file-service lee «Fichero» (file_service.files).');
  assert.equal(row(L, at(limpio, 1699, 'file-service', 'postgres')), 'file-service guarda una fila nueva de «Fichero» en file_service.files.');
  assert.equal(row(L, at(limpio, 1731, 'file-service', 'postgres')), "file-service actualiza «Fichero» y deja scan_status = 'CLEAN'.");
  assert.equal(row(ctxOf(infectado), at(infectado, 9657, 'file-service', 'postgres')), 'file-service lee «Usuario» (gateway.users, tabla de api-gateway).');
  assert.equal(row(ctxOf(limpio, { pieces: [] }), at(limpio, 1708, 'file-service', 'postgres')), 'file-service lee de file_service.files.');
  const upd = at(limpio, 1731, 'file-service', 'postgres');
  const cut = { ...upd, id: 'cut', req: { bytes: 1, text: upd.req!.text!.replace(/, \$1[0-4] = .*$/, '') } };
  const sql = (id: string, label: string, text: string, more: Partial<Exchange> = {}): Exchange => ({ id, kind: 'sql', from: 'file-service', to: 'postgres', t0: 1, t1: 1, label, ok: true, origin: 'observed', table: label.split(' ')[1], req: { bytes: 1, text }, ...more });
  const del = sql('del', 'DELETE file_service.files', 'delete from file_service.files where id=$1'), call = sql('call', 'CALL', 'call purge()');
  const bad = sql('bad', 'INSERT file_service.files', 'insert …', { ok: false, error: 'duplicate key value violates unique constraint "files_pkey"\nDETAIL: x' });
  const S = ctxOf({ ...limpio, exchanges: [cut, del, call, bad] });
  assert.equal(row(S, cut), 'file-service actualiza «Fichero» y deja scan_status.', 'a value only when every placeholder has its parameter (R6)');
  assert.equal(row(S, del), 'file-service borra «Fichero» en file_service.files.');
  assert.equal(row(S, call), 'file-service ejecuta CALL en postgres.');
  assert.equal(row(S, bad), 'postgres rechaza la sentencia: duplicate key value violates unique constraint "files_pkey".');
  // an entity's gender or number never has to agree: «Carpeta», «Compartición» (runs 42 and 55)
  const folders = [...PIECES, piece('dm:carpetas', 'data-model', 'Carpetas', { entities: [{ entity: 'Carpeta', table: 'file_service.folders', owner: 'svc:file-service' }] })];
  const ins = sql('ins', 'INSERT file_service.folders', 'insert into file_service.folders (id) values ($1)');
  assert.equal(row(ctxOf({ ...limpio, exchanges: [ins] }, { pieces: folders }), ins), 'file-service guarda una fila nueva de «Carpeta» en file_service.folders.');
});

test('kafka: what a publish carries, a delivery the code declares and what follows it, an ambiguous publisher', () => {
  assert.equal(row(L, limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9')!), 'file-service publica file.uploaded en kafka: fileId, storedName, bucket, originalName y 4 más.');
  assert.equal(row(L, limpio.exchanges.find((e) => e.id === 'kafka:file.clean:1:8')!), 'antivirus-service publica file.clean en kafka: fileId, storedName, originalName, ownerId y 2 más, con status CLEAN.');
  assert.equal(row(L, limpio.exchanges.find((e) => e.id === 'kafka:file.uploaded:1:9>antivirus-service')!), 'antivirus-service recibe file.uploaded en ScanConsumer.onFileUploaded. Lo dice el código: la entrega no se ve en la red. Lo primero que hace después se ve 5 ms más tarde.');
  const k = (id: string, from: string, to: string, more: Partial<Exchange> = {}): Exchange => ({ id, kind: 'kafka', from, to, t0: 9000, label: 'file.uploaded', topic: 'file.uploaded', ok: true, origin: 'derived', ...more });
  const pub = k('kafka:file.uploaded:0:1', 'file-service', 'kafka'), lone = k('kafka:file.uploaded:0:1>antivirus-service', 'kafka', 'antivirus-service');
  const amb = k('kafka:x.shared:0:1', 'publicador ambiguo', 'kafka', { label: 'x.shared', topic: 'x.shared' });
  const K = ctxOf({ ...limpio, exchanges: [pub, lone, amb] });
  assert.equal(row(K, pub), 'file-service publica file.uploaded en kafka: fileId, storedName, originalName, bucket y ownerId.', 'the contract\'s payload when the trace has no body');
  assert.match(row(K, lone), /No se ve que haga nada después en esta prueba\.$/);
  // its first work logged a millisecond before the delivery's time (run 42 «Compartir un fichero pendiente», 193 and 194): at once
  const pub2 = k('kafka:file.clean:1:9', 'antivirus-service', 'kafka', { t0: 190, label: 'file.clean', topic: 'file.clean' }), got = k('kafka:file.clean:1:9>file-service', 'kafka', 'file-service', { t0: 194, label: 'file.clean', topic: 'file.clean' });
  const first: Exchange = { id: 'q', kind: 'sql', from: 'file-service', to: 'postgres', t0: 193, t1: 193, label: 'SELECT file_service.files', ok: true, origin: 'observed', table: 'file_service.files', req: { bytes: 8, text: 'select 1' } };
  const E = ctxOf({ ...limpio, exchanges: [pub2, got, first] });
  assert.equal(E.chain.cause.get('q')?.parent, got.id);
  assert.match(row(E, got), /Lo primero que hace se ve en ese mismo momento\.$/);
  assert.equal(row(K, amb), 'Alguien publica x.shared: el código tiene 2 publicadores (a, b) y la traza no dice cuál.');
  assert.equal(sayOrphan(K.chain.orphans.find((o) => o.id === amb.id)!, K), 'Alguien publica x.shared: el código tiene 2 publicadores (a, b) y la traza no dice cuál.');
});

test('sse: the emitter, each relay, the arrival, the greeting', () => {
  assert.equal(row(L, at(limpio, 1721, 'api-gateway', 'notification-service', 'evento FILE_CLEAN')), 'notification-service envía el aviso FILE_CLEAN por el canal abierto: informe.pdf.');
  assert.equal(row(L, at(limpio, 1721, 'frontend', 'api-gateway', 'evento FILE_CLEAN')), 'api-gateway pasa el aviso a frontend.');
  assert.equal(row(L, at(limpio, 1722, 'browser', 'frontend', 'evento FILE_CLEAN')), 'El aviso FILE_CLEAN llega al navegador.');
  assert.equal(row(L, at(limpio, 1136, 'api-gateway', 'notification-service')), 'Se abre el canal: notification-service saluda con «connected».');
  // the hops nearer the browser do not greet: they pass the greeting on
  const hello = limpio.exchanges.filter((e) => e.kind === 'sse' && e.label === 'evento connected' && e.from !== 'api-gateway');
  assert.deepEqual(hello.map((e) => row(L, e)).sort(), ['api-gateway pasa el saludo «connected» a frontend.', 'frontend pasa el saludo «connected» al navegador.']);
});

test('tcp from the label: clean, infected, an error, anything else', () => {
  assert.equal(row(L, at(limpio, 1708, 'antivirus-service', 'clamav')), 'antivirus-service manda 620 B a clamav para analizarlo y clamav responde: limpio.');
  const t = (id: string, label: string): Exchange => ({ id, kind: 'tcp', from: 'antivirus-service', to: 'clamav', t0: 1, t1: 2, label, ok: true, origin: 'observed', req: { bytes: 86 }, res: { bytes: 35 } });
  const T = ctxOf({ ...limpio, exchanges: [t('e', 'stream: Size limit ERROR'), t('o', 'PONG'), t('b', '86 B ↑ 35 B ↓')] });
  assert.equal(row(T, t('e', '')), 'antivirus-service manda 86 B a clamav para analizarlo y clamav responde con error: stream: Size limit ERROR.');
  assert.equal(row(T, t('o', '')), 'antivirus-service abre una conexión con clamav: 86 B enviados, 35 B recibidos; la respuesta empieza por «PONG».');
  assert.equal(row(T, t('b', '')), 'antivirus-service abre una conexión con clamav: 86 B enviados, 35 B recibidos.');
});

test('faults: the five labels the tap writes, on runs 31 and 32 and synthetic rows', () => {
  const [lat] = load('limpio-31.json'), [ab] = load('limpio-32.json');
  const slow = lat.exchanges.find((e) => e.fault === 'latencia +800 ms inyectada')!;
  assert.match(row(ctxOf(lat), slow), new RegExp(`Laru retrasa esta llamada 800 ms antes de pasarla a ${slow.to}\\.$`));
  const cut = ab.exchanges.find((e) => e.fault === 'abortado')!;
  assert.match(row(ctxOf(ab), cut), new RegExp(`Laru corta la conexión: ${cut.from} se queda sin respuesta\\.`));
  const f = (id: string, fault: string): Exchange => ({ id, kind: 'http', from: 'file-service', to: 'minio', t0: 1, t1: 2, label: 'GET /b/k', method: 'GET', path: '/b/k', status: 200, ok: true, origin: 'observed', fault });
  const rows = [f('s', 'estado 503 inyectado'), f('n', 'sin respuesta'), f('w', 'ancho de banda 1024 B/s tras 4096 B'), f('w0', 'ancho de banda 512 B/s')];
  const F = ctxOf({ ...limpio, exchanges: rows });
  assert.deepEqual(rows.map((e) => row(F, e).replace(/^.*?\. /, '')), [
    'Laru no deja pasar esta llamada y responde 503 en nombre de minio.', 'Laru retiene la llamada sin responder: file-service espera hasta su tiempo límite.',
    'Laru limita la respuesta a 1024 B/s a partir del byte 4096.', 'Laru limita la respuesta a 512 B/s.',
  ]);
});

test('the failure stop: where it fails, what was expected, no hop failed, what the browser last received', () => {
  assert.equal(say({ kind: 'fail' }, L), [
    "Aquí falla la prueba, en el paso 2 «Subir informe.pdf»: Error: expect(locator).toBeVisible() failed · Locator: getByRole('main').getByText('Pendiente', { exact: true }) · Expected: visible · Timeout: 2000ms.",
    'Se esperaba: Aparece en la lista como pendiente.',
    'Ningún salto entre servicios falló: el fallo está en la página.',
    'Lo último que recibió el navegador antes del fallo: GET /api/files → 200 con scanStatus PENDING (0:01.730).',
  ].join('\n'));
  const S = ctxOf(sinSesion);
  assert.match(say({ kind: 'fail' }, S), /^Aquí falla el caso: .*\nEl primer salto que falló: api-gateway responde 403 \(prohibido\)\.$/);
});

test('times before the video\'s first frame read 0:00.000 (run 4, «Contraseña incorrecta» starts 528 ms before it)', () => {
  const [, wrong] = load('registro-4.json');
  const W = ctxOf(wrong);
  assert.ok(wrong.exchanges.some((e) => e.t0 < 0));
  const said = [say({ kind: 'fail' }, W), ...wrong.exchanges.map((e) => sayCause(e, W))].join('\n');
  assert.doesNotMatch(said, /-\d|\d:-/, said);
  assert.deepEqual([-463, 0, 999.6, 61234].map((t) => atMs(t)), ['0:00.000', '0:00.000', '0:01.000', '1:01.234']);
});

test('causes: each way a hop is caused, the reason a link was narrowed, the chip of a possible one', () => {
  const cause = (t0: number, from: string, to: string, label = '') => sayCause(at(limpio, t0, from, to, label), L);
  assert.equal(cause(1688, 'frontend', 'api-gateway'), 'La misma petición, reenviada por frontend.');
  assert.equal(sayCause(limpio.exchanges.find((e) => e.id === 'kafka:file.clean:1:8>file-service')!, L), 'La entrega del mensaje que publicó antivirus-service (mismo tema, partición y offset).');
  assert.equal(cause(1721, 'frontend', 'api-gateway', 'evento FILE_CLEAN'), 'El mismo aviso, un tramo antes.');
  assert.equal(cause(1136, 'api-gateway', 'notification-service'), 'La apertura del canal de api-gateway: su fila sale al cerrarse y no se cerró en la prueba.');
  assert.equal(cause(1699, 'file-service', 'postgres'), 'Ocurre mientras file-service atendía POST /api/files/upload.');
  assert.equal(cause(1722, 'file-service', 'postgres'), 'file-service lo hace al procesar file.clean.');
  assert.equal(cause(1724, 'browser', 'frontend'), 'La página reacciona al aviso FILE_CLEAN que acaba de llegar.');
  assert.equal(cause(1727, 'file-service', 'postgres'), 'Ocurre mientras file-service atendía GET /api/files · misma sentencia que en GET /api/files (0:01.708).');
  assert.equal(cause(1728, 'file-service', 'minio'), 'file-service lo hace al procesar file.clean · por el identificador 40fd…, que solo trae file.clean.');
  assert.equal(cause(1132, 'browser', 'frontend'), 'Lo pide el navegador (tanda 2 del paso 1).');
  const trio = limpio.exchanges.find((e) => e.t0 === 1127 && e.kind === 'sql')!;
  assert.equal(chip(L.chain.cause.get(trio.id)!, L), 'posible · también encaja en: GET /api/files/folders, GET /api/files/stats');
  assert.equal(chip(L.chain.cause.get(at(limpio, 1688, 'frontend', 'api-gateway').id)!, L), 'seguro');
  const stream: Exchange = { id: '5e9e9366-e89c-4e8b-8f9e-c43475fa4e6d', kind: 'http', from: 'api-gateway', to: 'notification-service', t0: 1133, t1: 7930, label: 'GET /api/notifications/stream', method: 'GET', path: '/api/notifications/stream', status: 200, ok: true, origin: 'observed', resHeaders: { 'content-type': 'text/event-stream' } };
  const W = ctxOf({ ...limpio, exchanges: [...limpio.exchanges, stream] });
  assert.equal(sayCause(at(limpio, 1136, 'api-gateway', 'notification-service'), W), 'La apertura del canal.');
  const C = { ...L, chain: { ...L.chain, cause: new Map([...L.chain.cause, [trio.id, { parent: limpio.exchanges.find((e) => e.t0 === 1125 && e.path === '/api/files/folders')!.id, how: 'inside' as const, certainty: 'inferred' as const, why: { by: 'conn' as const, conn: 'postgres#123' } }]]) } };
  assert.equal(sayCause(trio, C), 'Ocurre mientras file-service atendía GET /api/files/folders · misma conexión a postgres (pid 123).');
});

test('orphans: an unknown address, the host, work with no visible cause', () => {
  const x = (id: string, from: string, to: string, kind: Exchange['kind'] = 'http'): Exchange => ({ id, kind, from, to, t0: 9000 + ['u', 'h', 'n'].indexOf(id), t1: 9010, label: 'GET /', method: 'GET', path: '/', status: 200, ok: true, origin: 'observed' });
  const O = ctxOf({ ...limpio, exchanges: [x('u', '?172.30.1.99', 'frontend'), x('h', 'host', 'frontend'), x('n', 'batch-service', 'postgres', 'sql')] });
  assert.deepEqual(O.chain.orphans.map((o) => sayOrphan(o, O)), [
    'Viene de ?172.30.1.99: una dirección que el entorno no conoce.',
    'Tráfico de tu máquina durante la prueba: no es de esta prueba.',
    'batch-service lo hace sin una petición ni un mensaje que lo explique en esta prueba (¿una tarea programada?).',
  ]);
});

test('the act summary: services, writes, objects, topics with their consumers, notices, failures', () => {
  const upload = L.chain.acts.find((a) => a.roots.includes(at(limpio, 1687, 'browser', 'frontend').id))!;
  assert.equal(actSummary(upload, L), 'Recorre frontend, api-gateway, file-service, antivirus-service y notification-service · postgres: guarda 1 fila de «Fichero», actualiza 1 · minio: sube 1, lee 1, copia 1, borra 1 · publica file.uploaded (→ antivirus-service), file.clean (→ file-service, notification-service) · llega al navegador: FILE_CLEAN · 0 fallos');
  // two new users (run 55): «2 filas», whatever the entity's gender
  const reg: Exchange = { id: 'r', kind: 'http', from: 'runner', to: 'api-gateway', t0: 0, t1: 10, label: 'POST /api/auth/register', method: 'POST', path: '/api/auth/register', status: 201, ok: true, origin: 'observed' };
  const user = (id: string, t0: number): Exchange => ({ id, kind: 'sql', from: 'api-gateway', to: 'postgres', t0, t1: t0, label: 'INSERT gateway.users', ok: true, origin: 'observed', table: 'gateway.users', req: { bytes: 8, text: 'insert into gateway.users (id) values ($1)' } });
  const U = ctxOf({ ...limpio, steps: [], exchanges: [reg, user('u1', 2), user('u2', 4)] });
  assert.equal(actSummary(U.chain.acts[0], U), 'Recorre api-gateway · postgres: guarda 2 filas de «Usuario» · 0 fallos');
  const file: Exchange = { ...user('f1', 6), label: 'INSERT file_service.files', table: 'file_service.files' };
  const V = ctxOf({ ...limpio, steps: [], exchanges: [reg, user('u1', 2), user('u2', 4), file] });
  assert.equal(actSummary(V.chain.acts[0], V), 'Recorre api-gateway · postgres: guarda 2 filas de «Usuario» y 1 de «Fichero» · 0 fallos', 'one verb for every entity');
  // run 55: the browser's upload and frontend's forward span the same milliseconds; the trace may list the forward first
  const up = (id: string, from: string, to: string, t0: number, t1: number): Exchange => ({ id, kind: 'http', from, to, t0, t1, label: 'POST /api/files/upload', method: 'POST', path: '/api/files/upload', status: 201, ok: true, origin: 'observed' });
  const X = ctxOf({ ...limpio, steps: [], exchanges: [up('f', 'frontend', 'api-gateway', 1711, 1723), up('b', 'browser', 'frontend', 1711, 1723), up('g', 'api-gateway', 'file-service', 1712, 1722)] });
  assert.match(actSummary(X.chain.acts[0], X), /^Recorre frontend, api-gateway y file-service /);
});

test('a mark said in Spanish, for the «Marcas» list: never the reporter\'s English kind', () => {
  const a = L.chain.acts[0];
  assert.deepEqual(MARKS.slice(0, 4).map((m) => markSaid(m, a, L)), ['abre /login', 'escribe en «Ingresa tu usuario»', 'escribe en «Ingresa tu contraseña»', 'pulsa el botón «Iniciar Sesión»']);
  const kinds = ['click', 'dblclick', 'tap', 'fill', 'type', 'press', 'check', 'uncheck', 'select', 'files', 'navigate', 'back', 'reload', 'drag', 'hover'] as const;
  assert.deepEqual([markSaid({ t0: 0, t1: 1, kind: 'select', target: "getByLabel('País')" }, a, L), markSaid({ t0: 0, t1: 1, kind: 'hover', target: "getByText('Ayuda')" }, a, L)], ['elige una opción del campo «País»', 'pasa por encima de «Ayuda»']);
  for (const kind of kinds) { const said = markSaid({ t0: 0, t1: 1, kind, target: "getByRole('button', { name: 'X' })" }, a, L); assert.ok(said && !said.startsWith(kind), `${kind}: ${said}`); }
});

test('every row, act, cause and failure of every fixture says something, and never a typed value', () => {
  for (const t of FILES.flatMap(load)) for (const marks of [undefined, MARKS.map((m) => (m.kind === 'fill' ? { ...m, target: "getByLabel('Contraseña')" } : m))]) {
    const ctx = ctxOf({ ...t, actions: marks });
    const said = [...ctx.rows.map((r) => say({ kind: 'row', i: r.i }, ctx)), ...ctx.chain.acts.map((a) => act(ctx, a)), ...t.exchanges.map((e) => sayCause(e, ctx)), say({ kind: 'fail' }, ctx), ...ctx.chain.acts.map((a) => actSummary(a, ctx))];
    for (const s of said) {
      assert.ok(s.trim().length > 0, `${t.test}: an empty sentence`);
      assert.ok(!/undefined|NaN|\[object/.test(s), `${t.test}: ${s}`);
      assert.ok(!s.includes('Passw0rd!x'), `${t.test}: a typed value`);
    }
  }
});
