/**
 * The interface speaks Spanish; the core speaks English and sends a stable key with each reason and error.
 * A key missing here falls back to the core's English text rather than to nothing.
 */
import type { DotState } from '../components/ui.tsx';

type P = Record<string, string | number> | undefined;

const PIECE: Record<string, string> = {
  application: 'Aplicativo', module: 'Módulo', process: 'Proceso', repository: 'Repositorio', service: 'Servicio', datastore: 'Almacén', external: 'Sistema externo',
  agreement: 'Forma de trabajo', plan: 'Plan', decision: 'Decisión', contract: 'Contrato', 'data-model': 'Modelo de datos', convention: 'Convención', guide: 'Guía', 'test-plan': 'Plan de pruebas',
  flow: 'Flujo', scenario: 'Escenario', artifact: 'Artefacto', runbook: 'Runbook', architecture: 'Arquitectura', versioning: 'Versionamiento', stack: 'Stack', infrastructure: 'Infraestructura', secrets: 'Secretos', glossary: 'Glosario', term: 'Término', note: 'Nota',
};
const PIECES: Record<string, string> = {
  agreement: 'Formas de trabajo', plan: 'Planes', decision: 'Decisiones', contract: 'Contratos', 'data-model': 'Modelos de datos', convention: 'Convenciones', guide: 'Guías', 'test-plan': 'Planes de pruebas',
  flow: 'Flujos', scenario: 'Escenarios', artifact: 'Artefactos', runbook: 'Runbooks', architecture: 'Arquitecturas', versioning: 'Versionamientos', stack: 'Stacks', infrastructure: 'Infraestructuras', secrets: 'Secretos', glossary: 'Glosarios', term: 'Términos', note: 'Notas',
};
export const pieceLabel = (t: string) => PIECE[t] ?? t;
export const piecesLabel = (t: string) => PIECES[t] ?? t;
export const KIND: Record<string, string> = {
  product: 'producto', platform: 'plataforma', automation: 'automatización', legacy: 'heredado', area: 'área', feature: 'funcionalidad', story: 'historia',
  process: 'proceso', subprocess: 'subproceso', relational: 'relacional', document: 'documental', cache: 'caché', queue: 'cola', file: 'ficheros', search: 'búsqueda',
  directory: 'directorio', saas: 'SaaS', partner: 'socio', corporate: 'corporativo', infra: 'infraestructura',
};
/** What a front is made with, and where a mobile one runs. */
export const STACK: Record<string, string> = { react: 'React', angular: 'Angular', vue: 'Vue', svelte: 'Svelte', solid: 'Solid', vite: 'Vite', expo: 'Expo', 'react-native': 'React Native', nativescript: 'NativeScript', flutter: 'Flutter', android: 'Android nativo', ios: 'iOS nativo' };
export const PLATFORM: Record<string, string> = { ios: 'iOS', android: 'Android', cross: 'iOS y Android' };
export const STATUS: Record<string, string> = {
  draft: 'Borrador', active: 'Activo', deprecated: 'Retirado', proposed: 'Propuesto', accepted: 'Aceptada', superseded: 'Sustituida', rejected: 'Rechazada', implemented: 'Implementado',
};
export const STAGE: Record<string, string> = { plan: 'Planificar', design: 'Diseñar', build: 'Construir', test: 'Probar', deploy: 'Desplegar', operate: 'Operar' };

const REASON: Record<string, (p: P) => string> = {
  'not-required': () => 'No se exige a esta clase.',
  'no-pieces': (p) => `Falta: ${String(p?.pieces).split(', ').map(pieceLabel).join(', ').toLowerCase()}.`,
  'milestone-overdue': (p) => `«${p?.milestone}» vencía el ${p?.date}.`,
  'milestones-ok': () => 'Ningún hito vencido.',
  'contract-missing-in-code': (p) => `${p?.op} está en el contrato y no en el código.`,
  'endpoint-without-contract': (p) => `${p?.op} está en el código y en ningún contrato.`,
  'table-missing': (p) => `La tabla ${p?.table} está declarada y no aparece en el código.`,
  'design-ok': (p) => (p?.count === 1 ? 'Una pieza de diseño, y coincide con el código.' : `${p?.count} piezas de diseño, y coinciden con el código.`),
  'no-anchors': () => 'Sin código anclado.',
  'anchors-empty': () => 'Las anclas no encuentran ficheros.',
  'convention-fails': (p) => `«${p?.title}»: ${p?.count} incumplimientos.`,
  'build-ok': (p) => `${p?.files ? `${p.files} ficheros anclados` : 'Código en su sitio'}${p?.conventions ? `, ${p.conventions} convenciones aplican` : ''}.`,
  'no-runs': () => 'Los flujos aún no se han ejecutado.',
  'flow-no-spec': (p) => `${p?.flow} no tiene spec.`,
  'flow-not-run': (p) => `${p?.flow} no se ha ejecutado.`,
  'flow-failed': (p) => `${p?.flow} falló en el run ${p?.run}.`,
  'flows-green': (p) => (p?.count === 1 ? 'Su flujo pasó en su último run.' : `${p?.count} flujos pasaron en su último run.`),
  phase: (p) => `Llega en la fase ${p?.phase}.`,
  'no-envs': () => 'Ningún entorno se ha levantado todavía: laru env init y laru up.',
  'not-in-env': (p) => `${p?.name} no está en ningún entorno.`,
  'env-not-ready': (p) => `${p?.envs} no ha llegado a estar listo.`,
  'env-ready': (p) => `Listo en ${p?.env} el ${p?.at} UTC.`,
  'runbooks-missing': (p) => `Sin runbook: ${p?.list}.`,
  'runbooks-ok': (p) => (p?.count === 1 ? 'Tiene su runbook.' : `${p?.count} runbooks.`),
};
export const reasonText = (r: { key: string; params?: P; text: string }) => REASON[r.key]?.(r.params) ?? r.text;

