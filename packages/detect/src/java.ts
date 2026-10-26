/**
 * Java: JAX-RS / Quarkus and Spring, read with regular expressions over comment-free source.
 * A file is walked token by token — annotation, type declaration, `name(` — so method annotations
 * are settled at the method they decorate. One top-level type per file, as Java mandates.
 */
import type { Finding } from './types.ts';
import { annotationValue, envName, lineIndex, strings, stripComments } from './text.ts';

const TOKEN = /@(\w+)(\s*\((?:[^()"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))*\))?|\b(class|interface|record|enum)\s+(\w+)|\b([A-Za-z_]\w*)\s*\(/g;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this', 'synchronized', 'throw']);
const JAXRS_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const SPRING_VERBS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const METHOD_LEVEL = new Set([...JAXRS_VERBS, ...Object.keys(SPRING_VERBS), 'Path', 'RequestMapping', 'Incoming', 'Outgoing', 'KafkaListener']);
const CLASS_LEVEL = new Set(['Path', 'RequestMapping', 'RestController', 'Controller', 'RegisterRestClient', 'FeignClient', 'Entity', 'Table']);
const INTEGRATION = /@(SpringBootTest|QuarkusTest|QuarkusIntegrationTest|DataJpaTest|WebMvcTest|Testcontainers|QuarkusTestResource)\b/;

interface Ann { name: string; args?: string; offset: number }
interface TypeCtx { name: string; prefix?: string; jaxrs: boolean; controller: boolean; restClient?: string; feign?: { name?: string; url?: string } }

const joinPath = (...parts: (string | undefined)[]): string =>
  '/' + parts.filter(Boolean).map((p) => p!.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** `${STRIPE_URL}` names an environment variable; `${stripe.url}` names a property. */
function placeholderTarget(v: string | undefined): { envVar?: string; configKey?: string; url?: string } {
  if (!v) return {};
  const m = v.match(/^\$\{([^}:]+)(?::[^}]*)?\}/);
  if (!m) return { url: v };
  return /^[A-Z][A-Z0-9_]*$/.test(m[1]) ? { envVar: m[1] } : { configKey: m[1] };
}

export function detectJava(path: string, raw: string): Finding[] {
  const src = stripComments(raw);
  const lineOf = lineIndex(src);
  const out: Finding[] = [];

  if (/\/src\/test\//.test('/' + path)) {
    const count = (src.match(/@(Test|ParameterizedTest|RepeatedTest)\b/g) ?? []).length;
    const cases = [...src.matchAll(/@(?:Test|ParameterizedTest|RepeatedTest)\b[^{;]*?\bvoid\s+(\w+)\s*\(/g)].map((m) => ({ name: m[1], line: lineOf(m.index) }));
    if (count) out.push({ kind: 'tests', count, level: INTEGRATION.test(src) ? 'integration' : 'unit', cases });
    return out;
  }

  for (const m of src.matchAll(/\bstatic\s+final\s+String\s+(\w+)\s*=\s*"([^"]*)"/g)) out.push({ kind: 'constant', name: m[1], value: m[2], line: lineOf(m.index) });
  for (const m of src.matchAll(/System\.getenv\(\s*"([^"]+)"\s*\)/g)) out.push({ kind: 'env-var', name: m[1], via: 'getenv', line: lineOf(m.index) });

  let type: TypeCtx | null = null;
  let pending: Ann[] = [];

  const flushMethod = (symbol: string) => {
    const at = (a: Ann) => lineOf(a.offset);
    const sym = type ? `${type.name}.${symbol}` : symbol;
    const pathAnn = pending.find((a) => a.name === 'Path');
    let verbs: string[] = pending.filter((a) => JAXRS_VERBS.has(a.name)).map((a) => a.name);
    let local = annotationValue(pathAnn?.args, 'value');
    const mapping = pending.find((a) => a.name in SPRING_VERBS || a.name === 'RequestMapping');
    if (mapping) {
      local = annotationValue(mapping.args, 'value', 'path') ?? '';
      if (mapping.name === 'RequestMapping') {
        const ms = [...(mapping.args ?? '').matchAll(/RequestMethod\.(\w+)/g)].map((x) => x[1]);
        verbs = ms.length ? ms : ['ANY'];
      } else verbs = [SPRING_VERBS[mapping.name]];
    }
    const anchor = mapping ?? pending.find((a) => JAXRS_VERBS.has(a.name)) ?? pathAnn;
    if (verbs.length && anchor) {
      const p = joinPath(type?.prefix, local);
      for (const method of verbs) {
        if (type?.restClient !== undefined) out.push({ kind: 'outbound', method, path: p, configKey: type.restClient || undefined, line: at(anchor), symbol: sym });
        else if (type?.feign) out.push({ kind: 'outbound', method, path: p, ...placeholderTarget(type.feign.url), line: at(anchor), symbol: sym });
        else if (type?.jaxrs || type?.controller) out.push({ kind: 'endpoint', method, path: p, line: at(anchor), symbol: sym, source: 'code' });
      }
    }
    for (const a of pending) {
      if (a.name === 'Incoming' || a.name === 'Outgoing') {
        const ch = annotationValue(a.args, 'value');
        if (ch) out.push({ kind: 'channel', name: ch, dir: a.name === 'Incoming' ? 'in' : 'out', line: at(a), symbol: sym });
      }
      if (a.name === 'KafkaListener') {
        const topicsArg = (a.args ?? '').match(/\btopics\s*=\s*(\{[^}]*\}|"[^"]*"|[\w.]+)/)?.[1] ?? '';
        for (const t of strings(topicsArg)) out.push({ kind: 'topic', name: t, op: 'consumes', line: at(a), symbol: sym });
        for (const c of topicsArg.matchAll(/(?:\w+\.)?\b([A-Z][A-Z0-9_]+)\b/g)) out.push({ kind: 'topic', name: `const:${c[1]}`, op: 'consumes', line: at(a), symbol: sym });
      }
    }
    pending = [];
  };

  const flushType = (name: string) => {
    const has = (n: string) => pending.find((a) => a.name === n);
    const path = has('Path'), rm = has('RequestMapping'), rc = has('RegisterRestClient'), fc = has('FeignClient');
    type = {
      name,
      prefix: annotationValue(path?.args, 'value') ?? annotationValue(rm?.args, 'value', 'path'),
      jaxrs: Boolean(path) && !rc,
      controller: Boolean(has('RestController') || has('Controller')),
      restClient: rc ? (annotationValue(rc.args, 'configKey') ?? '') : undefined,
      feign: fc ? { name: annotationValue(fc.args, 'name', 'value'), url: annotationValue(fc.args, 'url') } : undefined,
    };
    if (has('Entity')) {
      const t = has('Table');
      const tableName = annotationValue(t?.args, 'name') ?? name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      out.push({ kind: 'table', name: tableName, schema: annotationValue(t?.args, 'schema'), op: 'maps', line: lineOf(has('Entity')!.offset), symbol: name });
    }
    pending = [];
  };

  for (const m of src.matchAll(TOKEN)) {
    const [, ann, args, typeKw, typeName, call] = m;
    if (ann) {
      const a: Ann = { name: ann, args, offset: m.index };
      // Field and parameter annotations need no method: they are settled where they stand.
      if (ann === 'ConfigProperty') {
        const key = annotationValue(args, 'name');
        if (key) out.push({ kind: 'env-var', name: envName(key), via: 'config-mapping', configKey: key, hasDefault: annotationValue(args, 'defaultValue') !== undefined, line: lineOf(m.index) });
      } else if (ann === 'Value') {
        const ph = annotationValue(args, 'value')?.match(/^\$\{([^}:]+)(?::([^}]*))?\}$/);
        if (ph) {
          const upper = /^[A-Z][A-Z0-9_]*$/.test(ph[1]);
          out.push({ kind: 'env-var', name: upper ? ph[1] : envName(ph[1]), via: upper ? 'placeholder' : 'config-mapping', configKey: upper ? undefined : ph[1], hasDefault: ph[2] !== undefined, line: lineOf(m.index) });
        }
      } else if (ann === 'Channel') {
        const ch = annotationValue(args, 'value');
        if (ch) out.push({ kind: 'channel', name: ch, dir: 'out', line: lineOf(m.index) });
      } else if (METHOD_LEVEL.has(ann) || CLASS_LEVEL.has(ann)) pending.push(a);
      continue;
    }
    if (typeKw) { if (!type) flushType(typeName); else pending = []; continue; }
    if (call && pending.some((a) => METHOD_LEVEL.has(a.name)) && !NOT_METHODS.has(call)) flushMethod(call);
  }

  // A topic the service creates when it starts: `TopicBuilder.name(FILE_UPLOADED).partitions(3)`. Its partitions are what a consumer
  // that subscribes earlier will wait for.
  for (const t of src.matchAll(/TopicBuilder\s*\.name\(\s*([^)]+?)\s*\)\s*\.partitions\(\s*(\d+)\s*\)/g)) {
    const arg = t[1].trim(), line = lineOf(t.index);
    if (/^["']/.test(arg)) out.push({ kind: 'topic', name: strings(arg)[0], op: 'defines', partitions: Number(t[2]), line });
    else if (/(?:^|\.)[A-Z][A-Z0-9_]+$/.test(arg)) out.push({ kind: 'topic', name: `const:${arg.split('.').pop()}`, op: 'defines', partitions: Number(t[2]), line });
  }

  // Kafka producers: `template.send("topic", …)`, a constant, or a local variable holding literals.
  const templates = [...src.matchAll(/KafkaTemplate\s*<[^>]*>\s+(\w+)/g)].map((x) => x[1]);
  for (const t of templates) {
    for (const s of src.matchAll(new RegExp(`\\b${t}\\.send\\(\\s*([^,)]+)`, 'g'))) {
      const arg = s[1].trim(), line = lineOf(s.index);
      if (/^["']/.test(arg)) out.push({ kind: 'topic', name: strings(arg)[0], op: 'publishes', line });
      else if (/(?:^|\.)[A-Z][A-Z0-9_]+$/.test(arg)) out.push({ kind: 'topic', name: `const:${arg.split('.').pop()}`, op: 'publishes', line });
      else {
        const local = src.match(new RegExp(`\\bString\\s+${arg}\\s*=([^;]+);`));
        for (const lit of strings(local?.[1] ?? '')) out.push({ kind: 'topic', name: lit, op: 'publishes', line });
      }
    }
  }
  return out;
}
