/**
 * Java: JAX-RS / Quarkus and Spring, read with regular expressions over comment-free source.
 * A file is walked token by token — annotation, type declaration, `name(` — so method annotations
 * are settled at the method they decorate. One top-level type per file, as Java mandates.
 */
import type { Finding, Param } from './types.ts';
import { annotationValue, enclosed, envName, EXCEPTION_STATUS, lineIndex, STATUS_NAME, strings, stripComments, topLevel } from './text.ts';

const TOKEN = /@(\w+)(\s*\((?:[^()"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))*\))?|\b(class|interface|record|enum)\s+(\w+)|\b([A-Za-z_]\w*)\s*\(/g;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this', 'synchronized', 'throw']);
const JAXRS_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const SPRING_VERBS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const METHOD_LEVEL = new Set([...JAXRS_VERBS, ...Object.keys(SPRING_VERBS), 'Path', 'RequestMapping', 'Incoming', 'Outgoing', 'KafkaListener', 'ResponseStatus']);
const CLASS_LEVEL = new Set(['Path', 'RequestMapping', 'RestController', 'Controller', 'RegisterRestClient', 'FeignClient', 'Entity', 'Table']);
const INTEGRATION = /@(SpringBootTest|QuarkusTest|QuarkusIntegrationTest|DataJpaTest|WebMvcTest|Testcontainers|QuarkusTestResource)\b/;

interface Ann { name: string; args?: string; offset: number }

/** Where a parameter goes, by its annotation: Spring, JAX-RS and Quarkus REST's own. */
const PARAM_IN: Record<string, Param['in']> = {
  PathVariable: 'path', PathParam: 'path', RestPath: 'path', RequestParam: 'query', QueryParam: 'query', RestQuery: 'query', RequestHeader: 'header',
  HeaderParam: 'header', RestHeader: 'header', CookieValue: 'cookie', CookieParam: 'cookie', RestCookie: 'cookie', RequestBody: 'body',
  RequestPart: 'form', FormParam: 'form', RestForm: 'form', MultipartForm: 'form',
};
const ANNOTATION = /@(\w+)(\s*\((?:[^()]|\([^()]*\))*\))?/g;
/** what the framework hands a handler, never the caller: no part of the request's contract */
const CONTEXT = /^(HttpServletRequest|HttpServletResponse|ServerHttpRequest|ServerHttpResponse|ServerWebExchange|HttpHeaders|Principal|Authentication|Model|ModelMap|BindingResult|Errors|Locale|UriInfo|Request|SecurityContext|SecurityIdentity|JsonWebToken|SseEventSink|Sse|AsyncResponse|RoutingContext|HttpSession|WebRequest|RedirectAttributes)$/;

/** A handler's parameters: where each goes, its name for the caller and its type. Spring's unannotated ones bind by rules too loose to say. */
function javaParams(list: string, jaxrs: boolean): Param[] {
  return topLevel(list).flatMap((p): Param[] => {
    const anns = [...p.matchAll(ANNOTATION)];
    const m = p.replace(ANNOTATION, ' ').replace(/\bfinal\b/g, ' ').trim().match(/^([\s\S]+?)\s+(\w+)$/);
    if (!m || anns.some((a) => a[1] === 'Context' || a[1] === 'BeanParam' || a[1] === 'AuthenticationPrincipal')) return [];
    const type = m[1].replace(/\s+/g, ' '), a = anns.find((x) => PARAM_IN[x[1]]);
    if (CONTEXT.test(type.replace(/<.*$/, ''))) return [];
    if (!a && !jaxrs) return [];
    const where = a ? (PARAM_IN[a[1]] === 'query' && /MultipartFile|FileUpload|InputStream/.test(type) ? 'form' : PARAM_IN[a[1]]) : 'body';
    const args = a?.[2], spring = a && /^(RequestParam|RequestHeader|RequestPart|CookieValue|RequestBody)$/.test(a[1]);
    const required = where === 'path' ? true : /^Optional</.test(type) ? false
      : spring ? !/\brequired\s*=\s*false\b/.test(args ?? '') && !/\bdefaultValue\s*=/.test(args ?? '')
      : anns.some((x) => /^(NotNull|NotBlank|NotEmpty)$/.test(x[1])) || undefined;
    return [{ in: where, name: (a && annotationValue(args, 'value', 'name')) || m[2], type, ...(required !== undefined ? { required } : {}) }];
  });
}

const BUILDER: Record<string, number> = { ok: 200, created: 201, accepted: 202, noContent: 204, notModified: 304, badRequest: 400, notFound: 404, unprocessableEntity: 422, internalServerError: 500, serverError: 500 };
/** The statuses a handler answers by itself: its `@ResponseStatus`, the builders and status names in its body, the exceptions it throws; a 2xx when none says one. */
function javaStatuses(body: string, anns: string, returns?: string, jaxrs?: boolean): number[] {
  const out = new Set<number>();
  for (const m of (anns + body).matchAll(/\b(?:HttpStatus|Status)\s*\.\s*([A-Z_]+)\b/g)) if (STATUS_NAME[m[1]]) out.add(STATUS_NAME[m[1]]);
  for (const m of body.matchAll(/\.status\(\s*(\d{3})\s*\)/g)) out.add(Number(m[1]));
  for (const m of body.matchAll(/\b(?:ResponseEntity|Response|RestResponse)\s*\.\s*(\w+)\s*\(/g)) if (BUILDER[m[1]]) out.add(BUILDER[m[1]]);
  for (const m of body.matchAll(/\bnew\s+(\w+?)Exception\s*\(/g)) if (EXCEPTION_STATUS[m[1]]) out.add(EXCEPTION_STATUS[m[1]]);
  if (![...out].some((s) => s < 300)) out.add(jaxrs && returns === 'void' ? 204 : 200);
  return [...out].sort((a, b) => a - b);
}

/** `ResponseEntity<List<X>>` → `List<X>`: the body it returns; nothing when the type says nothing of it. */
function bodyType(t: string): string | undefined {
  let x = t.trim();
  for (let m; (m = x.match(/^(?:ResponseEntity|RestResponse|Uni|Mono|CompletionStage|CompletableFuture|Optional|Callable|DeferredResult)\s*<([\s\S]+)>$/));) x = m[1].trim();
  return !x || /^(Response|ResponseEntity|Object|\?)$/.test(x) ? undefined : /^(void|Void)$/.test(x) ? 'void' : x.replace(/\s+/g, ' ');
}

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
  /** where the last annotation ends: a method's return type sits between it and the method's name */
  let annEnd = 0;

  const flushMethod = (symbol: string, nameAt: number, open: number) => {
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
      // what it takes, returns and answers: its parameter list, the type before its name, the body after it
      const sig = enclosed(src, open), after = src.slice(sig.end + 1), brace = after.search(/[{;]/);
      const body = after[brace] === '{' ? enclosed(src, sig.end + 1 + brace).inner : '';
      const returns = bodyType(src.slice(annEnd, nameAt).replace(/\b(public|protected|private|static|final|synchronized|abstract|default)\b/g, '').replace(/^\s*<[^>]*>/, ''));
      const params = javaParams(sig.inner, Boolean(type?.jaxrs));
      const shape = { ...(params.length ? { params } : {}), ...(returns ? { returns } : {}), statuses: javaStatuses(body, pending.map((a) => a.args ?? '').join(' '), returns, type?.jaxrs) };
      for (const method of verbs) {
        if (type?.restClient !== undefined) out.push({ kind: 'outbound', method, path: p, configKey: type.restClient || undefined, line: at(anchor), symbol: sym });
        else if (type?.feign) out.push({ kind: 'outbound', method, path: p, ...placeholderTarget(type.feign.url), line: at(anchor), symbol: sym });
        else if (type?.jaxrs || type?.controller) out.push({ kind: 'endpoint', method, path: p, line: at(anchor), symbol: sym, source: 'code', ...shape });
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
      annEnd = m.index + m[0].length;
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
    if (call && pending.some((a) => METHOD_LEVEL.has(a.name)) && !NOT_METHODS.has(call)) flushMethod(call, m.index, m.index + m[0].length - 1);
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
