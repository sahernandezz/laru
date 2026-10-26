import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMasker } from '@laru/trace';
import { maskOutput, withFields } from '../src/runs.ts';

test("the runner's events and Playwright's text files are masked in place; videos stay", () => {
  const secret = 'flow-Secret-77ab9z';
  const out = mkdtempSync(join(tmpdir(), 'ks-out-'));
  const ctx = join(out, 'results', 'x-story');
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(out, 'events.jsonl'), [
    JSON.stringify({ e: 'step-end', t: 1, error: `Expected: "${secret}"` }),
    JSON.stringify({ e: 'test-end', t: 2, errors: [`Received: "${secret}"`], durationMs: 3 }),
  ].join('\n') + '\n');
  writeFileSync(join(ctx, 'error-context.md'), `- textbox "Token": ${secret}\n`);
  writeFileSync(join(ctx, 'video.webm'), secret);
  maskOutput(out, createMasker([secret]));
  const events = readFileSync(join(out, 'events.jsonl'), 'utf8');
  assert.ok(!events.includes(secret) && !readFileSync(join(ctx, 'error-context.md'), 'utf8').includes(secret));
  assert.deepEqual(events.split('\n').filter(Boolean).map((l) => JSON.parse(l).durationMs), [undefined, 3], 'still one JSON event per line');
  assert.equal(readFileSync(join(ctx, 'video.webm'), 'utf8'), secret, 'binary output is left alone');
});

test('what a page snapshot shows typed into a secret field is masked, in error-context.md, in the events and in the runner log', () => {
  const out = mkdtempSync(join(tmpdir(), 'ks-out-'));
  const ctx = join(out, 'results', 'login-case');
  mkdirSync(ctx, { recursive: true });
  // as Playwright 1.64 writes the page in error-context.md (run 55, «Contraseña actual incorrecta»)
  writeFileSync(join(ctx, 'error-context.md'), [
    '# Page snapshot', '', '```yaml',
    '  - textbox "Ingresa tu usuario": ana-r55',
    '  - textbox "Ingresa tu contraseña" [active] [ref=e20]: Passw0rd!x',
    '  - textbox "Confirma la nueva contraseña": Nuev0Passw0rd!',
    '  - textbox "Clave de acceso": clave-123456',
    '  - textbox "PIN": 834211',
    '  - textbox "API token": tok-998877',
    '  - textbox "Buscar archivos..."',
    '  - textbox: hugo@example.com',
    '```',
  ].join('\n'));
  writeFileSync(join(out, 'events.jsonl'), JSON.stringify({ e: 'test-end', t: 2, errors: ['Expected aria snapshot\n- textbox "Password": Passw0rd!x'], durationMs: 3 }) + '\n');
  maskOutput(out, createMasker([]));
  const page = readFileSync(join(ctx, 'error-context.md'), 'utf8'), events = readFileSync(join(out, 'events.jsonl'), 'utf8');
  for (const typed of ['Passw0rd!x', 'Nuev0Passw0rd!', 'clave-123456', '834211', 'tok-998877']) assert.ok(!page.includes(typed) && !events.includes(typed), typed);
  assert.match(page, /^ {2}- textbox "Ingresa tu contraseña" \[active\] \[ref=e20\]: …[\w-]{4}$/m, 'the field stays, its value is a mark');
  assert.ok(page.includes('- textbox "Ingresa tu usuario": ana-r55') && page.includes('- textbox: hugo@example.com') && page.includes('- textbox "Buscar archivos..."'), 'other fields keep what they show');
  // the runner's log is masked line by line with the same masker
  assert.doesNotMatch(withFields(createMasker([])).text('    - textbox "Contraseña": Passw0rd!x'), /Passw0rd/);
});
