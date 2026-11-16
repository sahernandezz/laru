/** The fixture a spec imports loads inside the runner: there a spec is CommonJS, and Node refuses a sibling .ts of this ESM package. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('flow.ts imports nothing of its own package, only node: modules and @playwright/test', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'flow.ts'), 'utf8');
  const from = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(from.length > 0);
  assert.deepEqual(from.filter((f) => !f.startsWith('node:') && f !== '@playwright/test'), []);
});