const ISSUE: Record<string, (p: P) => string> = {
  required: () => 'Falta: es obligatoria y baja la nota del documento.',
  'diagram-missing': () => 'Dibújalo: un bloque ```mermaid.',
  'diagram-unknown': () => 'Este diagrama no es de ninguna clase que Laru conozca: flowchart, secuencia, C4, ER, estado…',
  'legacy-status': (p) => `Es un estado del estándar anterior; ahora: ${p?.options}. \`laru docs migrate\` lo cambia.`,
  'duplicate-number': (p) => `${p?.number} ya es de otra decisión.`,
  'bad-number': () => 'DEC- y al menos cuatro cifras: DEC-0001.',
  'too-long': (p) => `Como mucho ${p?.max} caracteres${p?.length ? ` (lleva ${p.length})` : ''}.`,
  'too-many': (p) => `Como mucho ${p?.max} elementos.`,
  'bad-enum': (p) => `Uno de: ${p?.options}.`,
  'bad-date': () => 'Una fecha AAAA-MM-DD.',
  'unknown-ref': (p) => `«${p?.id}» no existe${p?.suggestion ? `; ¿quisiste decir ${p.suggestion}?` : '.'}`,
  'ref-wrong-type': (p) => `Se espera un id que empiece por ${p?.prefixes}.`,
  'wrong-parent': (p) => `No puede ir dentro de una pieza de tipo ${pieceLabel(String(p?.parent)).toLowerCase()}; vive en ${String(p?.allowed).split(', ').map(pieceLabel).join(' o ').toLowerCase()}.`,
  'anchor-required': () => 'Ánclalo al código del que habla: `repo:ruta/**`.',
  'anchor-format': () => 'Formato `<repo>:<ruta o glob>[#Símbolo]`.',
  'anchor-empty': () => 'No encuentra ningún fichero en la rama de referencia.',
  'unknown-repo': (p) => `No hay ningún repo «${p?.repo}» en este workspace.`,
  'id-prefix': (p) => `El id empieza por \`${p?.prefix}:\`.`,
  immutable: () => 'Una decisión aceptada no se edita: escribe otra que la sustituya.',
  'extractable-inventory': () => 'Esto enumera endpoints: se extraen del código, una copia escrita se queda vieja.',
  'broken-link': (p) => `[[${p?.id}]] no existe.`,
};
/** The rules of the diagram standard, in Spanish; one outside this list shows the engine's own text. */
const DIAGRAM_RULE: Record<string, string> = {
  title: 'Ponle título: `title` en la primera línea o en el frontmatter.', size: 'Tiene demasiados elementos para leerse: pártelo.', labels: 'Cada flecha dice qué pasa por ella.',
  semicolon: 'Sin punto y coma fuera de una etiqueta entre comillas: usa una coma.', dialect: 'Escríbelo en el dialecto de su clase.', swimlanes: 'Necesita calles: un `subgraph` por rol y cada paso dentro de uno.',
  direction: 'Di su dirección: `flowchart TD` o `LR`.', decisions: 'Cada salida de una decisión lleva etiqueta: `-->|Sí|`.', end: 'El proceso termina: pon al menos un nodo final.',
  boundary: 'Lo propio va dentro de un `Container_Boundary` o `System_Boundary`.', technology: 'Cada `Container` declara su tecnología.', data: 'Las bases son `ContainerDb` y las colas `ContainerQueue`.',
  icons: 'Los servicios gestionados llevan su icono: `id@{ icon: "logos:…" }`.', 'derived-diagram-authored': 'Esta clase se calcula desde el catálogo: escribirla a mano la deja desfasada.',
};
export const issueText = (i: { key: string; params?: P; message: string }) =>
  ISSUE[i.key]?.(i.params) ?? (i.key.startsWith('diagram-') ? DIAGRAM_RULE[i.key.slice(8)] : undefined) ?? i.message;

