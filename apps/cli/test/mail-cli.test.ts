import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { run } from '../src/cli.ts';

test('laru mail and sms: the mailbox from the command line, nothing deleted without --yes', async () => {
  const fx = makeFixture();
  const root = join(fx.tmp, 'ws');
  const out: string[] = [], err: string[] = [];
  const io = { log: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  await run(['init', root, '--app', 'comercio'], { log: () => {}, err: () => {} });
  mkdirSync(join(root, 'envs'), { recursive: true });
  writeFileSync(join(root, 'envs', 'correo.yaml'), 'persistent: true\n');
  const box = join(root, '.laru', 'envs', 'correo', 'tap', 'mail');
  mkdirSync(join(box, 'eml'), { recursive: true });
  mkdirSync(join(box, 'cmd'), { recursive: true });
  const sid = `SM${'a'.repeat(32)}`;
  const lines = [
    { v: 1, t: Date.now() - 2000, id: '3f2b7a40-0c1d-4e5f-8a9b-1c2d3e4f5a6b', kind: 'mail', from: '1.2.3.4', sink: 'smtp', port: 587, tls: 'none', envelope: { from: 'a@t.test', rcpt: ['ana@t.test'] }, size: 10, headers: { from: 'a@t.test', to: ['ana@t.test'], cc: [], subject: 'Tu pedido' }, text: 'Entra: http://web/ok?token=abcd1234', attachments: [], links: [{ url: 'http://web/ok?token=abcd1234', class: 'external' }], codes: [], remote: [], lints: [], session: [], outcome: 'accepted', reply: '250' },
    { v: 1, t: Date.now() - 1000, id: sid, kind: 'sms', from: '1.2.3.4', sink: 'api.twilio.com', provider: 'twilio', sid, sender: '+1555', to: '+57300', body: 'Tu código es 482913', chars: 19, segments: 1, encoding: 'UCS-2', direction: 'outbound', codes: ['482913'] },
    { v: 1, t: Date.now() - 900, id: sid, kind: 'status', status: 'delivered' },
  ];
  writeFileSync(join(box, 'messages.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(await run(['mail', 'list', '--env', 'correo'], io, root), 0, err.join('\n'));
  assert.match(out.join('\n'), /1 mail, 1 SMS/);
  assert.match(out.join('\n'), /code 482913/);
  out.length = 0;
  assert.equal(await run(['mail', 'list', '--env', 'correo', '--q', 'tiene:código', '--json'], io, root), 0);
  assert.deepEqual(JSON.parse(out.join('\n')).messages.map((m: { kind: string }) => m.kind), ['sms']);
  out.length = 0;
  assert.equal(await run(['mail', 'read', 'SMaaaa', '--env', 'correo'], io, root), 0);
  assert.match(out.join('\n'), /Tu código es 482913/);
  out.length = 0;
  assert.equal(await run(['mail', 'read', '3f2b7a40', '--env', 'correo'], io, root), 0);
  assert.match(out.join('\n'), /links \(as received, unmasked\)[\s\S]*token=abcd1234/);
  out.length = 0;
  assert.equal(await run(['mail', 'clear', '--env', 'correo'], io, root), 0);
  assert.match(out.join('\n'), /would delete the 2 message\(s\) of correo; add --yes/);
  out.length = 0;
  assert.equal(await run(['mail', 'wait', '--env', 'correo', '--within', '1'], io, root), 1, 'nothing new arrives');
  assert.equal(await run(['sms', 'status', 'x', '--env', 'correo'], io, root), 2);
  assert.equal(await run(['mail', 'bogus', '--env', 'correo'], io, root), 2);
});
