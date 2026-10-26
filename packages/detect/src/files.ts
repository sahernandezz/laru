/** Build, packaging and infrastructure files: pom.xml, package.json, Dockerfile, compose, nginx, SQL, env examples, OpenAPI, Prisma. */
import { parse as parseYaml } from 'yaml';
import type { Finding, Tech } from './types.ts';
import { lineIndex } from './text.ts';

const tag = (xml: string, name: string): string | undefined => xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1];
const block = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

export function detectPom(src: string): Finding[] {
  const out: Finding[] = [];
  const own = src.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, '');
  const name = tag(own.replace(/<dependencies>[\s\S]*<\/dependencies>|<build>[\s\S]*<\/build>/g, ''), 'artifactId');
  if (/<modules>/.test(own) || tag(own, 'packaging') === 'pom') out.push({ kind: 'parent-module' });
  else {
    const tech: Tech | undefined = /quarkus-maven-plugin/.test(own) ? 'quarkus' : /spring-boot-maven-plugin/.test(own) ? 'spring' : undefined;
    if (tech) out.push({ kind: 'service-root', tech, name, line: 1 });
  }
  for (const deps of block(own.replace(/<build>[\s\S]*<\/build>/, ''), 'dependencies')) {
    for (const d of block(deps, 'dependency')) {
      const g = tag(d, 'groupId'), a = tag(d, 'artifactId');
      if (g && a) out.push({ kind: 'dependency', ecosystem: 'maven', name: `${g}:${a}`, version: tag(d, 'version'), scope: tag(d, 'scope') });
    }
  }
  return out;
}

const SERVER_DEPS = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi', 'next'];
const WEB_DEPS = ['@angular/core', 'react-dom', 'vue', 'svelte', 'solid-js', 'vite'];
const WEB_STACK: Record<string, string> = { '@angular/core': 'angular', 'react-dom': 'react', vue: 'vue', svelte: 'svelte', 'solid-js': 'solid', vite: 'vite' };
const MOBILE_DEPS: Array<[string, string]> = [['expo', 'expo'], ['react-native', 'react-native'], ['@nativescript/core', 'nativescript']];

export function detectPackageJson(src: string): Finding[] {
  let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; workspaces?: unknown };
  try { pkg = JSON.parse(src); } catch { return []; }
  const out: Finding[] = [];
  const deps = { ...pkg.dependencies };
  const all = { ...deps, ...pkg.devDependencies };
  const name = pkg.name?.replace(/^@[^/]+\//, '');
  const mobile = MOBILE_DEPS.find(([d]) => d in all);
  if (mobile) out.push({ kind: 'service-root', tech: 'mobile', name, line: 1, stack: mobile[1], platform: 'cross' });
  else if (SERVER_DEPS.some((d) => d in deps)) out.push({ kind: 'service-root', tech: 'node', name, line: 1 });
  else if (WEB_DEPS.some((d) => d in all) && (pkg.scripts?.build || pkg.scripts?.start)) out.push({ kind: 'service-root', tech: 'web', name, line: 1, stack: WEB_STACK[WEB_DEPS.find((d) => d in all)!] });
  else if (pkg.scripts?.start && !pkg.workspaces) out.push({ kind: 'service-root', tech: 'node', name, line: 1 });
  for (const [n, v] of Object.entries(pkg.dependencies ?? {})) out.push({ kind: 'dependency', ecosystem: 'npm', name: n, version: v });
  for (const [n, v] of Object.entries(pkg.devDependencies ?? {})) out.push({ kind: 'dependency', ecosystem: 'npm', name: n, version: v, scope: 'dev' });
  return out;
}

export function detectDockerfile(src: string): Finding[] {
  const out: Finding[] = [{ kind: 'service-root', tech: 'docker', line: 1 }];
  src.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*EXPOSE\s+(.+)/i);
    if (m) for (const p of m[1].split(/\s+/)) { const n = parseInt(p, 10); if (n) out.push({ kind: 'port', port: n, line: i + 1 }); }
  });
  return out;
}

export function detectCompose(src: string): Finding[] {
  let doc: { services?: Record<string, Record<string, unknown>> };
  try { doc = parseYaml(src) ?? {}; } catch { return []; }
  const lineOf = lineIndex(src);
  const out: Finding[] = [];
  for (const [name, s] of Object.entries(doc.services ?? {})) {
    const build = typeof s.build === 'string' ? s.build : (s.build as { context?: string } | undefined)?.context;
    const ports = ((s.ports as unknown[]) ?? []).map((p) => {
      if (typeof p === 'object' && p) { const o = p as { published?: number | string; target?: number }; return { host: o.published ? Number(o.published) : undefined, container: Number(o.target) }; }
      const parts = String(p).split('/')[0].split(':');
      return { host: parts.length > 1 ? Number(parts[parts.length - 2]) : undefined, container: Number(parts[parts.length - 1]) };
    }).filter((p) => p.container);
    const envRaw = s.environment;
    const env = Array.isArray(envRaw) ? envRaw.map((e) => String(e).split('=')[0]) : Object.keys((envRaw as object) ?? {});
    // literal values (`FILES_URL: http://api-gateway:8080`): a base URL read from one says where the service calls
    const pairs = Array.isArray(envRaw) ? envRaw.map(String).filter((e) => e.includes('=')).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]) : Object.entries((envRaw as object) ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]);
    const values = Object.fromEntries(pairs.filter(([, v]) => !v.includes('${')));
    const dependsOn = Array.isArray(s.depends_on) ? s.depends_on.map(String) : Object.keys((s.depends_on as object) ?? {});
    const at = src.search(new RegExp(`^\\s{2}${name.replace(/[-.]/g, '\\$&')}:`, 'm'));
    out.push({ kind: 'compose-service', name, image: s.image as string | undefined, build: build?.replace(/^\.\//, '').replace(/\/$/, ''), ports, env, ...(Object.keys(values).length ? { values } : {}), dependsOn, line: at >= 0 ? lineOf(at) : 1 });
  }
  // Variables the compose file expects from its environment: `${JWT_SECRET}`.
  for (const m of src.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::?-([^}]*))?\}/g)) out.push({ kind: 'env-var', name: m[1], via: 'compose', hasDefault: m[2] !== undefined, line: lineOf(m.index) });
  return out;
}

