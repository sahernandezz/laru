/** The vault's checks carry a stable code, and es.ts reads only that: every code has its Spanish, none falls back. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VarIssue } from '@laru/runtime';
import { admissionText, bindingMatch, BLOCKS, checkName, checkNote, laruLine, probeText, twinText, workspaceError, faultText, findingText, importWarning, lastText, rabbitText, redisNote, routeText, size, upError, varIssueText, whyText, type Said } from '../src/lib/es.ts';

const issue = (code: VarIssue['code'], key: string): VarIssue => ({ level: 'error', code, key, service: 'api', at: 'compose.yml:12', message: `${key}: english` });

test('every vault check reads in Spanish, by its code', () => {
  const codes: Array<[VarIssue['code'], string]> = [['missing-var', 'JWT_SECRET'], ['blank-override', 'JWT_SECRET'], ['plain-secret', 'DB_PASSWORD'], ['getenv', 'X'], ['unused-var', 'OLD'], ['type', 'API_PORT'], ['type', 'BILLING_URL']];
  for (const [code, key] of codes) {
    const { title, text } = varIssueText(issue(code, key), 'local');
    assert.ok(title.includes(key) && !text.includes('english'), `${code}: ${title} ${text}`);
  }
  assert.match(varIssueText(issue('type', 'BILLING_URL'), 'local').title, /URL/);
  assert.match(varIssueText(issue('type', 'API_PORT'), 'local').title, /número/);
  assert.deepEqual([...BLOCKS].sort(), ['blank-override', 'missing-var']);
});

test('import warnings and up errors', () => {
  assert.match(importWarning('PIN: shorter than 6 characters, so traces cannot mask it'), /^PIN tiene menos de 6/);
  assert.equal(importWarning('something new'), 'something new');
  assert.deepEqual(upError('api-gateway is unhealthy (probe: curl: (7) refused)', 'local', 'api-gateway'), { title: 'api-gateway no arrancó: no responde.', detail: 'Sonda: curl: (7) refused' });
  assert.equal(upError('api is exited with code 1', 'local', 'api').title, 'api no arrancó: se detuvo, con código 1.');
  assert.equal(upError('2 values are missing:\n  A: …\n  B: …', 'local').vars, true);
  assert.equal(upError('not ready after 90 s: api starting', 'local', 'api').detail, 'api: arrancando');
  assert.equal(upError('boom', 'local').detail, 'boom');
});

test('doctor notes', () => {
  assert.equal(checkNote('8 CPUs, 7.8 GiB'), '8 CPU, 7,8 GiB');
  assert.equal(checkNote('subnet 172.30.1.0/24, entrance :4180'), 'Subred 172.30.1.0/24, entrada :4180');
  assert.equal(checkNote('in keychain'), 'En el llavero del sistema');
  assert.equal(checkNote('5.5.0'), '5.5.0');
});

test('findings read in Spanish from their key and message shapes', () => {
  const f = (type: string, subject: string, detail: string, message: string) => findingText({ key: `${type}:${subject}${detail ? `:${detail}` : ''}`, type, subject, message });
  assert.equal(f('untested-endpoint', 'ep:api-gateway:GET /api/admin/users', '', 'no flow reaches GET /api/admin/users'), 'Ningún flujo recorre GET /api/admin/users.');
  assert.equal(f('contract-drift', 'file-service', 'GET /api/files/{id} 500', 'GET /api/files/{id} answered 500, which ctr:api-de-ficheros does not list among its errors'), 'GET /api/files/{id} respondió 500, y ctr:api-de-ficheros no lo lista entre sus errores.');
  assert.equal(f('contract-drift', 'file-service', 'GET /x', 'GET /x reached file-service and none of its contracts declares it'), 'GET /x llegó a file-service, y ninguno de sus contratos lo declara.');
  assert.equal(f('unused-var', 'var:KAFKA_BOOTSTRAP_SERVERS', '', 'KAFKA_BOOTSTRAP_SERVERS: set at app, but nothing in local reads it'), 'KAFKA_BOOTSTRAP_SERVERS tiene valor en aplicativo, y nada en local la lee.');
  assert.equal(f('undeclared-call', 'svc:a', 'svc:b', 'svc:a calls svc:b in runs, and nothing in the code says so'), 'a llama a b en los runs, y nada en el código lo dice.');
  assert.equal(f('table-multi-writer', 'tbl:x', '', 'tbl:x is written by a, b; its owner is a'), 'tbl:x la escriben a, b; su dueño es a.');
  assert.equal(f('flow-unstable', 'flow:x', '', 'flow:x changed result 3 times in its last 5 runs (passed failed passed failed passed)'), 'x cambió de resultado 3 veces en sus últimos 5 runs (correcto, falló, correcto, falló, correcto).');
  assert.equal(f('scenario-broken', 'scn:x', 'local', 'scn:x failed its setup on local: expect(received).toBe(201)'), 'La preparación de scn:x falló en local: expect(received).toBe(201)');
  assert.equal(f('scenario-broken', 'scn:y', 'setup', 'scn:y has no setup to play: docs/scenarios/y/y.setup.ts'), 'scn:y no tiene preparación que jugar: falta docs/scenarios/y/y.setup.ts.');
  assert.equal(f('something-new', 's', '', 'english stays'), 'english stays');
});

test('impact reasons, faults and sizes', () => {
  assert.equal(whyText('its spec, flow.md or support changed'), 'cambió su spec, su flow.md o support/');
  assert.equal(whyText('step «Subir» runs on svc:file-service'), 'el paso «Subir» corre en svc:file-service');
  assert.equal(whyText('unknown'), 'unknown');
  assert.equal(faultText({ latency: 800 }), '+800 ms');
  assert.equal(faultText({ status: 503, p: 0.2, method: 'POST', path: '^/api' }), 'responde 503; solo POST, ruta ~ ^/api; al 20 %');
  assert.equal(faultText({ bandwidth: 16384 }), '16 KB/s');
  assert.deepEqual([size(594), size(12 * 1024), size(3.4 * 2 ** 20)], ['594 B', '12 KB', '3,4 MB']);
});

test('a flow’s last result in a few words: a cached run passed, as the run it came from did', () => {
  assert.equal(lastText({ status: 'cached', cases: [] }), 'Correcto');
  assert.equal(lastText({ status: 'passed', cases: [] }), 'Correcto');
  assert.equal(lastText({ status: 'failed', failure: { step: 4 }, cases: [] }), 'Falló en el paso 4');
  assert.equal(lastText({ status: 'failed', cases: [{ status: 'passed' }, { status: 'failed' }] }), 'Falló un caso');
  assert.equal(lastText(null), 'Sin ejecutar');
});

test('a refused RabbitMQ read says why in Spanish, from the runtime\'s own reason', async () => {
  const { rabbit } = await import('@laru/runtime');
  const why = (args: unknown[][]) => rabbitText(rabbit.requeueRisk({ name: 'audit.events', type: 'quorum', arguments: args }) ?? '');
  assert.match(why([['x-delivery-limit', 'long', 5], ['x-dead-letter-exchange', 'longstr', 'shop.dlx']]), /^No se lee desde aquí: audit\.events es una cola quorum con un límite de 5 entregas\. .* lo manda a shop\.dlx como mensaje muerto\. Léela con un consumidor propio\.$/);
  assert.match(why([['x-delivery-limit', 'long', 5]]), /pasado el límite RabbitMQ lo descarta\./);
  assert.match(why([['x-delivery-limit', 'long', 5], ['x-dead-letter-exchange', 'longstr', '']]), /lo manda al intercambio por defecto como mensaje muerto/);
  assert.equal(rabbitText('ledger is a stream queue: a stream consumer reads it from an offset, nothing takes a message and puts it back'), 'No se lee desde aquí: ledger es una cola stream. Un consumidor de streams la lee desde un offset; nada saca un mensaje para devolverlo.');
  assert.equal(rabbitText('no exchange nope'), 'No existe el intercambio nope.');
  assert.equal(rabbitText('no queue orders'), 'La cola orders ya no existe.');
  assert.equal(rabbitText('RabbitMQ refused it (400): PRECONDITION_FAILED'), 'RabbitMQ lo rechazó (400): PRECONDITION_FAILED', 'the broker\'s own reason, said in Spanish');
  assert.equal(rabbitText('boom'), 'boom', 'anything else in the runtime\'s words');
});

/** A sentence in parts as read: a broker's value as itself. */
const said = (x: Said) => x.map((p) => (typeof p === 'string' ? p : p.code)).join('');

