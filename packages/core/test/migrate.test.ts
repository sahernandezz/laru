import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeWrite, loadKnowledge, migrateWorkspace, movePiece, newPiece, renamePiece, documentNote } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

const put = (root: string, path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

test('a workspace of the older standard migrates losing nothing, and a second run changes nothing', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  put(ws.root, 'docs/terms/cuarentena.md', '---\nid: term:cuarentena\ntype: term\ntitle: Cuarentena\nstatus: active\nsummary: Donde espera un fichero.\n---\n\n# Cuarentena\n\n## Definición\n\nEl bucket `quarantine`.\n\n## En el código\n\n- quarantine\n- quarantineBucket\n');
  put(ws.root, 'docs/services/api/service.md', '---\nid: svc:api\ntype: service\ntitle: API\nstatus: active\nsummary: La API.\n---\n\n# API\n\n## Responsabilidad\n\nTodo.\n');
  put(ws.root, 'docs/services/api/notes/limpieza.md', '---\nid: note:limpieza\ntype: note\ntitle: La limpieza no existe\nstatus: active\nsummary: El README promete limpieza.\nanchors:\n  - x:README.md\n---\n\n# La limpieza no existe\n\n## Nota\n\nSolo existe el informe.\n');
  put(ws.root, 'docs/contracts/api.md', '---\nid: ctr:api\ntype: contract\ntitle: API\nstatus: implemented\nsummary: Lo que expone.\n---\n\n# API\n\n## Propósito\n\nLo que usa el front.\n');

  const dry = migrateWorkspace(ws, { dryRun: true });
  assert.deepEqual(dry.lost, []);
  assert.ok(!existsSync(join(ws.root, 'docs/glossary')), 'a dry run writes nothing');

  const r = migrateWorkspace(ws);
  assert.deepEqual(r.lost, []);
  assert.deepEqual(r.created, ['docs/glossary/glosario.md']);
  assert.deepEqual(r.removed.sort(), ['docs/services/api/notes/limpieza.md', 'docs/terms/cuarentena.md']);
  const k = loadKnowledge(ws);
  assert.deepEqual(k.issues, []);
  assert.equal(k.byId.get('ctr:api')?.status, 'active');
  assert.match(readFileSync(join(ws.root, 'docs/contracts/api.md'), 'utf8'), /## Visión general/);
  assert.match(readFileSync(join(ws.root, 'docs/glossary/glosario.md'), 'utf8'), /Cuarentena \| El bucket `quarantine`\. \| {2}\| quarantine, quarantineBucket/);
  assert.deepEqual(k.byId.get('svc:api')?.fields.gotchas, ['La limpieza no existe: Solo existe el informe.']);
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

test('a runbook of the older standard becomes a guide of the application that names what it operates, losing nothing', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'], team: [{ part: 'Todo', team: 'Equipo' }] } }).ok);
  put(ws.root, 'docs/services/api/service.md', '---\nid: svc:api\ntype: service\ntitle: API\nstatus: active\nsummary: La API.\n---\n\n# API\n\n## Responsabilidad\n\nTodo. Si falla, mira [[rb:operar-api]].\n');
  put(ws.root, 'docs/services/api/runbooks/operar-db.md', '---\nid: rb:operar-db\ntype: runbook\ntitle: Operar db\nstatus: active\nsummary: Qué hacer cuando la base falla.\n---\n\n# Operar db\n\n## Diagnóstico\n\n- Mirar el log de la base\n');
  put(ws.root, 'docs/services/api/runbooks/operar-api.md', '---\nid: rb:operar-api\ntype: runbook\ntitle: Operar api\nstatus: active\nsummary: Qué hacer cuando la API falla.\nrelations:\n  depends_on:\n    - svc:api\n    - rb:operar-db\n---\n\n# Operar api\n\n## Cuándo usarlo\n\n- Los pedidos no entran\n\n## Diagnóstico\n\n- Mirar el log\n\n## Arreglo\n\n- Reiniciar\n\n## Verificación\n\n- Un pedido entra\n');
  const r = migrateWorkspace(ws);
  assert.deepEqual(r.lost, []);
  assert.deepEqual(r.created.sort(), ['docs/guides/operar-api.md', 'docs/guides/operar-db.md']);
  assert.ok(r.removed.includes('docs/services/api/runbooks/operar-api.md'));
  const k = loadKnowledge(ws);
  assert.deepEqual(k.issues, []);
  const g = k.byId.get('guide:operar-api');
  assert.equal(g?.type, 'guide');
  assert.match(String(g?.fields.goal), /\[\[svc:api\]\]/);
  assert.deepEqual(g?.fields.steps, ['Diagnóstico: Mirar el log', 'Arreglo: Reiniciar', 'Comprobar: Un pedido entra']);
  assert.match(String(k.byId.get('svc:api')?.fields.responsibility), /\[\[guide:operar-api\]\]/, 'who pointed at the runbook points at its guide');
  assert.ok(!JSON.stringify(k.pieces.map((p) => p.fields)).includes('rb:operar-api'), 'no reference to the old id is left');
  assert.deepEqual(g?.relations, { depends_on: ['svc:api', 'guide:operar-db'] }, 'its relations go with it, retargeted to the guides');
  assert.deepEqual(migrateWorkspace(ws).rewritten, []);
});