export function detectNginx(src: string): Finding[] {
  const lineOf = lineIndex(src);
  return [...src.matchAll(/location\s+(?:[=~^]+\s*)?(\S+)\s*\{[^}]*?proxy_pass\s+([^;\s]+)\s*;/g)]
    .map((m) => ({ kind: 'proxy' as const, prefix: m[1], target: m[2], line: lineOf(m.index) }));
}

export function detectProxyConf(src: string): Finding[] {
  try {
    const conf = JSON.parse(src) as Record<string, { target?: string }>;
    return Object.entries(conf).filter(([, v]) => v?.target).map(([k, v]) => ({ kind: 'proxy' as const, prefix: k.replace(/\/\*+$/, ''), target: v.target!, line: 1 }));
  } catch { return []; }
}

export function detectSql(src: string): Finding[] {
  const lineOf = lineIndex(src);
  return [...src.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(?:(\w+)[`"]?\.[`"]?)?(\w+)[`"]?/gi)]
    .map((m) => ({ kind: 'table' as const, name: m[2].toLowerCase(), schema: m[1]?.toLowerCase(), op: 'defines' as const, line: lineOf(m.index) }));
}

export function detectEnvFile(src: string): Finding[] {
  const out: Finding[] = [];
  src.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) out.push({ kind: 'env-var', name: m[1], via: 'env-file', line: i + 1 });
  });
  return out;
}

export function detectOpenApi(path: string, src: string): Finding[] {
  let doc: { paths?: Record<string, Record<string, unknown>>; openapi?: string; swagger?: string };
  try { doc = path.endsWith('.json') ? JSON.parse(src) : parseYaml(src); } catch { return []; }
  if (!doc?.paths || !(doc.openapi || doc.swagger)) return [];
  const lineOf = lineIndex(src);
  const out: Finding[] = [];
  for (const [p, ops] of Object.entries(doc.paths)) {
    for (const verb of Object.keys(ops ?? {})) {
      if (!/^(get|post|put|patch|delete|head|options)$/.test(verb)) continue;
      const at = src.indexOf(p);
      out.push({ kind: 'endpoint', method: verb.toUpperCase(), path: p, line: at >= 0 ? lineOf(at) : 1, source: 'openapi' });
    }
  }
  return out;
}

export function detectPrisma(src: string): Finding[] {
  const lineOf = lineIndex(src);
  return [...src.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)].map((m) => ({
    kind: 'table' as const, name: m[2].match(/@@map\(\s*"([^"]+)"/)?.[1] ?? m[1].toLowerCase(), op: 'maps' as const, line: lineOf(m.index), symbol: m[1],
  }));
}

/** Flutter (`pubspec.yaml` with a `flutter:` section): one app for iOS and Android. */
export function detectPubspec(src: string): Finding[] {
  if (!/^flutter:/m.test(src)) return [];
  return [{ kind: 'service-root', tech: 'mobile', name: src.match(/^name:\s*(\S+)/m)?.[1], line: 1, stack: 'flutter', platform: 'cross' }];
}

/** A native Android app: a Gradle module that applies the application plugin, named by its folder (`app` is the module's usual name, so its parent's). */
export function detectGradle(path: string, src: string): Finding[] {
  if (!/com\.android\.application|id\(["']android-application["']\)/.test(src)) return [];
  const dir = path.split('/').slice(0, -1);
  const base = dir.at(-1) === 'app' ? dir.at(-2) : dir.at(-1);
  return [{ kind: 'service-root', tech: 'mobile', name: !base ? 'app-android' : /android/i.test(base) ? base : `${base}-android`, line: 1, stack: 'android', platform: 'android' }];
}

/** A native iOS app: its Xcode project (the service is the folder that holds it; Pods are not apps). */
export function detectXcode(path: string): Finding[] {
  const name = path.match(/([^/]+)\.xcodeproj\/project\.pbxproj$/)?.[1];
  return name && name !== 'Pods' ? [{ kind: 'service-root', tech: 'mobile', name, line: 1, stack: 'ios', platform: 'ios' }] : [];
}
