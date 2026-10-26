/**
 * A runner is code from a repository. When it swaps its events file or its log for a link, or writes a line that is
 * not JSON, Laru loses those lines and says so; it does not die in a timer or a stream callback, and it does not
 * write through the link. Against a fake docker (scenario-env.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEvents, runFlows } from '../src/index.ts';
import { scenarioEnv } from './scenario-env.ts';

for (const events of ['link', 'garbage'] as const) {
  test(`a runner whose events are a ${events === 'link' ? 'link' : 'line that is not JSON'}: the run ends, the lines are counted as lost, nothing outside the run is written`, async () => {
    const env = await scenarioEnv({ persistent: false });
    env.script({ 'pedido-pagado': { pgWrite: true }, h1: { events } });
    const run = await runFlows(env.ws, { env: 'local', flows: ['pagar-el-pedido'], cache: false, id: 'h1' });
    assert.equal(run.phase, 'done');
    assert.match(run.error ?? '', /could not be kept: its events or log file is a link, or a line is not JSON/);
    assert.equal(readFileSync(join(env.dir, 'victim.txt'), 'utf8'), 'untouched', 'nothing was written through a link');
    if (events === 'garbage') assert.deepEqual(readEvents(env.ws, 'h1').map((e) => e.e), ['test-begin'], 'the real line is kept, the other one is not copied');
  });
}
