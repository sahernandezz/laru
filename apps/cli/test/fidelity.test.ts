/**
 * Fidelity as a contrast: what `infrastructure` declares of production against an env, with a verdict per row, and the
 * same rows in the findings of the screens, the CLI and the MCP.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptFinding, knowledgeWrite } from '@laru/core';
import { envDir, fidelity } from '@laru/runtime';
import { scenarioEnv } from '../../../packages/runtime/test/scenario-env.ts';
import { findingsOf, screenFindings } from '../src/env-cli.ts';

test('each declared aspect of production gets a verdict against the env, and an accepted difference carries its reason', async () => {
  const env = await scenarioEnv();
  const w = env.ws;
  // stripe is mocked by a script here, and the infrastructure says production reaches the real one
  const r = knowledgeWrite(w, { type: 'infrastructure', in: 'app:comercio', title: 'Producción', status: 'active', summary: 'Dónde corre en producción y qué se sabe de ello que no dice ningún fichero.', fields: { production: [{ service: 'stripe', aspect: 'mode', value: 'real' }, { service: 'stripe', aspect: 'read-limit', value: '25MB' }] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  writeFileSync(join(envDir(w, 'local'), 'tap', 'rules.json'), JSON.stringify({ seed: 1, faults: {}, mocks: { stripe: { mode: 'script' } }, peers: {} }));

  const rows = () => fidelity(w, 'local').rows.filter((x) => x.name === 'stripe');
  const mode = () => rows().find((x) => x.aspect === 'mode')!;
  assert.equal(mode().verdict, 'distinto');
  assert.equal(rows().find((x) => x.aspect === 'read-limit')?.verdict, 'no aplica', 'a mocked external does not read the file');

  // the difference is in every list of findings, the screens' included
  const gap = (l: Array<{ type: string }>) => l.filter((f) => f.type === 'fidelity-gap').length;
  assert.equal(gap(await findingsOf(w)), 1);
  assert.equal(gap(await screenFindings(w)), 1);

  acceptFinding(w, 'fidelity-gap:env:local:external:stripe:mode', { reason: 'Se imita para no cobrar de verdad' });
  assert.equal(mode().verdict, 'aceptado');
  assert.equal(mode().accepted?.reason, 'Se imita para no cobrar de verdad');
  assert.equal(gap((await screenFindings(w)).filter((f) => !f.accepted)), 0);

  // without the mock stripe is no longer part of this env: nothing to contrast
  writeFileSync(join(envDir(w, 'local'), 'tap', 'rules.json'), JSON.stringify({ seed: 1, faults: {}, mocks: {}, peers: {} }));
  assert.equal(rows().find((x) => x.aspect === 'mode'), undefined);
});