test('a publish review says where the message goes, and only a message that arrives is read', () => {
  const read = /Lo leerán sus consumidores/;
  const none = said(routeText('shop.events', 'user.created', { type: 'topic', queues: [] }));
  assert.equal(none, 'Ningún enlace de shop.events coincide con la clave user.created: RabbitMQ lo aceptará y lo descartará.');
  assert.equal(said(routeText('', 'nobody', { type: 'direct', queues: [] })), 'Ninguna cola se llama nobody: RabbitMQ lo aceptará y lo descartará.');
  assert.match(said(routeText('', 'orders', { type: 'direct', queues: [{ queue: 'orders', key: 'orders' }] })), /^Llegará a la cola orders\. Lo leerán/);
  const two = said(routeText('shop.events', 'order.paid', { type: 'topic', queues: [{ queue: 'orders', key: 'order.*' }, { queue: 'audit', key: '' }] }));
  assert.match(two, /^Lo recibirán las colas orders \(order\.\*\), audit\. /);
  assert.match(said(routeText('shop.headers', 'x', { type: 'headers' })), /^shop\.headers es un intercambio headers: .* no se sabe qué colas/);
  assert.deepEqual([read.test(none), read.test(two)], [false, true]);
});

test('amq.default is the default exchange in a review too', () => {
  assert.match(said(routeText('amq.default', 'orders', { type: 'direct', queues: [{ queue: 'orders', key: 'orders' }] })), /^Llegará a la cola orders\. /);
  assert.equal(said(routeText('amq.default', 'nobody', { type: 'direct', queues: [] })), 'Ninguna cola se llama nobody: RabbitMQ lo aceptará y lo descartará.');
});

