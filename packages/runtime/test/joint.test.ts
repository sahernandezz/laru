/**
 * Several projects in one env, without Docker: unique names, the joined compose, a joint render (a network per
 * project, the tap on all, visibility, share, host ports, pinned ports), the env a flow runs on, and vault levels.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Graph, type SystemMap, type Workspace } from '@laru/core';
import { renderCompose, type ComposeDoc, type RenderContext } from '../src/compose.ts';
import { envFor, envProjects, flowProjects, jointSpec, loadEnvSpec, specFrom, translateSpec } from '../src/env.ts';
import { joinComposes, jointRouting, proposeJoint } from '../src/join.ts';
import { nameOf } from '../src/names.ts';
import { targetsOf } from '../src/up.ts';
import type { EnvSpec } from '../src/types.ts';

const repo = (name: string, source: 'git' | 'folder' = 'git') => ({ name, source, url: source === 'git' ? `https://x.test/${name}.git` : '', branch: source === 'git' ? 'main' : '', role: 'service' as const });
const spec = (over: Partial<EnvSpec> = {}): EnvSpec => ({
  name: 'x', refs: {}, share: {}, persistent: true, hybrid: [], cache: [], resources: {}, health: {}, seed: {}, mocks: {}, faults: {}, intercept: { exclude: [], ports: {} }, hosts: [], overlay: {}, ...over,
});
const map = (names: SystemMap['names'], nodes: SystemMap['nodes'] = [], facts: SystemMap['facts'] = []): Graph =>
  new Graph({ version: 1, app: 'shop', builtAt: '', repos: Object.keys(names ?? {}).map((n) => ({ name: n, commit: 'c', ref: 'r' })), nodes, facts, names });

const pg = (vol: string) => ({ image: 'postgres:16', ports: [{ target: 5432 }], volumes: [{ type: 'volume', source: vol, target: '/var/lib/postgresql/data' }] });
const kafka = { image: 'apache/kafka:3.8.0', ports: [{ target: 9092 }] };
const APP: ComposeDoc = {
  name: 'app',
  services: {
    web: { build: { context: '/snap/app/web' }, ports: [{ target: 80, published: '8088' }], depends_on: { api: { condition: 'service_started' } } },
    api: { build: { context: '/snap/app/api' }, expose: ['3000'], ports: [{ target: 3000, published: '18080' }], depends_on: { postgres: { condition: 'service_healthy' }, kafka: { condition: 'service_started' } } },
    postgres: pg('pgdata'),
    kafka,
  },
  volumes: { pgdata: {} },
};
const LEDGER: ComposeDoc = {
  name: 'ledger',
  services: {
    'ledger-web': { build: { context: '/snap/ledger/web' }, ports: [{ target: 80, published: '8089' }], depends_on: { ledger: { condition: 'service_started' } } },
    ledger: { build: { context: '/snap/ledger/api' }, expose: ['3000'], environment: { DB: 'postgres://postgres:5432/ledger' }, extra_hosts: ['host.docker.internal=host-gateway'], depends_on: { postgres: { condition: 'service_healthy' }, kafka: { condition: 'service_started' } } },
    postgres: pg('pgdata'),
    kafka,
  },
  volumes: { pgdata: {} },
};
const NAMES: Record<string, Record<string, string>> = { app: { web: 'web', api: 'api', postgres: 'postgres', kafka: 'kafka' }, ledger: { 'ledger-web': 'ledger-web', ledger: 'ledger', postgres: 'ledger-postgres', kafka: 'ledger-kafka' } };

test('unique names: identity with one project, the map\'s table with several, a provisional prefix only behind an earlier project', () => {
  const one = { repos: [repo('app')] } as unknown as Workspace;
  assert.equal(nameOf(one, null, 'app', 'postgres'), 'postgres');
  const two = { repos: [repo('app'), repo('ledger', 'folder')] } as unknown as Workspace;
  assert.throws(() => nameOf(two, null, 'ledger', 'postgres'), /run laru map/);
  const g = map(NAMES);
  assert.equal(nameOf(two, g, 'ledger', 'postgres'), 'ledger-postgres');
  assert.equal(nameOf(two, g, 'app', 'postgres'), 'postgres');
  assert.equal(nameOf(two, g, 'ledger', 'redis'), 'redis', 'nobody earlier holds redis');
  assert.equal(nameOf(two, g, 'ledger', 'web'), 'ledger-web', 'app holds web');
});

test('joining composes: identity for one member; re-keyed, volumes prefixed and share applied for several', () => {
  const name = (r: string, s: string) => NAMES[r][s] ?? s;
  const single = joinComposes([{ repo: 'app', env: 'app-local', doc: APP, spec: spec() }], name);
  assert.deepEqual(single.doc, APP, 'the first project renders as before');
  assert.equal(JSON.stringify(single.doc), JSON.stringify(APP), 'byte for byte: its normalized.json too');
  const j = joinComposes([
    { repo: 'app', env: 'app-local', doc: APP, spec: spec() },
    { repo: 'ledger', env: 'ledger-local', doc: LEDGER, spec: spec() },
  ], name, { 'ledger-kafka': 'kafka' });
  assert.deepEqual(Object.keys(j.doc.services).sort(), ['api', 'kafka', 'ledger', 'ledger-postgres', 'ledger-web', 'postgres', 'web']);
  assert.deepEqual(Object.keys(j.doc.services.ledger.depends_on), ['ledger-postgres', 'kafka'], 'depends_on renamed in its project, and the shared broker replaces its own');
  assert.equal(j.doc.services['ledger-postgres'].volumes[0].source, 'ledger-pgdata');
  assert.equal(j.doc.services.postgres.volumes[0].source, 'app-pgdata');
  assert.deepEqual(Object.keys(j.doc.volumes ?? {}).sort(), ['app-pgdata', 'ledger-pgdata']);
  assert.equal(j.repoOf['ledger-postgres'], 'ledger');
  assert.equal(j.envOf['ledger-postgres'], 'ledger-local');
  assert.equal(j.composeOf['ledger-postgres'], 'postgres');
  assert.deepEqual(j.shareAlias, { 'ledger-kafka': 'kafka' });
});

/** The joint env of the two fixtures, rendered as up renders it. */
function joint() {
  const name = (r: string, s: string) => NAMES[r][s] ?? s;
  const j = joinComposes([
    { repo: 'app', env: 'app-local', doc: APP, spec: spec() },
    { repo: 'ledger', env: 'ledger-local', doc: LEDGER, spec: spec() },
  ], name, { 'ledger-kafka': 'kafka' });
  const included = Object.keys(j.doc.services).sort();
  const { targets, stores } = targetsOf(j.doc, included);
  const fronted = new Set(targets.map((t) => t.svc));
  const routing = jointRouting(j, included, fronted, (u) => Boolean(j.doc.services[u].ports?.length || j.doc.services[u].expose?.length), { 'ledger-kafka': 'kafka' });
  const ctx: RenderContext = {
    app: 'shop', env: 'both', workspaceKey: 'k', project: 'ks-shop-both', subnet: 7, targets, stores,
    imageKeys: { web: 'w1', api: 'a1', 'ledger-web': 'lw1', ledger: 'l1' }, packagesDir: '/p', tapDir: '/t', user: '1:1', inject: {},
    hostPorts: { web: { 80: 10080 }, api: { 3000: 13000 }, 'ledger-web': { 80: 10081 }, ledger: { 3000: 13001 }, postgres: { 5432: 15432 }, 'ledger-postgres': { 5432: 15433 } }, entrancePort: 4183,
    composeOf: j.composeOf, cacheNames: { 'app-pgdata': 'ks-shop-cache-pgdata', 'ledger-pgdata': 'ks-shop-cache-ledger-pgdata' },
    nets: [{ key: 'ks', name: 'ks-shop-both', subnet: 7 }, { key: 'app', name: 'ks-shop-both-app', subnet: 8 }, { key: 'ledger', name: 'ks-shop-both-ledger', subnet: 9 }],
    netOf: j.repoOf, visible: routing.visible, hostPortRoutes: routing.hostPortRoutes,
  };
  return { j, ctx, routing, sp: spec({ name: 'both', cache: ['app-pgdata'] }) };
}

