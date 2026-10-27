import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addRepo, checkWorkspace, coverage, freshness, initWorkspace, knowledgeShape, knowledgeWrite, loadGraph, loadKnowledge, parsePiece,
  E2E_GUIDE, E2E_RULES, PIECE_TYPES, documentNote, refreshMap, renderPiece, STANDARD, syncRepos, validatePiece, verifyPiece, type FieldValue, type Piece,
} from '../src/index.ts';
import { EXAMPLE_ES } from '../src/knowledge/standard-es.ts';
import { makeFixture } from './fixture.ts';

test('every piece of the standard: its example validates and its Markdown reads back byte for byte', () => {
  assert.equal(PIECE_TYPES.length, 23);
  const examples = PIECE_TYPES.map((t): Piece => {
    const e = STANDARD[t].example;
    return { id: `${STANDARD[t].prefix}:example`, type: t, kind: e.kind, title: e.title, status: e.status, summary: e.summary, anchors: e.anchors, meta: e.meta as Piece['meta'], relations: e.relations as Piece['relations'], fields: e.fields as Record<string, FieldValue> };
  });
  const refs = new Set(['svc:shop-api', 'mod:returns', 'proc:order-to-cash', 'dec:refunds-are-asynchronous', 'flow:return-a-paid-order']);
  for (const p of examples) {
    const issues = validatePiece(p, { exists: (id) => refs.has(id), resolveAnchor: () => ['some/file'] });
    assert.deepEqual(issues, [], `${p.type}: ${JSON.stringify(issues)}`);
    for (const lang of ['en', 'es'] as const) {
      const md = renderPiece(p, lang);
      const back = parsePiece(md);
      assert.deepEqual(back.issues, [], `${p.type}/${lang}`);
      assert.equal(renderPiece(back.piece!, lang), md, `${p.type}/${lang} round trip`);
    }
  }
});

test('the Spanish worked examples and hints: every type has them, they validate and they score 100', () => {
  const refs = new Set(['svc:shop-api', 'mod:returns', 'proc:order-to-cash', 'dec:refunds-are-asynchronous', 'flow:return-a-paid-order']);
  for (const t of PIECE_TYPES) {
    assert.ok(EXAMPLE_ES[t], `${t} has a Spanish example`);
    const e = { ...STANDARD[t].example, ...EXAMPLE_ES[t] };
    const p: Piece = { id: `${STANDARD[t].prefix}:ejemplo`, type: t, kind: e.kind, title: e.title, status: e.status, summary: e.summary, anchors: e.anchors, meta: e.meta as Piece['meta'], relations: e.relations as Piece['relations'], fields: e.fields as Record<string, FieldValue> };
    assert.deepEqual(validatePiece(p, { exists: (id) => refs.has(id), resolveAnchor: () => ['some/file'] }), [], t);
    assert.equal(documentNote(p).score, 100, t);
    assert.deepEqual(Object.keys(EXAMPLE_ES[t].fields).sort(), Object.keys(STANDARD[t].example.fields).sort(), `${t}: the same sections as the English one`);
    for (const f of STANDARD[t].fields) assert.ok(f.hintEs, `${t}.${f.name} has its hint in Spanish`);
  }
});

test('the document note: a worked example is 100, an empty required section lowers it and says what is owed', () => {
  for (const t of PIECE_TYPES) {
    const e = STANDARD[t].example;
    const p: Piece = { id: `${STANDARD[t].prefix}:x`, type: t, kind: e.kind, title: e.title, status: e.status, summary: e.summary, relations: e.relations as Piece['relations'], fields: e.fields as Record<string, FieldValue> };
    assert.equal(documentNote(p).score, 100, t);
  }
  const mod: Piece = { id: 'mod:x', type: 'module', kind: 'feature', title: 'X', status: 'active', summary: 'x', fields: { purpose: 'p' } };
  const n = documentNote(mod);
  assert.ok(n.score < 50);
  assert.ok(n.owed.some((o) => o.key === 'diagram-missing' && o.at === 'fields.built'));
  assert.ok(n.owed.some((o) => o.key === 'summary-short'));
});

test('positions in errors, and a field-by-field shape for the AI', () => {
  const p: Piece = { id: 'proc:x', type: 'process', kind: 'process', title: 'X', status: 'active', summary: 'x', fields: { goal: 'g', actors: ['a'], steps: [{ step: 's', actor: 'a', service: 'svc:billing' }, { step: '', actor: 'a' }] } };
  const issues = validatePiece(p, { exists: (id) => id === 'svc:billing-api', suggest: () => ['svc:billing-api'] });
  assert.deepEqual(issues.map((i) => `${i.at}:${i.key}`), ['fields.steps[0].service:unknown-ref', 'fields.steps[1].step:required', 'fields.flow:required']);
  assert.equal(issues.find((i) => i.key === 'fields.flow:required'.split(':')[1] && i.at === 'fields.flow')?.level, 'warning', 'an empty required section warns, it does not block');
  assert.match(issues[0].message, /did you mean svc:billing-api/);
});

