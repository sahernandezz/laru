import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addRepo, checkWorkspace, coverage, freshness, initWorkspace, knowledgeShape, knowledgeWrite, loadGraph, loadKnowledge, parsePiece,
  E2E_GUIDE, E2E_RULES, PIECE_TYPES, documentNote, refreshMap, renderPiece, sheetNote, STANDARD, syncRepos, validatePiece, verifyPiece, type FieldValue, type Piece,
} from '../src/index.ts';
import { EXAMPLE_ES } from '../src/knowledge/standard-es.ts';
import { makeFixture } from './fixture.ts';

test('every piece of the standard: its example validates and its Markdown reads back byte for byte', () => {
  assert.equal(PIECE_TYPES.length, 24);
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
    for (const m of STANDARD[t].meta ?? []) assert.ok(m.hintEs, `${t}.meta.${m.name} has its hint in Spanish`);
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

  await t.test('a broken write never reaches disk; what only departs from the standard is a warning', () => {
    const before = readdirSync(join(ws.root, 'docs', 'modules', 'pagos', 'modules', 'devoluciones'));
    const r = w({ type: 'contract', in: 'mod:devoluciones', title: 'API', summary: '', fields: { purpose: 'p', operations: [{ method: 'FETCH', path: '/refunds', service: 'svc:nope' }] } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.issues.filter((i) => i.level === 'error').map((i) => i.at), ['summary'], 'an empty summary breaks it');
    assert.deepEqual(r.issues.filter((i) => i.level === 'warning' && i.at.startsWith('fields.operations')).map((i) => i.at), ['fields.operations[0].method', 'fields.operations[0].service', 'fields.operations[0].summary', 'fields.operations[0].request', 'fields.operations[0].response'], 'an unknown method or service, and what an operation does not say, is said, not refused');
    assert.deepEqual(readdirSync(join(ws.root, 'docs', 'modules', 'pagos', 'modules', 'devoluciones')), before);
    const said = (x: ReturnType<typeof w>) => x.issues.filter((i) => i.level === 'warning').map((i) => i.key);
    assert.ok(said(w({ type: 'infrastructure', in: 'mod:devoluciones', title: 'R', summary: '', fields: { envs: [{ env: 'local', purpose: 'p' }] } })).includes('wrong-parent'));
    assert.ok(said(w({ type: 'convention', in: 'mod:pagos', title: 'N', summary: '', anchors: ['billing:nothing/here/**'], fields: {} })).includes('anchor-empty'), 'code not on the reference branch yet');
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

  await t.test('an accepted decision keeps what it decided, keeps up with where it stands, and a new one supersedes it in one write', () => {
    const id = 'dec:reembolso-asincrono';
    const d = { type: 'decision' as const, id, title: 'Reembolso asíncrono', summary: 'Por cola.', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' } };
    const wrong = (r: ReturnType<typeof w>) => r.issues.filter((i) => i.level === 'error').map((i) => `${i.at}:${i.key}`);
    const now = (x: string) => loadKnowledge(ws).byId.get(x)!;
    // where it stands today changes: its compliance, relations and owner; the status, left out, stays
    assert.deepEqual(wrong(w({ ...d, owner: 'pagos', relations: { relates_to: ['mod:devoluciones'] }, fields: { ...d.fields, compliance: 'Lo cumple RefundResource.' } })), []);
    assert.deepEqual([now(id).status, now(id).fields.compliance], ['accepted', 'Lo cumple RefundResource.']);
    assert.deepEqual(wrong(knowledgeWrite(ws, { ...d, fields: { ...d.fields, decision: ' d\n', alternatives: [{ 'why-not': 'w', option: 'o ' }] } }, g, { dryRun: true })), [], 'spacing and column order are not a change');
    // what it decided does not change, nor does it go back
    assert.deepEqual(wrong(w({ ...d, fields: { ...d.fields, decision: 'otra' } })), ['fields.decision:immutable']);
    assert.deepEqual(wrong(w({ ...d, title: 'Reembolso en línea' })), ['title:immutable']);
    assert.deepEqual(wrong(w({ ...d, status: 'proposed' })), ['status:immutable']);
    // a section it left empty is filled, once
    const sin = { type: 'decision' as const, in: 'mod:pagos', title: 'Cobros idempotentes', status: 'accepted', summary: 'Una clave por cobro.', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }] } };
    assert.deepEqual(wrong(w(sin)), []);
    assert.deepEqual(wrong(w({ ...sin, fields: { ...sin.fields, tradeoffs: 'Guardar las claves.' } })), []);
    assert.deepEqual(wrong(w({ ...sin, fields: { ...sin.fields, tradeoffs: 'Otra cosa.' } })), ['fields.tradeoffs:immutable']);
    // the one that supersedes it: proposed, the old one still rules; accepted, the old one is superseded, as it was
    const nueva = { type: 'decision' as const, in: 'mod:pagos', title: 'Reembolso en línea', status: 'proposed', summary: 'Sin cola.', meta: { supersedes: id }, fields: { context: 'c2', decision: 'd2', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't2' } };
    assert.equal(w(nueva).superseded, undefined);
    assert.equal(now(id).status, 'accepted');
    const r = w({ ...nueva, status: 'accepted' });
    assert.deepEqual([wrong(r), r.superseded], [[], [id]]);
    assert.deepEqual([now(id).status, now(id).fields.decision, now(id).fields.compliance, now(id).meta?.number], ['superseded', 'd', 'Lo cumple RefundResource.', 'DEC-0001']);
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
    assert.match(shape.example!.markdown, /\| Tipo \|[\s\S]*\| validation \|/, 'a validation is a step of the story');
    assert.equal(shape.folder, 'flows/<slug>/flow.md');
  });

  await t.test('a contract says of each operation what it is for, takes and answers, and its write names the endpoints its services still owe', async () => {
    const now = loadGraph(ws);
    const op = { method: 'POST', path: '/refunds', service: 'svc:billing-api', summary: 'Pedir el reembolso de un pedido pagado', request: 'Cuerpo `RefundRequest`: `{ orderId, amount }`', response: '200 con el reembolso pendiente' };
    const input = { type: 'contract' as const, in: 'mod:devoluciones', title: 'API de reembolsos', summary: 'Lo que llama el portal para reembolsar un pedido pagado.', fields: { purpose: 'El portal pide el reembolso de un pedido.', auth: 'El token del cliente.', operations: [op], errors: [{ status: '409', when: 'El pedido ya se reembolsó', operation: 'POST /refunds' }] } };
    const r = knowledgeWrite(ws, input, now);
    assert.ok(r.ok, JSON.stringify(r.issues));
    assert.equal(r.note!.items.find((i) => i.key === 'operation-detail')?.ok, true);
    const owed = r.issues.find((i) => i.key === 'service-endpoints-uncovered');
    assert.deepEqual([owed?.level, owed?.params?.service, owed?.params?.endpoints], ['warning', 'svc:billing-api', 'GET /orders/{id}/payment'], 'the other endpoint of its service, still in no contract');
    // an operation that does not say what it takes is a name, not a contract: the note says which
    const bare = documentNote({ id: 'ctr:x', status: 'active', ...input, fields: { ...input.fields, operations: [{ ...op, request: ' ' }] } });
    assert.deepEqual(bare.owed.filter((i) => i.key === 'operation-detail').map((i) => i.params?.operations), ['POST /refunds']);
    // nor is an event that does not say what it is for
    const mute = documentNote({ id: 'ctr:x', status: 'active', ...input, fields: { ...input.fields, events: [{ topic: 'refunds', direction: 'publishes', service: 'svc:billing-api', payload: '`RefundIssued`' }] } });
    assert.deepEqual(mute.owed.filter((i) => i.key === 'event-detail').map((i) => i.params?.events), ['refunds']);
    // check says it per service, and the service's sheet owes it
    const check = await checkWorkspace(ws, now);
    const billing = check.issues.find((i) => i.key === 'endpoint-without-contract' && i.id === 'svc:billing-api');
    assert.equal(billing?.params?.endpoints, 'GET /orders/{id}/payment');
    assert.equal(billing?.block, 'contrast');
    assert.ok(knowledgeWrite(ws, { type: 'service', in: 'app:comercio', id: 'svc:billing-api', title: 'billing-api', summary: 'Cobra los pedidos y devuelve el dinero de las devoluciones.', fields: { responsibility: 'Los cobros.' } }, now).ok);
    const item = sheetNote(ws, loadKnowledge(ws), now, loadKnowledge(ws).byId.get('svc:billing-api')!).items.find((i) => i.key === 'endpoint-contracts');
    assert.deepEqual([item?.ok, item?.params?.missing, item?.params?.endpoints], [false, 1, 2]);
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

test('a section or a column the standard does not have is kept as written and read back the same', async () => {
  const { renderPiece, parsePiece } = await import('../src/knowledge/piece.ts');
  const p = { id: 'ctr:pagos', type: 'contract' as const, title: 'Pagos', status: 'draft', summary: 's', fields: {
    purpose: 'Cobrar.', operations: [{ method: 'POST', path: '/cobros', service: 'svc:pagos', idempotencia: 'clave del cliente' }],
    'Riesgos': 'Un cobro doble.', 'Contactos': ['equipo pagos'],
  } };
  const back = parsePiece(renderPiece(p, 'es'));
  assert.deepEqual(back.issues, []);
  assert.deepEqual(back.piece?.fields, p.fields);
});