test('a joint render: a network per project, the tap on all, names reached across, share, host ports and pinned ports', () => {
  const { ctx, sp } = joint();
  const r = renderCompose(joinComposes([{ repo: 'app', env: 'app-local', doc: APP, spec: spec() }, { repo: 'ledger', env: 'ledger-local', doc: LEDGER, spec: spec() }], (rp, s) => NAMES[rp][s] ?? s, { 'ledger-kafka': 'kafka' }).doc, sp, ctx);
  const { doc, routes } = r;
  assert.deepEqual(Object.keys(doc.networks ?? {}), ['ks', 'app', 'ledger']);
  assert.equal(doc.networks!.ledger.name, 'ks-shop-both-ledger');
  assert.deepEqual(doc.networks!.ledger.ipam.config, [{ subnet: '172.30.9.0/24' }]);
  assert.equal(doc.networks!.ledger.labels['keelson.env'], 'both');
  const tap = doc.services['ks-tap'];
  assert.deepEqual(Object.fromEntries(Object.entries(tap.networks as Record<string, { ipv4_address: string }>).map(([k, v]) => [k, v.ipv4_address])), { ks: '172.30.7.254', app: '172.30.8.254', ledger: '172.30.9.254' });
  const aliases = (n: string) => (tap.networks[n].aliases as string[]).slice().sort();
  assert.deepEqual(aliases('ks'), ['api', 'ledger', 'ledger-postgres', 'ledger-web', 'postgres', 'web']);
  assert.deepEqual(aliases('app'), ['api', 'ledger', 'ledger-web', 'postgres', 'web'], 'app reaches ledger by its names: it does not define them');
  assert.deepEqual(aliases('ledger'), ['api', 'ledger', 'ledger-web', 'postgres', 'web'], 'each project\'s Postgres is read by the tap under the name its project uses');
  assert.ok(!aliases('app').includes('host.docker.internal'), 'host.docker.internal comes from extra_hosts, not DNS');
  // stores: each project keeps its own postgres, fronted by the tap; the shared broker is on both networks under the name each uses
  assert.deepEqual(doc.services['postgres-real'].networks, { app: { aliases: ['postgres-real'] } });
  assert.deepEqual(doc.services['ledger-postgres-real'].networks, { ledger: { aliases: ['ledger-postgres-real'] } });
  assert.deepEqual(routes.filter((x) => x.proto === 'pg' && !x.kind && x.net && x.net !== 'ks').map((x) => `${x.net}:${x.aliases.join()}→${x.upstream}`).sort(), ['app:postgres→postgres-real', 'ledger:postgres→ledger-postgres-real']);
  assert.deepEqual(doc.services.kafka.networks, { app: { aliases: ['kafka'] }, ledger: { aliases: ['kafka'] } });
  assert.ok(!doc.services['ledger-kafka'], 'the shared one is not started');
  assert.deepEqual(doc.services['ledger-real'].networks, { ledger: { aliases: ['ledger-real'] } });
  assert.deepEqual(doc.services['ledger-real'].extra_hosts, ['host.docker.internal:172.30.9.254'], 'replaces the compose\'s own host-gateway');
  assert.deepEqual(doc.services['api-real'].extra_hosts, ['host.docker.internal:172.30.8.254']);
  // host ports: app's 18080 → api:3000 from both projects' networks
  const hp = routes.filter((x) => x.kind === 'host-port' && x.ports[0] === 18080);
  assert.deepEqual(hp.map((x) => x.net).sort(), ['app', 'ledger']);
  assert.deepEqual(hp[0].portMap, { 18080: 3000 });
  assert.equal(hp[0].upstream, 'api-real');
  // pinned: each fronted host port has its own tap listener (two services share container port 80)
  assert.deepEqual((tap.ports as string[]).sort(), ['127.0.0.1:10080:30005', '127.0.0.1:10081:30003', '127.0.0.1:13000:30000', '127.0.0.1:13001:30001', '127.0.0.1:15432:30004', '127.0.0.1:15433:30002', '127.0.0.1:4183:7999'], 'a Postgres host port goes through the tap too');
  assert.deepEqual(routes.filter((x) => x.kind === 'pinned').map((x) => `${x.svc}:${x.ports[0]}→${Object.values(x.portMap!)[0]}`).sort(), ['api:30000→3000', 'ledger-postgres:30002→5432', 'ledger-web:30003→80', 'ledger:30001→3000', 'postgres:30004→5432', 'web:30005→80']);
  // volumes: per project; a cache keeps the first project's name, a later one's is prefixed
  assert.deepEqual(doc.volumes!['app-pgdata'], { name: 'ks-shop-cache-pgdata', external: true });
  assert.equal(doc.volumes!['ledger-pgdata'].name, 'ks-shop-both_ledger-pgdata');
  assert.equal(doc.services['ledger-real'].image, 'ks-shop/ledger:l1');
  assert.equal(renderCompose(joint().j.doc, sp, ctx).yaml, r.yaml, 'a second render is byte-identical');
});

