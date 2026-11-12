/**
 * Against the real Docker: Laru's cleanup removes what carries its labels and never what another project left, even
 * with a name like Laru's: images, volumes, containers and networks. Everything is created here and removed at the end.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
// it runs Laru's real cleanup on this machine's Docker (its own stale images go too): only when asked
const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;

test('images, volumes, containers and networks of another project stay; Laru\'s leftovers go', { skip: heavy, timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'laru-own-'));
  process.env.LARU_HOME = join(tmp, 'home');
  const { initWorkspace, loadWorkspace } = await import('@laru/core');
  const { destroyByLabel, prune, workspaceKey, LABEL } = await import('../src/index.ts');
  const ws = loadWorkspace(initWorkspace(join(tmp, 'ws'), { app: 'laruvalid' }).root);
  const sh = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  const has = (kind: 'image' | 'volume' | 'container' | 'network', name: string) => spawnSync('docker', [kind, 'inspect', name], { stdio: 'ignore' }).status === 0;
  const id = process.pid.toString(36);
  const build = (tag: string, labels: string[] = []) => execFileSync('docker', ['build', '-q', ...labels.flatMap((l) => ['--label', l]), '-t', tag, '-'], { input: 'FROM scratch\nLABEL laru.test=1\n', stdio: ['pipe', 'ignore', 'ignore'] });

  const img = { foreign: `ks-ajeno${id}/api:x`, gone: `ks-gone${id}/api:x`, base: `laruvalid${id}-base:x` };
  const vol = { foreign: `ks-ajeno${id}-data`, gone: `ks-gone${id}-data` };
  const net = { foreign: `ks-laruvalid-e-ajeno${id}`, mine: `ks-laruvalid-e-mine${id}` };
  const box = { foreign: `ks-laruvalid-e-ajeno${id}`, mine: `ks-laruvalid-e-mine${id}` };
  const mine = [`${LABEL.workspace}=${workspaceKey(ws)}`, `${LABEL.app}=laruvalid`, `${LABEL.env}=e`].flatMap((l) => ['--label', l]);
  try {
    build(img.foreign); // a look-alike name, without Laru's label
    build(img.gone, [`${LABEL.app}=gone${id}`]); // Laru's, of an app with no workspace on this machine
    build(img.base);
    sh('volume', 'create', vol.foreign);
    sh('volume', 'create', '--label', `${LABEL.app}=gone${id}`, vol.gone);
    sh('network', 'create', net.foreign);
    sh('network', 'create', ...mine, net.mine);
    sh('create', '--name', box.foreign, '--entrypoint', '/none', img.base);
    sh('create', '--name', box.mine, ...mine, '--entrypoint', '/none', img.base);

    await prune(ws, { what: ['images'] });
    assert.ok(has('image', img.foreign), 'another project\'s image stays');
    assert.ok(!has('image', img.gone), 'Laru\'s leftover image goes');
    assert.ok(has('volume', vol.foreign), 'another project\'s volume stays');
    assert.ok(!has('volume', vol.gone), 'Laru\'s leftover volume goes');

    await destroyByLabel(ws, { env: 'e' });
    assert.ok(has('container', box.foreign) && has('network', net.foreign), 'another project\'s container and network stay');
    assert.ok(!has('container', box.mine) && !has('network', net.mine), 'the env\'s own go');
  } finally {
    for (const c of Object.values(box)) spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
    for (const n of Object.values(net)) spawnSync('docker', ['network', 'rm', n], { stdio: 'ignore' });
    for (const v of Object.values(vol)) spawnSync('docker', ['volume', 'rm', v], { stdio: 'ignore' });
    for (const i of Object.values(img)) spawnSync('docker', ['image', 'rm', i], { stdio: 'ignore' });
  }
});