// ---------- environments, vault and doctor ----------
export const ENV_STATE: Record<string, string> = { ready: 'Listo', starting: 'Arrancando', failed: 'Con fallos', stopped: 'Parado', absent: 'Sin levantar' };
/** An env's state as a dot, beside its word. */
export const STATE_DOT: Record<string, DotState> = { ready: 'ok', starting: 'run', failed: 'err', stopped: 'idle', absent: 'idle' };
export const HEALTH: Record<string, string> = {
  healthy: 'Sano', running: 'En marcha', starting: 'Arrancando', waiting: 'Esperando', unhealthy: 'No responde', exited: 'Se detuvo',
  oom: 'Sin memoria', done: 'Terminado', host: 'En tu máquina', absent: 'Sin contenedor',
};
export const BUILT: Record<string, string> = { cached: 'En caché', built: 'Construido', image: 'Imagen' };
export const MODE: Record<string, string> = { container: 'Contenedor', host: 'En tu máquina', job: 'Tarea', tap: 'Interceptor' };
export const PHASE: Record<string, string> = {
  snapshot: 'Instantánea del código', import: 'Lectura del compose', values: 'Variables', render: 'Composición', pull: 'Imágenes', build: 'Construcción', ready: 'Arranque y salud',
};
const PHASE_NOTE: Record<string, string> = { 'compose.yml changed': 'compose.yml cambió', 'compose.yml unchanged': 'compose.yml sin cambios', 'nothing to pull': 'Nada que descargar', 'all images cached': 'Todo en caché' };
export const phaseNote = (n?: string) => (n ? PHASE_NOTE[n] ?? n : '');
export const LEVEL: Record<string, string> = { app: 'Aplicativo', env: 'Entorno', service: 'Servicio', flows: 'Flujos', personal: 'Personal' };
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A vault check, by its stable code; the runtime's English `message` is never read. */
export function varIssueText(i: { code: string; key: string; service?: string; at: string; message: string }, env: string): { title: string; text: string } {
  const k = i.key;
  switch (i.code) {
    case 'missing-var': return { title: `Falta ${k}.`, text: `${i.service} la necesita (${i.at}) y ningún nivel del vault le da valor.` };
    case 'blank-override': return { title: `${k} llega en blanco.`, text: `${i.at} se la pasa a ${i.service} como \`${k}: \${${k}}\`, y el vault la deja vacía: tapa el valor por defecto del código.` };
    case 'plain-secret': return { title: `${k} está en claro.`, text: `${i.at} la guarda sin cifrar y se versiona: vuelve a guardarla como secreto.` };
    case 'getenv': return { title: `${k} se lee sin valor por defecto.`, text: `${i.service} la lee en ${i.at}, y ni el compose ni el vault la definen.` };
    case 'unused-var': return { title: `${k} no la lee nadie.`, text: `Está en ${i.at}, pero nada en ${env} la lee.` };
    // The runtime checks the type by the key's name, with this same rule.
    case 'type': return /(^|_)(URL|URI|ENDPOINT)(_|$)/i.test(k)
      ? { title: `${k} no es una URL.`, text: `${i.at} le da un valor que no es una URL, y su nombre pide una.` }
      : { title: `${k} no es un número.`, text: `${i.at} le da un valor que no es un número, y su nombre pide uno.` };
    default: return { title: `${k}.`, text: i.message };
  }
}
/** Only these two leave a service without its value; the rest are worth a look, not a red row. */
export const BLOCKS = new Set(['missing-var', 'blank-override']);

/** The import's warnings: two known shapes, else the runtime's own words. */
export function importWarning(w: string): string {
  const short = w.match(/^(\w+): shorter than 6 characters/);
  if (short) return `${short[1]} tiene menos de 6 caracteres: las trazas no pueden enmascararla.`;
  const word = w.match(/^(\w+): the value is a plain word/);
  if (word) return `${word[1]} es una palabra corriente: al enmascararla se ocultará esa palabra en cualquier parte de las trazas.`;
  return w;
}

/** Why an up stopped: a Spanish title, and the detail in the runtime's words when there is no shape to read. */
export function upError(message: string, env: string, service?: string): { title: string; detail?: string; vars?: boolean } {
  const sick = service ? message.match(new RegExp(`^${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is (\\w+)(?: \\(probe: (.*)\\)| with code (\\d+))?$`, 's')) : null;
  if (sick) return { title: `${service} no arrancó: ${(HEALTH[sick[1]] ?? sick[1]).toLowerCase()}${sick[3] ? `, con código ${sick[3]}` : ''}.`, detail: sick[2] && `Sonda: ${sick[2]}` };
  const slow = message.match(/^not ready after (\d+) s: (.*)$/s);
  if (slow) return { title: `${env} no estuvo listo en ${slow[1]} s.`, detail: slow[2].split(', ').map((x) => { const [s, h] = x.split(' '); return `${s}: ${(HEALTH[h] ?? h).toLowerCase()}`; }).join('\n') };
  const missing = message.match(/^(\d+) values? (?:are|is) missing:\n/);
  if (missing) return { title: Number(missing[1]) === 1 ? 'Falta un valor para arrancar.' : `Faltan ${missing[1]} valores para arrancar.`, vars: true };
  return { title: service ? `${service} no arrancó.` : `No se pudo levantar ${env}.`, detail: message };
}

