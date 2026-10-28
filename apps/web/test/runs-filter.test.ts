/** The Runs list's filters in the address, the service heartbeat's rule, and runs in progress. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partsOf, queryOf } from '../src/lib/route.ts';
import { filterRuns, filtersOf, flowsOf, NO_FILTERS, queryString } from '../src/lib/runsFilter.ts';
import { inProgress, isOffline, nextMisses } from '../src/lib/service.ts';

const runs = [
  { flows: ['compartir-fichero', 'editar-perfil'], status: 'failed' as const },
  { flows: ['editar-perfil'], status: 'passed' as const },
  { flows: [], status: 'running' as const },
];

test('the filters survive the address: written to it, read back, and the route parts ignore them', () => {
  const f = { flujo: 'editar-perfil', estado: 'failed' };
  assert.equal(queryString(f), '?flujo=editar-perfil&estado=failed');
  assert.equal(queryString(NO_FILTERS), '');
  const hash = `#/runs${queryString(f)}`;
  assert.deepEqual(filtersOf(queryOf(hash)), f);
  assert.deepEqual(partsOf(hash), ['runs'], 'the route is still «runs»');
  assert.deepEqual(partsOf('#/runs/146/registro-e-inicio?x=1'), ['runs', '146', 'registro-e-inicio']);
  assert.deepEqual(filtersOf(queryOf('#/runs')), NO_FILTERS);
});

test('a run matches by the flow it ran and by its status; a session (no flows) matches only «todos»', () => {
  assert.equal(filterRuns(runs, NO_FILTERS).length, 3);
  assert.equal(filterRuns(runs, { flujo: 'editar-perfil', estado: '' }).length, 2);
  assert.equal(filterRuns(runs, { flujo: 'editar-perfil', estado: 'failed' }).length, 1);
  assert.equal(filterRuns(runs, { flujo: '', estado: 'running' }).length, 1);
  assert.equal(filterRuns(runs, { flujo: 'nope', estado: '' }).length, 0);
  assert.deepEqual(flowsOf(runs), ['compartir-fichero', 'editar-perfil']);
});

test('the service is offline after two misses in a row, and one answer clears it', () => {
  let m = 0;
  m = nextMisses(m, false); assert.equal(isOffline(m), false, 'one slow answer is not an outage');
  m = nextMisses(m, false); assert.equal(isOffline(m), true);
  m = nextMisses(m, true); assert.equal(isOffline(m), false);
  m = nextMisses(m, false); m = nextMisses(m, true); m = nextMisses(m, false); assert.equal(isOffline(m), false, 'misses must be consecutive');
});

test('a ping that only ran out of time (a busy service, or one queued behind other requests) takes six in a row to say offline', () => {
  let m = 0;
  for (let i = 1; i <= 5; i++) { m = nextMisses(m, false, true); assert.equal(isOffline(m), false, `${i} slow`); }
  m = nextMisses(m, false, true); assert.equal(isOffline(m), true, 'six slow pings: about half a minute without an answer');
  m = nextMisses(0, false, true); m = nextMisses(m, false); assert.equal(isOffline(m), false, 'one slow and one refused is not yet');
  m = nextMisses(m, false); assert.equal(isOffline(m), true);
});

test('runs in progress are the ones not done, newest first', () => {
  const l = [{ id: 1, phase: 'done', startedAt: '2026-10-25T10:00:00Z' }, { id: 2, phase: 'tests', startedAt: '2026-10-25T11:00:00Z' }, { id: 3, phase: 'up', startedAt: '2026-10-25T12:00:00Z' }];
  assert.deepEqual(inProgress(l).map((r) => r.id), [3, 2]);
});
