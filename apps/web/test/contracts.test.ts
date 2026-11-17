/** Contracts against the code and the runs: which operation an endpoint or a call is, and what is drift. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MapNode } from '@laru/core';
import { endpointMatcher } from '@laru/trace/assemble';
import type { DocPiece, SeenEndpoint } from '../src/api.ts';
import { detailOf, diffsOf, errorsOf, groupApi, opOfCall, opsOf, pathRe, serviceApi, unlisted } from '../src/lib/contracts.ts';

const contract = (id: string, operations: Array<Record<string, string>>, errors: Array<Record<string, string>> = []) =>
  ({ id, type: 'contract', title: id, status: 'implemented', summary: '', fields: { operations, errors } }) as unknown as DocPiece;
const files = contract('ctr:api-de-ficheros', [
  { method: 'GET', path: '/api/files/{fileId}', service: 'svc:file-service' },
  { method: 'GET', path: '/api/files/stats', service: 'svc:file-service' },
  { method: 'GET', path: '/api/files/{id}/thumbnail', service: 'svc:file-service' },
], [{ status: '403', when: 'no es tuyo' }, { status: '5xx', when: 'se cayó' }]);
const ep = (service: string, method: string, path: string, attrs: Record<string, unknown> = {}): MapNode => ({ id: `ep:${service}:${method} ${path}`, type: 'endpoint', name: `${method} ${path}`, service: `svc:${service}`, attrs: { method, path, ...attrs } });

test('pathRe: a placeholder is one segment, ** anything, and literal characters stay literal', () => {
  assert.ok(pathRe('/api/files/{fileId}').test('/api/files/9004a5dd'));
  assert.ok(!pathRe('/api/files/{fileId}').test('/api/files/9004a5dd/download'));
  assert.ok(pathRe('/api/files/**').test('/api/files/9004a5dd/download'));
  assert.ok(pathRe('/users/:id').test('/users/7'));
  assert.ok(!pathRe('/a.b').test('/aXb'));
});

test('opOfCall: the literal operation before the template; another service or method is not it', () => {
  const ops = opsOf([files]);
  assert.equal(opOfCall('file-service', 'GET', '/api/files/stats', ops)?.path, '/api/files/stats');
  assert.equal(opOfCall('file-service', 'GET', '/api/files/9004a5dd', ops)?.path, '/api/files/{fileId}');
  assert.equal(opOfCall('api-gateway', 'GET', '/api/files/stats', ops), undefined);
  assert.equal(opOfCall('file-service', 'DELETE', '/api/files/9004a5dd', ops), undefined);
});

test('opOfCall: the map endpoint a call reached decides, so a literal one no contract declares shadows the template', () => {
  const ops = opsOf([files]);
  const nodes = [ep('file-service', 'GET', '/api/files/{fileId}'), ep('file-service', 'GET', '/api/files/quarantine')];
  const match = endpointMatcher(nodes);
  const at = (path: string) => nodes.find((n) => n.id === match('file-service', 'GET', path));
  assert.equal(at('/api/files/quarantine')?.id, 'ep:file-service:GET /api/files/quarantine');
  assert.equal(opOfCall('file-service', 'GET', '/api/files/quarantine', ops, at('/api/files/quarantine')), undefined);
  assert.equal(opOfCall('file-service', 'GET', '/api/files/9004a5dd', ops, at('/api/files/9004a5dd'))?.path, '/api/files/{fileId}');
  assert.equal(opOfCall('file-service', 'GET', '/api/files/quarantine', ops)?.path, '/api/files/{fileId}', 'with no map endpoint, the templates decide');
});

test('serviceApi: endpoints with their operation, drift both ways, none without contracts or under an OpenAPI file', () => {
  const ops = opsOf([files]);
  const rows = serviceApi('svc:file-service', [ep('file-service', 'GET', '/api/files/{id}'), ep('file-service', 'GET', '/api/files/stats'), ep('file-service', 'DELETE', '/api/files/{fileId}'), ep('file-service', 'GET', '/api/v2', { contract: true })], ops);
  assert.deepEqual(rows.map((r) => [r.method, r.path, r.op?.path, r.drift]), [
    ['GET', '/api/files/{id}', '/api/files/{fileId}', undefined],
    ['GET', '/api/files/stats', '/api/files/stats', undefined],
    ['DELETE', '/api/files/{fileId}', undefined, 'no-contract'],
    ['GET', '/api/v2', undefined, undefined],
    ['GET', '/api/files/{id}/thumbnail', '/api/files/{id}/thumbnail', 'not-in-code'],
  ]);
  const gw = serviceApi('svc:api-gateway', [ep('api-gateway', 'GET', '/api/files/**'), ep('api-gateway', 'POST', '/api/auth/login')], ops, (e) => (e.attrs?.path === '/api/files/**' ? ['svc:file-service'] : []));
  assert.deepEqual(gw.map((r) => [r.path, r.drift, r.forward]), [['/api/files/**', undefined, ['svc:file-service']], ['/api/auth/login', 'no-contract', undefined]], 'what only forwards has its contract downstream; every other endpoint is owed one, contracts or not');
});

test('unlisted: error statuses the contract does not list; successes and a listed class are fine', () => {
  assert.deepEqual(unlisted({ 200: 4, 201: 1, 403: 1, 404: 2, 503: 1, error: 1 }, [{ status: '403' }, { status: '5xx' }]), ['404']);
  assert.deepEqual(unlisted(undefined, []), []);
});

test('errorsOf: for one operation, the rows its column or its words give it, and those that name none', () => {
  const c = contract('ctr:x', [], [
    { status: '400', when: 'Un id que no es UUID' },
    { status: '403', when: 'No está limpio', operation: 'GET /api/files/{id}/download' },
    { status: '404', when: '`GET /api/files/{fileId}/download`: no existe' },
    { status: '409', when: 'Ya existe', operation: 'POST /api/files, PUT /api/files/{id}' },
  ]);
  const of = (method: string, path: string) => errorsOf(c, { method, path }).map((e) => e.status);
  assert.deepEqual(of('GET', '/api/files/{fileId}/download'), ['400', '403', '404']);
  assert.deepEqual(of('PUT', '/api/files/{x}'), ['400', '409']);
  assert.deepEqual(errorsOf(c).map((e) => e.status), ['400', '403', '404', '409'], 'without an operation, all of them');
});

test('detailOf: the sections whose heading names the operation, up to the next one as deep, code fences aside', () => {
  const c = { ...contract('ctr:x', []), fields: { purpose: [
    'Intro.', '### `POST /api/files/upload` y `POST /api/files/upload/batch`', 'Multipart.', '#### Límites', '100MB.',
    '### `GET /api/files`', 'Lista.', '```', '### GET /api/files/upload', '```', 'Fin.', '## Otra',
  ].join('\n') } } as unknown as DocPiece;
  assert.equal(detailOf(c, { method: 'POST', path: '/api/files/upload/batch' }), 'Multipart.\n#### Límites\n100MB.');
  assert.equal(detailOf(c, { method: 'GET', path: '/api/files' }), 'Lista.\n```\n### GET /api/files/upload\n```\nFin.');
  assert.equal(detailOf(c, { method: 'GET', path: '/api/files/upload' }), '', 'a heading inside a code fence is code');
});

test('groupApi: by the contract that documents them, the rest by the resource after the shared prefix, forwards last', () => {
  const papelera = contract('ctr:papelera', [{ method: 'GET', path: '/api/files/trash', service: 'svc:file-service' }]);
  const rows = serviceApi('svc:file-service', [
    ep('file-service', 'DELETE', '/api/files/trash/{fileId}'), ep('file-service', 'GET', '/api/files/trash'), ep('file-service', 'GET', '/api/files/folders/{folderId}'),
    ep('file-service', 'POST', '/api/files/folders'), ep('file-service', 'GET', '/api/files'), ep('file-service', 'GET', '/api/files/legacy/**'),
  ], opsOf([papelera]), (e) => (String(e.attrs?.path).endsWith('**') ? ['svc:old'] : []));
  assert.deepEqual(groupApi(rows).map((g) => [g.kind, g.contract?.id ?? g.prefix ?? '', g.rows.map((r) => `${r.method} ${r.path}`)]), [
    ['resource', '/api/files', ['GET /api/files']],
    ['resource', '/api/files/folders', ['POST /api/files/folders', 'GET /api/files/folders/{folderId}']],
    ['contract', 'ctr:papelera', ['GET /api/files/trash']],
    ['resource', '/api/files/trash', ['DELETE /api/files/trash/{fileId}']],
    ['forward', '', ['GET /api/files/legacy/**']],
  ]);
});

test('diffsOf: what the runs and the code say that the operation does not', () => {
  const c = { ...contract('ctr:files', [{ method: 'GET', path: '/api/files/{id}', service: 'svc:file-service', summary: 'Un fichero', request: 'Ruta `id`', response: '200 con `{ id, name }`' }], [{ status: '404', when: 'No existe', operation: 'GET /api/files/{id}' }, { status: '409', when: 'Otra', operation: 'POST /api/files' }]) } as DocPiece;
  const [row] = serviceApi('svc:file-service', [ep('file-service', 'GET', '/api/files/{id}', { statuses: [200, 403, 404], params: [{ in: 'path', name: 'id' }, { in: 'query', name: 'inline' }, { in: 'header', name: 'X-User-Id' }] })], opsOf([c]));
  const sample = (status: number, res: string, query?: string) => ({ run: '7', flow: 'f', test: 't', id: 'x', status, query, res: { text: res, bytes: res.length } });
  const seen = { count: 4, run: '7', at: '', flows: ['f'], drift: ['GET /api/files/{id} without the header'], statuses: { 200: 2, 404: 1, 409: 1 }, samples: { 200: sample(200, '[{"id":1,"name":"a","owner":"b"}]', 'expand=1'), 404: sample(404, '{"error":"x"}') } } as unknown as SeenEndpoint;
  assert.deepEqual(diffsOf(row, seen), [
    { key: 'status-unlisted', status: '409', count: 1 },
    { key: 'code-status-unlisted', statuses: ['403'] },
    { key: 'unnamed', side: 'query', names: ['expand'] },
    { key: 'unnamed', side: 'response', names: ['owner'] },
    { key: 'unnamed', side: 'code', names: ['inline', 'X-User-Id'] },
    { key: 'mock', text: 'GET /api/files/{id} without the header' },
  ]);
  const created = { ...row, op: { ...row.op!, response: '201 con el fichero' } };
  assert.deepEqual(diffsOf(created, { ...seen, statuses: { 200: 2 }, samples: {}, drift: [] }).filter((d) => d.key === 'success-differs'), [{ key: 'success-differs', status: '200', declared: '201', from: 'runs' }]);
  assert.deepEqual(diffsOf({ ...row, op: undefined }, seen), [{ key: 'mock', text: 'GET /api/files/{id} without the header' }], 'without an operation there is nothing to differ from');
});
