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
  assert.doesNotMatch((stopCheck(ws, { session_id: 'e' }, []) as { reason?: string } | null)?.reason ?? '', /mod:devoluciones/, 'reviewed: written after the edit');
});

/** A workspace with the person's working agreement: how they want the agent to work here, in sections. */
function withAgreement(name: string, notes: string) {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, name), { app: 'comercio', title: 'Comercio' });
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'La tienda que vende y devuelve pedidos pagados.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'agreement', in: 'app:comercio', title: 'Mi forma de trabajo', status: 'active', summary: 'Cómo quiero que trabaje el agente en este workspace.', fields: { purpose: 'Tickets del sprint.', branches: 'Una rama por HU: feature/PAN-123-lo-que-hace, desde develop.', never: ['cmd: git push --force'], notes } });
  // the project's documentation: a guide that talks of PRs is about the project, never brought as how the agent works
  w({ type: 'guide', in: 'app:comercio', title: 'Revisar un PR del equipo', status: 'active', summary: 'Qué mira el equipo cuando revisa el PR de otro.', fields: { goal: 'Una revisión útil.', steps: ['Leer el diff entero.'] } });
  return ws;
}
const NOTES = '## PR\nTítulo «PAN-123 · qué cambia»; cuerpo con Contexto, Cambios y Pruebas.\n\n## Jira\nCierra la subtarea con el enlace al PR.\n\n## Publicar el SDK\nAntes `cmd: npm publish` sube la versión en package.json.\n\n## Pruebas\nCorre los flujos afectados antes de entregar.';

test('a PR, a commit or a ticket is stopped once with the person\'s instructions about it, whole; never with the project\'s documentation', async () => {
  const { instructions, momentsOf, rulesFor } = await import('../src/index.ts');
  const ws = withAgreement('ws-rules', NOTES);
  assert.deepEqual(instructions(ws).map((s) => s.title), ['Ramas', 'PR', 'Jira', 'Publicar el SDK', 'Pruebas'], 'its branches, then each heading of its instructions');
  assert.deepEqual(momentsOf('git add -A && git commit -m x && git push origin HEAD'), ['commit', 'push']);
  assert.deepEqual(rulesFor(ws, ['pr']).map((s) => s.title), ['PR', 'Jira'], 'the PR section, and the one that mentions the PR');
  assert.deepEqual(rulesFor(ws, ['push']).map((s) => s.title), ['Ramas']);

  const said = (session: string, command: string) => (preBash(ws, { session_id: session, tool_input: { command } }) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } } | null)?.hookSpecificOutput;
  const pr = said('s1', 'gh pr create --title "x" --body "y"')!;
  assert.equal(pr.permissionDecision, 'deny');
  assert.match(pr.permissionDecisionReason, /### PR\nTítulo «PAN-123 · qué cambia»; cuerpo con Contexto, Cambios y Pruebas\./, 'the instruction whole');
  assert.doesNotMatch(pr.permissionDecisionReason, /Revisar un PR del equipo/, 'the project\'s documentation is not how the agent works');
  assert.equal(said('s1', 'gh pr create --title "PAN-1 · x" --body "y"'), undefined, 'run again, it goes');
  assert.equal(said('s1', 'git commit -m x'), undefined, 'no instruction about a commit');
  assert.ok(said('s2', 'gh pr create'), 'another session is told again');
  // a command an instruction names with cmd:, though it is none of the moments
  assert.match(said('s3', 'npm publish --access public')?.permissionDecisionReason ?? '', /this command[\s\S]*### Publicar el SDK/);
  assert.equal(said('s3', 'npm test'), undefined);
  assert.equal(said('s4', 'git push --force')?.permissionDecision, 'deny', 'the agreement\'s never still refuses');
});

