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
    // What a case says it checks, in its own words: its @DisplayName, before @Test or after it, among the annotations
    // between the previous member and its name.
    const said = (from: number, to: number) => src.slice(from, to).match(/@DisplayName\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/)?.[1]?.replace(/\\(.)/g, '$1').trim() || undefined;
    const cases = [...src.matchAll(/@(?:Test|ParameterizedTest|RepeatedTest)\b[^{;]*?\bvoid\s+(\w+)\s*\(/g)].map((m) => {
      const title = said(Math.max(src.lastIndexOf('}', m.index), src.lastIndexOf(';', m.index)) + 1, m.index + m[0].length);
      return { name: m[1], line: lineOf(m.index), ...(title ? { title } : {}) };
    });
    // the class says what it tests: its own @DisplayName, else the first sentence of its Javadoc
    const at = src.search(/\bclass\s+\w+/), rawAt = raw.search(/\bclass\s+\w+/);
    const doc = rawAt < 0 ? undefined : raw.slice(raw.lastIndexOf(';', rawAt) + 1, rawAt).match(/\/\*\*([\s\S]*?)\*\//)?.[1];
    const sentence = doc?.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter((l) => l && !l.startsWith('@')).join(' ').replace(/<[^>]+>|\{@\w+\s+([^}]*)\}/g, '$1').match(/^(.*?[.!?])(\s|$)/)?.[1];
    const title = (at < 0 ? undefined : said(src.lastIndexOf(';', at) + 1, at)) ?? sentence;
    if (count) out.push({ kind: 'tests', count, level: INTEGRATION.test(src) ? 'integration' : 'unit', cases, ...(title ? { title } : {}) });
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
    // what a listener takes is its message: the type of its first parameter that is no header nor acknowledgement
    // (`FileEvent event`, `ConsumerRecord<String, FileEvent> record`, `Message<FileEvent> m`); what an @Outgoing gives, its return type
    const taken = () => listenerPayload(enclosed(src, open).inner);
    for (const a of pending) {
      if (a.name === 'Incoming' || a.name === 'Outgoing') {
        const ch = annotationValue(a.args, 'value');
        const payload = a.name === 'Incoming' ? taken().payload : bodyType(src.slice(annEnd, nameAt).replace(/\b(public|protected|private|static|final|synchronized|abstract|default)\b/g, '').replace(/^\s*<[^>]*>/, ''))?.replace(/^(?:Multi|Uni|Flowable|Publisher|Message|CompletionStage)<(.+)>$/, '$1');
        if (ch) out.push({ kind: 'channel', name: ch, dir: a.name === 'Incoming' ? 'in' : 'out', line: at(a), symbol: sym, ...(payload && payload !== 'void' ? { payload } : {}) });
      }
      if (a.name === 'KafkaListener') {
        const topicsArg = (a.args ?? '').match(/\btopics\s*=\s*(\{[^}]*\}|"[^"]*"|[\w.]+)/)?.[1] ?? '';
        const { payload, key } = taken(), group = annotationValue(a.args, 'groupId', 'id');
        const said = { ...(payload ? { payload } : {}), ...(key ? { key } : {}), ...(group ? { group } : {}) };
        for (const t of strings(topicsArg)) out.push({ kind: 'topic', name: t, op: 'consumes', line: at(a), symbol: sym, ...said });
        for (const c of topicsArg.matchAll(/(?:\w+\.)?\b([A-Z][A-Z0-9_]+)\b/g)) out.push({ kind: 'topic', name: `const:${c[1]}`, op: 'consumes', line: at(a), symbol: sym, ...said });
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
        // an emitter of a channel (`@Channel("uploads") Emitter<FileEvent> e`) sends that type on it
        const ch = annotationValue(args, 'value');
        const payload = src.slice(m.index + m[0].length).match(/^\s*(?:@\w+\s*)*(?:MutinyEmitter|Emitter)\s*<\s*([\w.]+(?:<[^<>]*>)?)\s*>/)?.[1];
        if (ch) out.push({ kind: 'channel', name: ch, dir: 'out', line: lineOf(m.index), ...(payload ? { payload } : {}) });
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

  // Kafka producers: `template.send("topic", …)`, a constant, or a local variable holding literals. What it sends is the
  // template's value type (`KafkaTemplate<String, FileEvent>`), or, when that says nothing (`Object`), the type of the
  // value the send is given; its key, the template's key type when the send passes one.
  const templates = [...src.matchAll(/KafkaTemplate\s*<\s*([^,<>]+(?:<[^<>]*>)?)\s*,\s*([^<>]+(?:<[^<>]*>)?)\s*>\s+(\w+)/g)].map((x) => ({ key: x[1].trim(), value: x[2].trim(), name: x[3] }));
  for (const m of src.matchAll(/KafkaTemplate\s*<[^>]*>\s+(\w+)|KafkaTemplate\s+(\w+)/g)) if (!templates.some((t) => t.name === (m[1] ?? m[2]))) templates.push({ key: '', value: '', name: m[1] ?? m[2] });
  for (const t of templates) {
    for (const s of src.matchAll(new RegExp(`\\b${t.name}\\.send\\(`, 'g'))) {
      const args = topLevel(enclosed(src, s.index + s[0].length - 1).inner).map((x) => x.trim());
      const arg = args[0] ?? '', line = lineOf(s.index);
      const value = args.length >= 3 ? args[2] : args[1];
      const payload = (t.value && !/^(Object|\?|String|byte\[\])$/.test(t.value) ? t.value : undefined) ?? (value ? typeOf(src, value, s.index) : undefined);
      const said = { ...(payload ? { payload } : {}), ...(args.length >= 3 && t.key ? { key: t.key } : {}) };
      if (/^["']/.test(arg)) out.push({ kind: 'topic', name: strings(arg)[0], op: 'publishes', line, ...said });
      else if (/(?:^|\.)[A-Z][A-Z0-9_]+$/.test(arg)) out.push({ kind: 'topic', name: `const:${arg.split('.').pop()}`, op: 'publishes', line, ...said });
      else {
        const local = src.match(new RegExp(`\\bString\\s+${arg}\\s*=([^;]+);`));
        for (const lit of strings(local?.[1] ?? '')) out.push({ kind: 'topic', name: lit, op: 'publishes', line, ...said });
      }
    }
  }

  // The shape of a data class: a record's components, or the fields of a class that holds data (Lombok's @Data, @Value,
  // @Getter or @Builder, or a name that says so: …Event, …Request, …Response, …Dto, …Message, …Command, …Payload).
  for (const m of src.matchAll(/\brecord\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const fields = topLevel(enclosed(src, m.index + m[0].length - 1).inner).flatMap((p) => { const x = p.replace(ANNOTATION, ' ').trim().match(/^([\s\S]+?)\s+(\w+)$/); return x ? [{ name: x[2], type: x[1].replace(/\s+/g, ' ') }] : []; });
    if (fields.length) out.push({ kind: 'shape', name: m[1], fields: fields.slice(0, 40), line: lineOf(m.index) });
  }
  for (const m of src.matchAll(/((?:@\w+(?:\([^)]*\))?\s*)*)(?:public\s+|protected\s+|final\s+|abstract\s+|static\s+)*class\s+(\w+)[^{]*\{/g)) {
    if (!/@(?:Data|Value|Getter|Builder)\b/.test(m[1]) && !/(?:Event|Request|Response|Dto|DTO|Message|Command|Payload)$/.test(m[2])) continue;
    const body = enclosed(src, m.index + m[0].length - 1).inner;
    const fields = [...body.matchAll(/(?<=^|[;{}])\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:private|protected|public)\s+(?!static\b)(?:final\s+)?([\w.]+(?:<[^;=(){}]*>)?(?:\[\])?)\s+(\w+)\s*(?:=[^;]*)?;/g)].map((f) => ({ name: f[2], type: f[1].replace(/\s+/g, ' ') }));
    if (fields.length) out.push({ kind: 'shape', name: m[2], fields: fields.slice(0, 40), line: lineOf(m.index + m[1].length) });
  }
  return out;
}

/** The message a listener takes: the type of its first parameter that is no header nor acknowledgement, unwrapped from a record or a message, with that record's key. */
function listenerPayload(list: string): { payload?: string; key?: string } {
  for (const p of topLevel(list)) {
    if (/@Header\b/.test(p)) continue;
    const t = p.replace(ANNOTATION, ' ').replace(/\bfinal\b/g, ' ').trim().match(/^([\s\S]+?)\s+\w+$/)?.[1].replace(/\s+/g, ' ');
    if (!t || /^(?:Acknowledgment|Consumer|MessageHeaders|Headers)\b/.test(t)) continue;
    const rec = t.match(/^(?:ConsumerRecord|Message|Record)<\s*(?:([\w.]+)\s*,\s*)?([\w.]+(?:<[^<>]*>)?)\s*>$/);
    return rec ? { payload: rec[2], ...(rec[1] ? { key: rec[1] } : {}) } : { payload: t };
  }
  return {};
}

/** The type of what a call is given: `new FileEvent(…)`, or a variable declared before it (`FileEvent event = …`, a parameter `FileEvent event`). */
function typeOf(src: string, expr: string, before: number): string | undefined {
  const made = expr.match(/^new\s+([\w.]+(?:<[^<>]*>)?)\s*\(/)?.[1];
  if (made) return made.replace(/<>$/, '');
  if (!/^\w+$/.test(expr)) return undefined;
  const decl = [...src.slice(0, before).matchAll(new RegExp(`([\\w.]+(?:<[^<>;=()]*>)?)\\s+${expr}\\s*[=;,)]`, 'g'))].at(-1)?.[1];
  return decl && !/^(?:return|var|new|else|final)$/.test(decl) ? decl : undefined;
}