/** The runtime's reasons, in Spanish: why a read is refused, or why reading and publishing cannot reach the broker. */
export function rabbitText(msg: string): string {
  const x = /^(.+) is a quorum queue with a delivery limit of (\d+): .* RabbitMQ (?:drops it|dead-letters it to (.+))\. Read it with a consumer of your own$/s.exec(msg);
  if (x) return `No se lee desde aquí: ${x[1]} es una cola quorum con un límite de ${x[2]} entregas. Leer y devolver un mensaje cuenta como una entrega más, y pasado el límite RabbitMQ ${x[3] ? `lo manda ${x[3] === 'the default exchange' ? 'al intercambio por defecto' : `a ${x[3]}`} como mensaje muerto` : 'lo descarta'}. Léela con un consumidor propio.`;
  if (/management port is not published/.test(msg)) return 'El puerto de gestión de RabbitMQ no está publicado en esta máquina: leer y publicar necesitan un entorno persistente.';
  if (/refuses guest outside localhost/.test(msg)) return 'RabbitMQ no deja entrar a guest desde fuera del contenedor: arráncalo con RABBITMQ_DEFAULT_USER y RABBITMQ_DEFAULT_PASS.';
  const reorder = /^(.+) is a quorum queue: a peek puts what it reads back at the end of the queue/s.exec(msg);
  if (reorder) return `${reorder[1]} es una cola quorum: leer devuelve los mensajes al final de la cola, detrás de los demás, y el orden cambia. Hay que confirmarlo para leerla.`;
  const stream = /^(.+) is a stream queue: /s.exec(msg);
  if (stream) return `No se lee desde aquí: ${stream[1]} es una cola stream. Un consumidor de streams la lee desde un offset; nada saca un mensaje para devolverlo.`;
  const missing = /^no (queue|exchange) (.*)$/s.exec(msg);
  if (missing) return missing[1] === 'queue' ? `La cola ${missing[2]} ya no existe.` : `No existe el intercambio ${missing[2]}.`;
  const refused = /^RabbitMQ refused it \((\d+)\): (.*)$/s.exec(msg);
  if (refused) return `RabbitMQ lo rechazó (${refused[1]}): ${refused[2]}`;
  return msg;
}

/** Text in parts: a `{ code }` part is a value from the broker, shown as code, so a mask in it reads boxed as everywhere else. */
export type Said = Array<string | { code: string }>;
/** RabbitMQ's default exchange: its empty name, or amq.default, as the management API and a publish take it. */
export const isDefaultExchange = (x: string) => !x || x === 'amq.default';

/**
 * Where a message goes, said before it is sent, from the broker's own route (`queues` keyed by binding, masked; none
 * when an exchange on the way does not route by key; `alternate` when no binding matched and the exchange's alternate
 * exchange takes it; `via` the exchanges a matching binding passes it on to). Only a message that reaches a queue is
 * read by its consumers.
 */
export function routeText(exchange: string, key: string, r: { type: string; queues?: Array<{ queue: string; key: string }>; partial?: true; alternate?: string; via?: string[] }): Said {
  const read = ' Lo leerán sus consumidores como si lo hubiera publicado un servicio. No se puede retirar.';
  const unknown = 'desde aquí no se sabe qué colas lo recibirán.';
  const others = 'desde aquí no se sabe qué otras colas lo recibirán.';
  const none = isDefaultExchange(exchange) ? `Ninguna cola se llama ${key || '(vacía)'}` : `Ningún enlace de ${exchange} coincide con la clave ${key || '(vacía)'}`;
  const list = (qs: Array<{ queue: string; key: string }>): Said =>
    [qs.length === 1 ? 'Lo recibirá la cola ' : 'Lo recibirán las colas ', ...qs.flatMap((q, i): Said => [i ? `, ${q.queue}` : q.queue, ...(q.key ? [' (', { code: q.key }, ')'] : [])])];
  const to = (qs: Array<{ queue: string; key: string }>): Said => [...list(qs), '.', read];
  // queues absent, or partial: an exchange on the way routes by what the keys cannot tell
  const qs = r.queues ?? [], unsure = Boolean(r.partial) || !r.queues;
  if (r.alternate !== undefined) {
    const ae = `${none}: RabbitMQ lo pasa a su intercambio alternativo, ${r.alternate || '(por defecto)'}`;
    if (unsure) return qs.length ? [`${ae}. `, ...list(qs), `, y ${others}`, read] : [`${ae}, y ${unknown}${read}`];
    return qs.length ? [`${ae}. `, ...to(qs)] : [`${ae}, que tampoco lo entrega a ninguna cola: RabbitMQ lo aceptará y lo descartará.`];
  }
  // Bindings took it to other exchanges: the alternate exchange is not used, whatever happens there. A fanout's
  // bindings take everything, so no key is said to match.
  const n = r.via?.length ?? 0, dest = `${n === 1 ? 'al intercambio' : 'a los intercambios'} ${r.via?.join(', ')}`;
  const via = !n ? '' : r.type === 'fanout' ? `${exchange} es fanout: sus enlaces lo llevan, sin mirar la clave, ${dest}`
    : n === 1 ? `Un enlace de ${exchange} coincide con la clave ${key || '(vacía)'} y lo lleva ${dest}`
    : `Los enlaces de ${exchange} que coinciden con la clave ${key || '(vacía)'} lo llevan ${dest}`;
  if (unsure) {
    if (qs.length) return [...list(qs), via ? `. Además, ${via[0].toLowerCase()}${via.slice(1)}, y ${others}` : `, y ${others}`, read];
    return [via ? `${via}, y ${unknown}${read}` : `${exchange} es un intercambio ${r.type}: no enruta por la clave, y ${unknown}${read}`];
  }
  if (!qs.length) return [via ? `${via}, donde nada lo toma: RabbitMQ lo aceptará y lo descartará.` : `${none}: RabbitMQ lo aceptará y lo descartará.`];
  if (isDefaultExchange(exchange)) return [`Llegará a la cola ${qs[0].queue}.${read}`];
  return to(qs);
}

