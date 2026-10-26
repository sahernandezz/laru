/** Fidelity without Docker: what the files of a repo say about production, a piece's declaration, and when two values are the same. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { computeFindings, initWorkspace, knowledgeWrite, loadKnowledge, STANDARD, type FieldValue } from '@laru/core';
import { authOf, declaredRefs, prodRefs, same } from '../src/fidelity.ts';

const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

test('production profiles, Kubernetes, Helm and a production compose each say what production runs, with the file and line', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-fid-'));
  put(root, 'orders/src/main/resources/application-prod.yml', 'server:\n  ssl:\n    enabled: true\n');
  put(root, 'billing/src/main/resources/application.properties', 'quarkus.http.port=8080\n%prod.quarkus.datasource.jdbc.url=jdbc:postgresql://db/billing\n');
  put(root, 'k8s/orders.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orders\nspec:\n  template:\n    spec:\n      containers:\n        - name: orders\n          image: registry/orders:1.4\n          resources:\n            limits: { memory: 512Mi, cpu: 500m }\n          env:\n            - name: SPRING_PROFILES_ACTIVE\n              value: prod\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nspec:\n  tls: [{ hosts: [shop.example] }]\n  rules:\n    - http:\n        paths:\n          - backend: { service: { name: orders } }\n');
  put(root, 'charts/redis/Chart.yaml', 'name: redis\n');
  put(root, 'charts/redis/values.yaml', 'image:\n  repository: redis\n  tag: "7.2"\nresources:\n  limits:\n    memory: 256Mi\n');
  put(root, 'charts/redis/templates/deploy.yaml', 'image: {{ .Values.image.repository }}\n');
  put(root, 'docker-compose.prod.yml', 'services:\n  postgres:\n    image: postgres:16.4\n    mem_limit: 2g\n');
  symlinkSync(root, join(root, 'charts', 'loop'));
  put(root, 'node_modules/x/k8s.yaml', 'kind: Deployment\nmetadata: { name: nope }\n');
  const refs = prodRefs(root, 'shop@abc1234', { orders: join(root, 'orders'), billing: join(root, 'billing') });
  const has = (participant: string, aspect: string, value: string, source: RegExp) => assert.ok(refs.some((r) => r.participant === participant && r.aspect === aspect && r.value === value && source.test(r.source)), `${participant} ${aspect} ${value} in ${JSON.stringify(refs)}`);
  has('orders', 'profile', 'prod', /^shop@abc1234\/orders\/.*application-prod\.yml$/);
  has('orders', 'protocol', 'HTTPS', /application-prod\.yml:2$/);
  has('billing', 'profile', 'prod', /application\.properties:2$/);
  has('orders', 'image', 'registry/orders:1.4', /k8s\/orders\.yaml:\d+$/);
  has('orders', 'memory', '512Mi', /k8s/);
  has('orders', 'cpus', '500m', /k8s/);
  has('orders', 'protocol', 'HTTPS', /k8s/);
  has('redis', 'image', 'redis:7.2', /charts\/redis\/values\.yaml/);
  has('redis', 'memory', '256Mi', /values/);
  has('postgres', 'image', 'postgres:16.4', /docker-compose\.prod\.yml:2$/);
  has('postgres', 'memory', '2g', /prod/);
  assert.ok(!refs.some((r) => r.participant === 'nope'), 'dependencies are not read');
});

test('an external declares how production reaches it; the participant defaults to the external', async () => {
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'laru-fid-')), { app: 'shop', docsLanguage: 'es' });
  const e = STANDARD.application.example;
  knowledgeWrite(ws, { type: 'application', title: e.title, kind: e.kind, status: e.status, summary: e.summary, fields: e.fields as Record<string, FieldValue> });
  const r = knowledgeWrite(ws, { type: 'external', in: 'app:shop', title: 'stripe', kind: 'saas', status: 'active', summary: 'Cobros.', fields: { purpose: 'Cobra tarjetas.', production: [{ aspect: 'mode', value: 'real' }] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(declaredRefs(ws), [{ participant: 'stripe', aspect: 'mode', value: 'real', source: 'ext:stripe' }]);

  // two differences of one participant (its memory and its cpus) are two findings, each accepted on its own
  const gap = (aspect: string, local: string, prod: string) => ({ env: 'local', kind: 'resources', name: 'orders', aspect, local, prod, source: 'k8s/orders.yaml:9' });
  const found = (await computeFindings(ws, null, loadKnowledge(ws), { fidelityGaps: [gap('memory', 'sin límite', '512Mi'), gap('cpus', 'sin límite', '500m')] })).filter((f) => f.type === 'fidelity-gap');
  assert.deepEqual(found.map((f) => f.key), ['fidelity-gap:env:local:resources:orders:memory', 'fidelity-gap:env:local:resources:orders:cpus']);
});

test('two values are the same in other units or spellings, never by default', () => {
  assert.ok(same('memory', '1g', '1Gi'));
  assert.ok(same('memory', '1024m', '1g'));
  assert.ok(!same('memory', '512Mi', '1g'));
  assert.ok(same('cpus', '500m', '0.5'));
  assert.ok(same('image', 'docker.io/library/postgres', 'postgres:latest'));
  assert.ok(!same('image', 'postgres:16-alpine', 'postgres:16.4'));
  assert.ok(!same('mode', 'script', 'real'));
  assert.ok(!same('memory', 'sin límite', '512Mi'), 'no limit here against a limit in production is a gap');
  // authentication compares by class: the local value is a class, the declared one free text
  assert.ok(same('auth', 'idp', 'Keycloak'));
  assert.ok(same('auth', 'jwt', 'JWT propio del gateway'));
  assert.ok(same('auth', 'off', 'none'));
  assert.ok(!same('auth', 'off', 'Keycloak'));
  assert.ok(!same('auth', 'jwt', 'Keycloak'));
  assert.ok(!same('auth', 'jwt', 'API key'), 'a mechanism of another class is a difference, not a match');
  assert.ok(!same('auth', 'on', 'mTLS'));
  assert.ok(same('auth', 'idp', 'Keycloak, no anónimos'), 'a «no» inside a sentence does not make it off');
  // what the variables say: a flag that turns it off wins over an IdP; one from the vault leaves it unknown
  assert.equal(authOf({ KEYCLOAK_URL: 'http://kc', SECURITY_ENABLED: 'false' }).known, 'off');
  assert.equal(authOf({ KEYCLOAK_URL: 'http://kc', AUTH_DISABLED: 'true' }).known, 'off');
  assert.equal(authOf({ KEYCLOAK_URL: 'http://kc', SECURITY_ENABLED: '${KS_API__SECURITY_ENABLED}' }).known, undefined);
  assert.equal(authOf({ KEYCLOAK_URL: 'http://kc', SECURITY_ENABLED: 'true' }).known, 'idp');
  assert.equal(authOf({ JWT_SECRET: '${KS_API__JWT_SECRET}' }).known, 'jwt');
  assert.equal(authOf({ PORT: '8080' }).known, undefined, 'nothing seen is unknown, never off');
  assert.ok(!same('auth', 'jwt', 'firma propia'), 'a text of no known class compares as written');
});
