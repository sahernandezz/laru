/**
 * The default a variable is read with (`${JWT_SECRET:dev}`, `defaultValue = "…"`) is often a secret's stand-in: the map
 * says that a default exists and where, never what it is. Every sentinel below must stay out of everything the map holds.
 */
import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, context, initWorkspace, loadExtraction, loadGraph, refreshMap, stateDir } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

const APP = {
  'docker-compose.yml': 'services:\n  api:\n    build: ./api\n    environment:\n      DB_PASS: ${DB_PASS:-sentinel-compose}\n',
  'api/Dockerfile': 'FROM eclipse-temurin:21\n',
  'api/pom.xml': '<project><artifactId>api</artifactId><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
  'api/src/main/resources/application.yml': 'jwt:\n  secret: ${JWT_SECRET:sentinel-yml}\n  expiration-ms: ${JWT_EXPIRATION_MS:sentinel-3600000}\n  issuer: ${JWT_ISSUER}\n',
  'api/src/main/resources/application.properties': 'app.key=${APP_KEY:sentinel-properties}\n',
  'api/src/main/java/acme/Keys.java': '@Path("/keys")\npublic class Keys {\n  @ConfigProperty(name = "stripe.key", defaultValue = "sentinel-annotation") String stripe;\n  @ConfigProperty(name = "stripe.region") String region;\n  @Value("${legacy.token:sentinel-value}") String legacy;\n  @GET public String get() { return null; }\n}\n',
};

test('a variable read with a default: the map says there is one, never its value', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'keys', title: 'Keys' });
  fx.write(join(fx.tmp, 'code', 'app'), APP);
  await addRepo(ws, join(fx.tmp, 'code', 'app'), { name: 'app' });
  const { map } = await refreshMap(ws);

  const read = (name: string) => map.facts.filter((f) => f.p === 'reads-var' && f.o === `var:${name}`).map((f) => f.note);
  assert.deepEqual(read('JWT_SECRET'), ['has a default'], 'a placeholder in a config file');
  assert.deepEqual(read('JWT_EXPIRATION_MS'), ['has a default']);
  assert.deepEqual(read('APP_KEY'), ['has a default'], 'a properties file');
  assert.deepEqual(read('STRIPE_KEY'), ['overrides stripe.key, has a default'], 'defaultValue of @ConfigProperty');
  assert.deepEqual(read('LEGACY_TOKEN'), ['overrides legacy.token, has a default'], '@Value with a default');
  assert.deepEqual(read('JWT_ISSUER'), [undefined], 'no default, no note');
  assert.deepEqual(read('STRIPE_REGION'), ['overrides stripe.region'], 'overridden, no default');

  assert.doesNotMatch(JSON.stringify(map), /sentinel/, 'no note, attribute or node of the map holds a default');
  assert.doesNotMatch(readFileSync(join(stateDir(ws), 'map.json'), 'utf8'), /sentinel/, 'nor the map on disk');
  const said = context(loadGraph(ws), ws, 'svc:api', 4000);
  assert.match(said, /has a default/);
  assert.doesNotMatch(said, /sentinel/, 'nor what an agent is told');
  assert.doesNotMatch(JSON.stringify(loadExtraction(ws, 'app')!.files['docker-compose.yml']), /sentinel/, 'nor the compose findings, which the map ignores');

  // A cache written by the detectors of version 3 carried the value and no flag: it is read again, not reused.
  const cache = join(stateDir(ws), 'extract', 'app.json');
  const old = JSON.parse(readFileSync(cache, 'utf8'));
  old.detectors = 3;
  for (const file of Object.values<{ findings: Array<Record<string, unknown>> }>(old.files)) for (const f of file.findings) if (f.kind === 'env-var') { delete f.hasDefault; f.default = 'sentinel-stale'; }
  writeFileSync(cache, JSON.stringify(old));
  const again = (await refreshMap(ws)).map;
  assert.deepEqual(again.facts.filter((f) => f.o === 'var:JWT_SECRET').map((f) => f.note), ['has a default'], 'the stale findings were read again');
  assert.doesNotMatch(JSON.stringify(again), /sentinel/);
});

test('a map written before the default left it still says nothing of the value: it is cleaned as it loads, until the next refresh', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'keys', title: 'Keys' });
  fx.write(join(fx.tmp, 'code', 'app'), APP);
  await addRepo(ws, join(fx.tmp, 'code', 'app'), { name: 'app' });
  await refreshMap(ws);
  const file = join(stateDir(ws), 'map.json');
  const legacy = JSON.parse(readFileSync(file, 'utf8'));
  for (const f of legacy.facts) if (f.p === 'reads-var' && f.o === 'var:JWT_SECRET') f.note = 'default sentinel-legacy';
  for (const f of legacy.facts) if (f.p === 'reads-var' && f.o === 'var:STRIPE_KEY') f.note = 'overrides stripe.key';
  writeFileSync(file, JSON.stringify(legacy));
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const g = loadGraph(ws);
  const note = (name: string) => g.map.facts.find((f) => f.p === 'reads-var' && f.o === `var:${name}`)?.note;
  assert.equal(note('JWT_SECRET'), 'has a default');
  assert.equal(note('STRIPE_KEY'), 'overrides stripe.key', 'a note that is not a default stays');
  assert.doesNotMatch(JSON.stringify(g.map), /sentinel/, 'what /api/map serves');
  assert.doesNotMatch(context(g, ws, 'svc:api', 4000), /sentinel/, 'and what an agent is told');
});