/** What a Redis value read leaves out, said under it; `shown`: how many elements (entries of a stream) it shows. */
export function redisNote(v: { type: string; size?: number; cut?: true; capped?: true }, shown: number): string {
  if (v.type === 'string') return 'Solo los primeros 64 KB.';
  return [
    v.size !== undefined && shown < v.size ? `Se ven ${nf.format(shown)}: ${v.type === 'list' ? 'los primeros' : v.type === 'zset' ? 'los de menor puntuación' : v.type === 'stream' ? 'las primeras por id' : 'al azar'}.` : '',
    v.cut ? 'Lo que pasa de 8 KB se ve cortado.' : '',
    v.capped ? 'Las entradas con más de 100 campos muestran solo los primeros 100.' : '',
  ].filter(Boolean).join(' ');
}

/**
 * What a binding matches when its key alone does not say it, by its exchange's type: fanout ignores the key, headers
 * route by the message's headers, and an empty key on any other matches only the empty routing key. Null: the key says it.
 */
export function bindingMatch(type: string | undefined, key: string): { label: string; hint: string } | null {
  if (type === 'fanout') return { label: 'cualquiera', hint: 'Un intercambio fanout entrega todo lo que recibe, sin mirar la clave' };
  if (type === 'headers') return { label: 'por cabeceras', hint: 'Un intercambio headers enruta por las cabeceras del mensaje, no por la clave' };
  return key ? null : { label: '(vacía)', hint: 'Solo le llegan los mensajes publicados con la clave vacía' };
}

