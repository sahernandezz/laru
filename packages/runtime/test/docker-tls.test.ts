/**
 * An app that calls a fixed HTTPS host by name: the tap answers for it with a certificate of the local CA, the
 * service trusts that CA, and a contract mock answers. Heavy: LARU_E2E=1 with Docker running.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace } from '@laru/core';
import { down, up, workspaceKey } from '../src/index.ts';
import { dockerUp, guard } from './guard.ts';

const APP = {
  'docker-compose.yml': 'services:\n  client:\n    build: ./client\n    ports: ["3000:3000"]\n',
  'client/Dockerfile': 'FROM node:22-alpine\nCOPY server.js /srv/server.js\nEXPOSE 3000\nCMD ["node", "/srv/server.js"]\n',
  'client/server.js': `require('http').createServer(async (req, res) => {
  try { const r = await fetch('https://api.partner.test/v1/ping'); res.end(JSON.stringify({ status: r.status, body: await r.json() })); }
  catch (e) { res.end(JSON.stringify({ error: String(e.cause ?? e) })); }
}).listen(3000);
`,
};

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;

test('a fixed HTTPS host answered by a mock through the tap, trusted through the local CA', { skip: heavy, timeout: 10 * 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-tls-')));
  process.env.LARU_HOME = join(tmp, 'home');
  process.env.LARU_VAULT_KEYSTORE = 'file';
  mkdirSync(process.env.LARU_HOME, { recursive: true });
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'maxEnvs: 9\n');
  const work = join(tmp, 'seed', 'tlsapp');
  for (const [p, c] of Object.entries(APP)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  git('clone', '--quiet', '--bare', work, join(tmp, 'remotes', 'tlsapp.git'));
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'tlsapp', title: 'TLS' });
  await addRepo(ws, `file://${join(tmp, 'remotes', 'tlsapp.git')}`);
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: tlsapp:docker-compose.yml\nhosts: [api.partner.test]\nmocks:\n  api.partner.test: { mode: contract }\n');
  mkdirSync(join(ws.root, 'mocks', 'api.partner.test'), { recursive: true });
  writeFileSync(join(ws.root, 'mocks', 'api.partner.test', 'openapi.yaml'), "openapi: 3.0.3\npaths:\n  /v1/ping:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              example: { pong: true }\n");
  const g = guard(workspaceKey(ws));
  t.after(async () => { await down(ws, 'local', { caches: true }).catch(() => undefined); g.check(); });

  const r = await up(ws, { env: 'local' });
  const client = r.addresses.find((a) => a.service === 'client')!;
  const answer = await (await fetch(client.url)).json() as { status?: number; body?: unknown; error?: string };
  assert.deepEqual(answer, { status: 200, body: { pong: true } });
  const traffic = readFileSync(join(ws.root, '.laru', 'envs', 'local', 'tap', 'traffic.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(traffic.some((x) => x.svc === 'api.partner.test' && x.mock === 'contract' && x.path === '/v1/ping' && x.status === 200), 'the HTTPS call is recorded, decrypted, with the mock that answered');
  assert.ok(!readFileSync(join(ws.root, '.laru', 'envs', 'local', 'compose.yml'), 'utf8').includes('ca.key'), 'the CA key is never mounted');
});