test('each request brings the person\'s instructions about it, whole and once; with none, the agent is still told it works by them', async () => {
  const { onPrompt, rulesForText } = await import('../src/index.ts');
  const ws = withAgreement('ws-prompt', NOTES);
  const titles = (t: string) => rulesForText(ws, t).map((s) => s.title);
  assert.ok(titles('haz la PR de la HU PAN-123').includes('PR'));
  assert.deepEqual(titles('crea la rama para el cambio'), ['Ramas']);
  assert.deepEqual(titles('corre las pruebas del módulo'), ['Pruebas']);
  assert.deepEqual(titles('¿qué hora es?'), []);
  const say = (prompt: string) => (onPrompt(ws, { session_id: 'p1', prompt }) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  const first = say('crea la rama y abre la PR de PAN-9');
  assert.match(first, /the person's instructions in their working agreement/);
  assert.match(first, /### Ramas\nUna rama por HU/);
  assert.match(first, /### PR\n/);
  assert.doesNotMatch(first, /Revisar un PR del equipo/);
  const again = say('ahora abre la PR');
  assert.doesNotMatch(again, /###/, 'what was shown stays in the session: not again');
  assert.match(again, /working agreement/, 'the line, every time');
});

test('Docker from the agent\'s shell is refused with what Laru does instead; a word «docker» elsewhere is not', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws-docker'), { app: 'comercio', title: 'Comercio' });
  const said = (command: string) => (preBash(ws, { session_id: 'd', tool_input: { command } }) as { hookSpecificOutput?: { permissionDecisionReason: string } } | null)?.hookSpecificOutput?.permissionDecisionReason;
  for (const c of ['docker ps', 'wsl -d Ubuntu docker compose ps', 'cd api && docker logs api', '& docker.exe ps']) assert.match(said(c) ?? '', /Not from your shell[\s\S]*laru exec <service> -- <command>/, c);
  for (const c of ['grep -rn docker .', 'cat docker-compose.yml', 'laru doctor', 'laru up']) assert.equal(said(c), undefined, c);
});

test('a container engine is found as the shell would run it: wrappers, shells, eval, quotes, paths, heredocs, what a pipeline feeds a shell; never in what only names it', async () => {
  const { runsDocker } = await import('../src/index.ts');
  const yes = ['docker ps', 'sudo -E docker ps', 'sudo -u root docker ps', 'wsl -d Ubuntu docker ps', 'wsl -e docker ps', 'wsl -u root -- docker ps', 'wsl.exe -- docker compose ps', '& docker ps', 'DOCKER_HOST=tcp://x docker ps', 'env FOO=1 docker run x', 'env -i docker ps', 'env -S "docker ps"', 'x | docker exec -i c sh',
    'echo $(docker ps -q)', 'echo `docker ps`', 'echo "$(docker ps)"', 'command docker ps', 'exec docker ps', 'exec -a x docker ps', 'time docker ps', 'timeout 5 docker ps', 'timeout -s KILL 5 docker ps', 'nice -n 10 docker ps', 'nohup docker ps', 'xargs docker rm', 'xargs -I{} docker rm {}', 'sleep 1 & docker ps', '"docker" ps', "'docker' ps", 'doc""ker ps', "do'ck'er ps", '\\docker ps',
    '/usr/bin/docker ps', 'C:\\tools\\docker.exe ps', '"C:\\Program Files\\Docker\\docker.exe" ps', 'bash -c "docker ps"', 'bash -lc "cd x && docker ps"', "sh -c 'docker compose ps'", 'pwsh -Command "docker ps"', 'cmd /c docker ps', 'eval docker ps', 'eval "docker ps"', 'iex "docker ps"', 'bash <<< "docker ps"', 'podman ps', 'nerdctl ps', 'docker-compose up', 'bash -c "echo \\"x\\" && docker ps"',
    'bash <<EOF\ndocker ps\nEOF', 'cat > a.txt <<EOF\nhola\nEOF\ndocker ps', 'ls && docker ps # list', 'cmd /c "echo #& docker ps"', 'cat <<EOF | bash\ndocker ps\nEOF', 'echo "docker ps" | sh', "printf 'docker ps' | bash -s", 'cat <<< "docker ps" | bash', 'echo docker ps | cmd',
    'cat <<EOF | sudo bash\ndocker ps\nEOF', 'echo docker ps | sudo -u root sh', 'echo docker ps | env bash', 'echo docker ps | /bin/bash -l', 'echo docker ps |& bash', 'echo docker ps | busybox sh', 'docker ps 2>&1 | tail', 'npm test &> log; docker ps'];
  const no = ['grep -rn docker .', 'cat docker-compose.yml', 'laru doctor', 'git commit -m "docker cleanup"', 'git commit -m "fix; docker ps"', 'echo "a && docker ps"', "echo 'x | docker ps'", 'ls docker/', 'mydocker ps', 'npm run docker:build', 'echo docker', 'wsl -l -v', 'bash -c "ls docker"', 'git log --grep docker', 'command -v docker', 'type docker', 'which docker', 'git commit -m "$(cat msg)"',
    `git commit -m "$(cat <<'EOF'\nfix: docker cleanup\n\ndocker ps no longer needed\nEOF\n)"`, 'cat > run.sh <<EOF\n#!/bin/sh\ndocker run --rm x\nEOF\nchmod +x run.sh', 'cat <<-EOF\n\tdocker ps\n\tEOF', 'cat <<< "docker ps"', 'grep -c x <<< "docker ps"', 'ls # then docker ps', 'npm test 2>&1 | tail -5', 'echo foo#bar',
    'bash ./scripts/build.sh', 'bash /x/build-docker.sh', 'echo hi | bash', 'cat install.sh | bash', 'cd docker && bash', 'echo "use docker" > notes.txt && cat setup.sh | bash', 'grep docker x.txt; bash -n s.sh', 'cat docker.md | wc -l'];
  // PowerShell: Start-Process, -EncodedCommand (base64 of UTF-16) and -Command by any prefix it takes
  const b64 = (t: string) => Buffer.from(t, 'utf16le').toString('base64');
  yes.push('Start-Process docker -ArgumentList ps', 'Start-Process -FilePath docker -ArgumentList "ps"', 'saps docker', `powershell -EncodedCommand ${b64('docker ps')}`, `pwsh -enc ${b64('docker compose up -d')}`, 'pwsh -co "docker ps"', 'powershell -NoProfile -Command "& docker ps"', "Invoke-Expression 'docker ps'", "& 'C:\\Program Files\\Docker\\docker.exe' ps", 'bash -xc "docker ps"', 'Start-Process -FilePath "C:\\Program Files\\Docker\\docker.exe"');
  no.push('Start-Process notepad', 'pwsh -File ./build.ps1', 'Get-Content docker-compose.yml', `powershell -EncodedCommand ${b64('Get-ChildItem')}`, 'pwsh -c "Get-Content docker.md"', 'bash -x build.sh');
  // Start-Process and start by their real parameters: any prefix, a colon, switches before the program, a title first
  yes.push('Start-Process -FilePath:docker', 'Start-Process -Fi docker -Arg ps', 'Start-Process -Wait docker', 'start "titulo" docker ps', 'cmd /c start "" docker ps', 'start /d C:\\x docker ps', 'Start-Process powershell -ArgumentList "-c","docker ps"', "Start-Process bash -ArgumentList '-c \"docker ps\"'", 'start powershell -ArgumentList "-Command docker ps"');
  no.push('Start-Process -FilePath notepad -ArgumentList docker-compose.yml', 'start "" notepad', 'Start-Process -Wait code', 'start https://docs.docker.com');
  // what Start-Process runs is a command line, read whole: every command of its argument list
  yes.push("Start-Process cmd -ArgumentList '/c echo x & docker ps'", 'Start-Process bash -ArgumentList "-c","echo x; docker ps"', "Start-Process pwsh -ArgumentList '-c', 'Get-Date; docker ps'");
  no.push("Start-Process cmd -ArgumentList '/c echo docker'", 'Start-Process bash -ArgumentList "-c","ls docker"');
  // any other program takes its arguments as text: a ; or a & there is no command; and Start-Process has no title
  // what Start-Process starts is resolved like any command: a wrapper it starts still runs what follows
  yes.push("Start-Process wsl -ArgumentList 'docker ps'", "Start-Process wsl -ArgumentList '-d','Ubuntu','docker','ps'", "Start-Process sudo -ArgumentList 'docker ps'", "Start-Process env -ArgumentList 'X=1 docker ps'", "saps busybox -ArgumentList 'sh -c docker'", 'start wsl docker ps');
  no.push("Start-Process wsl -ArgumentList '-l','-v'");
  // a program that is not a shell gets its arguments as text: $(…), backticks and << there are nothing that runs
  no.push("Start-Process git -ArgumentList 'commit','-m','$(docker ps)'", "Start-Process notepad -ArgumentList '`docker ps`'", "Start-Process code -ArgumentList 'a.txt <<EOF docker'");
  no.push("Start-Process notepad -ArgumentList 'notas.txt; docker ps'", "Start-Process code -ArgumentList '--goto','a.ts:1 & docker'", "Start-Process git -ArgumentList 'commit','-m','fix | docker ps'", "start notepad 'x; docker ps'", 'Start-Process notepad docker', 'saps code docker-compose.yml');
  // wsl with a command line hands it to the distribution's shell (its ; $(…) and quotes count); wsl -e runs a program as it is
  yes.push("Start-Process wsl -ArgumentList 'echo x; docker ps'", 'wsl "echo x; docker ps"', "wsl echo '$(docker ps)'", "wsl -d Ubuntu -- 'echo x && docker ps'", "Start-Process wsl -ArgumentList 'echo $(docker ps)'");
  no.push('wsl ls -la', 'wsl grep docker x.txt', "wsl -e echo 'x; docker ps'", 'wsl --shutdown');
  yes.push("Start-Process wsl -ArgumentList '-e','docker','ps'", "Start-Process wsl -ArgumentList 'echo','x; docker ps'");
  no.push("Start-Process wsl -ArgumentList '-e','echo','x; docker ps'", "Start-Process wsl -ArgumentList '-e echo \"x; docker ps\"'", "Start-Process wsl -ArgumentList '--exec','printf','%s','$(docker ps)'");
  for (const c of yes) assert.ok(runsDocker(c), `missed: ${c}`);
  for (const c of no) assert.ok(!runsDocker(c), `refused by mistake: ${c}`);
});


test('an agreement written before its «Notas» became «Instrucciones para el agente» still gives them to the agent', async () => {
  const { instructions, loadAgreement } = await import('../src/index.ts');
  const { writeFileSync } = await import('node:fs');
  const ws = withAgreement('ws-old', '');
  const agr = loadAgreement(ws)!;
  // the file as an earlier Laru wrote it: its section under the old heading
  writeFileSync(join(ws.root, agr.path), `${readFileSync(join(ws.root, agr.path), 'utf8').trimEnd()}\n\n## Notas\n\n### PR\nTítulo con la HU.\n`);
  assert.deepEqual(instructions(ws).map((s) => s.title), ['Ramas', 'PR']);
  assert.match(String(loadAgreement(ws)!.fields.notes), /### PR\nTítulo con la HU\./);
});
