/**
 * Which logo each piece of the map wears: a store by its image, an external by its host, a service by the framework its
 * libraries say (never by a driver it uses), and nothing when Laru does not know it. And every logo is only a drawing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fact, Indexed, MapNode } from '../src/api.ts';
import { roleOf, techOf } from '../src/lib/tech.ts';
import { ALIASES, LOGOS } from '../src/lib/techIcons.ts';

const graph = (nodes: MapNode[], facts: Array<Pick<Fact, 's' | 'p' | 'o'>> = []): Indexed => {
  const out = new Map<string, Fact[]>();
  for (const f of facts as Fact[]) (out.get(f.s) ?? out.set(f.s, []).get(f.s)!).push(f);
  return { map: { nodes, facts } as never, nodes: new Map(nodes.map((n) => [n.id, n])), out: (id) => out.get(id) ?? [], in: () => [] };
};
const node = (id: string, type: MapNode['type'], extra: Partial<MapNode> = {}): MapNode => ({ id, type, name: id.split(':').slice(1).join(':'), ...extra });
const libs = (svc: string, ...names: string[]) => names.map((n) => ({ s: svc, p: 'depends-on' as const, o: `dep:x:${n}` }));
const deps = (...names: string[]) => names.map((n) => node(`dep:x:${n}`, 'dependency', { name: n }));

test('a store by the image it runs, an external by its host', () => {
  const of = (n: MapNode) => techOf(null, n, ALIASES);
  assert.equal(of(node('ds:postgres', 'datastore', { kind: 'relational', attrs: { image: 'postgres:16-alpine' } })), 'postgresql');
  assert.equal(of(node('ds:kafka', 'datastore', { kind: 'queue', attrs: { image: 'apache/kafka:3.7.0' } })), 'kafka');
  assert.equal(of(node('ds:broker', 'datastore', { kind: 'queue', attrs: { image: 'confluentinc/cp-kafka:7.6.0' } })), 'kafka');
  assert.equal(of(node('ds:minio', 'datastore', { kind: 'file', attrs: { image: 'cgr.dev/chainguard/minio:latest' } })), 'minio');
  assert.equal(of(node('ds:cache', 'datastore', { kind: 'cache', attrs: { image: 'redis:7@sha256:abc' } })), 'redis');
  assert.equal(of(node('ext:api.twilio.com', 'external', { kind: 'service' })), 'twilio');
  assert.equal(of(node('ext:api.stripe.com', 'external', { kind: 'service' })), 'stripe');
  // what Laru does not know keeps its generic icon
  assert.equal(of(node('ext:clamav', 'external', { kind: 'infra', attrs: { image: 'clamav/clamav-debian:latest' } })), undefined);
  assert.equal(of(node('ext:smtp', 'external', { kind: 'service', attrs: { via: 'SMTP_HOST' } })), undefined);
});

test('a service by the framework its libraries say, the most specific one, never by a driver', () => {
  const front = node('svc:frontend', 'service', { kind: 'web', attrs: { tech: 'web' } });
  assert.equal(techOf(graph([front, ...deps('@angular/core', 'rxjs')], libs('svc:frontend', '@angular/core', 'rxjs')), front, ALIASES), 'angular');
  const shop = node('svc:shop', 'service', { kind: 'node' });
  assert.equal(techOf(graph([shop, ...deps('react', 'next')], libs('svc:shop', 'react', 'next')), shop, ALIASES), 'nextjs');
  const api = node('svc:api', 'service', { kind: 'node' });
  assert.equal(techOf(graph([api, ...deps('express', '@nestjs/core')], libs('svc:api', 'express', '@nestjs/core')), api, ALIASES), 'nestjs');
  const files = node('svc:files', 'service', { kind: 'spring', attrs: { tech: 'spring' } });
  assert.equal(techOf(graph([files, ...deps('org.postgresql:postgresql', 'io.minio:minio')], libs('svc:files', 'org.postgresql:postgresql', 'io.minio:minio')), files, ALIASES), 'spring', 'its database driver is not what it is');
  // a service built from any Dockerfile says nothing of its technology
  assert.equal(techOf(graph([]), node('svc:web', 'service', { kind: 'docker', attrs: { tech: 'docker' } }), ALIASES), undefined);
});

test('a service with no framework: what its front is built with, the image its Dockerfile builds from, its libraries\' language', () => {
  const none = graph([]);
  const svc = (id: string, attrs: Record<string, unknown>) => node(id, 'service', { kind: 'docker', attrs: { tech: 'docker', ...attrs } });
  assert.equal(techOf(none, svc('svc:shop', { tech: 'web', stack: 'react' }), ALIASES), 'react');
  assert.equal(techOf(none, svc('svc:back', { base: 'eclipse-temurin:21-jre-alpine' }), ALIASES), 'java');
  assert.equal(techOf(none, svc('svc:fn', { base: 'gcr.io/distroless/java21' }), ALIASES), 'java');
  assert.equal(techOf(none, svc('svc:web', { base: 'nginx:alpine' }), ALIASES), 'nginx');
  assert.equal(techOf(none, svc('svc:replica', { base: 'postgres:16' }), ALIASES), 'postgresql');
  const mailer = svc('svc:mailer', {});
  assert.equal(techOf(graph([mailer, node('dep:npm:nodemailer', 'dependency', { name: 'nodemailer' })], [{ s: 'svc:mailer', p: 'depends-on', o: 'dep:npm:nodemailer' }]), mailer, ALIASES), 'nodejs', 'npm libraries with no framework are Node.js');
});

test('a piece with no brand Laru knows says what it does: an antivirus, a mail server, a mock, a local cloud', () => {
  assert.equal(roleOf(node('ext:clamav', 'external', { kind: 'infra', attrs: { image: 'clamav/clamav-debian:latest' } })), 'antivirus');
  assert.equal(roleOf(node('ext:smtp', 'external', { kind: 'service', attrs: { via: 'SMTP_HOST' } })), 'mail');
  assert.equal(roleOf(node('ds:mailpit', 'datastore', { attrs: { image: 'axllent/mailpit' } })), 'mail');
  assert.equal(roleOf(node('ext:payments-mock', 'external', { attrs: { image: 'wiremock/wiremock:3' } })), 'mock');
  assert.equal(roleOf(node('ds:aws', 'datastore', { attrs: { image: 'localstack/localstack' } })), 'cloud');
  assert.equal(roleOf(node('ds:postgres', 'datastore', { attrs: { image: 'postgres:16' } })), undefined);
  // a service too, by its name or the image its Dockerfile builds from; its name still gives it no brand
  const svc = (id: string, attrs: Record<string, unknown> = {}) => node(id, 'service', { kind: 'docker', attrs: { tech: 'docker', ...attrs } });
  assert.equal(roleOf(svc('svc:clamav')), 'antivirus');
  assert.equal(roleOf(svc('svc:mail')), 'mail');
  assert.equal(roleOf(svc('svc:payments-mock')), 'mock');
  assert.equal(roleOf(svc('svc:scanner', { base: 'clamav/clamav:1.4' })), 'antivirus');
  assert.equal(roleOf(svc('svc:files')), undefined);
  assert.equal(techOf(graph([]), svc('svc:kafka-consumer'), ALIASES), undefined, 'a service is not the brand its name says');
});

test('every logo is a drawing: no script, no event, no link out, and its ids its own', () => {
  for (const [key, l] of Object.entries(LOGOS)) {
    assert.doesNotMatch(l.s, /<script|<foreignObject|\son[a-z]+\s*=|javascript:|href="(?!#)/i, key);
    for (const id of l.s.matchAll(/id="([^"]+)"/g)) assert.ok(id[1].startsWith(`t-${key}-`), `${key}: ${id[1]}`);
    assert.match(l.v, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/, key);
  }
  assert.ok(Object.keys(LOGOS).length >= 150, 'the catalogue is broad');
  for (const k of new Set(Object.values(ALIASES))) assert.ok(LOGOS[k], `${k} names a logo`);
});
