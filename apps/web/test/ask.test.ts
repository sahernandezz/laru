/**
 * A call the service answers 409 (what it would delete on an env that keeps its data) is put to the person once and
 * sent again with `confirm`; and no screen starts a run, applies a scenario or opens a session without that.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { askFirst, Cancelled, setAskHost } from '../src/lib/ask.ts';

const wants = Object.assign(new Error('Se restaura postgres (se pierden las filas de hoy).'), { status: 409 });

test('a 409 is asked once and sent again with confirm; a no is Cancelled and sends nothing more; other errors pass', async () => {
  const asked: Array<{ text: string; label: string; title?: string }> = [];
  setAskHost(async (q) => { asked.push(q); return answer; });
  let answer = true;
  const sent: Array<true | undefined> = [];
  const call = (fail: Error | null) => async (confirm?: true) => { sent.push(confirm); if (fail && !confirm) throw fail; return 'done'; };

  assert.equal(await askFirst(call(null), 'Aplicar'), 'done');
  assert.deepEqual([asked.length, sent], [0, [undefined]], 'nothing to ask: no question');

  sent.length = 0;
  assert.equal(await askFirst(call(wants), 'Aplicar', 'Aplicar «x» en local'), 'done');
  assert.deepEqual(asked, [{ text: wants.message, label: 'Aplicar', title: 'Aplicar «x» en local' }]);
  assert.deepEqual(sent, [undefined, true], 'the second time says yes');

  sent.length = 0; answer = false;
  await assert.rejects(askFirst(call(wants), 'Aplicar'), Cancelled);
  assert.deepEqual(sent, [undefined], 'a no sends nothing');

  sent.length = 0;
  const other = Object.assign(new Error('boom'), { status: 500 });
  await assert.rejects(askFirst(call(other), 'Aplicar'), /boom/);
  assert.equal(asked.length, 2, 'only a 409 is a question');

  setAskHost(undefined);
  await assert.rejects(askFirst(call(wants), 'Aplicar'), (e: Error) => e === wants, 'nobody to ask: the 409 is the answer');
});

test('every screen that starts a run, applies a scenario or opens a session from one goes through askFirst', () => {
  const src = new URL('../src/', import.meta.url).pathname;
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx$/.test(f) && f !== 'api.ts');
  const calls = (text: string) => (text.match(/'\/api\/(runs\/start|scenarios\/apply|session\/start)'/g) ?? []).length;
  const found = files.map((f) => [f, readFileSync(join(src, f), 'utf8')] as const).filter(([, t]) => calls(t));
  assert.deepEqual(found.map(([f]) => f).sort(), ['pages/Envs.tsx', 'pages/Flows.tsx', 'pages/Live.tsx', 'pages/Overview.tsx', 'pages/Runs.tsx', 'pages/Scenarios.tsx', 'pages/Sheets.tsx'], 'a new caller is a new line in this list, and an askFirst in its file');
  for (const [f, t] of found) assert.ok((t.match(/askFirst\(/g) ?? []).length >= calls(t), `${f} has ${calls(t)} such call(s) and ${(t.match(/askFirst\(/g) ?? []).length} askFirst`);
  assert.match(readFileSync(join(src, 'main.tsx'), 'utf8'), /<AskHost \/>/, 'and the question has somewhere to be asked');
});
