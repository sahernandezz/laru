/** Contracts against the code and the runs: which operation an endpoint or a call is, and what is drift. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MapNode } from '@laru/core';
import { endpointMatcher } from '@laru/trace/assemble';
import type { DocPiece } from '../src/api.ts';
import { opOfCall, opsOf, pathRe, serviceApi, unlisted } from '../src/lib/contracts.ts';

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
  assert.deepEqual(serviceApi('svc:api-gateway', [ep('api-gateway', 'GET', '/api/files/**')], ops).map((r) => r.drift), [undefined], 'a service no contract speaks of has nothing to drift from');
});

test('unlisted: error statuses the contract does not list; successes and a listed class are fine', () => {
  assert.deepEqual(unlisted({ 200: 4, 201: 1, 403: 1, 404: 2, 503: 1, error: 1 }, [{ status: '403' }, { status: '5xx' }]), ['404']);
  assert.deepEqual(unlisted(undefined, []), []);
});
