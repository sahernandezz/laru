/** Build, packaging and infrastructure files: pom.xml, package.json, Dockerfile, compose, nginx, SQL, env examples, OpenAPI, Prisma. */
import { parse as parseYaml } from 'yaml';
import type { Finding, Param, Tech } from './types.ts';
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
  // A version written as a property (`${jjwt.version}`) is the property's; none at all is fixed by an imported BOM or the
  // parent (`spring-boot-starter-parent 3.4.1`), said by name and version.
  const props: Record<string, string> = Object.fromEntries([...(block(own, 'properties')[0] ?? '').matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)].map((m) => [m[1], m[2]]));
  const resolve = (v?: string) => v?.replace(/\$\{([\w.-]+)\}/g, (all, k: string) => props[k] ?? all);
  const parent = src.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  const boms = block(src.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/)?.[1] ?? '', 'dependency').filter((d) => tag(d, 'scope') === 'import');
  const managedBy = [...boms.map((d) => `${resolve(tag(d, 'artifactId'))} ${resolve(tag(d, 'version')) ?? ''}`.trim()), ...(parent ? [`${tag(parent, 'artifactId')} ${resolve(tag(parent, 'version')) ?? ''}`.trim()] : [])][0];
  for (const deps of block(own.replace(/<build>[\s\S]*<\/build>/, ''), 'dependencies')) {
    for (const d of block(deps, 'dependency')) {
      const g = tag(d, 'groupId'), a = tag(d, 'artifactId'), v = tag(d, 'version'), version = resolve(v);
      const property = v && version !== v ? v.match(/^\$\{([\w.-]+)\}$/)?.[1] : undefined;
      if (g && a) out.push({ kind: 'dependency', ecosystem: 'maven', name: `${g}:${a}`, version, scope: tag(d, 'scope'), ...(property ? { property } : {}), ...(!v && managedBy ? { managedBy } : {}) });
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

/**
 * The image a Dockerfile builds from: its last FROM, whose flags (`--platform`) are not the image, and a stage named
 * before it is that stage's image. Nothing for `scratch` or an image only a build argument says.
 */
export function baseImage(src: string): string | undefined {
  const stages = new Map<string, string>();
  let last: string | undefined;
  for (const m of src.matchAll(/^\s*FROM\s+(.+?)\s*$/gim)) {
    const words = m[1].split(/\s+/).filter((w) => !w.startsWith('--'));
    const image = stages.get(words[0]?.toLowerCase()) ?? words[0];
    const as = words.findIndex((w) => w.toLowerCase() === 'as');
    if (as > 0 && words[as + 1]) stages.set(words[as + 1].toLowerCase(), image);
    last = image;
  }
  return last && last !== 'scratch' && !last.includes('$') ? last : undefined;
}

export function detectDockerfile(src: string): Finding[] {
  const base = baseImage(src);
  const out: Finding[] = [{ kind: 'service-root', tech: 'docker', line: 1, ...(base ? { base } : {}) }];
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

interface ApiSchema { $ref?: string; type?: string; items?: ApiSchema }
interface ApiParam { name?: string; in?: string; required?: boolean; type?: string; schema?: ApiSchema }
interface ApiOp { summary?: string; description?: string; parameters?: ApiParam[]; requestBody?: { required?: boolean; content?: Record<string, { schema?: ApiSchema }> }; responses?: Record<string, { content?: Record<string, { schema?: ApiSchema }>; schema?: ApiSchema }> }
/** `#/components/schemas/FileInfo` → FileInfo; an array of them → FileInfo[] */
const schemaName = (s?: ApiSchema): string | undefined => s?.$ref?.split('/').pop() ?? (s?.type === 'array' && schemaName(s.items) ? `${schemaName(s.items)}[]` : s?.type);

export function detectOpenApi(path: string, src: string): Finding[] {
  let doc: { paths?: Record<string, Record<string, unknown>>; openapi?: string; swagger?: string };
  try { doc = path.endsWith('.json') ? JSON.parse(src) : parseYaml(src); } catch { return []; }
  if (!doc?.paths || !(doc.openapi || doc.swagger)) return [];
  const lineOf = lineIndex(src);
  const out: Finding[] = [];
  for (const [p, ops] of Object.entries(doc.paths)) {
    const shared = ((ops as { parameters?: ApiParam[] })?.parameters ?? []);
    for (const verb of Object.keys(ops ?? {})) {
      if (!/^(get|post|put|patch|delete|head|options)$/.test(verb)) continue;
      const at = src.indexOf(p);
      // what the file says of it: its summary, parameters, body and answers
      const op = ((ops as Record<string, ApiOp>)[verb] ?? {}) as ApiOp;
      const params: Param[] = [...shared, ...(op.parameters ?? [])].filter((x) => x?.name && x.in).map((x) => ({
        in: x.in === 'formData' ? 'form' : x.in === 'body' ? 'body' : x.in as Param['in'], name: x.name!, ...(schemaName(x.schema) ?? x.type ? { type: schemaName(x.schema) ?? x.type } : {}), ...(x.required !== undefined ? { required: Boolean(x.required) } : {}),
      }));
      const [ct, body] = Object.entries(op.requestBody?.content ?? {})[0] ?? [];
      if (ct) params.push({ in: /form/.test(ct) ? 'form' : 'body', name: schemaName(body?.schema) ?? ct, type: schemaName(body?.schema) ?? ct, ...(op.requestBody?.required !== undefined ? { required: Boolean(op.requestBody.required) } : {}) });
      const statuses = Object.keys(op.responses ?? {}).filter((x) => /^\d{3}$/.test(x)).map(Number).sort((a, b) => a - b);
      const ok = Object.entries(op.responses ?? {}).find(([x]) => /^2\d\d$/.test(x))?.[1];
      const returns = schemaName(ok?.schema ?? Object.values(ok?.content ?? {})[0]?.schema);
      const summary = (op.summary ?? op.description)?.split('\n')[0].trim();
      out.push({ kind: 'endpoint', method: verb.toUpperCase(), path: p, line: at >= 0 ? lineOf(at) : 1, source: 'openapi', ...(params.length ? { params } : {}), ...(returns ? { returns } : {}), ...(statuses.length ? { statuses } : {}), ...(summary ? { summary } : {}) });
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
