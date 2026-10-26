/**
 * An instance of an env (a flow's environment, an ephemeral run) shares its env label and nothing else: bringing the
 * base env down, or starting an instance, leaves the other's containers, masks and events alone.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { destroyByLabel } from '../src/docker.ts';
import { envDir, forgetValues } from '../src/env.ts';
import { eventsFile } from '../src/up.ts';

/** A docker that lists the containers of a base env and of one instance of it, and logs what it is asked to remove. */
function fake() {
  const bin = mkdtempSync(join(tmpdir(), 'ks-inst-'));
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  ps) printf 'base1|\\nbase2|\\ninst1|f-compartir\\n' ;;
  network) if [ "$2" = ls ]; then printf 'netbase|\\nnetinst|f-compartir\\n'; fi ;;
  volume) if [ "$2" = ls ]; then printf 'volbase|\\nvolinst|f-compartir\\n'; fi ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return { bin, log };
}

test('bringing the base env down leaves its instances\' containers, networks and volumes', async () => {
  const f = fake();
  const path = process.env.PATH;
  process.env.PATH = `${f.bin}:${path}`;
  try {
    const r = await destroyByLabel({ root: '/ws' }, { env: 'local' });
    assert.deepEqual([r.containers, r.networks, r.volumes], [2, 1, 1]);
    const calls = readFileSync(f.log, 'utf8');
    assert.match(calls, /rm -f -v base1 base2\b/);
    assert.doesNotMatch(calls, /inst1|netinst|volinst/);
    await destroyByLabel({ root: '/ws' }, { env: 'local', run: 'f-compartir' });
    assert.match(readFileSync(f.log, 'utf8'), /ps -a --filter label=\S+ --filter label=\S+=local --filter label=\S+=f-compartir/, 'an instance is asked for by its run label');
  } finally { process.env.PATH = path; }
});

test('forgetting the base env\'s values keeps the masks of the instances that run; a sweep forgets them too', () => {
  const ws = { app: 'a', root: mkdtempSync(join(tmpdir(), 'ks-forget-')) } as never;
  const dirs = [join(envDir(ws, 'local'), 'tap'), join(envDir(ws, 'local'), 'runs', 'f-x', 'tap')];
  for (const d of dirs) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'mask.json'), '{}'); }
  forgetValues(ws, 'local');
  assert.equal(existsSync(join(dirs[0], 'mask.json')), false);
  assert.equal(existsSync(join(dirs[1], 'mask.json')), true, 'the instance still has its mask');
  forgetValues(ws, 'local', undefined, { runs: true });
  assert.equal(existsSync(dirs[1]), false);
});

test('an instance writes its events to its own file', () => {
  const ws = { app: 'a', root: '/ws' } as never;
  assert.notEqual(eventsFile(ws, 'local'), eventsFile(ws, 'local', 'f-x'));
  assert.match(eventsFile(ws, 'local', 'f-x'), /runs\/f-x\/events\.jsonl$/);
});

test('a flow\'s environment is an env of its own, derived from the base and whole, whatever the flow names', async () => {
  const { scenarioEnv } = await import('./scenario-env.ts');
  const { listEnvs, loadEnvSpec, isInstance, envFile, instanceFile } = await import('../src/env.ts');
  const { prepareInstance, needsOf, baseFor, instanceBase } = await import('../src/flowenv.ts');
  const env = await scenarioEnv();
  // the fixture's flow needs billing-api and starts from scn:pedido-pagado
  assert.deepEqual(needsOf(env.ws, 'pagar-el-pedido'), ['billing-api']);
  assert.equal(baseFor(env.ws), 'local');
  const p = prepareInstance(env.ws, 'pagar-el-pedido');
  assert.equal(p.env, 'f-pagar-el-pedido');
  assert.ok(isInstance(p.env) && !isInstance('local') && !isInstance('fast'));
  assert.equal(envFile(env.ws, p.env), instanceFile(env.ws, p.env), 'its spec lives with the machine\'s state');
  assert.deepEqual(listEnvs(env.ws), ['local'], 'the workspace\'s envs are not made longer by an instance');
  const spec = loadEnvSpec(env.ws, p.env);
  assert.equal(instanceBase(env.ws, p.env), 'local');
  assert.deepEqual(p.services, ['billing-api'], 'what the flow documents as needing, for its sheet');
  assert.equal(spec.services, undefined, 'and the env is not narrowed to it: every service of the base answers');
  assert.equal(spec.persistent, true);
  assert.throws(() => baseFor(env.ws, 'nope'), /derive it from one of local/);
});

test('seeding plays a scenario\'s setup under the flow\'s own name, puts nothing back, and refuses an exclusive scenario', async () => {
  const { scenarioEnv } = await import('./scenario-env.ts');
  const { isExclusive, seedScenario } = await import('../src/scenarios.ts');
  const env = await scenarioEnv();
  env.script({ 'pedido-pagado': { identities: [{ name: 'ana', username: 'ana-seed' }], pgWrite: true } });
  const all = (await import('../src/scenarios.ts')).listScenarios(env.ws);
  const free = all.find((s) => !s.restart.length && !s.mocks.length && !s.faults.length && !s.exclusive);
  const restarting = all.find((s) => s.restart.length);
  assert.ok(free && restarting, 'the fixture has a plain scenario and one that restarts a service');
  assert.equal(isExclusive(env.ws, restarting.id), true, 'a scenario that restarts a service needs the whole env');
  assert.equal(isExclusive(env.ws, free.id), false);
  await assert.rejects(seedScenario(env.ws, restarting.id, { env: 'local', as: 'r1-seed0', out: join(tmpdir(), 'ks-seed-x') }), /exclusive/);
  env.forget();
  const r = await seedScenario(env.ws, free.id, { env: 'local', as: 'r1-seed1', out: join(mkdtempSync(join(tmpdir(), 'ks-seed-')), 'out') });
  assert.ok(Array.isArray(r.identities));
  assert.deepEqual(env.creates(), [], 'no database was made from a snapshot: nothing was put back');
  const calls = env.calls().join('\n');
  assert.doesNotMatch(calls, /DROP DATABASE/, 'and none was dropped');
  assert.match(calls, /KS_RUN=r1-seed1|r1-seed1/, 'the runner played it under the flow\'s own name');
});

test('an instance with no mask of its own shows nothing; the base env, and an up still writing its mask, do not need one', async () => {
  const { envMasker } = await import('../src/env.ts');
  const ws = { app: 'a', root: mkdtempSync(join(tmpdir(), 'ks-mask-')) } as never;
  assert.throws(() => envMasker(ws, 'f-compartir'), /no mask of its own/);
  assert.doesNotThrow(() => envMasker(ws, 'f-compartir', undefined, { allowMissing: true }), 'an up that has not written it yet');
  assert.doesNotThrow(() => envMasker(ws, 'local'), 'the base env is masked from what it has, as before');
});