test('a later project\'s own env: unique keys and labels, its compose names as aliases, the same image tag', () => {
  const name = (r: string, s: string) => NAMES[r][s] ?? s;
  const j = joinComposes([{ repo: 'ledger', env: 'ledger-local', doc: LEDGER, spec: spec() }], name);
  const included = Object.keys(j.doc.services);
  const { targets, stores } = targetsOf(j.doc, included);
  const r = renderCompose(j.doc, spec({ cache: ['pgdata'] }), { app: 'shop', env: 'ledger-local', workspaceKey: 'k', project: 'ks-shop-ledger-local', subnet: 5, targets, stores, imageKeys: { 'ledger-web': 'lw1', ledger: 'l1' }, packagesDir: '/p', tapDir: '/t', user: '1:1', inject: {}, hostPorts: {}, composeOf: j.composeOf, cacheNames: { pgdata: 'ks-shop-cache-ledger-pgdata' } });
  assert.deepEqual(r.doc.services['ledger-postgres-real'].networks, { ks: { aliases: ['ledger-postgres-real'] } });
  assert.equal(r.doc.services['ledger-postgres-real'].labels['keelson.service'], 'ledger-postgres', 'found by its label, renamed or not');
  assert.deepEqual(r.routes.find((x) => x.svc === 'ledger-postgres')?.aliases, ['postgres'], 'the tap answers for it under its compose name');
  assert.equal(r.doc.services['ledger-real'].image, 'ks-shop/ledger:l1', 'the tag the joint env uses: nothing is rebuilt');
  assert.deepEqual(r.doc.volumes!.pgdata, { name: 'ks-shop-cache-ledger-pgdata', external: true });
  assert.deepEqual(r.routes.find((x) => x.svc === 'ledger')?.aliases, ['ledger']);
});

