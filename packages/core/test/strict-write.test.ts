/** What the agent writes may draw any diagram anywhere; only one that does not draw, or a note under the policy, is refused. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIAGRAM_KINDS } from '@laru/diagrams';
import { diagramShape, documentNote, endpointIn, initWorkspace, knowledgeShape, knowledgeWrite, loadWorkspace, STANDARD } from '../src/index.ts';

test('the agent gets the suggested diagrams with how each is drawn, the whole catalogue, and the rule that any of them fits', () => {
  const ws = loadWorkspace(initWorkspace(join(mkdtempSync(join(tmpdir(), 'laru-shape-')), 'ws'), { app: 'tienda', title: 'Tienda' }).root);
  const dec = knowledgeShape(ws, 'decision')!;
  assert.deepEqual(dec.diagrams.suggested.map((d) => d.kind), ['c4-container', 'sequence', 'deployment', 'network', 'integration']);
  assert.ok(dec.diagrams.suggested[0].rules.length && dec.diagrams.suggested[0].template, 'each suggested one with its rules and a template');
  assert.equal(dec.diagrams.catalogue.length, DIAGRAM_KINDS.length, 'and every class Laru draws');
  assert.match(dec.diagrams.rule, /not a limit/);
  assert.match(dec.writing, /No size limits/);
  assert.ok(dec.fields.some((f) => f.name === 'diagrams' && f.diagram === 'optional'), 'a place for the diagram that fits no other section');
  assert.ok(!dec.fields.some((f) => 'max' in f), 'no section has a size limit');
  assert.equal(diagramShape('state')?.kind, 'state', 'any class is drawn on demand');
  for (const s of Object.values(STANDARD)) for (const k of s.diagrams ?? []) assert.ok((DIAGRAM_KINDS as readonly string[]).includes(k), `${s.type}: ${k}`);
});

test('a write is refused only for a diagram that does not draw or a note under the policy; any class goes in any section', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'laru-strict-')), 'ws');
  initWorkspace(root, { app: 'tienda', title: 'Tienda' });
  appendFileSync(join(root, 'laru.yaml'), 'policies:\n  documento: 90\n');
  const ws = loadWorkspace(root);
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Tienda', kind: 'product', status: 'active', summary: 'Una tienda que vende y devuelve pedidos pagados.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);

  // a sequence where a C4 diagram is suggested, and a long section: both fine
  const long = `Cómo se hace, paso a paso. ${'Una frase que explica algo concreto del módulo. '.repeat(60)}`;
  const sequence = `${long}\n\n\`\`\`mermaid\nsequenceDiagram\n  title Devolver\n  Cliente->>API: pide la devolución\n  API-->>Cliente: devolución creada\n\`\`\``;
  const mod = { type: 'module' as const, id: 'mod:devoluciones', in: 'app:tienda', title: 'Devoluciones', kind: 'area', summary: 'Devolver un pedido pagado y recuperar el dinero.', fields: { purpose: 'Devolver un pedido pagado.', built: sequence, notas: 'Una sección propia, bienvenida.' } };
  const fine = knowledgeWrite(ws, mod, null, { strict: true, dryRun: true });
  assert.ok(!fine.issues.some((i) => i.level === 'error' && i.key !== 'policy-documento'), JSON.stringify(fine.issues));
  assert.ok(!fine.issues.some((i) => ['diagram-kind', 'too-long', 'unknown-field'].includes(i.key)), 'no class, size or own-section complaint');

  const broken = knowledgeWrite(ws, { ...mod, fields: { ...mod.fields, built: 'Así.\n\n```mermaid\nthis is not a diagram\n```' } }, null, { strict: true, dryRun: true });
  assert.ok(broken.issues.some((i) => i.key === 'diagram-unknown' && i.level === 'error'), 'a diagram of no class is refused');
  assert.ok(knowledgeWrite(ws, { ...mod, fields: { purpose: 'Devolver.' } }, null, { strict: true, dryRun: true }).issues.some((i) => i.key === 'policy-documento' && i.level === 'error'), 'and a note under 90');
  assert.equal(knowledgeWrite(ws, { ...mod, fields: { ...mod.fields, built: 'Así.\n\n```mermaid\nthis is not a diagram\n```' } }, null, { dryRun: true }).ok, true, 'the web and the scaffold still write it, with warnings');
});

test('assertive, not short: vague words, a repeated summary and an endpoint the code lacks are said; a diagram adds to the note', () => {
  const ws = loadWorkspace(initWorkspace(join(mkdtempSync(join(tmpdir(), 'laru-assert-')), 'ws'), { app: 'tienda', title: 'Tienda' }).root);
  const r = knowledgeWrite(ws, { type: 'application', title: 'Tienda', kind: 'product', status: 'active', summary: 'Una tienda que vende y devuelve pedidos pagados.', fields: { purpose: 'Probablemente vende cosas, etc. TODO: revisar el todo.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Una tienda que vende y devuelve pedidos pagados.'] } }, null, { dryRun: true });
  const vague = r.issues.find((i) => i.key === 'vague');
  assert.deepEqual(String(vague?.params?.words).split(', '), ['probablemente', 'etc.', 'TODO'], '«todo» in Spanish is not a placeholder');
  assert.ok(r.note!.owed.some((o) => o.key === 'vague'), 'it lowers the note');
  const plainInput = { type: 'application' as const, id: 'app:tienda', title: 'Tienda', status: 'active', summary: 'Una tienda que vende y devuelve pedidos pagados.', fields: {} };
  const plain = knowledgeWrite(ws, { type: 'application', title: 'Tienda', kind: 'product', status: 'active', summary: 'Una tienda que vende y devuelve pedidos pagados.', fields: { purpose: 'Vende pedidos y gestiona sus devoluciones.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }, null, { dryRun: true });
  const drawn = knowledgeWrite(ws, { type: 'application', title: 'Tienda', kind: 'product', status: 'active', summary: 'Una tienda que vende y devuelve pedidos pagados.', fields: { purpose: 'Vende pedidos y gestiona sus devoluciones.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'], diagrams: '```mermaid\nsequenceDiagram\n  title Comprar\n  Cliente->>Tienda: paga\n```' } }, null, { dryRun: true });
  assert.ok(drawn.note!.score > plain.note!.score, `a diagram adds: ${plain.note!.score} → ${drawn.note!.score}`);
  const same = knowledgeWrite(ws, { type: 'decision', in: 'app:tienda', title: 'Pagos en cola', summary: 'Los pagos van por una cola.', fields: { context: 'Los pagos van por una cola.', decision: 'Los pagos van por una cola.', alternatives: [{ option: 'x', 'why-not': 'y' }], tradeoffs: 'Se tarda más.' } }, null, { dryRun: true });
  assert.ok(same.issues.some((i) => i.key === 'repeats-summary' && i.at === 'fields.context'));

  // what it names is looked up in the map: `{id}`, `:id` and `**` are the same parameter
  const has = endpointIn({ ofType: () => [{ id: 'ep:api-gateway:GET /api/files/{fileId}' }, { id: 'ep:api-gateway:POST /api/auth/login' }] } as never);
  assert.equal(has('GET', '/api/files/:id'), true);
  assert.equal(has('POST', '/api/auth/login/'), true);
  assert.equal(has('DELETE', '/api/files/{fileId}'), false);
  const named = { ...plainInput, fields: { purpose: 'Entra con `POST /api/auth/login` y borra con `DELETE /api/files/{id}`.' } } as never;
  const note = documentNote(named, { endpoint: has });
  assert.deepEqual(note.owed.find((o) => o.key === 'unknown-endpoint')?.params, { endpoints: 'DELETE /api/files/{id}' });
});
