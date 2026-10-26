/**
 * «Aplicar» without the interface: `laru scenario apply` and the MCP tools say what applying would delete on a
 * persistent env and change nothing until they are told yes (`--yes`, `confirm: true`). Against a fake docker.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listRuns, runsDir } from '../../../packages/runtime/src/index.ts';
import { scenarioEnv } from '../../../packages/runtime/test/scenario-env.ts';
import { run } from '../src/cli.ts';
import { createServer } from '../src/mcp.ts';

const PASSWORD = 'vault-Passw0rd-zq81';
const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { io: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
};
const runs = (calls: string[]) => calls.filter((l) => l.startsWith('run ')).length;

test('laru scenario apply and session start --scenario: a persistent env prints what would be deleted and exits 1 until --yes; an ephemeral one needs none', async () => {
  const env = await scenarioEnv({ secret: { key: 'ADMIN_PASSWORD', value: PASSWORD } });
  const root = env.ws.root;
  env.script({ 'pedido-pagado': { identities: [{ name: 'ana', username: 'ana', passwordVar: 'ADMIN_PASSWORD' }], pgWrite: true }, 'pedido-vacio': {} });

  const no = capture();
  assert.equal(await run(['scenario', 'apply', 'scn:pedido-pagado', '--env', 'local'], no.io, root), 1);
  assert.match(no.err.join('\n'), /^Se juega la preparación del escenario, que escribe sobre lo que hay y se reinicia billing-api; postgres conserva lo que tiene\.\nTo go ahead: laru scenario apply scn:pedido-pagado --env local --yes$/);
  assert.deepEqual([no.out, runs(env.calls())], [[], 0], 'nothing was printed as done and nothing ran');

  const yes = capture();
  assert.equal(await run(['scenario', 'apply', 'scn:pedido-pagado', '--env', 'local', '--yes'], yes.io, root), 0);
  assert.match(yes.out.join('\n'), /scn:pedido-pagado applied on local in .*\(its setup played\)\n  ana: ana \(password: the one its setup made, not shown here\)/);
  assert.equal(yes.out.join('\n').includes(PASSWORD), false, 'who can sign in is named; the password is not');
  assert.equal(runs(env.calls()), 1);

  // the same question for a session that starts from a scenario
  const s = capture();
  assert.equal(await run(['session', 'start', '--env', 'local', '--scenario', 'scn:pedido-vacio'], s.io, root), 1);
  assert.match(s.err.join('\n'), /^Se restaura postgres desde la instantánea «base» \(se pierden las filas de hoy\) y se juega la preparación del escenario, que escribe sobre lo que hay\.\nTo go ahead: laru session start --env local --scenario scn:pedido-vacio --yes$/);
  assert.equal(runs(env.calls()), 1, 'no session, no apply');
  const s2 = capture();
  assert.equal(await run(['session', 'start', '--env', 'local', '--scenario', 'scn:pedido-vacio', '--yes'], s2.io, root), 0);
  assert.match(s2.out.join('\n'), /^session \d+ open on local/);

  // the hint keeps what the person typed
  const s3 = capture();
  assert.equal(await run(['session', 'start', '--env', 'local', '--scenario', 'scn:pedido-pagado', '--title', 'subir un fichero', '--browser'], s3.io, root), 1);
  assert.match(s3.err.join('\n'), /To go ahead: laru session start --env local --scenario scn:pedido-pagado --title "subir un fichero" --browser --yes$/);

  // provisioning resets the same stores to «base»: it asks the same
  const before = runs(env.calls());
  const p = capture();
  assert.equal(await run(['scenario', 'provision', 'scn:pedido-vacio', '--env', 'local'], p.io, root), 1);
  assert.match(p.err.join('\n'), /^Se restaura postgres desde la instantánea «base» \(se pierden las filas de hoy\) y se juega la preparación del escenario.*\nTo go ahead: laru scenario provision scn:pedido-vacio --env local --yes$/s);
  assert.equal(runs(env.calls()), before, 'nothing ran');
  const p2 = capture();
  assert.equal(await run(['scenario', 'provision', 'scn:pedido-vacio', '--env', 'local', '--yes'], p2.io, root), 0);
  assert.match(p2.out.join('\n'), /^scn:pedido-vacio provisioned in /);

  // a flow that starts from a scenario applies it: it asks too, and plays nothing until --yes
  const t = capture(), playing = runs(env.calls());
  assert.equal(await run(['test', 'pagar-el-pedido', '--env', 'local'], t.io, root), 1);
  assert.match(t.err.join('\n'), /^scn:pedido-pagado: Se restaura postgres .*\nTo go ahead: the same command with --yes$/s);
  assert.deepEqual([t.out, runs(env.calls())], [[], playing], 'no run, no runner');
  const t2 = capture();
  // the sessions above are still open on local, and a run waits for a session that records on its env: they are closed first
  for (const r of listRuns(env.ws)) if (r.kind === 'session') writeFileSync(join(runsDir(env.ws), r.id, 'run.json'), JSON.stringify({ ...r, phase: 'done', status: 'passed' }));
  await run(['test', 'pagar-el-pedido', '--env', 'local', '--yes', '--no-cache'], t2.io, root);
  assert.equal(t2.err.some((l) => l.includes('To go ahead')), false);
  assert.ok(runs(env.calls()) > playing, 'with --yes the scenario and the flow ran');

  // an env that keeps nothing worth asking about
  writeFileSync(join(root, 'envs', 'local.yaml'), 'persistent: false\n');
  const e = capture();
  assert.equal(await run(['scenario', 'apply', 'scn:pedido-pagado', '--env', 'local'], e.io, root), 0);
  assert.deepEqual(e.err, []);

  // an error of the scenarios is a message, not a stack
  const bad = capture();
  assert.equal(await run(['scenario', 'apply', 'scn:nada', '--env', 'local'], bad.io, root), 1);
  assert.match(bad.err.join('\n'), /^no scenario scn:nada; scenarios are /);
});

test('MCP scenario_apply and session_start: without confirm they answer with what would be deleted and change nothing; with confirm: true they go ahead', async () => {
  const env = await scenarioEnv({ secret: { key: 'ADMIN_PASSWORD', value: PASSWORD } });
  env.script({ 'pedido-pagado': { identities: [{ name: 'ana', username: 'ana', passwordVar: 'ADMIN_PASSWORD' }], pgWrite: true }, 'pedido-vacio': {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(env.ws.root).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  for (const name of ['scenario_apply', 'session_start', 'flow_run']) {
    const confirm = (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { type: string; default: boolean }>).confirm;
    assert.deepEqual([confirm.type, confirm.default], ['boolean', false], `${name} takes confirm, off unless said`);
  }
  assert.match(tools.find((t) => t.name === 'scenario_apply')!.description!, /changes nothing: ask the person, then call again with confirm: true/);
  const text = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text;

  const asked = await text('scenario_apply', { scenario: 'scn:pedido-pagado', env: 'local' });
  assert.match(asked, /^Not applied\. Se juega la preparación del escenario, que escribe sobre lo que hay y se reinicia billing-api; postgres conserva lo que tiene\.\nIf the person agrees to that, call scenario_apply again with confirm: true$/);
  assert.equal(runs(env.calls()), 0);
  const done = await text('scenario_apply', { scenario: 'scn:pedido-pagado', env: 'local', confirm: true });
  assert.match(done, /^scn:pedido-pagado applied on local in .* its setup played\.\nwho can sign in: ana \(ana\)$/);
  assert.equal(done.includes(PASSWORD), false);
  assert.equal(runs(env.calls()), 1);

  const sAsked = await text('session_start', { scenario: 'scn:pedido-vacio', env: 'local', browser: false });
  assert.match(sAsked, /^Not applied\. .*call session_start again with confirm: true$/s);
  assert.equal(runs(env.calls()), 1);
  assert.match(await text('session_start', { scenario: 'scn:pedido-vacio', env: 'local', browser: false, confirm: true }), /^session \d+ open on local\./);

  // a flow that starts from a scenario is the same hazard by another door
  const before = runs(env.calls());
  const flow = await text('flow_run', { flows: ['pagar-el-pedido'], env: 'local' });
  assert.match(flow, /^Not applied\. scn:pedido-pagado: Se restaura postgres .*\nIf the person agrees to that, call flow_run again with confirm: true$/s);
  assert.equal(runs(env.calls()), before, 'no scenario applied, no runner');
  assert.match(tools.find((t) => t.name === 'flow_run')!.description!, /plays nothing until the person agrees and you call again with confirm: true/);
  await client.close();
});
