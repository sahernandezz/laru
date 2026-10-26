/** Scenarios without Docker: how they are read from the documentation, and a setup's session moved to the entrance. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeFindings, initWorkspace, knowledgeWrite, loadKnowledge, stateDir, STANDARD, type FieldValue } from '@laru/core';
import { listScenarios } from '../src/scenarios.ts';
import { movedTo } from '../src/sessions.ts';
import { planText } from '../src/scenarios.ts';

test('a scenario is read with its setup, mocks, faults and restarts; one that extends needs no setup of its own', async () => {
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'laru-scn-')), { app: 'shop', docsLanguage: 'es' });
  const e = STANDARD.application.example;
  assert.equal(knowledgeWrite(ws, { type: 'application', title: e.title, kind: e.kind, status: e.status, summary: e.summary, fields: e.fields as Record<string, FieldValue> }).ok, true);
  const app = 'app:shop';
  const a = knowledgeWrite(ws, { type: 'scenario', in: app, title: 'Pedido pagado', status: 'active', summary: 'Un pedido pagado.', fields: {
    given: [{ kind: 'data', what: 'El pedido A-1042, pagado' }], mocks: [{ service: 'stripe', mode: 'simulate' }], faults: [{ service: 'stripe', latency: '800', p: '0.5' }],
  } });
  const b = knowledgeWrite(ws, { type: 'scenario', in: app, title: 'Stripe lento', status: 'active', summary: 'El mismo, con Stripe lento.', meta: { extends: 'scn:pedido-pagado' }, fields: {
    given: [{ kind: 'fault', what: 'Stripe tarda 8 s' }], faults: [{ service: 'stripe', latency: '8000' }],
  } });
  assert.deepEqual([a.ok, b.ok, a.issues, b.issues], [true, true, [], []]);
  const dir = loadKnowledge(ws).byId.get('scn:pedido-pagado')!.dir;
  assert.equal(dir, 'docs/scenarios/pedido-pagado', 'a scenario has a folder of its own, like a flow');
  writeFileSync(join(ws.root, dir, 'pedido-pagado.setup.ts'), '// setup');
  const [paid, slow] = ['scn:pedido-pagado', 'scn:stripe-lento'].map((id) => listScenarios(ws).find((s) => s.id === id)!);
  assert.equal(paid.setup, 'docs/scenarios/pedido-pagado/pedido-pagado.setup.ts');
  assert.deepEqual(paid.mocks, [{ service: 'stripe', mode: 'simulate' }]);
  assert.deepEqual(paid.faults, [{ service: 'stripe', rule: { latency: 800, p: 0.5 } }], 'numbers, and only the columns written');
  assert.deepEqual([slow.setup, slow.extends], [undefined, 'scn:pedido-pagado']);

  // scenario-broken: one with nothing to play, and one whose setup failed on an env
  knowledgeWrite(ws, { type: 'scenario', in: app, title: 'Sin preparar', status: 'draft', summary: 'Aún sin setup.', fields: { given: [{ kind: 'data', what: 'Nada todavía' }] } });
  mkdirSync(join(stateDir(ws), 'envs', 'local', 'scenarios'), { recursive: true });
  writeFileSync(join(stateDir(ws), 'envs', 'local', 'scenarios', 'pedido-pagado.json'), JSON.stringify({ slug: 'pedido-pagado', broken: 'expect(received).toBe(201)\nmore', provisionedAt: '2026-10-23T10:00:00Z' }));
  const broken = (await computeFindings(ws, null, loadKnowledge(ws))).filter((f) => f.type === 'scenario-broken').map((f) => [f.subject, f.severity, f.message]);
  assert.deepEqual(broken, [
    ['scn:sin-preparar', 'warning', 'scn:sin-preparar has no setup to play: docs/scenarios/sin-preparar/sin-preparar.setup.ts'],
    ['scn:pedido-pagado', 'error', 'scn:pedido-pagado failed its setup on local: expect(received).toBe(201)'],
  ], 'one that extends another is not missing a setup');
});

test("a setup's session, saved on the env's network, is moved to the entrance the person's browser uses", () => {
  const st = { cookies: [{ name: 's', value: 'v', domain: 'frontend', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }, { name: 'o', value: 'x', domain: 'other', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }],
    origins: [{ origin: 'http://frontend', localStorage: [{ name: 'vf_token', value: 't' }] }, { origin: 'http://other', localStorage: [] }] };
  const m = movedTo(st, 'http://frontend', 'http://frontend.shop.localhost:4180');
  assert.deepEqual(m.origins?.map((o) => o.origin), ['http://frontend.shop.localhost:4180', 'http://other']);
  assert.deepEqual(m.cookies?.map((c) => c.domain), ['frontend.shop.localhost', 'other']);
  assert.equal(m.origins?.[0].localStorage[0].value, 't');
});

test('a scenario that empties the mailbox says how many messages go before it asks', () => {
  const base = { plays: false, restores: [], restarts: [], keeps: [], lastMs: undefined };
  assert.match(planText({ ...base, mailbox: 14 }), /^Se vacía el buzón: 14 mensajes/);
  assert.match(planText({ ...base, mailbox: 1 }), /^Se vacía el buzón: 1 mensaje\b/);
  assert.match(planText({ ...base, mailbox: 0 }), /^Se vacía el buzón: 0 mensajes/);
  assert.match(planText(base), /^No se borra ni se reinicia nada/, 'a scenario that leaves the mailbox alone does not mention it');
});