test('the documentation model over a real workspace', async (t) => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  await addRepo(ws, fx.billingUrl);
  await addRepo(ws, fx.portalUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  const w = (input: Parameters<typeof knowledgeWrite>[1]) => knowledgeWrite(ws, input, g);

  await t.test('the folder is the containment, and headings follow the docs language', () => {
    assert.ok(w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
    const area = w({ type: 'module', in: 'app:comercio', title: 'Pagos', kind: 'area', status: 'active', summary: 'Cobros y devoluciones.', fields: { purpose: 'Todo lo que mueve dinero.' } });
    assert.ok(area.ok, JSON.stringify(area.issues));
    const feat = w({ type: 'module', in: 'mod:pagos', title: 'Devoluciones', kind: 'feature', status: 'active', summary: 'Devolver un pedido pagado.', anchors: ['billing:api/src/main/java/acme/RefundResource.java'], fields: { purpose: 'El cliente devuelve un pedido.' } });
    assert.equal(feat.path, 'docs/modules/pagos/modules/devoluciones/module.md');
    const md = readFileSync(join(ws.root, feat.path!), 'utf8');
    assert.match(md, /## Qué hace/);
    assert.match(md, /verified:\n {2}fingerprint: [0-9a-f]{12}/);
    const k = loadKnowledge(ws);
    assert.equal(k.byId.get('mod:devoluciones')!.parent, 'mod:pagos');
    assert.deepEqual(k.issues, []);
  });

  await t.test("Laru's e2e standard: the application's first write brings its guide, and the tester reads the rules", () => {
    const guide = loadKnowledge(ws).byId.get(E2E_GUIDE.id)!;
    assert.equal(guide.path, 'docs/guides/flujos-e2e.md');
    assert.deepEqual(guide.fields.steps, E2E_RULES);
    assert.match(readFileSync(join(ws.root, guide.path), 'utf8'), /## Cuando falla/);
    assert.ok(readFileSync(join(ws.root, '.claude', 'agents', 'tester.md'), 'utf8').includes(`- ${E2E_RULES[0]}`));
    assert.deepEqual(knowledgeShape(ws, 'flow')!.standard, { guide: E2E_GUIDE.id, rules: E2E_RULES });
  });

  await t.test('an invalid write never reaches disk', () => {
    const before = readdirSync(join(ws.root, 'docs', 'modules', 'pagos', 'modules', 'devoluciones'));
    const r = w({ type: 'contract', in: 'mod:devoluciones', title: 'API', summary: 'x', fields: { purpose: 'p', operations: [{ method: 'FETCH', path: '/refunds', service: 'svc:nope' }] } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.issues.filter((i) => i.level === 'error').map((i) => i.at), ['fields.operations[0].method', 'fields.operations[0].service']);
    assert.deepEqual(readdirSync(join(ws.root, 'docs', 'modules', 'pagos', 'modules', 'devoluciones')), before);
    assert.equal(w({ type: 'infrastructure', in: 'mod:devoluciones', title: 'R', summary: 's', fields: { envs: [{ env: 'local', purpose: 'p' }] } }).issues[0].key, 'wrong-parent');
    assert.equal(w({ type: 'note', in: 'mod:pagos', title: 'N', summary: 's', anchors: ['billing:nothing/here/**'], fields: { body: 'x' } }).issues[0].key, 'anchor-empty');
  });

  await t.test('a contract is contrasted with the extracted endpoints, in both directions', () => {
    const r = w({ type: 'contract', in: 'mod:devoluciones', title: 'API de devoluciones', summary: 'Lo que llama el portal.', fields: { purpose: 'Pedir devoluciones.', operations: [{ method: 'POST', path: '/refunds', service: 'svc:billing-api' }, { method: 'GET', path: '/refunds/{id}', service: 'svc:billing-api' }] } });
    assert.ok(r.ok, JSON.stringify(r.issues));
    const k = loadKnowledge(ws);
    const design = coverage(ws, k, g, k.byId.get('mod:devoluciones')!).find((c) => c.stage === 'design')!;
    assert.equal(design.state, 'part');
    assert.deepEqual(design.reasons.map((x) => x.key), ['contract-missing-in-code']);
    assert.equal(design.reasons[0].params?.op, 'GET /refunds/{id}');
  });

  await t.test('an accepted decision is not edited', () => {
    const d = { type: 'decision' as const, in: 'mod:pagos', title: 'Reembolso asíncrono', status: 'accepted', summary: 'Por cola.', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' } };
    assert.ok(w(d).ok);
    assert.equal(w({ ...d, fields: { ...d.fields, decision: 'otra' } }).issues.find((i) => i.level === 'error')?.key, 'immutable');
  });

  await t.test('decisions are numbered in order, never reused, and the number survives a rewrite', () => {
    const d = { type: 'decision' as const, in: 'mod:pagos', title: 'Segunda', status: 'proposed', summary: 'Otra.', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' } };
    const num = (id: string) => loadKnowledge(ws).byId.get(id)?.meta?.number;
    assert.equal(num('dec:reembolso-asincrono'), 'DEC-0001');
    const r1 = w(d);
    assert.ok(r1.ok, JSON.stringify(r1.issues));
    assert.equal(num('dec:segunda'), 'DEC-0002');
    assert.ok(w({ ...d, summary: 'Otra, reescrita.' }).ok);
    assert.equal(num('dec:segunda'), 'DEC-0002');
    assert.equal(w({ ...d, title: 'Tercera', meta: { number: 'DEC-0001' } }).issues.find((i) => i.level === 'error')?.key, 'duplicate-number');
  });

  await t.test('conventions are inherited and checked against the code they rule', async () => {
    assert.ok(w({ type: 'convention', in: 'app:comercio', title: 'Sin System.out', summary: 'Se registra con el logger.', fields: { rule: 'Nada de System.out.', rationale: 'Se pierde.', good: '`log.info(...)`', check: ['forbid: System\\.out\\.print'] } }).ok);
    const check = await checkWorkspace(ws, g);
    assert.ok(!check.issues.some((i) => i.level === 'error'), JSON.stringify(check.issues.filter((i) => i.level === 'error')));
    assert.ok(!check.issues.some((i) => i.key === 'convention-violated'));
  });

  await t.test('changing anchored code marks the piece stale in under five seconds', async () => {
    const seed = join(fx.tmp, 'seed', 'billing');
    const t0 = performance.now();
    fx.write(seed, { 'api/src/main/java/acme/RefundResource.java': '@Path("/refunds")\npublic class RefundResource {\n  @POST public Response create(RefundRequest r) { System.out.println(r); return null; }\n}' });
    fx.sh(seed, 'commit', '--quiet', '-am', 'print');
    fx.sh(seed, 'push', '--quiet', fx.billingUrl.replace('file://', ''), 'main');
    await syncRepos(ws);
    await refreshMap(ws);
    const k = loadKnowledge(ws);
    assert.equal(freshness(ws, k.byId.get('mod:devoluciones')!), 'stale');
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, `${ms} ms`);
    const check = await checkWorkspace(ws, loadGraph(ws));
    assert.deepEqual(check.stale, ['mod:devoluciones']);
    assert.ok(check.issues.some((i) => i.key === 'convention-violated' && /RefundResource\.java:3/.test(i.message)), 'the new System.out breaks the inherited convention');
    assert.ok(verifyPiece(ws, 'mod:devoluciones').ok);
    assert.equal(freshness(ws, loadKnowledge(ws).byId.get('mod:devoluciones')!), 'fresh');
  });

  await t.test('a file typed by hand in the wrong place is reported, not dropped', async () => {
    writeFileSync(join(ws.root, 'docs', 'modules', 'pagos', 'stray.md'), '# hola');
    const check = await checkWorkspace(ws, g);
    assert.ok(check.issues.some((i) => i.key === 'misplaced' && i.path.endsWith('stray.md')));
    assert.ok(existsSync(join(ws.root, 'docs', 'modules', 'pagos', 'stray.md')));
  });

  await t.test('the shape the AI reads has the docs-language headings and a worked example', () => {
    const shape = knowledgeShape(ws, 'flow')!;
    assert.equal(shape.fields.find((f) => f.name === 'steps')!.heading, 'Pasos');
    assert.match(shape.example!.markdown, /## Casos cortos/);
    assert.equal(shape.folder, 'flows/<slug>/flow.md');
  });
});

test('a flow\'s timeout is a duration: a bad one is an error that names the field', () => {
  const flow = (timeout: string | undefined): Piece => ({ id: 'flow:x', type: 'flow', kind: 'flow', title: 'X', status: 'active', summary: 'x', meta: timeout === undefined ? {} : { timeout }, fields: { goal: 'g', actors: ['a'], steps: [{ step: 's', actor: 'a', expected: 'e' }] } });
  const keys = (t: string | undefined) => validatePiece(flow(t), { exists: () => true }).filter((i) => i.at === 'timeout').map((i) => i.key);
  assert.deepEqual(keys('30s'), []);
  assert.deepEqual(keys(undefined), []);
  for (const bad of ['soon', '0s', '3h', '30']) assert.deepEqual(keys(bad), ['bad-timeout'], bad);
});

test('versioning, architecture, data stores and infrastructure owe their diagram, like modules and processes', () => {
  const owed = (type: Piece['type'], fields: Record<string, FieldValue>) =>
    documentNote({ id: `${STANDARD[type].prefix}:x`, type, title: 'X', status: 'active', summary: 'x', fields }).owed.filter((o) => o.key === 'diagram-missing').map((o) => o.at);
  assert.deepEqual(owed('versioning', { branches: [{ pattern: 'main', purpose: 'p' }] }), ['fields.graph']);
  assert.deepEqual(owed('architecture', { components: [{ component: 'a', role: 'r' }] }), ['fields.views']);
  assert.deepEqual(owed('datastore', { ownership: 'o' }), ['fields.dataflow']);
  assert.deepEqual(owed('infrastructure', { network: 'Solo el ingress es público.' }), ['fields.topology', 'fields.network']);
});
