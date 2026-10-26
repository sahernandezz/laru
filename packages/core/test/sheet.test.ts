import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptFinding, initWorkspace, knowledgeWrite, loadKnowledge, sheetNote } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('the sheet note is the contrast: what the class owes, accepted with a reason that can expire', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  const mod = { type: 'module' as const, in: 'app:comercio', title: 'Pagos', kind: 'feature', status: 'active', summary: 'Cobros y devoluciones de pedidos pagados.', fields: { purpose: 'Dinero.', usecases: [{ case: 'Pagar', actor: 'Cliente' }, { case: 'Devolver', actor: 'Cliente'}] } };
  assert.ok(knowledgeWrite(ws, mod).ok);
  const k = () => loadKnowledge(ws);
  const note = () => sheetNote(ws, k(), null, k().byId.get('mod:pagos')!, undefined, new Map(), '2026-10-25');

  const n = note();
  const owed = n.owed.filter((o) => o.kind === 'contrast').map((o) => `${o.key}@${o.at ?? ''}`);
  assert.deepEqual(owed.filter((o) => o.startsWith('usecase-flow')).sort(), ['usecase-flow@fields.usecases[0]', 'usecase-flow@fields.usecases[1]'], 'each use case without a flow is owed');
  assert.ok(owed.includes('anchors@') && owed.includes('test-plan@'));
  assert.equal(n.shown, Math.min(n.doc, n.sheet!), 'the tree shows the smaller of the two');
  assert.ok(n.owed.some((o) => o.kind === 'structure'), 'the document owes too');

  const item = n.owed.find((o) => o.key === 'test-plan')!;
  acceptFinding(ws, item.accept!, { reason: 'Se prueba desde el flujo del proceso', until: '2026-12-01' });
  const after = note();
  assert.ok(!after.owed.some((o) => o.key === 'test-plan'));
  assert.equal(after.items.find((o) => o.key === 'test-plan')?.accepted?.reason, 'Se prueba desde el flujo del proceso');
  assert.ok(after.sheet! > n.sheet!);
  const later = sheetNote(ws, k(), null, k().byId.get('mod:pagos')!, undefined, new Map(), '2026-12-02');
  assert.ok(later.owed.some((o) => o.key === 'test-plan'), 'an expired acceptance reopens it');
});

test('policies break the check only when the workspace turns them on, and say which block', async () => {
  const { checkWorkspace } = await import('../src/index.ts');
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  const off = await checkWorkspace(ws, null);
  assert.ok(!off.issues.some((i) => i.block === 'policy' || i.level === 'error'));
  assert.ok(off.issues.some((i) => i.block === 'structure' && i.key === 'required'), 'an empty required section is a warning in the structure block');
  ws.policies = { documento: 90, hoja: 90 };
  const on = await checkWorkspace(ws, null);
  assert.deepEqual(on.issues.filter((i) => i.block === 'policy').map((i) => i.key).sort(), ['policy-documento', 'policy-hoja']);
  assert.ok(on.issues.filter((i) => i.block === 'policy').every((i) => i.level === 'error'));
});