test('joint refusals: two TCP services on one port of one network, one host port in two members', () => {
  const { j } = joint();
  const doubled = { ...j, doc: { ...j.doc, services: { ...j.doc.services, 'ledger-web': { ...j.doc.services['ledger-web'], ports: [{ target: 80, published: '8088' }] } } } };
  assert.throws(() => jointRouting(doubled, Object.keys(doubled.doc.services), new Set(['web', 'ledger-web']), () => true, {}), /app:web and ledger:ledger-web both publish host port 8088/);
  const { ctx, sp } = joint();
  const tcp = { ...ctx, targets: [...ctx.targets, { svc: 'clam', ports: [3310], proto: 'tcp' as const }, { svc: 'ledger-clam', ports: [3310], proto: 'tcp' as const }], netOf: { ...ctx.netOf, clam: 'app', 'ledger-clam': 'ledger' }, visible: { ...ctx.visible, app: { ...ctx.visible!.app, 'ledger-clam': 'ledger-clam' } } };
  const doc = { ...j.doc, services: { ...j.doc.services, clam: { image: 'x', ports: [{ target: 3310 }] }, 'ledger-clam': { image: 'y', ports: [{ target: 3310 }] } } };
  assert.throws(() => renderCompose(doc, sp, tcp), /clam and ledger-clam both answer TCP on port 3310 of network app/);
  const apart = renderCompose(doc, sp, { ...tcp, visible: ctx.visible });
  assert.deepEqual(apart.warnings, ['clam and ledger-clam share TCP port 3310: by that port, the runner reaches clam'], 'on their own networks they are apart; on ks the first keeps it');
});

