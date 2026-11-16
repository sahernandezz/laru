/**
 * A run's recording of the mailbox keeps no code and no token in plain: the live screen shows them for the person to
 * use, the recording passes everything through the run's masker, which knows them once the tests ended; a mail's
 * original and its attachments are not kept, as encoded they cannot be masked.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDir } from '@laru/core';
import { createMasker, PLAIN } from '@laru/trace';
import { recordState } from '../src/index.ts';
import { scenarioEnv } from './scenario-env.ts';

test('the recorded mailbox masks the codes and the links\' tokens, and keeps no original nor attachment', async () => {
  const env = await scenarioEnv();
  const box = join(stateDir(env.ws), 'envs', 'local', 'tap', 'mail');
  mkdirSync(join(box, 'eml'), { recursive: true });
  const CODE = '482913', TOKEN = 'tok-9f8e7d6c5b4a';
  const mailId = '3f2b7a40-0c1d-4e5f-8a9b-1c2d3e4f5a6b', sid = `SM${'a'.repeat(32)}`;
  writeFileSync(join(box, 'eml', `${mailId}.eml`), `From: a@t.test\r\nTo: ana@t.test\r\nSubject: Tu acceso\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Entra: <a href="http://web/ok?token=${TOKEN}">aqui</a>, codigo ${CODE}</p><img src="http://tracker/px?t=${TOKEN}">\r\n`);
  writeFileSync(join(box, 'messages.jsonl'), [
    { v: 1, t: Date.now() - 2000, id: mailId, kind: 'mail', from: '1.2.3.4', sink: 'smtp', port: 587, tls: 'none', envelope: { from: 'a@t.test', rcpt: ['ana@t.test'] }, size: 10, headers: { from: 'a@t.test', to: ['ana@t.test'], cc: [], subject: `Tu código ${CODE}` }, text: `Entra: http://web/ok?token=${TOKEN} con el código ${CODE}`, attachments: [{ name: 'acta.pdf', type: 'application/pdf', size: 3, sha256: 'x' }], links: [{ url: `http://web/ok?token=${TOKEN}`, class: 'external' }], codes: [CODE], remote: [], lints: [], session: [], outcome: 'accepted', reply: '250' },
    { v: 1, t: Date.now() - 1000, id: sid, kind: 'sms', from: '1.2.3.4', sink: 'api.twilio.com', provider: 'twilio', sid, sender: '+1555', to: '+57300', body: `Tu código es ${CODE}`, chars: 19, segments: 1, encoding: 'UCS-2', direction: 'outbound', codes: [CODE] },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const dir = join(stateDir(env.ws), 'runs', '9');
  mkdirSync(dir, { recursive: true });
  // as the run's masker is made from what the sink learned (env.ts, envMasker): long values and short codes alike
  const rec = await recordState(env.ws, 'local', undefined, dir, createMasker([TOKEN, CODE], undefined, { short: [TOKEN, CODE] }));

  const kept = [readFileSync(join(dir, 'state', 'reads.json'), 'utf8'), ...readdirSync(join(dir, 'state', 'blobs')).map((f) => readFileSync(join(dir, 'state', 'blobs', f), 'utf8')), ...Object.values(rec.blobs).map((b) => decodeURIComponent(b.headers['x-laru-blocked'] ?? ''))].join('\n');
  assert.ok(rec.reads['mail?kind=all'] && 'ok' in rec.reads['mail?kind=all'], 'the mailbox was recorded');
  assert.ok(rec.reads[`mail/message?id=${mailId}`] && rec.reads[`mail/message?id=${sid}`], 'both messages were recorded');
  assert.ok(rec.blobs[`mail/html?id=${mailId}`], 'the mail\'s view was kept');
  assert.doesNotMatch(kept, new RegExp(CODE), 'no code in plain, in the list, a message, an SMS or a view');
  assert.doesNotMatch(kept, new RegExp(TOKEN), 'no link\'s token in plain');
  assert.equal(Object.keys(rec.blobs).filter((k) => /^mail\/(eml|part)/.test(k)).length, 0, 'no original, no attachment');
  assert.deepEqual(rec.withheld, [`mail/eml?id=${mailId}`, `mail/part?id=${mailId}&n=0`], 'and the recording says it held them back');
  assert.equal(rec.masked, true);
  assert.match(decodeURIComponent(rec.blobs[`mail/html?id=${mailId}`].headers['x-laru-blocked']), /tracker\/px\?t=…/, 'a blocked image\'s address is kept, masked');
  const msg = (rec.reads[`mail/message?id=${mailId}`] as { ok: { unmasked?: true; eml: boolean } }).ok;
  assert.equal(msg.unmasked, undefined, 'it does not say its codes are in plain view');
  assert.equal(msg.eml, false, 'it offers no original to download');
});

test('with masking off the recording keeps the mailbox as the live screen has it, original included, and says it is in plain', async () => {
  const env = await scenarioEnv();
  const box = join(stateDir(env.ws), 'envs', 'local', 'tap', 'mail');
  mkdirSync(join(box, 'eml'), { recursive: true });
  const id = '3f2b7a40-0c1d-4e5f-8a9b-1c2d3e4f5a6b';
  writeFileSync(join(box, 'eml', `${id}.eml`), 'From: a@t.test\r\nTo: ana@t.test\r\nSubject: Hola\r\nContent-Type: text/plain\r\n\r\ncodigo 482913\r\n');
  writeFileSync(join(box, 'messages.jsonl'), JSON.stringify({ v: 1, t: Date.now(), id, kind: 'mail', from: '1.2.3.4', sink: 'smtp', port: 587, tls: 'none', envelope: { from: 'a@t.test', rcpt: ['ana@t.test'] }, size: 10, headers: { from: 'a@t.test', to: ['ana@t.test'], cc: [], subject: 'Hola' }, text: 'codigo 482913', attachments: [], links: [], codes: ['482913'], remote: [], lints: [], session: [], outcome: 'accepted', reply: '250' }) + '\n');
  const dir = join(stateDir(env.ws), 'runs', '9');
  mkdirSync(dir, { recursive: true });
  const rec = await recordState(env.ws, 'local', undefined, dir, PLAIN);
  assert.equal(rec.masked, false);
  assert.deepEqual(rec.withheld, []);
  assert.ok(rec.blobs[`mail/eml?id=${id}`], 'the original, as the live screen offers it');
  assert.equal((rec.reads[`mail/message?id=${id}`] as { ok: { eml: boolean; unmasked: true } }).ok.eml, true);
});