test('a binding key in a review comes as the broker\'s value, so its mask is boxed as in the table', () => {
  const parts = routeText('shop.events', 'tenant.x', { type: 'topic', queues: [{ queue: 'emails', key: 'tenant.…3W5w' }, { queue: 'audit', key: '' }] });
  assert.deepEqual(parts.filter((p) => typeof p !== 'string'), [{ code: 'tenant.…3W5w' }]);
  assert.ok(parts.every((p) => typeof p !== 'string' || !p.includes('…3W5w')), 'never inside plain text');
});

test('a review follows the alternate exchange: where the message really goes when no binding matches', () => {
  const ae = said(routeText('shop.ae', 'user.created', { type: 'topic', queues: [{ queue: 'unrouted.q', key: '' }], alternate: 'unrouted' }));
  assert.match(ae, /^Ningún enlace de shop\.ae coincide con la clave user\.created: RabbitMQ lo pasa a su intercambio alternativo, unrouted\. Lo recibirá la cola unrouted\.q\. Lo leerán/);
  assert.ok(!/descartará/.test(ae));
  assert.match(said(routeText('shop.ae', 'x', { type: 'topic', queues: [], alternate: 'gone' })), /alternativo, gone, que tampoco lo entrega a ninguna cola: RabbitMQ lo aceptará y lo descartará\.$/);
  assert.match(said(routeText('shop.ae', 'x', { type: 'topic', alternate: 'by.headers' })), /alternativo, by\.headers, y desde aquí no se sabe qué colas lo recibirán\./);
});

test('a review through an exchange binding says the message reached that exchange, not that no binding matched', () => {
  const lost = said(routeText('e3', 'k', { type: 'direct', queues: [], via: ['e4'] }));
  assert.equal(lost, 'Un enlace de e3 coincide con la clave k y lo lleva al intercambio e4, donde nada lo toma: RabbitMQ lo aceptará y lo descartará.');
  assert.match(said(routeText('e3', 'k', { type: 'topic', via: ['e4', 'e5'] })), /^Los enlaces de e3 que coinciden con la clave k lo llevan a los intercambios e4, e5, y desde aquí no se sabe qué colas lo recibirán\./);
  // a fanout takes everything: no key is said to match
  assert.equal(said(routeText('f1', 'anything', { type: 'fanout', queues: [], via: ['e4', 'x5'] })), 'f1 es fanout: sus enlaces lo llevan, sin mirar la clave, a los intercambios e4, x5, donde nada lo toma: RabbitMQ lo aceptará y lo descartará.');
  // partial: the queues the keys tell are said, and that others may get it too
  assert.match(said(routeText('e7', 'k', { type: 'direct', queues: [{ queue: 'dq', key: 'k' }], partial: true, via: ['h1'] })), /^Lo recibirá la cola dq \(k\)\. Además, un enlace de e7 coincide con la clave k y lo lleva al intercambio h1, y desde aquí no se sabe qué otras colas lo recibirán\. Lo leerán/);
  assert.match(said(routeText('e3', 'k', { type: 'direct', queues: [{ queue: 'q', key: '' }], via: ['e4'] })), /^Lo recibirá la cola q\. /);
});

test('a binding says what it matches by its exchange\'s type: only fanout and headers ignore the key', () => {
  assert.equal(bindingMatch('fanout', '')?.label, 'cualquiera');
  assert.equal(bindingMatch('fanout', 'order.*')?.label, 'cualquiera', 'fanout ignores even a key it was bound with');
  assert.equal(bindingMatch('headers', '')?.label, 'por cabeceras');
  assert.equal(bindingMatch('direct', '')?.label, '(vacía)', 'a direct exchange bound with an empty key takes only the empty key');
  assert.equal(bindingMatch('topic', '')?.label, '(vacía)');
  assert.equal(bindingMatch(undefined, '')?.label, '(vacía)', 'the default exchange is direct');
  assert.equal(bindingMatch('direct', 'orders'), null, 'the key says it');
  assert.equal(bindingMatch('topic', '#'), null);
});

