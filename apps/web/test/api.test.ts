/** A workspace's page lives under /w/<id>/: its API calls go under its id, the machine's do not, old addresses land. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { apiUrlFor, HOME, homeRedirect, screenOnly, wsOf, wsPage } from '../src/lib/route.ts';

test('the workspace comes from the path; the hash route stays as it was', () => {
  assert.equal(wsOf('/w/vaultflow/'), 'vaultflow');
  assert.equal(wsOf('/w/vaultflow~ab12/'), 'vaultflow~ab12');
  assert.equal(wsOf('/'), undefined);
  assert.equal(wsOf('/w/vaultflow'), undefined, 'without its slash it is not a workspace page');
  assert.equal(wsPage('vaultflow', '#/runs/44'), '/w/vaultflow/#/runs/44');
});

test('apiUrl puts per-workspace paths under the workspace and leaves the machine alone', () => {
  assert.equal(apiUrlFor('vaultflow', '/api/runs'), '/api/w/vaultflow/runs');
  assert.equal(apiUrlFor('vaultflow', '/api/run-file?id=4&path=flows/x/video.webm'), '/api/w/vaultflow/run-file?id=4&path=flows/x/video.webm');
  assert.equal(apiUrlFor('vaultflow', '/api/env/events?env=local'), '/api/w/vaultflow/env/events?env=local');
  for (const p of ['/api/ping', '/api/workspaces', '/api/workspaces/probe?path=~', '/api/machine', '/api/machine/config', '/api/w/finanzas/env/down']) assert.equal(apiUrlFor('vaultflow', p), p);
  assert.equal(apiUrlFor(undefined, '/api/runs'), '/api/runs', 'the home page has no workspace');
  assert.equal(apiUrlFor('vaultflow', '/assets/x.js'), '/assets/x.js');
});

test('the home page: the only workspace, or an old bookmark to the one opened last', () => {
  const vf = { id: 'vaultflow', exists: true }, fin = { id: 'finanzas', exists: true }, gone = { id: null, exists: false };
  assert.equal(homeRedirect('', [vf]), '/w/vaultflow/');
  assert.equal(homeRedirect('#/runs/44', [vf]), '/w/vaultflow/#/runs/44');
  assert.equal(homeRedirect('#/runs/44', [fin, vf]), '/w/finanzas/#/runs/44', 'rows come most recently opened first');
  assert.equal(homeRedirect('', [fin, vf]), null, 'several: the home page itself');
  assert.equal(homeRedirect('', [vf, gone]), null, 'one is missing: the page shows it with «Quitar de la lista»');
  // asked for by name (Ajustes, the switcher, a maxEnvs refusal): «Esta máquina» stays reachable with one workspace
  assert.equal(homeRedirect('', [vf], new URL(HOME, 'http://127.0.0.1:4100').search), null);
  assert.equal(homeRedirect('#/runs/44', [vf], '?home'), null);
  assert.equal(homeRedirect('#/runs/44', []), null);
});

test('switching workspace keeps the screen and leaves behind what it pointed at, which the other workspace does not have', () => {
  assert.equal(screenOnly('#/mocks/local/api-gateway'), '#/mocks');
  assert.equal(screenOnly('#/docs/flow%3Acompartir-fichero/t/live'), '#/docs');
  assert.equal(screenOnly('#/runs/44?estado=failed'), '#/runs');
  assert.equal(screenOnly(''), '');
  assert.equal(screenOnly('#/'), '');
  assert.equal(wsPage('tienda', screenOnly('#/mail/correo/abc')), '/w/tienda/#/mail');
});
