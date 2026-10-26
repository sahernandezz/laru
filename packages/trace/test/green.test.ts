/** «Verde»: a test is green when it played everything and only the failures on a `// app:` line are left. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onKnownDeviation } from '../src/reporter.ts';
import { isGreen, type Trace } from '../src/trace.ts';

const src = [
  "await step('Subir', async () => {",       // 1
  '  // app: the list shows no badge while PENDING',  // 2
  '  await expect.soft(a).toBeVisible();',  // 3
  '  // plain comment',                       // 4
  '  await expect.soft(b).toBeVisible();',  // 5
  '  // app: said first',                     // 6
  '  // and continued here',                  // 7
  '  await expect.soft(c).toBeVisible();',  // 8
  '  await expect.soft(d).toBeVisible(); // app: on its own line', // 9
  '  await expect(e).toBeVisible();',        // 10
].join('\n');
const at = (line: number) => ({ location: { file: 'x.spec.ts', line, column: 1 } });

test('a failure is a known deviation when // app: is on its line or heads the comment lines just above it', () => {
  const read = () => src;
  assert.equal(onKnownDeviation(at(3), read), true, 'the comment right above');
  assert.equal(onKnownDeviation(at(5), read), false, 'a plain comment above does not count, and the app: above that is another check\'s');
  assert.equal(onKnownDeviation(at(8), read), true, 'app: a comment line higher, the comment continues');
  assert.equal(onKnownDeviation(at(9), read), true, 'on its own line');
  assert.equal(onKnownDeviation(at(10), read), false, 'a hard assertion nobody documented');
  assert.equal(onKnownDeviation({}, read), false, 'no location, no deviation');
  assert.equal(onKnownDeviation(at(3), () => { throw new Error('gone'); }), false, 'an unreadable spec is unexpected');
});

const trace = (o: Partial<Trace>): Trace => ({ v: 1, run: '1', flow: 'f', test: 't', env: 'local', t0: 0, durationMs: 1, status: 'failed', story: true, stepsTotal: 3, participants: [], steps: [{ n: 1 }, { n: 2 }, { n: 3 }] as Trace['steps'], exchanges: [], logs: [], ...o });

test('a story is green when it played every step and failed only on known deviations; any other failure, or a step not played, is not', () => {
  const failure = (known: number, unexpected: number) => ({ step: 2, message: 'x', known, unexpected });
  assert.equal(isGreen(trace({ status: 'passed' })), true);
  assert.equal(isGreen(trace({ failure: failure(2, 0) })), true, 'two deviations, nothing else');
  assert.equal(isGreen(trace({ failure: failure(2, 1) })), false, 'one more failure that is nobody\'s known deviation');
  assert.equal(isGreen(trace({ failure: failure(0, 1) })), false);
  assert.equal(isGreen(trace({ failure: failure(0, 0) })), false, 'failed with no error to explain it is not green');
  assert.equal(isGreen(trace({ failure: { step: 2, message: 'x' } })), false, 'a trace from before the count is not green: nothing says it');
  assert.equal(isGreen(trace({ failure: failure(1, 0), steps: [{ n: 1 }, { n: 2 }] as Trace['steps'] })), false, 'the story stopped at step 2 of 3');
  assert.equal(isGreen(trace({ story: false, failure: failure(1, 0), steps: [] })), true, 'a short case has no steps to play');
  assert.equal(isGreen(trace({ status: 'skipped' })), false);
});
