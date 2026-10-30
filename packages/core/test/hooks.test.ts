import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, knowledgeWrite, loadGraph, postEdit, preBash, preEdit, refreshMap, stopCheck } from '../src/index.ts';
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

  // a file the agent just created, not yet at the reference branch, is ruled as the ones next to it
  const fresh = join(ws.checkouts.billing, 'api/src/main/java/acme/NewThing.java');
  writeFileSync(fresh, 'class NewThing {\n  void x() { System.out.println("x"); }\n}\n');
  const created = { session_id: 's3', tool_name: 'Write', tool_input: { file_path: fresh } };
  assert.match((preEdit(ws, created) as typeof pre).hookSpecificOutput.additionalContext, /Sin System\.out/, 'its conventions before the edit');
  assert.equal((postEdit(ws, created) as typeof post).decision, 'block', 'and a broken rule blocks it after');
});

test('the working agreement and the docs: refused before the edit or the command, asked about, reviewed at the stop', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g); assert.ok(r.ok, JSON.stringify(r.issues)); return r; };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'module', id: 'mod:devoluciones', in: 'app:comercio', title: 'Devoluciones', summary: 'Devolver pedidos.', kind: 'area', anchors: ['billing:api/src/main/java/acme/**'], fields: { purpose: 'Devolver.' } });
  const file = join(ws.checkouts.billing, 'api/src/main/java/acme/RefundResource.java');
  const edit = (session: string, f = file) => ({ session_id: session, tool_name: 'Edit', tool_input: { file_path: f } });
  type Decision = { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  const decision = (x: unknown) => (x as Decision | null)?.hookSpecificOutput?.permissionDecision;

  // a piece of docs/ by hand: refused, and sent to knowledge_write; a flow's spec beside it is code, and goes
  const piece = join(ws.root, 'docs', 'modules', 'devoluciones', 'module.md');
  assert.equal(decision(preEdit(ws, edit('a', piece))), 'deny');
  assert.match((preEdit(ws, edit('a', piece)) as Decision).hookSpecificOutput.permissionDecisionReason, /knowledge_write/);
  assert.notEqual(decision(preEdit(ws, edit('a', join(ws.root, 'docs', 'flows', 'x', 'x.spec.ts')))), 'deny');

  // no agreement yet: nothing refused
  assert.equal(preBash(ws, { tool_input: { command: 'git push origin main' } }), null);
  assert.notEqual(decision(preEdit(ws, edit('b'))), 'deny');
  // the agreement: written, the agent files point at it; its branches and commands are held
  const agr = w({ type: 'agreement', in: 'app:comercio', title: 'Tickets', summary: 'Tickets del sprint, una rama por ticket.', fields: { purpose: 'Desarrollar tickets.', protected: ['main', 'release/*'], never: ['cmd: git push --force', 'Tocar producción'], confirm: ['cmd: ^git push'] } });
  // each person's, out of git: in the state folder; only CLAUDE.local.md (ignored too) points at the file, the shared files say where it lives
  assert.equal(agr.path, join('.laru', 'agreement.md'));
  assert.match(readFileSync(join(ws.root, '.gitignore'), 'utf8'), /^\.laru\/$/m);
  assert.match(readFileSync(join(ws.root, '.gitignore'), 'utf8'), /^CLAUDE\.local\.md$/m);
  assert.match(readFileSync(join(ws.root, 'CLAUDE.local.md'), 'utf8'), /@\.laru\/agreement\.md/);
  for (const f of ['CLAUDE.md', 'AGENTS.md']) assert.doesNotMatch(readFileSync(join(ws.root, f), 'utf8'), /Desarrollar tickets|@\.laru/, `${f} is shared: the same words for everyone`);
  assert.equal(decision(preBash(ws, { tool_input: { command: 'git push --force origin x' } })), 'deny');
  assert.equal(decision(preBash(ws, { tool_input: { command: 'git push origin feature/x' } })), 'ask');
  assert.equal(preBash(ws, { tool_input: { command: 'git status' } }), null);
  assert.equal(knowledgeWrite(ws, { type: 'agreement', id: agr.id, title: 'Tickets', summary: 'Tickets del sprint, una rama por ticket.', fields: { purpose: 'x', never: ['cmd: (git'] } }, g).ok, false, 'a command that does not compile is refused');
  const second = { type: 'agreement' as const, in: 'app:comercio', title: 'Pruebas de concepto', summary: 'Pruebas de concepto, se puede romper todo.', fields: { purpose: 'Probar ideas.', never: ['Publicar'] } };
  const twice = knowledgeWrite(ws, second, g, { dryRun: true });
  assert.ok(!twice.ok && twice.issues.some((i) => i.key === 'agreement-one'), 'one working agreement in force per workspace');
  const over = knowledgeWrite(ws, { ...second, status: 'deprecated' }, g, { dryRun: true });
  assert.ok(!over.ok && over.issues.some((i) => i.key === 'agreement-one'), 'nor a deprecated one: it would be written over the one there is');
  assert.ok(knowledgeWrite(ws, { type: 'agreement', id: agr.id, title: 'Tickets', status: 'deprecated', summary: 'Tickets del sprint, una rama por ticket.', fields: { purpose: 'Desarrollar tickets.', never: ['Tocar producción'] } }, g, { dryRun: true }).ok, 'the same one, updated, goes');
  const checkout = ws.checkouts.billing;
  execFileSync('git', ['-C', checkout, 'checkout', '-q', '-B', 'main']);
  assert.match((preEdit(ws, edit('c')) as Decision).hookSpecificOutput.permissionDecisionReason, /on main.*«main»/);
  execFileSync('git', ['-C', checkout, 'checkout', '-q', '-b', 'feature/devolver']);
  assert.notEqual(decision(preEdit(ws, edit('d'))), 'deny', 'on a branch of its own, the edit goes');

  // the stop: the module that describes the edited file is asked to be reviewed, once; written after, it is not
  assert.equal(stopCheck(ws, { session_id: 'e' }, []), null, 'nothing edited, nothing to say');
  postEdit(ws, edit('e'));
  const stop = stopCheck(ws, { session_id: 'e' }, []) as { decision: string; reason: string };
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /mod:devoluciones/);
  assert.equal(stopCheck(ws, { session_id: 'e', stop_hook_active: true }, []), null, 'stopping again lets go');
  assert.match((stopCheck(ws, { session_id: 'f' }, [{ path: 'docs/x.md', message: 'broken' }]) as { reason: string }).reason, /1 error/);
  await new Promise((r) => setTimeout(r, 15));
  w({ type: 'module', id: 'mod:devoluciones', title: 'Devoluciones', summary: 'Devolver pedidos pagados.', kind: 'area', anchors: ['billing:api/src/main/java/acme/**'], fields: { purpose: 'Devolver.' } });
  assert.equal(stopCheck(ws, { session_id: 'e' }, []), null, 'reviewed: written after the edit');
});
