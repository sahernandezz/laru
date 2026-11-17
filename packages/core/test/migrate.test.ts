import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deletePiece, initWorkspace, knowledgeWrite, loadKnowledge, migrateWorkspace, movePiece, newPiece, renamePiece, documentNote } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

const put = (root: string, path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

test('a workspace of the older standard migrates losing nothing, and a second run changes nothing', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  put(ws.root, 'docs/services/api/service.md', '---\nid: svc:api\ntype: service\ntitle: API\nstatus: active\nsummary: La API.\n---\n\n# API\n\n## Responsabilidad\n\nTodo.\n');
  put(ws.root, 'docs/contracts/api.md', '---\nid: ctr:api\ntype: contract\ntitle: API\nstatus: implemented\nsummary: Lo que expone.\n---\n\n# API\n\n## Propósito\n\nLo que usa el front.\n');

  const dry = migrateWorkspace(ws, { dryRun: true });
  assert.deepEqual(dry.lost, []);
  assert.match(readFileSync(join(ws.root, 'docs/contracts/api.md'), 'utf8'), /## Propósito/, 'a dry run writes nothing');

  const r = migrateWorkspace(ws);
  assert.deepEqual(r.lost, []);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.removed, []);
  const k = loadKnowledge(ws);
  assert.deepEqual(k.issues, []);
  assert.equal(k.byId.get('ctr:api')?.status, 'active');
  assert.match(readFileSync(join(ws.root, 'docs/contracts/api.md'), 'utf8'), /## Visión general/);
  assert.deepEqual(migrateWorkspace(ws).rewritten, []);
});

test('new, move and rename: the folder is the containment and a rename takes its references along', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => knowledgeWrite(ws, x);
  assert.ok(w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  assert.ok(w({ type: 'module', in: 'app:comercio', title: 'Pagos', kind: 'area', status: 'active', summary: 'Cobros.', fields: { purpose: 'Dinero.' } }).ok);
  assert.ok(w({ type: 'module', in: 'app:comercio', title: 'Envíos', kind: 'area', status: 'active', summary: 'Entregas.', fields: { purpose: 'Cajas.' } }).ok);

  const n = newPiece(ws, null, { type: 'glossary', title: 'Glosario' });
  assert.ok(n.ok, JSON.stringify(n.issues));
  assert.equal(n.path, 'docs/glossary/glosario.md');
  assert.ok(n.note!.score < 100 && n.note!.owed.some((o) => o.at === 'fields.terms'));

  assert.ok(w({ type: 'decision', in: 'mod:pagos', title: 'Cobro asíncrono', status: 'proposed', summary: 'Por cola.', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' } }).ok);
  const dec = { type: 'decision' as const, status: 'proposed', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' } };
  assert.ok(w({ ...dec, in: 'mod:pagos', title: 'Otro cobro', summary: 'Otro.', meta: { supersedes: 'dec:cobro-asincrono' } }).ok);

  assert.equal(movePiece(ws, 'dec:cobro-asincrono', 'mod:envios').ok, true);
  assert.equal(loadKnowledge(ws).byId.get('dec:cobro-asincrono')?.parent, 'mod:envios');
  assert.equal(movePiece(ws, 'mod:pagos', 'mod:pagos').ok, false);
  assert.equal(movePiece(ws, 'mod:envios', 'mod:pagos').ok, true);
  assert.equal(loadKnowledge(ws).byId.get('dec:cobro-asincrono')?.parent, 'mod:envios', 'the children go with their container');

  const r = renamePiece(ws, 'dec:cobro-asincrono', 'cobro-por-cola');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const k = loadKnowledge(ws);
  assert.deepEqual(k.issues, []);
  assert.equal(r.id, 'dec:cobro-por-cola');
  assert.ok(k.byId.has('dec:cobro-por-cola') && !k.byId.has('dec:cobro-asincrono'));
  assert.equal(k.byId.get('dec:otro-cobro')?.meta?.supersedes, 'dec:cobro-por-cola');
  assert.equal(renamePiece(ws, 'dec:otro-cobro', 'cobro-por-cola').ok, false, 'an id already taken is refused');
});

test('delete: a piece goes whole, a container only with what it holds, and what still names it is said', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => knowledgeWrite(ws, x);
  const has = (id: string) => loadKnowledge(ws).byId.has(id);
  assert.ok(w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  assert.ok(w({ type: 'module', in: 'app:comercio', title: 'Pagos', kind: 'area', status: 'active', summary: 'Cobros.', fields: { purpose: 'Dinero.' } }).ok);
  assert.ok(w({ type: 'convention', in: 'app:comercio', title: 'Sin System.out', summary: 'Se registra con el logger.', fields: { rule: 'Nada de System.out.', rationale: 'Se pierde.', good: '`log.info(...)`' } }).ok);
  assert.ok(w({ type: 'decision', in: 'mod:pagos', title: 'Cobro asíncrono', status: 'accepted', summary: 'Por cola.', relations: { relates_to: ['conv:sin-system-out'] }, fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' } }).ok);
  assert.ok(w({ type: 'flow', in: 'mod:pagos', title: 'Pagar', status: 'active', summary: 'Un cliente paga.', fields: { goal: 'Cobrar.' } }).ok);

  // a convention: its file, and its folder once empty; a dry run says the same and deletes nothing
  const dry = deletePiece(ws, 'conv:sin-system-out', { dryRun: true });
  assert.deepEqual([dry.ok, dry.removed, dry.named], [true, ['conv:sin-system-out'], ['dec:cobro-asincrono']]);
  assert.ok(has('conv:sin-system-out'));
  const conv = deletePiece(ws, 'conv:sin-system-out');
  assert.deepEqual([conv.ok, conv.path, conv.issues.map((i) => `${i.at}:${i.key}`)], [true, 'docs/conventions/sin-system-out.md', ['dec:cobro-asincrono:still-named']]);
  assert.ok(!has('conv:sin-system-out') && !existsSync(join(ws.root, 'docs/conventions')));

  // a flow takes its folder (its spec) and its shared evidence
  const flowDir = join(ws.root, 'docs/modules/pagos/flows/pagar');
  writeFileSync(join(flowDir, 'pagar.spec.ts'), '// spec');
  put(ws.root, 'evidence/pagar/evidence.json', '{}');
  assert.ok(deletePiece(ws, 'flow:pagar').ok);
  assert.ok(!existsSync(flowDir) && !existsSync(join(ws.root, 'evidence/pagar')) && !has('flow:pagar'));

  // a container that holds pieces goes only with them, an accepted decision too
  assert.deepEqual(deletePiece(ws, 'mod:pagos').issues.map((i) => i.key), ['not-empty']);
  assert.ok(has('mod:pagos'));
  const mod = deletePiece(ws, 'mod:pagos', { contents: true });
  assert.deepEqual([mod.ok, mod.removed], [true, ['mod:pagos', 'dec:cobro-asincrono']]);
  assert.ok(!existsSync(join(ws.root, 'docs/modules')) && !has('dec:cobro-asincrono'));

  // the root, Laru's e2e guide (it would be written again) and what does not exist are refused
  assert.deepEqual(['app:comercio', 'guide:flujos-e2e', 'conv:nada'].map((id) => deletePiece(ws, id).issues[0]?.key), ['not-supported', 'not-supported', 'unknown-ref']);
  assert.ok(has('guide:flujos-e2e'));
  assert.deepEqual(loadKnowledge(ws).issues, []);
});

