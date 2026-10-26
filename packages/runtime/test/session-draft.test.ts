import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeWrite, loadKnowledge } from '@laru/core';
import { runsDir, sessionToFlow, sessionToScenario } from '../src/index.ts';

/** A workspace with an application, a module and a kept session (marks and actions, no services). */
function fixture() {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-draft-')), 'ws'), { app: 'shop', title: 'Shop', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'], team: [{ part: 'Todo', team: 'Equipo' }] } }).ok);
  assert.ok(knowledgeWrite(ws, { type: 'module', in: 'app:shop', title: 'Pedidos', kind: 'feature', status: 'active', summary: 'Pedidos.', fields: { purpose: 'Pedir.' } }).ok);
  const dir = join(runsDir(ws), '7');
  mkdirSync(join(dir, 'flows', 'session'), { recursive: true });
  const trace = { v: 1, run: '7', flow: 'session', test: 'S', env: 'local', t0: 0, durationMs: 1000, status: 'passed', participants: [], steps: [{ n: 1, title: 'Pedir', t0: 0, t1: 1000, status: 'passed' }],
    actions: [{ t0: 10, t1: 10, kind: 'click', target: "getByRole('button', { name: 'Pedir' })", step: 1 }], exchanges: [], logs: [] };
  writeFileSync(join(dir, 'flows', 'session', 'trace.json'), JSON.stringify(trace));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id: '7', kind: 'session', title: 'Pedir', env: 'local', ephemeral: false, flows: ['session'], phase: 'done', status: 'passed', startedAt: new Date().toISOString(), pid: 1, results: {} }));
  return ws;
}

test('a draft of a scenario or of a flow never replaces a piece that exists: it is refused before anything is written', async () => {
  const ws = fixture();
  const first = await sessionToScenario(ws, '7', { in: 'mod:pedidos', title: 'Con un pedido' });
  assert.equal(first.ok, true, first.issues.map((i) => i.message).join('; '));
  const md = join(ws.root, loadKnowledge(ws).byId.get('scn:con-un-pedido')!.path), before = readFileSync(md, 'utf8');
  // someone writes the scenario by hand after the draft; a second draft with the same title must not touch it
  writeFileSync(md, before.replace('Borrador de la sesión 7.', 'Escrito a mano.'));
  const again = await sessionToScenario(ws, '7', { in: 'mod:pedidos', title: 'Con un pedido' });
  assert.equal(again.ok, false);
  assert.match(again.issues[0].message, /already exists/);
  assert.match(readFileSync(md, 'utf8'), /Escrito a mano\./, 'the existing scenario is as it was');

  const flow = await sessionToFlow(ws, '7', { in: 'mod:pedidos', title: 'Pedir' });
  assert.equal(flow.ok, true, flow.issues.map((i) => i.message).join('; '));
  const fmd = join(ws.root, loadKnowledge(ws).byId.get('flow:pedir')!.path);
  writeFileSync(fmd, readFileSync(fmd, 'utf8').replace('Borrador de la sesión 7.', 'Escrito a mano.'));
  assert.equal((await sessionToFlow(ws, '7', { in: 'mod:pedidos', title: 'Pedir' })).ok, false);
  assert.match(readFileSync(fmd, 'utf8'), /Escrito a mano\./);
  assert.ok(existsSync(md));
});

test('the session browser is only sent to addresses of its own entrance', async () => {
  const { isEntranceUrl } = await import('../src/sessions.ts');
  const ok = (u: string) => isEntranceUrl(u, 'tienda', '4181');
  assert.equal(ok('http://web.tienda.localhost:4181/pedido/42/confirmar?token=abc'), true);
  assert.equal(ok('http://api.tienda.localhost:4181/'), true);
  for (const u of ['http://web.tienda.localhost:5432/', 'http://web.otra.localhost:4181/', 'https://web.tienda.localhost:4181/', 'http://evil.test:4181/', 'http://web.tienda.localhost.evil.test:4181/', 'http://user:pw@web.tienda.localhost:4181/', 'javascript:alert(1)', 'file:///etc/passwd', '//web.tienda.localhost:4181/', 'not a url']) assert.equal(ok(u), false, u);
});