const nf = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
/** 850 ms, 2,4 s, 1 min 32 s */
export const secs = (ms = 0) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${nf.format(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
/** hace 5 min, ayer, hace 3 días */
export function ago(iso: string, now = Date.now()): string {
  const s = (Date.parse(iso) - now) / 1000;
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] = Math.abs(s) < 60 ? [s, 'second'] : Math.abs(s) < 3600 ? [s / 60, 'minute'] : Math.abs(s) < 86400 ? [s / 3600, 'hour'] : [s / 86400, 'day'];
  return Math.abs(s) < 45 ? 'ahora' : rtf.format(Math.round(n), unit);
}
export const RUN_STATUS: Record<string, string> = { queued: 'En cola', running: 'En curso', passed: 'Correcto', failed: 'Falló', error: 'Error de infraestructura', cancelled: 'Cancelado', interrupted: 'Interrumpido', cached: 'En caché', skipped: 'Omitido', todo: 'Sin escribir' };
export const RUN_DOT: Record<string, DotState> = { passed: 'ok', cached: 'ok', failed: 'err', error: 'err', running: 'run', queued: 'queue', cancelled: 'idle', interrupted: 'idle', skipped: 'idle' };
/** A flow's last result that says something about the code, in a few words. */
export function lastText(last: { status: string; failure?: { step: number }; cases: Array<{ status: string }> } | null): string {
  if (!last) return 'Sin ejecutar';
  if (last.status !== 'failed') return 'Correcto';
  return last.failure ? `Falló en el paso ${last.failure.step}` : last.cases.some((c) => c.status === 'failed') ? 'Falló un caso' : 'Falló';
}
/** Laru's own lines about waiting for a lock and moving what another env holds, as the env page shows them. */
export function laruLine(line: string): string {
  const wait = line.match(/^waiting for (.+) to finish$/);
  if (wait) return `esperando a que termine ${wait[1]}`;
  const mv = line.match(/^(.+) moves from (\S+) to (\S+): (.+) holds it$/);
  if (!mv) return line;
  const [, what, from, to, by] = mv;
  const name = what === 'the subnet' ? 'la subred' : what === 'the entrance' ? 'la entrada' : what.endsWith("'s subnet") ? `la subred de ${what.slice(0, -9)}` : `el puerto de ${what}`;
  return `${name} pasa de ${from} a ${to}: la usa ${by === 'another program' ? 'otro programa' : by.replace(/^network /, 'la red ')}`;
}
export const RUN_PHASE: Record<string, string> = { queued: 'En cola', build: 'Construir', up: 'Levantar', tests: 'Pruebas', evidence: 'Evidencia', destroy: 'Destruir', done: 'Terminado' };

const CHECK: Record<string, string> = { docker: 'Docker', compose: 'Docker Compose', resources: 'Recursos de Docker', 'vault key': 'Clave del vault' };
export const checkName = (n: string) => CHECK[n] ?? n.replace(/^env /, 'Entorno ').replace(/^held (\S+)(?: run (\d+))?$/, (_m, e: string, r?: string) => `En uso: ${e}${r ? `, run ${r}` : ''}`);
const STORE: Record<string, string> = { keychain: 'En el llavero del sistema', 'secret-tool': 'En secret-tool', file: 'En un fichero sin cifrar (vault.key): mejor en un llavero' };
export function checkNote(note: string): string {
  const res = note.match(/^(\d+) CPUs, ([\d.]+) GiB( \(.*\))?$/);
  if (res) return `${res[1]} CPU, ${res[2].replace('.', ',')} GiB${res[3] ? '; una app como vaultflow necesita unos 6' : ''}`;
  const env = note.match(/^subnet (\S+), entrance :(.+)$/);
  if (env) return `Subred ${env[1]}, entrada :${env[2]}`;
  const held = note.match(/^(this workspace|workspace (\S+)): subnets (.*), ports (.*)$/);
  if (held) return `${held[2] ? `Workspace ${held[2]}` : 'Este workspace'}: ${held[3] === '-' ? 'sin subred' : `subred ${held[3]}`}, ${held[4] === '-' ? 'sin puertos' : `puertos ${held[4]}`}`;
  return note
    .replace(/^engine /, 'Motor ')
    .replace(/^in (keychain|secret-tool|file)$/, (_m, s: string) => STORE[s])
    .replace(/^none yet \(the first secret creates it\)$/, 'Todavía no hay: la crea el primer secreto')
    .replace(/^not running$/, 'Docker no está en marcha')
    .replace(/^docker compose is missing$/, 'Falta docker compose');
}

// ---------- findings, impact, mocks ----------
export const FINDING: Record<string, string> = {
  'undeclared-call': 'Llamada sin declarar', 'dead-declaration': 'Declaración muerta', 'contract-drift': 'Fuera de contrato', 'untested-endpoint': 'Endpoint sin probar',
  'stale-fact': 'Hecho desfasado', 'convention-violated': 'Convención incumplida', 'missing-var': 'Variable que falta', 'unused-var': 'Variable sin uso',
  'table-multi-writer': 'Tabla con varios escritores', 'flow-unstable': 'Flujo inestable', 'flow-env-missing': 'Flujo sin entorno', 'scenario-broken': 'Escenario roto', 'behavior-drift': 'Comportamiento cambiado',
};
export const SEVERITY: Record<string, { cls: 'high' | 'mid' | 'low'; label: string }> = { error: { cls: 'high', label: 'Alta' }, warning: { cls: 'mid', label: 'Media' }, info: { cls: 'low', label: 'Baja' } };

/**
 * A finding in Spanish, read from its type and the parts its key carries (`type:subject:detail`). The core writes
 * `message` in English for the CLI; a shape this does not know falls back to it rather than to nothing.
 */
export function findingText(f: { key: string; type: string; subject: string; message: string }): string {
  const detail = f.key.startsWith(`${f.type}:${f.subject}:`) ? f.key.slice(f.type.length + f.subject.length + 2) : '';
  const m = f.message;
  const bare = (id: string) => id.replace(/^(svc|var|flow):/, '');
  let x: RegExpMatchArray | null;
  switch (f.type) {
    case 'undeclared-call': return `${bare(f.subject)} llama a ${bare(detail)} en los runs, y nada en el código lo dice.`;
    case 'dead-declaration': return `${bare(f.subject)} declara una llamada a ${bare(detail)} que ningún run ha hecho.`;
    case 'untested-endpoint': return `Ningún flujo recorre ${m.replace(/^no flow reaches /, '')}.`;
    case 'stale-fact': return `${f.subject}: el código al que está anclado cambió desde que se verificó.`;
    case 'convention-violated': return (x = m.match(/^(.+) breaks (\S+) \((.*)\)$/)) ? `${x[1]} incumple ${x[2]}: ${x[3]}.` : m;
    case 'table-multi-writer': return (x = m.match(/^(.+?) is written by (.+?)(?:; its owner is (.+))?$/)) ? `${x[1]} la escriben ${x[2]}${x[3] ? `; su dueño es ${x[3]}` : ''}.` : m;
    case 'flow-unstable': return (x = m.match(/changed result (\d+) times in its last (\d+) runs \((.*)\)$/)) ? `${bare(f.subject)} cambió de resultado ${x[1]} veces en sus últimos ${x[2]} runs (${x[3].split(' ').map((st) => (RUN_STATUS[st] ?? st).toLowerCase()).join(', ')}).` : m;
    case 'behavior-drift': {
      const KIND: Record<string, string> = { missing: 'ya no hace', new: 'ahora hace', cause: 'cambió la causa de' };
      return (x = m.match(/^(\S+): (\d+) hop\(s\) differ from the behavior approved in run (\S+), in run (\S+); first, step «(.+)»: (missing|new|cause) (.+)$/)) ? `${bare(x[1])}: ${x[2]} ${x[2] === '1' ? 'salto distinto' : 'saltos distintos'} del comportamiento aprobado en el run ${x[3]}, en el run ${x[4]}; el primero, en «${x[5]}»: ${KIND[x[6]]} ${x[7]}.` : m;
    }
    case 'scenario-broken':
      if ((x = m.match(/^(\S+) has no setup to play: (.+)$/))) return `${x[1]} no tiene preparación que jugar: falta ${x[2]}.`;
      if ((x = m.match(/^(\S+) failed its setup on (\S+): (.*)$/))) return `La preparación de ${x[1]} falló en ${x[2]}: ${x[3]}`;
      return m;
    case 'missing-var': return `Falta ${bare(f.subject)}: ${detail || 'un servicio'} la necesita y ningún nivel del vault le da valor.`;
    case 'unused-var': return (x = m.match(/: set at (\w+), but nothing in (\S+) reads it$/)) ? `${bare(f.subject)} tiene valor en ${(LEVEL[x[1]] ?? x[1]).toLowerCase()}, y nada en ${x[2]} la lee.` : `${bare(f.subject)} tiene valor y nadie la lee.`;
    case 'contract-drift':
      if ((x = m.match(/^(\S+ \S+) reached (\S+) and none of its contracts declares it$/))) return `${x[1]} llegó a ${x[2]}, y ninguno de sus contratos lo declara.`;
      if ((x = m.match(/^(\S+ \S+) answered (\d+), which (\S+) does not list among its errors$/))) return `${x[1]} respondió ${x[2]}, y ${x[3]} no lo lista entre sus errores.`;
      if ((x = m.match(/^(\S+)→(\S+) (.+?): (.*)$/))) return `${x[1]} → ${x[2]} ${x[3]} se sale del contrato: ${x[4]}`;
      return m;
    default: return m;
  }
}

const WHY: Array<[RegExp, (x: RegExpMatchArray) => string]> = [
  [/^env-wide change: (.+)$/, (x) => `un cambio que afecta a todo el entorno: ${x[1]}`],
  [/^needs (.+)$/, (x) => `necesita ${x[1]}, que cambió`],
  [/^step «(.+)» runs on (.+)$/, (x) => `el paso «${x[1]}» corre en ${x[2]}`],
  [/^its last run went through (.+)$/, (x) => `su último run pasó por ${x[1]}`],
  [/^(.+) consumes (.+), which it published$/, (x) => `${x[1]} consume ${x[2]}, que el flujo publica`],
  [/^its spec, flow\.md or support changed$/, () => 'cambió su spec, su flow.md o support/'],
];
/** Why impact picked a flow, in Spanish. */
export const whyText = (w: string) => { for (const [re, f] of WHY) { const x = w.match(re); if (x) return f(x); } return w; };

export const MOCK_MODE: Record<string, { label: string; hint: string }> = {
  contract: { label: 'Contrato', hint: 'Responde según el contrato del mock y valida que cada petición lo cumple.' },
  record: { label: 'Grabar', hint: 'Pasa al servicio real y guarda los pares de petición y respuesta.' },
  simulate: { label: 'Simular', hint: 'Responde con lo grabado; lo que no está grabado es un error visible.' },
  spy: { label: 'Espiar', hint: 'Simula lo que conoce y deja pasar el resto al servicio real.' },
  script: { label: 'Guion', hint: 'Respuestas guionizadas y con estado, de un fichero TS pequeño.' },
  sink: { label: 'Buzón', hint: 'Recibe lo que la aplicación envía (correo por SMTP, SMS por la API de Twilio) y lo guarda: no envía nada fuera de tu máquina.' },
};

/** What a fault does, in one line: «+800 ms», «responde 503», «corta la conexión», and when. */
export function faultText(f: { code?: number; latency?: number; status?: number; abort?: boolean; timeout?: boolean; bandwidth?: number; slowAfter?: number; p?: number; path?: string; method?: string; from?: string }): string {
  const what = [
    f.latency ? `+${f.latency} ms` : '',
    f.status ? `responde ${f.status}` : '',
    f.code ? `código ${f.code}` : '',
    f.abort ? 'corta la conexión' : '',
    f.timeout ? 'no responde nunca' : '',
    f.bandwidth ? `${size(f.bandwidth)}/s${f.slowAfter ? ` a partir del byte ${f.slowAfter}` : ''}` : '',
  ].filter(Boolean).join(', ') || 'sin efecto';
  const when = [f.method, f.path ? `ruta ~ ${f.path}` : '', f.from ? `desde ${f.from}` : ''].filter(Boolean).join(', ');
  return `${what}${when ? `; solo ${when}` : ''}${f.p !== undefined && f.p < 1 ? `; al ${Math.round(f.p * 100)} %` : ''}`;
}

/** 594 B, 12 KB, 3,4 MB */
export const size = (b: number) => (b < 1024 ? `${b} B` : b < 2 ** 20 ? `${Math.round(b / 1024)} KB` : b < 2 ** 30 ? `${nf.format(b / 2 ** 20)} MB` : `${nf.format(b / 2 ** 30)} GB`);

// ---------- workspaces, the machine, storage ----------

const gib = (b = 0) => `${nf.format(Math.round((b / 2 ** 30) * 10) / 10)} GiB`;
/**
 * Why an up was not admitted, from the runtime's admission record: the envs that run (by app/env) and the numbers.
 * `name` is the env that was refused.
 */
export function admissionText(a: { kind: 'maxEnvs' | 'memory'; max?: number; needBytes?: number; totalBytes?: number; foreignBytes?: number; offer?: { app: string; env: string; memBytes: number }; others: Array<{ app: string; env: string; memBytes?: number }> }, name: string): string {
  const who = (o: { app: string; env: string }) => `${o.app}/${o.env.replace(/ \(run (\d+)\)$/, ', run $1').replace(/^tool$/, 'una herramienta')}`;
  const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`);
  if (a.kind === 'maxEnvs') return `Ya ${a.others.length === 1 ? 'corre' : 'corren'} ${and(a.others.map(who))} y el máximo es ${a.max}. Cámbialo en «Esta máquina».`;
  const foreign = a.foreignBytes && a.foreignBytes > 0.1 * 2 ** 30 ? ` y ${gib(a.foreignBytes)} los ocupan contenedores que no son de Laru` : '';
  return `No cabe: ${a.others.length ? and(a.others.map((o) => `${who(o)} usa ${gib(o.memBytes)}`)) : 'nada de Laru ocupa memoria'}${foreign}; ${name} ${a.needBytes ? `necesitó ${gib(a.needBytes)} la última vez` : 'no se ha medido todavía'} y Docker tiene ${gib(a.totalBytes)}.${a.offer ? ` Parar ${a.offer.app}/${a.offer.env} (${gib(a.offer.memBytes)}) lo haría caber.` : ''}`;
}

/** What «Añadir workspace» says of a folder typed or picked. */
export function probeText(p: { ok: boolean; reason?: string; error?: string; app?: string; title?: string; projects?: number; registered?: boolean }): string {
  if (p.ok) return `${p.app} — «${p.title}», ${plural(p.projects ?? 0, 'proyecto', 'proyectos')}${p.registered ? '. Ya está en la lista' : ''}`;
  return ({ empty: '', missing: 'No existe esa carpeta', 'no-yaml': 'No hay laru.yaml en esa carpeta', invalid: `laru.yaml no es válido: ${p.error ?? ''}` } as Record<string, string>)[p.reason ?? ''] ?? p.error ?? '';
}

/** The service's refusals when adding or creating a workspace, by the field they name. */
export function workspaceError(msg: string): { field: string; text: string } {
  const [, field = '', rest = msg] = /^(root|app|docsLanguage): (.*)$/s.exec(msg) ?? [];
  const under = /^a folder under (.+)$/.exec(rest), over = /^overlaps the workspace at (.+)$/.exec(rest), proj = /^inside a project of (.+)$/.exec(rest);
  const text = under ? `Tiene que ser una carpeta dentro de ${under[1]}.`
    : /^there is a workspace there already/.test(rest) ? 'Ahí ya hay un workspace: ábrelo con «Abrir uno que ya existe».'
    : over ? `Se solapa con el workspace de ${over[1]}.` : proj ? `Está dentro de un proyecto de ${proj[1]}.`
    : field === 'app' ? 'Solo minúsculas, números y guiones; empieza por una letra o un número.'
    : /^no laru\.yaml here/.test(msg) ? 'No hay laru.yaml en esa carpeta.' : msg;
  return { field: field || (/laru\.yaml/.test(msg) ? 'root' : ''), text };
}

export const twinText = (app: string, id: string) => `Otro workspace ya usa el id ${app}: este queda como ${id}, y los dos compartirán ~/.laru/${app} (clones, instantáneas, clave del vault).`;
