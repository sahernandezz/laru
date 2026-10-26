/** What a person types in the data screen (a cell, a filter) can be a password: it travels on psql's stdin, quoted, and never on a command line. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rows, stores, updateRow } from '../src/index.ts';
import { scenarioEnv } from './scenario-env.ts';

test('a typed value reaches Postgres in the SQL on stdin and never in the arguments of docker', async () => {
  const env = await scenarioEnv();
  const pg = (await stores(env.ws, 'local')).find((s) => s.kind === 'postgres')!;
  const typed = "hunter2's\\ pass";
  await updateRow(pg, { schema: 'public', table: 'users', key: { id: '7' }, set: { password: typed } });
  await rows(pg, { schema: 'public', table: 'users', filters: [{ column: 'email', op: '=', value: typed }] });
  assert.deepEqual(env.calls().filter((l) => /hunter2|\bp\d=|-v p\d/.test(l)), [], 'no argument of any docker call holds it');
  const sent = env.stdin();
  assert.match(sent, /UPDATE "public"\."users" SET "password" = E'hunter2''s\\\\ pass' WHERE "id" = E'7';/, 'quoted so that a backslash and a quote stay data, whatever standard_conforming_strings is');
  assert.match(sent, /WHERE "email"::text = E'hunter2''s\\\\ pass'/);
  assert.doesNotMatch(sent, /:'p\d'/, 'no placeholder is left for psql to expand');
});
