/** The session's notices: each is its own, failures stay on screen, and what resolves a notice takes it away. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { clearNotices, dismiss, notices, notify } from '../src/lib/notices.ts';

test('two notices of one pulse are two: closing one leaves the other, a failure included', () => {
  const now = Date.now;
  Date.now = () => 1_000; // the same millisecond for both
  try {
    notify({ kind: 'run', title: 'Run #9 falló', state: 'err' });
    notify({ kind: 'docker', title: 'Docker volvió', state: 'ok' });
  } finally { Date.now = now; }
  const [back, failed] = notices().live;
  assert.notEqual(back.id, failed.id);
  dismiss(back.id);
  assert.deepEqual(notices().live.map((x) => x.title), ['Run #9 falló'], 'the failure is still on screen');
  assert.equal(notices().live[0].level, 'alert');
  dismiss(failed.id);
  clearNotices();
});

test('a change right after another joins it; Docker coming back takes its alert away', () => {
  notify({ kind: 'change', title: 'Actualizado', state: 'run', files: ['a.md'] });
  notify({ kind: 'change', title: 'Actualizado', state: 'run', files: ['b.md'] });
  assert.equal(notices().list.length, 1);
  assert.deepEqual(notices().list[0].files, ['b.md', 'a.md']);
  assert.equal(notices().live.filter((x) => x.kind === 'change').length, 1);
  notify({ kind: 'docker', title: 'Docker dejó de responder', state: 'err' });
  notify({ kind: 'docker', title: 'Docker volvió', state: 'ok' });
  assert.deepEqual(notices().live.filter((x) => x.kind === 'docker').map((x) => x.title), ['Docker volvió']);
});

test('a new version of the service stays on screen until it is pressed or closed, and pressing it is its action', () => {
  let reloaded = 0;
  notify({ kind: 'update', title: 'Laru se actualizó a la 0.1.0-beta.22', state: 'run', act: () => { reloaded++; } });
  const [card] = notices().live;
  assert.equal(card.level, 'alert', 'the page keeps running the old version until it reloads');
  card.act!();
  assert.equal(reloaded, 1);
  dismiss(card.id);
  clearNotices();
});
