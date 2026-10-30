/** What the agent writes is held to the diagram standard and the workspace's policy; the web and the scaffold are not. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeShape, knowledgeWrite, loadWorkspace } from '../src/index.ts';

test('the agent gets how each diagram is drawn, and its write is refused for a wrong class or a note under the policy', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'laru-strict-')), 'ws');
  initWorkspace(root, { app: 'tienda', title: 'Tienda' });
  appendFileSync(join(root, 'laru.yaml'), 'policies:\n  documento: 90\n');
  const ws = loadWorkspace(root);
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Tienda', kind: 'product', status: 'active', summary: 'Una tienda que vende y devuelve pedidos pagados.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);

  const built = knowledgeShape(ws, 'module')!.fields.find((f) => f.name === 'built')!;
  assert.deepEqual(built.diagrams!.map((d) => d.dialect), ['C4Container', 'C4Component'], 'each class the section takes, with its dialect');
  assert.ok(built.diagrams![0].rules.some((r) => r.startsWith('error: ')) && built.diagrams![0].template, 'its rules and a template');

  const flowchart = 'Cómo se hace.\n\n```mermaid\nflowchart LR\n  a --> b\n```';
  const mod = { type: 'module' as const, id: 'mod:devoluciones', in: 'app:tienda', title: 'Devoluciones', kind: 'area', summary: 'Devolver un pedido pagado y recuperar el dinero.', fields: { purpose: 'Devolver.', built: flowchart } };
  const strict = knowledgeWrite(ws, mod, null, { strict: true, dryRun: true });
  assert.equal(strict.ok, false);
  assert.ok(strict.issues.some((i) => i.key === 'diagram-kind' && i.level === 'error'), 'a flowchart where a C4 diagram goes');
  assert.ok(strict.issues.some((i) => i.key === 'policy-documento' && i.level === 'error'), 'and a note under 90');
  const web = knowledgeWrite(ws, mod, null, { dryRun: true });
  assert.equal(web.ok, true, 'the web and the scaffold still write it, with warnings');
  assert.ok(web.issues.some((i) => i.key === 'diagram-kind' && i.level === 'warning'));
});
