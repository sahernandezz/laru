import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closure, interpolations, renderCompose, type ComposeDoc, type RenderContext } from '../src/compose.ts';
import type { EnvSpec } from '../src/types.ts';
import { targetsOf } from '../src/up.ts';

const vf = (): ComposeDoc => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'vaultflow-compose.json'), 'utf8'));

const spec = (over: Partial<EnvSpec> = {}): EnvSpec => ({
  name: 'local', refs: {}, share: {}, persistent: true, hybrid: [], cache: ['clamav-data'], resources: { clamav: { memory: '2g' } }, health: {}, seed: {},
  mocks: {}, faults: {}, intercept: { exclude: [], ports: {} }, hosts: [], overlay: { services: { minio: { image: 'cgr.dev/chainguard/minio:latest' } } }, ...over,
});

const http = (svc: string, port: number) => ({ svc, ports: [port], proto: 'http' as const });
const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  app: 'vaultflow', env: 'local', workspaceKey: 'abc123def0', project: 'ks-vaultflow-local', subnet: 7,
  targets: [http('api-gateway', 8080), http('file-service', 8081), http('batch-service', 8082), http('antivirus-service', 8083),
    http('notification-service', 8084), http('frontend', 80), http('minio', 9000), { svc: 'clamav', ports: [3310], proto: 'tcp' }],
  imageKeys: { 'api-gateway': 'k1', 'file-service': 'k2', 'batch-service': 'k3', 'antivirus-service': 'k4', 'notification-service': 'k5', frontend: 'k6' },
  packagesDir: '/ks/pkgs', tapDir: '/ws/.laru/envs/local/tap', hostPorts: { postgres: { '5432': 15432 }, kafka: { '29092': 19092 } },
  entrancePort: 4180, user: '501:20', inject: { 'api-gateway': ['JWT_SECRET'] },
  stores: { postgres: 'postgres', kafka: 'kafka' }, ...over,
});

test('the tap takes the names of the services it fronts; the real ones are renamed', () => {
  const { doc, routes } = renderCompose(vf(), spec(), ctx());
  assert.ok(doc.services['api-gateway-real'] && !doc.services['api-gateway']);
  assert.deepEqual(doc.services['api-gateway-real'].networks, { ks: { aliases: ['api-gateway-real'] } });
  assert.equal(doc.services['api-gateway-real'].hostname, undefined, 'a hostname would answer DNS for the name the tap holds');
  const tap = doc.services['ks-tap'];
  assert.equal(tap.networks.ks.ipv4_address, '172.30.7.254');
  assert.ok(tap.networks.ks.aliases.includes('clamav') && tap.networks.ks.aliases.includes('minio'));
  assert.deepEqual(routes.find((r) => r.svc === 'clamav'), { svc: 'clamav', aliases: ['clamav'], ports: [3310], upstream: 'clamav-real', proto: 'tcp' });
  // depends_on follows the rename, and everyone waits for the tap
  assert.deepEqual(Object.keys(doc.services['antivirus-service-real'].depends_on).sort(), ['clamav-real', 'kafka', 'ks-tap', 'minio-real']);
  assert.equal(doc.services.postgres.networks.ks.aliases[0], 'postgres');
});

test('nothing is published but stores on 127.0.0.1 and the tap entrance; no container names', () => {
  const { doc } = renderCompose(vf(), spec(), ctx());
  for (const [name, s] of Object.entries(doc.services)) {
    assert.equal(s.container_name, undefined, name);
    for (const p of s.ports ?? []) assert.match(p, /^127\.0\.0\.1:/, name);
  }
  assert.deepEqual(doc.services.postgres.ports, ['127.0.0.1:15432:5432']);
  assert.deepEqual(doc.services['ks-tap'].ports, ['127.0.0.1:4180:7999']);
  assert.equal(doc.services['api-gateway-real'].ports, undefined);
});

