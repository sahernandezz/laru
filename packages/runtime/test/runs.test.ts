/** A run's evidence on disk and where each flow starts, without Docker: the media moved once, the base URL per project. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@laru/core';
import type { Trace } from '@laru/trace';
import { baseUrls, dropRawMedia, envDir, keepEvidence, recordingOn, type FlowSpec } from '../src/index.ts';

test("a run's evidence: the story's video and its screenshots move to flows/<slug>/; the raw media left in out/ goes, the rest stays", () => {
  const dir = mkdtempSync(join(tmpdir(), 'laru-run-'));
  const put = (p: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), p); };
  for (const p of ['pagar-historia/video.webm', 'pagar-historia/s1.png', 'pagar-historia/trace.zip', 'pagar-caso/video.webm', 'pagar-caso/error-context.md', 'otro/trace.zip']) put(`out/results/${p}`);
  const story = { test: 'historia', video: '/ks/out/results/pagar-historia/video.webm', pwTrace: '/ks/out/results/pagar-historia/trace.zip', steps: [{ n: 1 }, { n: 2 }] } as unknown as Trace;
  const caso = { test: 'caso', steps: [{ n: 3 }] } as unknown as Trace;
  keepEvidence(dir, 'pagar', [story, caso], story);
  dropRawMedia(join(dir, 'out', 'results'));
  const flow = join(dir, 'flows', 'pagar');
  assert.deepEqual(readdirSync(flow).sort(), ['cases.json', 's1.png', 'trace.json', 'trace.zip', 'video.webm']);
  assert.equal(readFileSync(join(flow, 'trace.zip'), 'utf8'), 'out/results/pagar-historia/trace.zip', 'Playwright\'s trace moves the same way');
  assert.equal(readFileSync(join(flow, 'video.webm'), 'utf8'), 'out/results/pagar-historia/video.webm', 'moved, the one copy');
  assert.deepEqual(JSON.parse(readFileSync(join(flow, 'trace.json'), 'utf8')), { test: 'historia', video: 'video.webm', pwTrace: 'trace.zip', steps: [{ n: 1, screenshot: 's1.png' }, { n: 2 }] });
  assert.deepEqual(JSON.parse(readFileSync(join(flow, 'cases.json'), 'utf8')), [{ test: 'caso', steps: [{ n: 3 }] }]);
  const left = (readdirSync(join(dir, 'out', 'results'), { recursive: true }) as string[]).filter((p) => /\.\w+$/.test(p)).sort();
  assert.deepEqual(left, ['pagar-caso/error-context.md'], 'no video, screenshot or zip (raw and unmasked) stays in out/');
  // a story whose video the runner did not leave names none
  const lost = { test: 'historia', video: '/ks/out/results/nada/video.webm', steps: [] } as unknown as Trace;
  keepEvidence(dir, 'sin-video', [lost], lost);
  assert.equal(JSON.parse(readFileSync(join(dir, 'flows', 'sin-video', 'trace.json'), 'utf8')).video, undefined);
  assert.ok(!existsSync(join(dir, 'flows', 'sin-video', 'cases.json')));
});

test("in a joint env each flow starts on its own project's front: the project of the first service it needs", () => {
  const ws = { root: mkdtempSync(join(tmpdir(), 'laru-base-')) } as Workspace;
  const r = (svc: string, ports: number[], more = {}) => ({ svc, aliases: [svc], ports, upstream: `${svc}-real`, proto: 'http', ...more });
  mkdirSync(join(envDir(ws, 'all'), 'tap'), { recursive: true });
  writeFileSync(join(envDir(ws, 'all'), 'tap', 'routes.json'), JSON.stringify({ routes: [
    // what is not the browser's: a project network's own route, a published host port, a tcp store
    r('audit-web', [8081], { net: 'audit' }), r('audit-web', [18080], { net: 'ks', kind: 'host-port' }), r('postgres', [5432], { net: 'ks', proto: 'tcp' }),
    r('api-gateway', [8080], { net: 'ks' }), r('frontend', [80], { net: 'ks' }), r('audit-api', [3000], { net: 'ks' }), r('audit-web', [80], { net: 'ks' }), r('ledger', [3000], { net: 'ks' }),
  ] }));
  const map = { nodes: [['frontend', 'vaultflow'], ['api-gateway', 'vaultflow'], ['postgres', 'vaultflow'], ['audit-web', 'audit'], ['audit-api', 'audit'], ['ledger', 'ledger']].map(([s, repo]) => ({ id: `svc:${s}`, repo })) };
  const flow = (slug: string, needs: string[]) => ({ slug, needs }) as FlowSpec;
  assert.deepEqual(baseUrls(ws, 'all', undefined, [flow('subir', ['svc:api-gateway']), flow('auditar', ['ds:audit-postgres', 'svc:audit-api', 'svc:frontend']), flow('asentar', ['svc:ledger']), flow('nada', [])], map),
    { subir: 'http://frontend', auditar: 'http://audit-web', asentar: 'http://ledger:3000' });
  assert.deepEqual(baseUrls(ws, 'all', undefined, [flow('subir', ['svc:api-gateway'])], null), {}, 'no map: every flow keeps the env\'s base URL');
});

test('a session that is recording on an env is found, and an env of one flow or one run is never recording for someone else', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-rec-'));
  const ws = { root, app: 'a', title: 'A', repos: [] } as unknown as Workspace;
  const put = (id: string, r: object) => { mkdirSync(join(root, '.laru', 'runs', id), { recursive: true }); writeFileSync(join(root, '.laru', 'runs', id, 'run.json'), JSON.stringify({ id, flows: [], ephemeral: false, results: {}, startedAt: new Date().toISOString(), ...r })); };
  put('1', { kind: 'session', env: 'local', phase: 'tests', status: 'running', pid: process.pid });
  put('2', { kind: 'session', env: 'other', phase: 'done', status: 'passed', pid: process.pid });
  put('3', { kind: 'session', env: 'third', phase: 'tests', status: 'running', pid: 2 ** 22 + 7 });
  assert.equal(recordingOn(ws, 'local')?.id, '1');
  assert.equal(recordingOn(ws, 'other'), undefined, 'a saved session records nothing');
  assert.equal(recordingOn(ws, 'third'), undefined, 'a session whose service is gone records nothing');
  assert.equal(recordingOn(ws, 'f-compartir'), undefined, 'a flow\'s own env is not shared');
});
