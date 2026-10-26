/** A workspace and a machine set up before the product was called Laru keep working with their old files and folders. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFile, envOf, findWorkspace, initWorkspace, isWorkspace, laruHome, loadWorkspace, stateDir, writeAgentFiles } from '../src/index.ts';

const OLD = 'keelson'; // legacy-name

test('an old workspace: its config, lock and state folder are found under their old names', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-legacy-'));
  writeFileSync(join(root, `${OLD}.yaml`), 'app: viejo\ntitle: Viejo\nrepos: {}\n');
  writeFileSync(join(root, `${OLD}.lock`), 'repos:\n  api: abc123\n');
  mkdirSync(join(root, `.${OLD}`));
  assert.ok(isWorkspace(root));
  assert.equal(findWorkspace(join(root)), root);
  const ws = loadWorkspace(root);
  assert.deepEqual([ws.app, ws.lock.api], ['viejo', 'abc123']);
  assert.equal(stateDir(ws), join(root, `.${OLD}`));
  assert.equal(configFile(root), join(root, `${OLD}.yaml`));
});

test('a new workspace gets the new names', () => {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'laru-new-')), 'w'), { app: 'nuevo' });
  assert.ok(existsSync(join(ws.root, 'laru.yaml')));
  assert.equal(stateDir(ws), join(ws.root, '.laru'));
  assert.match(readFileSync(join(ws.root, '.gitignore'), 'utf8'), /^\.laru\/$/m);
});

test('the old agent files are rewritten in place: one block, the server and the hooks under the new name', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-agents-'));
  writeFileSync(join(root, `${OLD}.yaml`), 'app: viejo\ntitle: Viejo\nrepos: {}\n');
  writeFileSync(join(root, 'CLAUDE.md'), `<!-- ${OLD}:start -->\nold guide\n<!-- ${OLD}:end -->\n\nMy own notes\n`);
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { [OLD]: { command: OLD, args: ['mcp'] }, other: { command: 'x' } } }));
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: `${OLD} hook pre-edit` }] }] } }));
  writeFileSync(join(root, '.claude', 'agents', 'developer.md'), `---\nname: developer\ntools: Read, mcp__${OLD}__context\n---\n\n<!-- ${OLD}:start -->\nold\n<!-- ${OLD}:end -->\n`);
  writeAgentFiles(loadWorkspace(root));
  const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(md.match(/:start -->/g)?.length, 1);
  assert.ok(md.includes('<!-- laru:start -->') && md.includes('My own notes') && !md.includes(OLD));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers).sort(), ['laru', 'other']);
  const hooks = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.PreToolUse.flatMap((h: { hooks: Array<{ command: string }> }) => h.hooks.map((x) => x.command)), ['laru hook pre-edit']);
  const dev = readFileSync(join(root, '.claude', 'agents', 'developer.md'), 'utf8');
  assert.ok(dev.includes('mcp__laru__context') && !dev.includes(OLD));
});

test('the machine folder and the variables keep their old names while the new ones are absent', () => {
  const before = { home: process.env.LARU_HOME, old: process.env[`${OLD.toUpperCase()}_HOME`], x: process.env.LARU_REVEAL, ox: process.env[`${OLD.toUpperCase()}_REVEAL`] };
  try {
    delete process.env.LARU_HOME;
    process.env[`${OLD.toUpperCase()}_HOME`] = '/tmp/old-home';
    assert.equal(laruHome(), '/tmp/old-home');
    process.env.LARU_HOME = '/tmp/new-home';
    assert.equal(laruHome(), '/tmp/new-home', 'the new name wins');
    delete process.env.LARU_REVEAL;
    process.env[`${OLD.toUpperCase()}_REVEAL`] = 'off';
    assert.equal(envOf('REVEAL'), 'off');
  } finally {
    for (const [k, v] of [['LARU_HOME', before.home], [`${OLD.toUpperCase()}_HOME`, before.old], ['LARU_REVEAL', before.x], [`${OLD.toUpperCase()}_REVEAL`, before.ox]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