test('built images are tagged by content key, labelled, and values are namespaced', () => {
  const { doc, yaml } = renderCompose(vf(), spec(), ctx());
  const gw = doc.services['api-gateway-real'];
  assert.equal(gw.image, 'ks-vaultflow/api-gateway:k1');
  assert.equal(gw.environment.JWT_SECRET, '${KS_API_GATEWAY__JWT_SECRET}');
  assert.equal(doc.services.postgres.environment.POSTGRES_DB, '${KS_POSTGRES__POSTGRES_DB:-vaultflow}');
  assert.equal(gw.labels['keelson.env'], 'local');
  assert.equal(gw.labels['keelson.workspace'], 'abc123def0');
  assert.ok(!/\$\{(?!KS_)/.test(yaml), 'every interpolation is namespaced');
});

test('postgres logs statements, kafka gets a host listener, clamav its memory, caches are external', () => {
  const { doc } = renderCompose(vf(), spec(), ctx());
  assert.ok(doc.services.postgres.command.includes('log_min_duration_statement=0'));
  assert.match(doc.services.kafka.environment.KAFKA_ADVERTISED_LISTENERS, /HOST:\/\/127\.0\.0\.1:19092$/);
  assert.ok(doc.services.kafka.ports.includes('127.0.0.1:19092:29092'));
  assert.equal(doc.services['clamav-real'].mem_limit, '2g');
  assert.deepEqual(doc.volumes?.['clamav-data'], { name: 'ks-vaultflow-cache-clamav-data', external: true });
  assert.equal(doc.volumes?.['postgres-data'].name, 'ks-vaultflow-local_postgres-data');
  assert.equal(doc.services['minio-real'].image, 'cgr.dev/chainguard/minio:latest');
});

test('a job on the postgres image keeps its command', () => {
  const doc = vf();
  doc.services.seed = { image: 'postgres:16-alpine', command: ['psql', '-h', 'postgres', '-c', 'select 1'], depends_on: { postgres: { condition: 'service_healthy' } } };
  const { doc: out } = renderCompose(doc, spec(), ctx({ stores: { ...ctx().stores, seed: 'postgres' } }));
  assert.deepEqual(out.services.seed.command, ['psql', '-h', 'postgres', '-c', 'select 1']);
});

test('built HTTP services get a readiness check; the repo own checks are kept', () => {
  const { doc } = renderCompose(vf(), spec(), ctx());
  assert.match(doc.services['file-service-real'].healthcheck.test[1], /127\.0\.0\.1:8081\//);
  assert.deepEqual(doc.services['clamav-real'].healthcheck.test, ['CMD', 'clamdscan', '--ping', '3']);
});

test('hybrid services run on the host: the tap routes their name there', () => {
  const { doc, routes } = renderCompose(vf(), spec({ hybrid: ['file-service'] }), ctx());
  assert.equal(doc.services['file-service-real'], undefined);
  assert.equal(routes.find((r) => r.svc === 'file-service')?.upstream, 'host.docker.internal');
});

test('an ephemeral run publishes nothing and restarts nothing', () => {
  const { doc } = renderCompose(vf(), spec({ persistent: false }), ctx({ run: 'x1', hostPorts: {}, entrancePort: undefined, project: 'ks-vaultflow-local-rx1' }));
  assert.ok(Object.values(doc.services).every((s) => !s.ports));
  assert.equal(doc.services['ks-tap'].labels['keelson.run'], 'x1');
  assert.equal(doc.services['ks-tap'].restart, 'no');
});

test('render is deterministic, and the subset pulls its dependencies and jobs', () => {
  assert.equal(renderCompose(vf(), spec(), ctx()).yaml, renderCompose(vf(), spec(), ctx()).yaml);
  assert.deepEqual(closure(vf(), ['file-service']), ['file-service', 'kafka', 'minio', 'minio-init', 'postgres']);
  assert.deepEqual(interpolations(vf().services.postgres), ['POSTGRES_DB:-vaultflow', 'POSTGRES_PASSWORD:-vaultflow_secret', 'POSTGRES_USER:-vaultflow']);
});

test('host networking cannot be isolated and says where to fix it', () => {
  const doc = vf();
  doc.services.kafka.network_mode = 'host';
  assert.throws(() => renderCompose(doc, spec(), ctx()), /services\.kafka\.network_mode/);
});

test('a mocked service is not started; the tap answers for it and nobody waits for it', () => {
  const { doc, routes } = renderCompose(vf(), spec({ mocks: { clamav: { mode: 'script' }, stripe: { mode: 'contract', port: 8080 } } }), ctx({ mocksDir: '/ws/mocks', extraEnv: { 'file-service': { STRIPE_URL: 'http://stripe:8080' } } }));
  assert.equal(doc.services['clamav-real'], undefined);
  assert.ok(!('clamav-real' in doc.services['antivirus-service-real'].depends_on));
  assert.deepEqual(routes.find((r) => r.svc === 'clamav'), { svc: 'clamav', aliases: ['clamav'], ports: [3310], upstream: '', proto: 'tcp' });
  assert.deepEqual(routes.find((r) => r.svc === 'stripe'), { svc: 'stripe', aliases: ['stripe'], ports: [8080], upstream: '', proto: 'http' });
  assert.ok(doc.services['ks-tap'].volumes.includes('/ws/mocks:/ks/mocks'));
  assert.ok(doc.services['ks-tap'].networks.ks.aliases.includes('stripe'));
  assert.equal(doc.services['file-service-real'].environment.STRIPE_URL, 'http://stripe:8080');
});

test('DynamoDB Local is fronted by the tap over HTTP, like MinIO; Mongo and Redis are stores the tap leaves alone', () => {
  const doc: ComposeDoc = { services: {
    dynamodb: { image: 'amazon/dynamodb-local:2.5.2', ports: ['8000:8000'] },
    ddb: { image: 'public.ecr.aws/aws-dynamodb-local/aws-dynamodb-local:2', healthcheck: { test: ['CMD', 'true'] } },
    minio: { image: 'minio/minio', ports: ['9000:9000'] },
    mongo: { image: 'mongo:7', ports: ['27017:27017'] },
    redis: { image: 'redis:7-alpine', ports: ['6379:6379'] },
  } };
  const r = targetsOf(doc, Object.keys(doc.services));
  assert.deepEqual(r.targets, [{ svc: 'dynamodb', ports: [8000], proto: 'http' }, { svc: 'ddb', ports: [8000], proto: 'http' }, { svc: 'minio', ports: [9000], proto: 'http' }], 'a DynamoDB without ports listens on 8000');
  assert.deepEqual(r.stores, { mongo: 'other', redis: 'other' });
  assert.deepEqual(Object.keys(r.health), ['dynamodb'], 'its readiness is asked with curl when the repo has no check of its own');
  assert.match(r.health.dynamodb.cmd, /curl -sSI http:\/\/127\.0\.0\.1:8000\//);
});

test('vaultflow renders byte for byte what main rendered: one project, identity names, no networks per project', () => {
  const golden = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');
  // up passes the identity name table and the first project's cache names: they change nothing
  const names = Object.fromEntries(Object.keys(vf().services).map((s) => [s, s]));
  const r = renderCompose(vf(), spec(), ctx({ composeOf: names, cacheNames: { 'clamav-data': 'ks-vaultflow-cache-clamav-data' } }));
  assert.equal(r.yaml, golden('vaultflow-local.golden.yml'));
  assert.equal(JSON.stringify(r.routes, null, 2) + '\n', golden('vaultflow-local.golden.routes.json'));
});

test('the topics a service creates are created by a job before whoever talks to the broker starts', () => {
  const { doc } = renderCompose(vf(), spec(), ctx({ topics: [{ name: 'file.uploaded', partitions: 3 }, { name: 'file.clean', partitions: 3 }] }));
  const job = doc.services['ks-topics'];
  assert.ok(job, 'a one-shot job on the broker\'s image');
  assert.equal(job.image, doc.services.kafka.image);
  assert.equal(job.restart, 'no');
  assert.match(String(job.command[2]), /--create --if-not-exists --topic 'file\.uploaded' --partitions 3.*--topic 'file\.clean' --partitions 3/);
  assert.deepEqual(job.networks, doc.services.kafka.networks, 'on the broker\'s own network');
  assert.equal(job.depends_on.kafka.condition, 'service_healthy');
  for (const who of ['file-service-real', 'antivirus-service-real', 'notification-service-real']) {
    if (Object.keys(doc.services[who]?.depends_on ?? {}).includes('kafka')) assert.equal(doc.services[who].depends_on['ks-topics'].condition, 'service_completed_successfully', `${who} waits for the topics`);
  }
  assert.equal(renderCompose(vf(), spec(), ctx()).doc.services['ks-topics'], undefined, 'no topics known: no job');
});

test('an env that runs a few services does not get half-made ones from the overlay of the services it leaves out', () => {
  const { doc } = renderCompose(vf(), spec({ services: ['postgres'] }), ctx());
  assert.deepEqual(Object.keys(doc.services).filter((s) => /^minio/.test(s)), [], 'minio is not run here, so its image override is not merged');
  const all = renderCompose(vf(), spec(), ctx()).doc;
  assert.equal(all.services['minio-real']?.image, 'cgr.dev/chainguard/minio:latest', 'where it runs, the override still applies');
});

test('a sink the compose does not run: the tap holds its name, TCP on the mail ports with a certificate, and the services trust the CA; nothing makes it an http mock', () => {
  const s = spec({ mocks: { smtp: { mode: 'sink', sink: 'smtp' }, 'api.twilio.com': { mode: 'sink', sink: 'twilio' } }, hosts: ['api.twilio.com'], faults: {} });
  const { doc, routes } = renderCompose(vf(), s, ctx({ tls: { caDir: '/home/.laru/ca', truststores: { 'api-gateway': '/home/.laru/ca/cacerts' } } }));
  assert.deepEqual(routes.find((r) => r.svc === 'smtp'), { svc: 'smtp', aliases: ['smtp'], ports: [25, 465, 587, 1025, 2525], upstream: '', proto: 'tcp', tls: { cert: '/ks/ca/hosts/smtp.crt', key: '/ks/ca/hosts/smtp.key' } });
  assert.deepEqual(routes.filter((r) => r.svc === 'api.twilio.com').map((r) => r.proto), ['https'], 'Twilio is a name over https, not an http mock on port 80');
  assert.equal(routes.filter((r) => r.svc === 'smtp').length, 1);
  const tap = doc.services['ks-tap'];
  assert.ok(tap.networks.ks.aliases.includes('smtp') && tap.networks.ks.aliases.includes('api.twilio.com'));
  assert.ok(tap.volumes.some((v: string) => v.endsWith(':/ks/ca/hosts:ro')));
  // an env with only an SMTP sink (no https host) still has its services trust the local CA, which signs the sink's certificate
  const only = renderCompose(vf(), spec({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } } }), ctx({ tls: { caDir: '/home/.laru/ca', truststores: { 'api-gateway': '/home/.laru/ca/cacerts' } } }));
  assert.equal(only.doc.services['api-gateway-real'].environment.NODE_EXTRA_CA_CERTS, '/ks/ca/ca.crt');
  assert.ok(only.doc.services['ks-tap'].volumes.some((v: string) => v.endsWith(':/ks/ca/hosts:ro')));
});

test('egress: closed makes the env network internal, and only the tap and what publishes ports meet the outside', () => {
  const { doc } = renderCompose(vf(), spec({ egress: 'closed' }), ctx());
  assert.equal(doc.networks!.ks.internal, true);
  assert.deepEqual(Object.keys(doc.networks!).sort(), ['ks', 'ks-out']);
  assert.equal(doc.networks!['ks-out'].internal, undefined, 'the second network is a normal one');
  const outside = Object.entries(doc.services).filter(([, s]) => s.networks && 'ks-out' in s.networks).map(([n]) => n).sort();
  assert.deepEqual(outside, ['kafka', 'ks-tap', 'postgres'], 'the tap and the stores that publish a port');
  for (const n of ['api-gateway-real', 'file-service-real', 'frontend-real']) assert.deepEqual(Object.keys(doc.services[n].networks), ['ks'], `${n} sees only the env's network`);
  const open = renderCompose(vf(), spec(), ctx()).doc;
  assert.equal(open.networks!.ks.internal, undefined);
  assert.deepEqual(Object.keys(open.networks!), ['ks'], 'an open env is as it was');
});

test('when Docker does not answer, Laru says what to do, inside WSL2 too (Docker Engine with no daemon started, a socket the user cannot use)', async () => {
  const { dockerHint } = await import('../src/docker.ts');
  assert.match(dockerHint('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', true)!, /sudo service docker start.*systemd=true/);
  assert.match(dockerHint('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', false)!, /start Docker Desktop/);
  assert.match(dockerHint('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock', true)!, /usermod -aG docker/);
  assert.match(dockerHint('spawn docker ENOENT', true)!, /install Docker Engine in it.*WSL integration/);
  assert.equal(dockerHint('Error response from daemon: something else', true), undefined, 'anything else is shown as Docker said it');
});