test('a quorum peek refused for want of a confirmation says why in Spanish', () => {
  assert.equal(rabbitText('qq is a quorum queue: a peek puts what it reads back at the end of the queue, behind the rest, so the order changes, and marks it redelivered. Ask for it with reorder'),
    'qq es una cola quorum: leer devuelve los mensajes al final de la cola, detrás de los demás, y el orden cambia. Hay que confirmarlo para leerla.');
});

test('a Redis stream whose entry lost fields says so, whatever the entry count', () => {
  assert.equal(redisNote({ type: 'stream', size: 1, capped: true }, 1), 'Las entradas con más de 100 campos muestran solo los primeros 100.');
  assert.equal(redisNote({ type: 'stream', size: 61, capped: true }, 50), 'Se ven 50: las primeras por id. Las entradas con más de 100 campos muestran solo los primeros 100.');
  assert.equal(redisNote({ type: 'stream', size: 61 }, 50), 'Se ven 50: las primeras por id.');
  assert.equal(redisNote({ type: 'list', size: 2, cut: true }, 2), 'Lo que pasa de 8 KB se ve cortado.');
});

test('workspaces, the machine and admission read in Spanish', () => {
  const others = [{ key: 'k1', app: 'vaultflow', env: 'local', memBytes: 4.1 * 2 ** 30 }, { key: 'k2', app: 'finanzas', env: 'dev', memBytes: 2.2 * 2 ** 30 }];
  assert.equal(admissionText({ kind: 'memory', needBytes: 5.3 * 2 ** 30, totalBytes: 7.8 * 2 ** 30, others }, 'all'), 'No cabe: vaultflow/local usa 4,1 GiB y finanzas/dev usa 2,2 GiB; all necesitó 5,3 GiB la última vez y Docker tiene 7,8 GiB.');
  assert.equal(admissionText({ kind: 'memory', totalBytes: 8 * 2 ** 30, others: [{ app: 'x', env: 'local (run 12)', memBytes: 2 ** 30 }] }, 'all'), 'No cabe: x/local, run 12 usa 1 GiB; all no se ha medido todavía y Docker tiene 8 GiB.');
  assert.equal(admissionText({ kind: 'maxEnvs', max: 1, others: [others[1]] }, 'all'), 'Ya corre finanzas/dev y el máximo es 1. Cámbialo en «Esta máquina».');
  assert.equal(probeText({ ok: true, app: 'finanzas', title: 'Finanzas', projects: 1 }), 'finanzas — «Finanzas», 1 proyecto');
  assert.equal(probeText({ ok: false, reason: 'no-yaml' }), 'No hay laru.yaml en esa carpeta');
  assert.deepEqual(workspaceError('root: a folder under /Users/ana'), { field: 'root', text: 'Tiene que ser una carpeta dentro de /Users/ana.' });
  assert.deepEqual(workspaceError('app: lowercase letters, digits and dashes').field, 'app');
  assert.match(workspaceError('root: overlaps the workspace at /Users/ana/laru/vaultflow').text, /^Se solapa con el workspace de \/Users/);
  assert.equal(laruLine('the entrance moves from 4180 to 4181: vaultflow/local holds it'), 'la entrada pasa de 4180 a 4181: la usa vaultflow/local');
  assert.equal(laruLine("audit's subnet moves from 172.30.1.0/24 to 172.30.2.0/24: network bridge-x holds it"), 'la subred de audit pasa de 172.30.1.0/24 a 172.30.2.0/24: la usa la red bridge-x');
  assert.equal(laruLine('web:80 moves from 10080 to 10081: another program holds it'), 'el puerto de web:80 pasa de 10080 a 10081: la usa otro programa');
  assert.equal(laruLine('waiting for up vaultflow/local to finish'), 'esperando a que termine up vaultflow/local');
  assert.equal(laruLine('compose up -d'), 'compose up -d', 'any other line as it is');
  assert.match(twinText('vaultflow', 'vaultflow~612e'), /este queda como vaultflow~612e, .*compartirán ~\/\.laru\/vaultflow/);
  assert.equal(checkName('held vaultflow/local'), 'En uso: vaultflow/local');
  assert.equal(checkNote('workspace 612e1a449b: subnets 172.30.1.0/24, ports 4180, 15432'), 'Workspace 612e1a449b: subred 172.30.1.0/24, puertos 4180, 15432');
});
