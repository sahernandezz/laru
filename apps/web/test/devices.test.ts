/** Following one device in the studio: who sent each exchange, and what its requests caused. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Exchange } from '@laru/trace';
import type { Cause } from '@laru/trace/chain';
import { deviceName, devicesOf, onlyDevice } from '../src/lib/devices.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('a User-Agent reads as the browser and the system it runs on', () => {
  assert.equal(deviceName(IPHONE), 'Safari en iPhone');
  assert.equal(deviceName(MAC), 'Chrome en Mac');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), 'Edge en Windows');
  assert.equal(deviceName('okhttp/4.12.0'), 'okhttp');
  assert.equal(deviceName('MiApp/2.1 CFNetwork/1494.0.7 Darwin/23.4.0'), 'MiApp en iOS');
  assert.equal(deviceName(undefined), 'Sin identificar');
});

test('each device keeps its requests, its streams and what they caused; background work belongs to none', () => {
  const ex = (id: string, from: string, to: string, ua?: string, kind: Exchange['kind'] = 'http') =>
    ({ id, kind, from, to, t0: 0, label: id, ok: true, origin: 'observed', ...(ua ? { reqHeaders: { 'user-agent': ua } } : {}) }) as Exchange;
  const trace = {
    participants: ['browser', 'api', 'db', 'worker', 'browser:luis', '?172.30.1.12'].map((id) => ({ id, name: id === 'browser:luis' ? 'Navegador de luis' : id, type: 'service' as const })),
    exchanges: [
      ex('a', 'browser', 'api', IPHONE), ex('a1', 'api', 'db'),
      ex('b', 'browser', 'api', MAC), ex('s', 'browser', 'api', MAC), ex('s.1', 'browser', 'api', undefined, 'sse'),
      ex('c', 'browser:luis', 'api'),
      ex('w', 'worker', 'db'),
      ex('x', '?172.30.1.12', 'api', IPHONE), ex('y', '?172.30.1.12', 'api', MAC),
    ],
  };
  const cause = new Map<string, Cause>([['a1', { parent: 'a' } as Cause]]);
  const d = devicesOf(trace, cause), { of, list } = d;
  assert.deepEqual(list, [{ name: 'Chrome en Mac', count: 3 }, { name: 'Safari en iPhone', count: 2 }, { name: 'Equipo 172.30.1.12', count: 2 }, { name: 'Navegador de luis', count: 1 }]);
  assert.equal(of.get('w'), undefined);
  const phone = onlyDevice(trace, d, 'Safari en iPhone');
  assert.deepEqual(phone.exchanges.map((e) => e.id), ['a', 'a1']);
  assert.deepEqual(phone.participants.map((p) => p.id), ['browser', 'api', 'db']);
});

test('the actions stay with the device that is Laru\'s own browser', () => {
  const HEADLESS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36';
  const ex = (id: string, from: string, ua: string) => ({ id, kind: 'http', from, to: 'api', t0: 0, label: id, ok: true, origin: 'observed', reqHeaders: { 'user-agent': ua } }) as Exchange;
  const trace = { participants: [], exchanges: [ex('a', 'browser', HEADLESS), ex('b', 'browser', IPHONE)], actions: [{ t0: 0, t1: 1, kind: 'click' as const }] };
  const d = devicesOf(trace, new Map());
  assert.equal(d.actor, 'Chromium de Laru en Mac');
  assert.equal(onlyDevice(trace, d, 'Chromium de Laru en Mac').actions.length, 1);
  assert.equal(onlyDevice(trace, d, 'Safari en iPhone').actions.length, 0);
});

test('an event of a stream opened before the trace goes with its sender\'s one device, or with its own User-Agent', () => {
  const ex = (id: string, ua?: string, kind: Exchange['kind'] = 'http') => ({ id, kind, from: 'browser', to: 'api', t0: 0, label: id, ok: true, origin: 'observed', ...(ua ? { reqHeaders: { 'user-agent': ua } } : {}) }) as Exchange;
  const one = devicesOf({ participants: [], exchanges: [ex('a', IPHONE), ex('gone.1', undefined, 'sse')] }, new Map());
  assert.equal(one.of.get('gone.1'), 'Safari en iPhone');
  const two = devicesOf({ participants: [], exchanges: [ex('a', IPHONE), ex('b', MAC), ex('gone.1', MAC, 'sse')] }, new Map());
  assert.equal(two.of.get('gone.1'), 'Chrome en Mac');
});

test('the test\'s own calls are the test, whatever client it used', () => {
  const ex = (id: string, from: string, ua: string) => ({ id, kind: 'http', from, to: 'api', t0: 0, label: id, ok: true, origin: 'observed', reqHeaders: { 'user-agent': ua } }) as Exchange;
  const d = devicesOf({ participants: [{ id: 'runner', name: 'Prueba', type: 'runner' }], exchanges: [ex('a', 'runner', 'Playwright/1.64.1'), ex('b', 'browser', MAC)] }, new Map());
  assert.deepEqual(d.list.map((x) => x.name).sort(), ['Chrome en Mac', 'Prueba']);
});