test('a joint env file: validated by field, members translated and merged, a member\'s mock of another member dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-joint-'));
  mkdirSync(join(root, 'envs'));
  const files: Record<string, string> = {
    'app-local': 'from: app:docker-compose.yml\nresources: { postgres: { memory: 256m } }\ncache: [pgdata]\n',
    'ledger-local': 'from: ledger:docker-compose.yml\nresources: { postgres: { memory: 128m } }\nmocks: { api: { mode: simulate } }\n',
    other: 'from: app:docker-compose.yml\n',
    hyb: 'from: ledger:docker-compose.yml\nhybrid: [ledger]\n',
    both: 'join: [app-local, ledger-local]\nshare: { ledger-kafka: kafka }\nresources: { ledger-postgres: { memory: 200m } }\n',
  };
  for (const [n, t] of Object.entries(files)) writeFileSync(join(root, 'envs', `${n}.yaml`), t);
  const ws = { root, app: 'shop', repos: [repo('app'), repo('ledger', 'folder')], services: [], checkouts: {}, lock: {}, title: 'Shop', docsLanguage: 'es' } as unknown as Workspace;
  const at = (e: string, raw: Record<string, unknown>) => { try { specFrom(ws, e, raw); return 'ok'; } catch (x) { return (x as Error).message; } };
  assert.match(at('j', { from: 'app:c.yml', join: ['app-local', 'ledger-local'] }), /envs\/j\.yaml: join: a joint env has no from/);
  assert.match(at('j', { join: ['app-local', 'ledger-local'], hybrid: ['ledger'] }), /envs\/j\.yaml: hybrid: not in a joint env; use it in app-local or ledger-local/);
  assert.match(at('j', { join: ['app-local', 'both'] }), /envs\/j\.yaml: join\[1\]: both is itself joint/);
  assert.match(at('j', { join: ['app-local', 'hyb'] }), /join\[1\]: hyb runs hybrid services/);
  assert.match(at('j', { join: ['app-local', 'other'] }), /envs\/j\.yaml: join: app-local and other both bring app/);
  assert.match(at('j', { from: 'ledger:c.yml', refs: { ledger: 'main' } }), /envs\/j\.yaml: refs\.ledger: a folder has no branches or commits; remove it/);
  assert.match(at('j', { from: 'app:c.yml', share: { a: 'b' } }), /share: only a joint env shares services/);
  assert.equal(at('j', { join: ['app-local', 'ledger-local'], share: { 'ledger-kafka': 'kafka' } }), 'ok');
  const names = (r: string) => (s: string) => NAMES[r][s] ?? s;
  const members = [
    { repo: 'app', env: 'app-local', spec: translateSpec(loadEnvSpec(ws, 'app-local'), names('app')) },
    { repo: 'ledger', env: 'ledger-local', spec: translateSpec(loadEnvSpec(ws, 'ledger-local'), names('ledger')) },
  ];
  const dropped: string[] = [];
  const merged = jointSpec(loadEnvSpec(ws, 'both'), ['join', 'share', 'resources'], members, { api: 'app', 'ledger-postgres': 'ledger' }, (l) => dropped.push(l));
  assert.deepEqual(merged.resources, { postgres: { memory: '256m' }, 'ledger-postgres': { memory: '200m' } }, 'members translated, the joint env on top');
  assert.deepEqual(merged.cache, ['app-pgdata']);
  assert.deepEqual(merged.mocks, {});
  assert.deepEqual(dropped, ['ledger-local simula api; en both habla con el de app']);
  assert.deepEqual(envProjects(ws, 'both'), ['app', 'ledger']);
});

