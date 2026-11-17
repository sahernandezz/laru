/**
 * Which technology a piece of the map is, to show its logo: a store or an external by the image it runs (`postgres:16`,
 * `apache/kafka`) or the host it is (`api.stripe.com`); a service by the framework its libraries say (`@angular/core`,
 * `org.springframework.boot:…`), else by its kind (`spring`, `quarkus`).
 */
import type { Indexed, MapNode } from '../api.ts';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A service's framework, from one of its libraries: the more specific first (Next before React, Nest before Express). */
const FRAMEWORKS: Array<[RegExp, string]> = [
  [/^next$/, 'nextjs'], [/^nuxt3?$/, 'nuxt'], [/^@remix-run\//, 'remix'], [/^astro$/, 'astro'], [/^@sveltejs\/kit$/, 'svelte'],
  [/^@angular\/core$/, 'angular'], [/^@nestjs\/core$/, 'nestjs'], [/^@adonisjs\/core$/, 'adonisjs'], [/^solid-js$/, 'solid'], [/^preact$/, 'preact'],
  [/^vue$/, 'vue'], [/^svelte$/, 'svelte'], [/^react$/, 'react'], [/^ember-source$/, 'ember'], [/^electron$/, 'electron'],
  [/^fastify$/, 'fastify'], [/^koa$/, 'koa'], [/^@hapi\/hapi$/, 'hapi'], [/^express$/, 'express'],
  [/^io\.quarkus:/, 'quarkus'], [/^io\.ktor:/, 'ktor'], [/^org\.springframework(\.boot)?:/, 'spring'],
  [/^django$/i, 'django'], [/^fastapi$/i, 'fastapi'], [/^flask$/i, 'flask'], [/^rails$/, 'rails'], [/^laravel\/framework$/, 'laravel'], [/^symfony\//, 'symfony'],
  [/^microsoft\.aspnetcore/i, 'dotnet'],
];
/** Kinds that say nothing of the technology: a service built from any Dockerfile, any web front. */
const VAGUE = new Set(['docker', 'web', 'service', 'infra', 'relational', 'queue', 'file', 'document', 'cache', 'http']);
/** The language a service's libraries are written for, when no framework says more: npm is Node.js, Maven Java. */
const ECOSYSTEM: Record<string, string> = { npm: 'nodejs', maven: 'java', gradle: 'java', pypi: 'python', go: 'go', nuget: 'dotnet', composer: 'php', gem: 'ruby', cargo: 'rust' };
/** An image's words, last segment first, then its parts, and each without its version (`gcr.io/distroless/java21`, `confluentinc/cp-kafka`). */
const imageWords = (image: unknown) => {
  const repo = String(image ?? '').replace(/@.*$/, '').replace(/:[^/]*$/, '');
  return repo ? repo.split('/').reverse().flatMap((seg) => [seg, ...seg.split(/[-_.]/)]).flatMap((w) => [w, w.replace(/\d+$/, '')]) : [];
};
/** A piece's name and host, whole and in parts: `api.stripe.com` is Stripe. */
const nameWords = (n: MapNode) => [n.name, ...n.name.split(/[.\-_/:@]/), ...String(n.attrs?.host ?? '').split('.')];
/** Any piece by its image; a store or an external by its name and host too. A service's name says what it does, not what it is built with (`kafka-consumer`). */
const wordsOf = (n: MapNode) => [...imageWords(n.attrs?.image), ...(n.type === 'service' ? [] : nameWords(n))];

const memo = new WeakMap<Indexed, Map<string, string | undefined>>();

/** The key of its logo in `aliases` (word → logo), or undefined: then it keeps a generic icon (see `roleOf`). */
export function techOf(g: Indexed | null | undefined, n: MapNode, aliases: Record<string, string>): string | undefined {
  const seen = g ? memo.get(g) ?? memo.set(g, new Map()).get(g)! : undefined;
  if (seen?.has(n.id)) return seen.get(n.id);
  const hit = (words: string[]) => { for (const w of words) { const k = aliases[norm(w)]; if (k && !VAGUE.has(norm(w))) return k; } return undefined; };
  let key = hit(wordsOf(n));
  if (!key && n.type === 'service') {
    const deps = g ? g.out(n.id).filter((f) => f.p === 'depends-on' && f.o.startsWith('dep:')) : [];
    const libs = deps.map((f) => g!.nodes.get(f.o)?.name ?? f.o.replace(/^dep:[^:]+:/, ''));
    // its framework; else what its front is built with; else the image its Dockerfile builds from; else its libraries' language; else its kind
    key = FRAMEWORKS.find(([re, k]) => aliases[k] && libs.some((l) => re.test(l)))?.[1]
      ?? hit([String(n.attrs?.stack ?? '')])
      ?? hit(imageWords(n.attrs?.base))
      ?? deps.map((f) => ECOSYSTEM[f.o.split(':')[1]]).find((k) => k && aliases[k])
      ?? hit([String(n.attrs?.tech ?? ''), n.kind ?? '']);
  }
  seen?.set(n.id, key);
  return key;
}

/** What a piece with no brand Laru knows does, said by a generic icon: an antivirus, a mail server, a mock, a local cloud. */
export type Role = 'antivirus' | 'mail' | 'mock' | 'cloud';
const ROLES: Array<[RegExp, Role]> = [
  [/^(clamav|clamd|antivirus|av)$/, 'antivirus'],
  [/^(smtp|mail|mailpit|mailhog|maildev|mailcatcher|mailbox|postfix|exim|greenmail|smtp4dev|inbucket)$/, 'mail'],
  [/^(wiremock|mockserver|mock|mocks|prism|mountebank|imposter)$/, 'mock'],
  [/^(localstack|azurite|moto)$/, 'cloud'],
];
export function roleOf(n: MapNode): Role | undefined {
  // what it does, a service says by its name and the image its Dockerfile builds from too (`payments-mock`, `FROM clamav/clamav`)
  const words = [...imageWords(n.attrs?.image), ...imageWords(n.attrs?.base), ...nameWords(n)].map(norm);
  return ROLES.find(([re]) => words.some((w) => re.test(w)))?.[1];
}
