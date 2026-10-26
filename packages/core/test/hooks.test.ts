import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, knowledgeWrite, loadGraph, postEdit, preEdit, refreshMap } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('edit hooks: the conventions once per session and file, a block on a broken rule, silence elsewhere', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => assert.ok(knowledgeWrite(ws, x, g).ok);
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'module', id: 'mod:devoluciones', in: 'app:comercio', title: 'Devoluciones', summary: 'Devolver pedidos.', kind: 'area', anchors: ['billing:api/src/main/java/acme/**'], fields: { purpose: 'Devolver.' } });
  w({ type: 'convention', in: 'mod:devoluciones', title: 'Sin System.out', summary: 'Se registra con el logger.', fields: { rule: 'Nada de System.out.', rationale: 'Se pierde.', good: '`log.info(...)`', check: ['forbid: System\\.out\\.print'] } });
  const file = join(ws.checkouts.billing, 'api/src/main/java/acme/RefundResource.java');
  const input = { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: file } };

  const t0 = performance.now();
  const pre = preEdit(ws, input) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.ok(performance.now() - t0 < 200, 'answers in under 200 ms');
  assert.equal(pre.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(pre.hookSpecificOutput.additionalContext, /Sin System\.out/);
  assert.equal(preEdit(ws, input), null, 'once per session and file');
  assert.ok(preEdit(ws, { ...input, session_id: 's2' }), 'a new session hears it again');
  assert.equal(preEdit(ws, { ...input, tool_input: { file_path: join(fx.tmp, 'elsewhere.java') } }), null, 'silence outside the checkouts');

  assert.equal(postEdit(ws, input), null);
  writeFileSync(file, 'class RefundResource {\n  void x() {\n    System.out.println("x");\n  }\n}\n');
  const post = postEdit(ws, input) as { decision: string; reason: string };
  assert.equal(post.decision, 'block');
  assert.match(post.reason, /RefundResource\.java:3 breaks «Sin System\.out»/);
});