test('which env a flow runs on: the smallest that runs its projects; ready, then local, then by name; an error that says how to make one', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-envfor-'));
  mkdirSync(join(root, 'envs'));
  for (const [n, t] of Object.entries({ local: 'from: app:c.yml\n', fast: 'from: app:c.yml\n', 'ledger-local': 'from: ledger:c.yml\n', both: 'join: [local, ledger-local]\n', zz: 'join: [fast, ledger-local]\n' })) writeFileSync(join(root, 'envs', `${n}.yaml`), t);
  const ws = { root, app: 'shop', repos: [repo('app'), repo('ledger', 'folder')], services: [], checkouts: {}, lock: {} } as unknown as Workspace;
  const g = map(NAMES, [{ id: 'svc:web', type: 'service', name: 'web', repo: 'app' }, { id: 'svc:ledger', type: 'service', name: 'ledger', repo: 'ledger' }, { id: 'ds:ledger-postgres', type: 'datastore', name: 'ledger-postgres', repo: 'ledger' }, { id: 'ext:stripe', type: 'external', name: 'stripe' }]);
  const shop = { id: 'flow:comprar', needs: ['svc:web', 'ext:stripe'] };
  const cross = { id: 'flow:comprar-y-asentar', needs: ['svc:web', 'svc:ledger', 'ds:ledger-postgres'] };
  assert.deepEqual(flowProjects(g, cross), ['app', 'ledger']);
  assert.equal(envFor(ws, g, [shop]), 'local', 'fewest projects, then local');
  assert.equal(envFor(ws, g, [shop], new Set(['fast'])), 'fast', 'a ready one wins the tie');
  assert.equal(envFor(ws, g, [cross]), 'both');
  assert.equal(envFor(ws, g, [shop, cross], new Set(['zz'])), 'zz');
  writeFileSync(join(root, 'envs', 'both.yaml'), 'from: app:c.yml\n');
  writeFileSync(join(root, 'envs', 'zz.yaml'), 'from: app:c.yml\n');
  assert.throws(() => envFor(ws, g, [cross]), /flow:comprar-y-asentar needs app and ledger; no env has both: laru env init all --join local,ledger-local/);
  const single = { ...ws, repos: [repo('app')] } as Workspace;
  assert.equal(envFor(single, null, [cross], new Set(['fast'])), 'local', 'one project: today\'s choice');
});

test('«Nuevo entorno conjunto» proposes the members, the shared broker, the names both use and how they talk', () => {
  const g = map(NAMES, [
    { id: 'svc:api', type: 'service', name: 'api', repo: 'app' }, { id: 'svc:ledger', type: 'service', name: 'ledger', repo: 'ledger' },
    { id: 'ds:kafka', type: 'datastore', name: 'kafka', kind: 'queue', repo: 'app' }, { id: 'ds:ledger-kafka', type: 'datastore', name: 'ledger-kafka', kind: 'queue', repo: 'ledger' },
    { id: 'topic:order.created', type: 'topic', name: 'order.created' },
  ], [
    { s: 'svc:api', p: 'publishes', o: 'topic:order.created', origin: 'extracted' }, { s: 'svc:ledger', p: 'consumes', o: 'topic:order.created', origin: 'extracted' },
    { s: 'svc:ledger', p: 'calls', o: 'svc:api', origin: 'extracted', note: 'config API_URL, across projects', anchor: { repo: 'ledger', commit: 'c', path: 'api/app.properties', line: 3 } },
  ]);
  const p = proposeJoint({ name: 'both', picked: ['app', 'ledger'], envs: [{ env: 'local', repo: 'app' }], map: g.map, composeOf: { ledger: 'docker-compose.yml' }, repos: ['app', 'ledger'] });
  assert.deepEqual(p.members, [{ repo: 'app', env: 'local' }, { repo: 'ledger', env: 'ledger-local', create: 'ledger:docker-compose.yml' }]);
  assert.deepEqual(p.share, { 'ledger-kafka': 'kafka' });
  assert.equal(p.shareWhy['ledger-kafka'], 'order.created');
  assert.deepEqual(p.collisions.map((c) => c.name).sort(), ['kafka', 'postgres']);
  assert.deepEqual(p.talks, [{ from: 'svc:ledger', to: 'svc:api', note: 'config API_URL, across projects', at: 'ledger:api/app.properties:3' }]);
  assert.equal(p.yaml, 'join: [local, ledger-local]\nshare: { ledger-kafka: kafka }\npersistent: true\n');
});
