/**
 * A dialog in steps moves the focus to the new step's `[data-autofocus]` when the step changes, because the button that
 * changed it is gone: each step needs one, or «Volver» leaves the focus on <body>.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const pages = join(import.meta.dirname, '../src/pages');

test('every dialog in steps has a place for the focus on each step', () => {
  let seen = 0;
  for (const f of readdirSync(pages).filter((x) => x.endsWith('.tsx'))) {
    for (const fn of readFileSync(join(pages, f), 'utf8').split(/\n(?=(?:export )?function )/)) {
      if (!fn.includes("querySelector<HTMLElement>('[data-autofocus]')?.focus()") || !fn.includes('stepped')) continue;
      seen++;
      const targets = fn.match(/\s(?:data-autofocus|autoFocus)[\s/>=]/g) ?? [];
      assert.ok(targets.length >= 2, `${f}: ${fn.slice(0, fn.indexOf('('))} has ${targets.length} focus target(s) for two steps`);
    }
  }
  assert.ok(seen >= 2, 'the Kafka and RabbitMQ publish dialogs');
});
