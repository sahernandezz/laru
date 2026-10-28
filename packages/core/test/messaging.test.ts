import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Finding } from '@laru/detect';
import { buildSystemMap } from '../src/build.ts';
import type { RepoExtraction } from '../src/extract.ts';
import type { Workspace } from '../src/workspace.ts';

const ws = { app: 'tienda', title: 'Tienda', repos: [{ name: 'app', source: 'git', url: 'https://x.test/app.git', branch: 'main', role: 'service' }], services: [], checkouts: {}, lock: {}, docsLanguage: 'es' } as unknown as Workspace;
const ex = (files: Record<string, Finding[]>): RepoExtraction => ({ repo: 'app', commit: 'c0ffee', ref: 'main', detectors: 0, tree: {}, files: Object.fromEntries(Object.entries(files).map(([p, findings]) => [p, { blob: p, findings }])) as RepoExtraction['files'] });
const dep = (name: string, ecosystem: 'npm' | 'maven' = 'npm', scope?: string): Finding => ({ kind: 'dependency', ecosystem, name, ...(scope ? { scope } : {}) });
const externals = (m: ReturnType<typeof buildSystemMap>) => m.nodes.filter((n) => n.type === 'external').map((n) => [n.name, n.attrs?.via, n.attrs?.messaging]).sort();

test('what sends mail or texts becomes an external with the variable that moves it; a mail host with a default is named by the host', () => {
  const m = buildSystemMap(ws, [ex({
    'api/package.json': [{ kind: 'service-root', tech: 'node', name: 'api' }, dep('nodemailer'), dep('twilio'), dep('@sendgrid/mail'), dep('nodemailer-mock', 'npm', 'dev')],
    'api/server.js': [{ kind: 'env-var', name: 'SMTP_HOST', line: 3, via: 'process.env' }],
    'legacy/pom.xml': [{ kind: 'service-root', tech: 'spring', name: 'legacy' }, dep('org.springframework.boot:spring-boot-starter-mail', 'maven')],
    'legacy/src/main/resources/application.properties': [{ kind: 'config', key: 'spring.mail.host', value: '${MAIL_HOST:smtp.gmail.com}', line: 1 }, { kind: 'config', key: 'spring.mail.port', value: '587', line: 2 }],
    'plain/package.json': [{ kind: 'service-root', tech: 'node', name: 'plain' }, dep('express')],
  })]);
  assert.deepEqual(externals(m), [
    ['api.sendgrid.com', undefined, 'http'], ['api.twilio.com', undefined, 'sms'], ['smtp', 'SMTP_HOST', 'smtp'], ['smtp.gmail.com', 'MAIL_HOST', 'smtp']].sort());
  assert.ok(!m.nodes.some((n) => n.id.includes('${')), 'a placeholder is never a node name');
  const callers = (id: string) => m.facts.filter((f) => f.o === id).map((f) => f.s).sort();
  assert.deepEqual([callers('ext:smtp'), callers('ext:smtp.gmail.com'), callers('ext:api.twilio.com')], [['svc:api'], ['svc:legacy'], ['svc:api']]);
  assert.equal(m.nodes.find((n) => n.id === 'ext:api.twilio.com')!.attrs!.provider, 'Twilio');
  // a service with nothing of the kind adds nothing: the control for vaultflow, which sends nothing
  assert.equal(m.facts.filter((f) => f.s === 'svc:plain' && f.o.startsWith('ext:')).length, 0);
});

test('ignore-externals takes the hosts it names off the map, exactly or with *, with what reaches them; without it the map is the same', () => {
  const extraction = ex({
    'api/package.json': [{ kind: 'service-root', tech: 'node', name: 'api' }],
    'api/server.js': [
      { kind: 'outbound', url: 'https://www.search.example/q', line: 1 },
      { kind: 'outbound', url: 'https://eu.mock.example/x', line: 2 },
      { kind: 'outbound', url: 'https://payments.example.com/charge', line: 3 },
    ] as Finding[],
  });
  const plain = buildSystemMap(ws, [extraction]);
  assert.deepEqual(externals(plain).map((e) => e[0]), ['eu.mock.example', 'payments.example.com', 'www.search.example']);
  const m = buildSystemMap({ ...ws, ignoreExternals: ['www.search.example', '*.mock.example'] }, [extraction]);
  assert.deepEqual(externals(m).map((e) => e[0]), ['payments.example.com']);
  assert.ok(!m.facts.some((f) => /search|mock/.test(f.o)), 'nothing reaches what is gone');
  assert.equal(m.facts.length, plain.facts.length - 2);
});
