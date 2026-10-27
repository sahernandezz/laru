/**
 * The standard of every piece: seven containers and twelve facets. One source for the validator, the
 * renderer, the interface's forms and what `knowledge_shape` hands the AI. Section headings exist in every
 * documentation language; the content is written by whoever writes, in the workspace's language.
 */

export const CONTAINERS = ['application', 'module', 'process', 'repository', 'service', 'datastore', 'external'] as const;
export const FACETS = ['plan', 'decision', 'contract', 'data-model', 'convention', 'guide', 'test-plan', 'flow', 'scenario', 'runbook', 'architecture', 'artifact', 'versioning', 'stack', 'infrastructure', 'secrets', 'glossary', 'term', 'note'] as const;
/** Before the current standard: still read, never offered; `laru docs migrate` turns a term into a glossary row, a note into a known trap and a runbook into a guide of the application. */
export const LEGACY_TYPES = ['term', 'note', 'runbook'] as const;
export type ContainerType = (typeof CONTAINERS)[number];
export type FacetType = (typeof FACETS)[number];
export type PieceType = ContainerType | FacetType;
export const ALL_PIECE_TYPES: PieceType[] = [...CONTAINERS, ...FACETS];
/** The 23 types a person or the AI can create: 7 containers and 16 facets. */
export const PIECE_TYPES: PieceType[] = ALL_PIECE_TYPES.filter((t) => !(LEGACY_TYPES as readonly string[]).includes(t));
export const isContainer = (t: string): t is ContainerType => (CONTAINERS as readonly string[]).includes(t);
/** Facets with a folder of their own, beside the files they run: `flows/<slug>/flow.md` and its spec, `scenarios/<slug>/scenario.md` and its setup. */
export const OWN_FOLDER: PieceType[] = ['flow', 'scenario'];

import { HINT_ES } from './standard-es.ts';

export type Lang = 'en' | 'es';
export type Label = Record<Lang, string>;

export type FieldType = 'text' | 'markdown' | 'list' | 'refs' | 'rows';
export interface Column { name: string; label: Label; required?: boolean; enum?: string[]; ref?: string[]; date?: boolean; max?: number }
export interface Field {
  name: string;
  label: Label;
  type: FieldType;
  required?: boolean;
  /** characters for text and markdown, items for lists, refs and rows */
  max?: number;
  columns?: Column[];
  /** id prefixes a reference may point at */
  ref?: string[];
  hint: string;
  /** the hint in Spanish, for a workspace documented in Spanish; without it the English one is shown */
  hintEs?: string;
  /** headings this section had before and a file may still carry: read, rewritten with the label by `docs migrate` */
  alias?: string[];
  /** a markdown section that holds a diagram: a fenced `mermaid` block, drawn by the diagram engine */
  diagram?: 'required' | 'optional';
  /** classes of diagram this section expects, to tell a flowchart of a process from one of a deployment */
  kinds?: string[];
  /** the word count under which the section is thin (a warning, not an error) */
  minWords?: number;
}

export type Stage = 'plan' | 'design' | 'build' | 'test' | 'deploy' | 'operate';
export const STAGES: Stage[] = ['plan', 'design', 'build', 'test', 'deploy', 'operate'];
export const STAGE_LABEL: Record<Stage, Label> = {
  plan: { en: 'Plan', es: 'Planificar' }, design: { en: 'Design', es: 'Diseñar' }, build: { en: 'Build', es: 'Construir' },
  test: { en: 'Test', es: 'Probar' }, deploy: { en: 'Deploy', es: 'Desplegar' }, operate: { en: 'Operate', es: 'Operar' },
};

export interface PieceStandard {
  type: PieceType;
  prefix: string;
  label: Label;
  question: Label;
  /** For containers, the folder that holds them; for facets, the folder inside their container. */
  folder: string;
  kinds?: string[];
  statuses: string[];
  /** statuses of the standard before the current one: accepted with a warning, `laru docs migrate` rewrites them */
  legacyStatuses?: string[];
  /** relations a piece of this type is expected to declare (a missing one is a point of the document's note) */
  expects?: string[];
  livesIn: ContainerType[];
  stage?: Stage;
  /** code anchors: required, optional, or not part of this piece */
  anchors: 'required' | 'optional' | 'no';
  /** frontmatter beyond the common keys */
  meta?: Array<{ name: string; ref?: string[]; list?: boolean; hint: string }>;
  fields: Field[];
  example: { title: string; kind?: string; status: string; summary: string; anchors?: string[]; meta?: Record<string, unknown>; relations?: Record<string, string[]>; fields: Record<string, unknown> };
}

const L = (en: string, es: string): Label => ({ en, es });
const ANY: ContainerType[] = [...CONTAINERS];
const SERVICE = ['svc:'], MODULE_OR_PROCESS = ['mod:', 'proc:', 'svc:'];
const LIFECYCLE = ['draft', 'active', 'deprecated'];

/** what production runs when no file of the repos says it: fidelity compares every env with it */
const production = (who: string): Field => ({ name: 'production', label: L('In production', 'En producción'), type: 'rows', max: 15, hint: `What production runs that no file of the repos says: image, profile, memory, cpus, protocol, auth, mode (real, contract, simulate…), upload-limit or read-limit. ${who}`, columns: [{ name: 'service', label: L('Participant', 'Participante') }, { name: 'aspect', label: L('Aspect', 'Aspecto'), required: true, enum: ['image', 'profile', 'memory', 'cpus', 'protocol', 'auth', 'mode', 'upload-limit', 'read-limit'] }, { name: 'value', label: L('Value', 'Valor'), required: true }] });
const col = (name: string, en: string, es: string, o: Partial<Column> = {}): Column => ({ name, label: L(en, es), ...o });
const md = (name: string, en: string, es: string, hint: string, hintEs: string, o: Partial<Field> = {}): Field => ({ name, label: L(en, es), type: 'markdown', max: 1500, hint, hintEs, ...o });
const items = (name: string, en: string, es: string, hint: string, hintEs: string, o: Partial<Field> = {}): Field => ({ name, label: L(en, es), type: 'list', max: 15, hint, hintEs, ...o });
const table = (name: string, en: string, es: string, hint: string, hintEs: string, columns: Column[], o: Partial<Field> = {}): Field => ({ name, label: L(en, es), type: 'rows', max: 30, hint, hintEs, columns, ...o });
const purpose = (hint: string): Field => ({ name: 'purpose', label: L('Purpose', 'Propósito'), type: 'markdown', required: true, max: 1500, hint });

export const STANDARD: Record<PieceType, PieceStandard> = {
  /* ------------------------------ containers ------------------------------ */
  application: {
    type: 'application', prefix: 'app', label: L('Application', 'Aplicativo'), question: L('What is this application for, and for whom?', '¿Para qué y para quién es este aplicativo?'),
    folder: '', kinds: ['product', 'platform', 'automation', 'legacy'], statuses: LIFECYCLE, livesIn: [], anchors: 'no',
    fields: [
      purpose('What it does and why it exists, in two or three paragraphs. Not how it is built: the map says that.'),
      { name: 'users', label: L('Users', 'Usuarios'), type: 'rows', required: true, max: 20, hint: 'Who uses it and what each one needs from it.', columns: [{ name: 'actor', label: L('Actor', 'Actor'), required: true }, { name: 'need', label: L('Need', 'Necesidad'), required: true }] },
      { name: 'scope', label: L('Scope', 'Alcance'), type: 'list', required: true, max: 15, hint: 'What it covers, one line each.' },
      { name: 'out-of-scope', label: L('Out of scope', 'Fuera de alcance'), type: 'list', max: 15, hint: 'What someone could expect from it and it does not do.' },
      { name: 'constraints', label: L('Constraints', 'Restricciones'), type: 'list', max: 15, hint: 'Rules the whole application must respect: regulation, platforms, budgets.' },
      table('team', 'Team', 'Equipo', 'Who builds and answers for it: teams and roles, never people.', 'Quién la construye y responde por ella: equipos y roles, nunca personas.', [col('part', 'Part', 'Parte', { required: true }), col('team', 'Team', 'Equipo', { required: true })], { required: true, max: 20 }),
      md('milestones', 'Status and milestones', 'Estado e hitos', 'Where it stands and what comes next.', 'En qué punto está y qué viene.', { max: 1000 }),
    ],
    example: { title: 'Shop', kind: 'product', status: 'active', summary: 'Online shop: customers order and pay, support handles returns.', fields: {
      purpose: 'Lets customers buy from the catalogue and pay by card, and lets support handle returns without touching the database.',
      users: [{ actor: 'Customer', need: 'Order, pay and return a purchase' }, { actor: 'Support', need: 'Approve or reject a return' }],
      scope: ['Catalogue browsing', 'Card payments', 'Returns'], 'out-of-scope': ['Invoicing for companies'], constraints: ['Card data never stored: Stripe holds it'],
      team: [{ part: 'Orders and payments', team: 'Commerce' }, { part: 'Support tools', team: 'Support engineering' }],
    } },
  },
  module: {
    type: 'module', prefix: 'mod', label: L('Module', 'Módulo'), question: L('Which part of the application is this?', '¿Qué parte del aplicativo es esta?'),
    folder: 'modules', kinds: ['area', 'feature', 'story'], statuses: LIFECYCLE, livesIn: ['application', 'module'], anchors: 'optional',
    fields: [
      { ...purpose('What this part does for its users. A feature should be testable from this paragraph alone.'), label: L('What it does', 'Qué hace'), alias: ['Propósito', 'Purpose'], hintEs: 'Qué hace esta parte para sus usuarios. Una funcionalidad debe poder probarse solo con este párrafo.' },
      table('usecases', 'Use cases', 'Casos de uso', 'Each thing a person does with it, and the flow that proves it (many cases may point at one flow).', 'Cada cosa que una persona hace con él y el flujo que lo prueba (varios casos pueden apuntar al mismo flujo).', [col('case', 'Case', 'Caso', { required: true }), col('actor', 'Actor', 'Actor'), col('flow', 'Flow', 'Flujo', { ref: ['flow:'] })], { required: true, max: 25 }),
      md('built', 'How it is built', 'Cómo está construido', 'The parts and how they work together, with a diagram (a fenced mermaid block: flowchart, sequence or C4 component). What the code says is extracted; this is the intent.', 'Las piezas y cómo trabajan juntas, con un diagrama (un bloque mermaid: flowchart, sequence o C4 componente). Lo que dice el código se extrae; esto es la intención.', { required: true, diagram: 'required', kinds: ['c4-container', 'c4-component'], minWords: 40 }),
      table('interfaces', 'Interfaces', 'Interfaces', 'What it exposes or consumes, as intent: the extracted endpoints are contrasted with this table.', 'Qué expone o consume, como intención: los endpoints extraídos se contrastan con esta tabla.', [col('kind', 'Type', 'Tipo', { required: true, enum: ['http', 'event', 'queue', 'table', 'file', 'screen'] }), col('name', 'Name', 'Nombre', { required: true }), col('direction', 'Direction', 'Dirección', { enum: ['exposes', 'consumes'] }), col('contract', 'Contract', 'Contrato', { ref: ['ctr:'] })], { max: 40 }),
      items('submodules', 'Submodules', 'Submódulos', 'In an area: each child module, by id.', 'En un área: cada módulo hijo, por id.', { max: 30 }),
      md('design', 'Design decision', 'Decisión de diseño', 'The one decision that shapes it and where it is written down.', 'La decisión que la moldea y dónde está escrita.', { max: 800 }),
      { name: 'responsibilities', label: L('Responsibilities', 'Responsabilidades'), type: 'list', max: 12, hint: 'What it is in charge of, one line each.' },
      { name: 'boundaries', label: L('Boundaries', 'Límites'), type: 'list', max: 12, hint: 'What it deliberately does not do, and who does it instead.' },
      { name: 'acceptance', label: L('Acceptance criteria', 'Criterios de aceptación'), type: 'list', max: 15, hint: 'For a story: the checks that say it is done.' },
    ],
    example: { title: 'Returns', kind: 'feature', status: 'active', summary: 'A customer returns a paid order; support approves or rejects it.', anchors: ['shop:src/main/java/acme/returns/**'], fields: {
      purpose: 'A customer asks to return a paid order, totally or partly. Support approves or rejects it, and the refund goes back through the card that paid.',
      usecases: [{ case: 'Ask for a return', actor: 'Customer', flow: 'flow:return-a-paid-order' }, { case: 'Approve or reject a return', actor: 'Support' }],
      built: 'A return is a request that lives in the orders service. The portal posts it, support reviews it from the back office, and a worker sends the refund to the payment provider.\n\n```mermaid\nC4Container\n  title Returns, containers\n  Container_Boundary(shop, "Shop") {\n    Container(api, "Shop API", "Java, Spring Boot", "Records returns")\n    Container(worker, "Refund worker", "Java", "Sends refunds")\n  }\n  System_Ext(stripe, "Stripe", "Card payments")\n  Rel(api, worker, "Hands over the refund", "AMQP")\n  Rel(worker, stripe, "Refunds", "REST")\n```\n\nThe request is recorded first and the refund is sent later, so a slow provider never holds the customer waiting for an answer.',
      responsibilities: ['Accept a return request', 'Refund through the payment provider'], boundaries: ['Does not issue credit notes: invoicing does'],
    } },
  },
  process: {
    type: 'process', prefix: 'proc', label: L('Process', 'Proceso'), question: L('How does the work flow, end to end?', '¿Cómo fluye el trabajo de punta a punta?'),
    folder: 'processes', kinds: ['process', 'subprocess'], statuses: LIFECYCLE, livesIn: ['application', 'process'], anchors: 'no',
    fields: [
      { name: 'goal', label: L('Goal', 'Objetivo'), type: 'markdown', required: true, max: 800, hint: 'What the process achieves and when it is over.' },
      { name: 'actors', label: L('Actors', 'Actores'), type: 'list', required: true, max: 10, hint: 'Roles and systems that take part. Teams and roles, never people.' },
      { name: 'steps', label: L('Steps', 'Pasos'), type: 'rows', required: true, max: 30, hint: 'One row per step. The service column names `svc:` ids so the step can be contrasted with the map.', columns: [{ name: 'step', label: L('Step', 'Paso'), required: true }, { name: 'actor', label: L('Actor', 'Actor'), required: true }, { name: 'service', label: L('Service', 'Servicio'), ref: SERVICE }, { name: 'data', label: L('Data', 'Datos') }] },
      { name: 'exceptions', label: L('Exceptions', 'Excepciones'), type: 'rows', max: 15, hint: 'What happens when a step fails.', columns: [{ name: 'when', label: L('When', 'Cuándo'), required: true }, { name: 'then', label: L('Then', 'Entonces'), required: true }] },
      md('flow', 'Flow', 'Flujo', 'The process as a diagram (a fenced mermaid block: flowchart or state): proposed from the steps.', 'El proceso como diagrama (un bloque mermaid: flowchart o state): se propone desde los pasos.', { required: true, diagram: 'required', kinds: ['process'] }),
      items('io', 'Inputs and outputs', 'Entradas y salidas', 'What goes in and what comes out, one line each.', 'Qué entra y qué sale, una línea cada cosa.'),
      items('indicators', 'Indicators', 'Indicadores', 'How you know it works: a number and its threshold.', 'Cómo sabes que funciona: un número y su umbral.', { max: 10 }),
    ],
    example: { title: 'Order to cash', kind: 'process', status: 'active', summary: 'From the order to the money in the account.', fields: {
      goal: 'An order becomes money: it is paid, shipped and cannot be disputed any more.', actors: ['Customer', 'Payments platform'],
      steps: [{ step: 'Place the order', actor: 'Customer', service: 'svc:shop-api', data: 'orders' }, { step: 'Charge the card', actor: 'Payments platform', service: 'svc:shop-api', data: 'payments' }],
      flow: '```mermaid\n---\ntitle: Order to cash\n---\nflowchart TD\n  subgraph customer["Customer"]\n    place[Place the order]\n  end\n  subgraph platform["Payments platform"]\n    charge[Charge the card]\n    paid([Paid])\n  end\n  place --> charge\n  charge --> paid\n```',
      exceptions: [{ when: 'The card is declined', then: 'The order stays unpaid for 24 h and is then cancelled' }],
    } },
  },
  repository: {
    type: 'repository', prefix: 'repo', label: L('Repository', 'Repositorio'), question: L('What the code of this repository cannot say about itself', 'Lo que el código de este repositorio no dice de sí mismo'),
    folder: 'repos', statuses: LIFECYCLE, livesIn: ['application'], anchors: 'no',
    fields: [
      { name: 'responsibility', label: L('Responsibility', 'Responsabilidad'), type: 'markdown', required: true, max: 800, hint: 'Why this repository exists apart from the others.' },
      { name: 'gotchas', label: L('Known traps', 'Trampas conocidas'), type: 'list', max: 15, hint: 'What bites whoever works here for the first time.' },
      md('config', 'Configuration and deployment', 'Configuración y despliegue', 'How it is configured and shipped: branches, pipelines, environments.', 'Cómo se configura y se despliega: ramas, pipelines, entornos.', { max: 800 }),
      items('gates', 'Quality gates', 'Puertas de calidad', 'What must pass before a change lands: build, tests, lint, review.', 'Qué debe pasar antes de aceptar un cambio: build, pruebas, lint, revisión.', { max: 10 }),
      md('layers', 'Layers', 'Capas', 'When it is layered: its packages and what may depend on what (a fenced mermaid flowchart).', 'Si tiene capas: sus paquetes y qué puede depender de qué (un bloque mermaid flowchart).', { diagram: 'optional', kinds: ['packages'] }),
    ],
    example: { title: 'shop', status: 'active', summary: 'The back-end repository of the shop: every service that touches money lives here.', fields: { responsibility: 'Holds every service that touches money, so a security review covers one repository.', gotchas: ['Integration tests need Docker running'] } },
  },
  service: {
    type: 'service', prefix: 'svc', label: L('Service', 'Servicio'), question: L('What the code of this service cannot say', 'Lo que el código de este servicio no dice'),
    folder: 'services', statuses: LIFECYCLE, livesIn: ['application'], anchors: 'optional',
    fields: [
      { name: 'responsibility', label: L('Responsibility', 'Responsabilidad'), type: 'markdown', required: true, max: 800, hint: 'What it owns. Never a list of endpoints, tables or variables: those are extracted.' },
      { name: 'invariants', label: L('Invariants', 'Invariantes'), type: 'list', max: 12, hint: 'What must stay true whatever changes.' },
      { name: 'gotchas', label: L('Known traps', 'Trampas conocidas'), type: 'list', max: 12, hint: 'What surprised someone once.' },
      { name: 'boundaries', label: L('Boundaries', 'Límites'), type: 'list', max: 12, hint: 'What it deliberately does not do: "does not call X on purpose".' },
    ],
    example: { title: 'shop-api', status: 'active', summary: 'Owns orders and their payment state; nothing else writes the orders table.', fields: { responsibility: 'Owns orders and their payment state. Nothing else writes the orders table.', invariants: ['An order is charged at most once'] } },
  },
  datastore: {
    type: 'datastore', prefix: 'ds', label: L('Data store', 'Almacén de datos'), question: L('Who owns this data, and for how long is it kept?', '¿De quién son estos datos y cuánto se guardan?'),
    folder: 'datastores', kinds: ['relational', 'document', 'cache', 'queue', 'file', 'search', 'directory'], statuses: LIFECYCLE, livesIn: ['application'], anchors: 'no',
    fields: [
      { name: 'ownership', label: L('Ownership', 'Propiedad'), type: 'markdown', required: true, max: 800, hint: 'Which team answers for it and which service may write where.' },
      { name: 'contents', label: L('Contents', 'Contenido'), type: 'rows', max: 30, hint: 'Schemas, buckets or topic families and who owns each one.', columns: [{ name: 'part', label: L('Part', 'Parte'), required: true }, { name: 'owner', label: L('Owner', 'Dueño'), ref: SERVICE }, { name: 'notes', label: L('Notes', 'Notas') }] },
      { name: 'retention', label: L('Retention', 'Retención'), type: 'markdown', max: 600, hint: 'How long data lives and what deletes it.' },
      table('entities', 'Entities', 'Entidades', 'What each entity means; the tables are extracted.', 'Qué significa cada entidad; las tablas se extraen.', [col('entity', 'Entity', 'Entidad', { required: true }), col('meaning', 'Meaning', 'Significado', { required: true })], { max: 40 }),
      md('access', 'Access', 'Acceso', 'Who reaches it and how: users, networks, credentials by name.', 'Quién llega a él y cómo: usuarios, redes, credenciales por nombre.', { max: 600 }),
      md('dataflow', 'Data flow', 'Recorrido de los datos', 'Where its data comes from, what transforms it and where it goes next (a fenced mermaid flowchart).', 'De dónde llegan sus datos, qué los transforma y adónde van después (un bloque mermaid flowchart).', { required: true, diagram: 'required', kinds: ['data-flow'] }),
    ],
    example: { title: 'postgres', kind: 'relational', status: 'active', summary: 'The relational database of the shop, one schema per service that uses it.', fields: { ownership: 'Platform team. Each service writes only its own schema.', contents: [{ part: 'schema shop', owner: 'svc:shop-api' }], dataflow: '```mermaid\n---\ntitle: Orders data\n---\nflowchart LR\n  portal[Portal] -->|order| api[shop-api]\n  api -->|INSERT orders| db[(schema shop)]\n  db -->|nightly export| bi[Reporting]\n```' } },
  },
  external: {
    type: 'external', prefix: 'ext', label: L('External system', 'Sistema externo'), question: L('What we use from a system that is not ours, and what happens when it fails', 'Qué usamos de un sistema que no es nuestro y qué pasa cuando falla'),
    folder: 'externals', kinds: ['saas', 'partner', 'corporate', 'legacy', 'infra'], statuses: LIFECYCLE, livesIn: ['application'], anchors: 'no',
    fields: [
      purpose('What we rely on it for.'),
      { name: 'failure-modes', label: L('Failure modes', 'Modos de fallo'), type: 'rows', max: 15, hint: 'How it fails and what we do then. This is what its mock and fault rules will reproduce.', columns: [{ name: 'failure', label: L('Failure', 'Fallo'), required: true }, { name: 'effect', label: L('Effect', 'Efecto'), required: true }, { name: 'handling', label: L('Handling', 'Tratamiento') }] },
      production('The participant defaults to this external.'),
      table('flows', 'What flows', 'Qué fluye', 'The data that goes in and out and why.', 'Los datos que entran y salen y para qué.', [col('data', 'Data', 'Datos', { required: true }), col('direction', 'Direction', 'Dirección', { enum: ['out', 'in', 'both'] }), col('why', 'Why', 'Para qué')], { max: 15 }),
      table('endpoints', 'Endpoints', 'Extremos', 'Each way we reach it: from where, to where, by which mechanism.', 'Cada forma de llegar a él: desde dónde, hasta dónde, por qué mecanismo.', [col('from', 'From', 'Origen', { required: true }), col('to', 'To', 'Destino', { required: true }), col('mechanism', 'Mechanism', 'Mecanismo'), col('frequency', 'Frequency', 'Frecuencia')], { max: 15 }),
      md('retries', 'Retries', 'Reintentos', 'How often and how long we retry, and what is idempotent.', 'Cuántas veces y por cuánto tiempo se reintenta, y qué es idempotente.', { max: 500 }),
      md('ownership', 'Ownership', 'Propiedad', 'Who owns the relationship and the contract with them.', 'Quién lleva la relación y el contrato con ellos.', { max: 400 }),
    ],
    example: { title: 'Stripe', kind: 'saas', status: 'active', summary: 'The external provider that charges and refunds cards so we never hold card data.', fields: { purpose: 'Charges and refunds cards; holds every card number so we never do.', 'failure-modes': [{ failure: 'Timeout', effect: 'The refund stays pending', handling: 'Retried by the worker' }] } },
  },

  /* -------------------------------- facets -------------------------------- */
  plan: {
    type: 'plan', prefix: 'plan', label: L('Plan', 'Plan'), question: L('What is going to be done, when, and against which risks?', '¿Qué se va a hacer, cuándo y con qué riesgos?'),
    folder: 'plans', statuses: LIFECYCLE, livesIn: ['application', 'module'], stage: 'plan', anchors: 'no',
    fields: [
      { name: 'goal', label: L('Goal', 'Objetivo'), type: 'markdown', required: true, max: 800, hint: 'What is true when the plan is done.' },
      { name: 'milestones', label: L('Milestones', 'Hitos'), type: 'rows', required: true, max: 20, hint: 'Dated milestones. One still open past its date makes the stage only partly covered.', columns: [{ name: 'milestone', label: L('Milestone', 'Hito'), required: true }, { name: 'date', label: L('Date', 'Fecha'), required: true, date: true }, { name: 'done', label: L('Done', 'Hecho'), required: true, enum: ['yes', 'no'] }] },
      { name: 'risks', label: L('Risks', 'Riesgos'), type: 'rows', required: true, max: 15, hint: 'What could stop it and what is done about it.', columns: [{ name: 'risk', label: L('Risk', 'Riesgo'), required: true }, { name: 'mitigation', label: L('Mitigation', 'Mitigación') }] },
      table('team', 'Team', 'Equipo', 'Who does it.', 'Quién lo hace.', [col('role', 'Role', 'Rol', { required: true }), col('team', 'Team', 'Equipo', { required: true })], { required: true, max: 15 }),
      md('done', 'Definition of done', 'Definición de terminado', 'What must be true to call it finished.', 'Qué debe ser cierto para darlo por terminado.', { required: true, max: 600 }),
    ],
    example: { title: 'Partial returns', status: 'active', summary: 'Returns of part of an order, by December.', fields: { goal: 'A customer can return some lines of an order.', team: [{ role: 'Back end', team: 'Commerce' }], done: 'Customers return part of an order from the portal and the flow passes.', milestones: [{ milestone: 'Contract agreed', date: '2026-11-15', done: 'no' }], risks: [{ risk: 'Stripe partial refunds limits', mitigation: 'Spike in week one' }] } },
  },
  decision: {
    type: 'decision', prefix: 'dec', label: L('Decision', 'Decisión'), question: L('Why is it like this?', '¿Por qué es así?'),
    folder: 'decisions', statuses: ['proposed', 'accepted', 'superseded', 'rejected'], livesIn: ANY, stage: 'design', anchors: 'optional',
    meta: [{ name: 'supersedes', ref: ['dec:'], hint: 'The decision this one replaces; that one becomes superseded.' }, { name: 'number', hint: 'DEC-0001: given when it is created, in order, and never reused.' }],
    fields: [
      { name: 'context', label: L('Context', 'Contexto'), type: 'markdown', required: true, max: 1500, hint: 'The forces at play when the decision was taken.' },
      { name: 'decision', label: L('Decision', 'Decisión'), type: 'markdown', required: true, max: 1000, hint: 'What was decided, in the active voice.' },
      { name: 'alternatives', label: L('Alternatives', 'Alternativas'), type: 'rows', required: true, max: 8, hint: 'What else was considered and why it lost.', columns: [{ name: 'option', label: L('Option', 'Opción'), required: true }, { name: 'why-not', label: L('Why not', 'Por qué no'), required: true }] },
      { name: 'tradeoffs', label: L('What we give up', 'Lo que se pierde'), type: 'markdown', required: true, max: 800, hint: 'The price of the decision. A decision without a price has not been understood.' },
      md('compliance', 'Compliance status', 'Estado de cumplimiento', 'Whether the code follows it today, and where it does not.', 'Si el código la cumple hoy y dónde no.', { max: 600 }),
    ],
    example: { title: 'Refunds are asynchronous', status: 'accepted', meta: { number: 'DEC-0001' }, summary: 'Refunds go through a queue, not inside the request.', fields: { context: 'Stripe can take seconds to answer and the request must not hold a connection that long.', decision: 'The request records the refund as pending and a worker sends it.', alternatives: [{ option: 'Call Stripe inside the request', 'why-not': 'Timeouts reach the customer' }], tradeoffs: 'The customer does not see the result immediately; they get an email.' } },
  },
  contract: {
    type: 'contract', prefix: 'ctr', label: L('Contract', 'Contrato'), question: L('What does it expose or consume, and with which shape?', '¿Qué expone o consume y con qué forma?'),
    folder: 'contracts', statuses: LIFECYCLE, legacyStatuses: ['proposed', 'implemented'], livesIn: ['module', 'service', 'external'], stage: 'design', anchors: 'no',
    fields: [
      { ...purpose('Who uses this interface and for what.'), label: L('Overview', 'Visión general'), alias: ['Propósito', 'Purpose'] },
      md('auth', 'Authentication', 'Autenticación', 'How a caller proves who it is, and what it may do.', 'Cómo se identifica quien llama y qué puede hacer.', { required: true, max: 600 }),
      { name: 'operations', label: L('Operations', 'Operaciones'), type: 'rows', max: 60, hint: 'Each operation with the service that should expose it. Contrasted with the extracted endpoints in both directions.', columns: [{ name: 'method', label: L('Method', 'Método'), required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, { name: 'path', label: L('Path', 'Ruta'), required: true }, { name: 'service', label: L('Service', 'Servicio'), required: true, ref: SERVICE }, { name: 'summary', label: L('Summary', 'Resumen') }] },
      { name: 'events', label: L('Events', 'Eventos'), type: 'rows', max: 30, hint: 'Topics it publishes or consumes.', columns: [{ name: 'topic', label: L('Topic', 'Tema'), required: true }, { name: 'direction', label: L('Direction', 'Dirección'), required: true, enum: ['publishes', 'consumes'] }, { name: 'service', label: L('Service', 'Servicio'), required: true, ref: SERVICE }, { name: 'payload', label: L('Payload', 'Contenido') }] },
      { name: 'errors', label: L('Errors and compatibility', 'Errores y compatibilidad'), alias: ['Errores', 'Errors'], type: 'rows', required: true, max: 20, hint: 'Error answers a caller must handle.', columns: [{ name: 'status', label: L('Status', 'Estado'), required: true }, { name: 'when', label: L('When', 'Cuándo'), required: true }] },
      md('versioning', 'Contract versioning', 'Versionado del contrato', 'How it changes without breaking callers: versions, deprecation, compatibility.', 'Cómo cambia sin romper a quien llama: versiones, deprecación, compatibilidad.', { max: 600 }),
    ],
    example: { title: 'Returns API', status: 'draft', summary: 'What the portal calls to return an order.', fields: { purpose: 'The portal asks for a return and follows its state.', auth: 'The portal sends the customer token; only the owner of the order may ask for its return.', operations: [{ method: 'POST', path: '/returns', service: 'svc:shop-api', summary: 'Ask for a return' }], errors: [{ status: '409', when: 'The order was already returned' }] } },
  },
  'data-model': {
    type: 'data-model', prefix: 'dm', label: L('Data model', 'Modelo de datos'), question: L('Which data exists, and with which rules?', '¿Qué datos hay y con qué reglas?'),
    folder: 'data-models', statuses: LIFECYCLE, livesIn: ['application', 'module', 'datastore'], stage: 'design', anchors: 'no',
    fields: [
      purpose('What this model describes and at which distance: the whole system, one feature, one store.'),
      { name: 'entities', label: L('Entities', 'Entidades'), type: 'rows', required: true, max: 40, hint: 'Each entity with its table and the service that owns it. Contrasted with the extracted tables.', columns: [{ name: 'entity', label: L('Entity', 'Entidad'), required: true }, { name: 'table', label: L('Table', 'Tabla') }, { name: 'owner', label: L('Owner', 'Dueño'), ref: SERVICE }, { name: 'notes', label: L('Notes', 'Notas') }] },
      { name: 'rules', label: L('Rules', 'Reglas'), type: 'list', max: 20, hint: 'Invariants over the data.' },
      { name: 'level', label: L('Level', 'Nivel'), type: 'text', required: true, max: 20, hint: 'conceptual, logical or physical.', hintEs: 'conceptual, lógico o físico.' },
      md('er', 'Diagram', 'Diagrama', 'The model as an ER diagram (a fenced mermaid block). A physical model is drawn from the extracted tables.', 'El modelo como diagrama ER (un bloque mermaid). Un modelo físico se dibuja desde las tablas extraídas.', { diagram: 'optional', kinds: ['data-model', 'data-flow', 'state'] }),
    ],
    example: { title: 'Returns data', status: 'active', summary: 'The tables and rules behind a return: what is stored, who owns it and what must hold.', fields: { purpose: 'The data of the returns feature.', level: 'logical', entities: [{ entity: 'Return', table: 'shop.returns', owner: 'svc:shop-api' }], rules: ['A return never exceeds what was paid'] } },
  },
  convention: {
    type: 'convention', prefix: 'conv', label: L('Convention', 'Convención'), question: L('How is it done here?', '¿Cómo se hace aquí?'),
    folder: 'conventions', statuses: LIFECYCLE, livesIn: ['application', 'module', 'repository'], stage: 'build', anchors: 'optional',
    meta: [{ name: 'overrides', ref: ['conv:'], hint: 'A convention above that this one hardens or replaces in this branch.' }],
    fields: [
      { name: 'rule', label: L('Rule', 'Regla'), type: 'markdown', required: true, max: 600, hint: 'The rule, in one or two sentences.' },
      { name: 'rationale', label: L('Why', 'Por qué'), type: 'markdown', required: true, max: 800, hint: 'What goes wrong without it.' },
      { name: 'good', label: L('Good example', 'Ejemplo bueno'), type: 'markdown', required: true, max: 1500, hint: 'A short example that follows it, usually code.' },
      { name: 'bad', label: L('Bad example', 'Ejemplo malo'), type: 'markdown', max: 1500, hint: 'A short example that breaks it.' },
      { name: 'check', label: L('Check', 'Comprobación'), type: 'list', max: 5, hint: '`forbid: <regex>` or `require: <regex>`, applied to the files the convention covers.' },
      items('exceptions', 'Exceptions', 'Excepciones', 'Where it does not apply and why.', 'Dónde no aplica y por qué.', { max: 8 }),
    ],
    example: { title: 'Errors as problem details', status: 'active', summary: 'HTTP errors answer RFC 9457 problem details.', fields: { rule: 'Every 4xx and 5xx answer has the `application/problem+json` shape.', rationale: 'Clients handle one error shape instead of one per service.', good: '`return ResponseEntity.of(ProblemDetail.forStatus(404)).build();`', check: ['forbid: ResponseEntity\\.status\\(\\d+\\)\\.body\\("'] } },
  },
  guide: {
    type: 'guide', prefix: 'guide', label: L('Guide', 'Guía'), question: L('How do I do X here?', '¿Cómo hago X aquí?'),
    folder: 'guides', statuses: LIFECYCLE, livesIn: ['application', 'repository'], stage: 'build', anchors: 'optional',
    fields: [
      { name: 'goal', label: L('Goal', 'Objetivo'), type: 'markdown', required: true, max: 500, hint: 'What you can do once you have followed it.' },
      { name: 'steps', label: L('Steps', 'Pasos'), type: 'list', required: true, max: 25, hint: 'In order, one action each.' },
      { name: 'troubleshooting', label: L('When it fails', 'Cuando falla'), type: 'rows', max: 15, hint: 'Symptom and fix.', columns: [{ name: 'symptom', label: L('Symptom', 'Síntoma'), required: true }, { name: 'fix', label: L('Fix', 'Arreglo'), required: true }] },
    ],
    example: { title: 'Add an endpoint', status: 'active', summary: 'The steps to add an endpoint, from its contract as a draft to a green flow.', fields: { goal: 'A new endpoint, documented and tested.', steps: ['Write the contract as proposed', 'Implement it', 'Run the affected flows'] } },
  },
  'test-plan': {
    type: 'test-plan', prefix: 'tp', label: L('Test plan', 'Plan de pruebas'), question: L('What must be tested, and at which level?', '¿Qué debe probarse y a qué nivel?'),
    folder: 'test-plans', statuses: LIFECYCLE, livesIn: ['application', 'module', 'process'], stage: 'test', anchors: 'no',
    fields: [
      { name: 'strategy', label: L('Strategy', 'Estrategia'), type: 'markdown', required: true, max: 1200, hint: 'How it is tested and why: which levels carry the weight.' },
      { name: 'scope', label: L('Scope', 'Alcance'), type: 'rows', required: true, max: 30, hint: 'One row per target with the levels it needs: unit, integration, contract, e2e.', columns: [{ name: 'target', label: L('Target', 'Objetivo'), required: true, ref: MODULE_OR_PROCESS }, { name: 'levels', label: L('Levels', 'Niveles'), required: true }, { name: 'minimum', label: L('Minimum', 'Mínimo') }] },
      md('environments', 'Environments and test data', 'Entornos y datos de prueba', 'Which env and scenario each level runs on.', 'En qué entorno y escenario corre cada nivel.', { required: true, max: 800 }),
      md('criteria', 'Acceptance and exit criteria', 'Criterios de aceptación y salida', 'When the testing is done and what blocks a release.', 'Cuándo se da por terminada la prueba y qué bloquea una entrega.', { required: true, max: 800 }),
      items('not-tested', 'What is not tested', 'Qué no se prueba', 'What is left out on purpose and why.', 'Qué se deja fuera a propósito y por qué.', { max: 10 }),
    ],
    example: { title: 'Returns tests', status: 'active', summary: 'Contract and end-to-end tests for returns.', fields: { strategy: 'The flow carries the weight: a return is only real when the money moves.', environments: 'Contract tests run on the local environment; the flow runs on the full one with the card mocked.', criteria: 'Every state of a return has a passing flow; a failing flow blocks the release.', scope: [{ target: 'mod:returns', levels: 'contract, e2e', minimum: 'one flow per state' }] } },
  },
  flow: {
    type: 'flow', prefix: 'flow', label: L('Flow', 'Flujo'), question: L('Which business journey is tested end to end?', '¿Qué recorrido de negocio se prueba de punta a punta?'),
    folder: 'flows', statuses: LIFECYCLE, livesIn: ['process', 'module'], stage: 'test', anchors: 'no',
    meta: [
      { name: 'realizes', ref: ['proc:'], hint: 'The process this journey walks through.' },
      { name: 'needs', ref: ['svc:', 'ds:', 'ext:'], list: true, hint: 'What must be running for it: services, stores and externals.' },
      { name: 'scenario', ref: ['scn:'], hint: 'The state it starts from: applied before it is played, once for every flow of a run that names it.' },
      { name: 'timeout', hint: 'How long it may run before it is cut: 30s, 2m, 1h (1 s to 2 h). Without it the runner\'s 5 minutes apply.' },
    ],
    fields: [
      { name: 'goal', label: L('Goal', 'Objetivo'), type: 'markdown', required: true, max: 800, hint: 'What the journey proves.' },
      { name: 'actors', label: L('Actors', 'Actores'), type: 'list', required: true, max: 8, hint: 'Who takes part.' },
      { name: 'preconditions', label: L('Preconditions', 'Precondiciones'), type: 'rows', max: 10, hint: 'What exists before the journey: an account, a file. The spec makes each row in prepare(), before the story\'s first step; underneath (the API, a session) only when «Proven in» names a flow that walks that path on screen (its story plays its Steps, each step checking what the person sees), does not prepare that same data underneath itself and relies only on flows that do the same.', columns: [{ name: 'data', label: L('Data', 'Dato'), required: true }, { name: 'proven', label: L('Proven in', 'Probado en'), ref: ['flow:'] }] },
      { name: 'steps', label: L('Steps', 'Pasos'), type: 'rows', required: true, max: 20, hint: 'The story, step by step: what a person does on screen and what they see there. These become the steps of the recorded test, with no API call inside.', columns: [{ name: 'step', label: L('Step', 'Paso'), required: true }, { name: 'actor', label: L('Actor', 'Actor'), required: true }, { name: 'service', label: L('Service', 'Servicio'), ref: SERVICE }, { name: 'expected', label: L('Expected', 'Se espera'), required: true }] },
      { name: 'cases', label: L('Short cases', 'Casos cortos'), type: 'rows', max: 20, hint: 'Variations tested apart from the story. Each form the story fills has validation cases (empty, format, limits, permission) that check the message shown; a case no person can cause from the screen is api.', columns: [{ name: 'case', label: L('Case', 'Caso'), required: true }, { name: 'expected', label: L('Expected', 'Se espera'), required: true }, { name: 'kind', label: L('Type', 'Tipo'), enum: ['validation', 'api', 'variation'] }] },
      { name: 'validated', label: L('Validations in', 'Validaciones en'), type: 'refs', ref: ['flow:'], max: 5, hint: 'The flows that hold the validation cases of the forms this story fills through a shared helper (sign-in, upload) and does not test itself: each such form needs a flow here whose validation case, played on screen, fills it last itself, inline or with the function that fills it.' },
    ],
    example: { title: 'Return a paid order', status: 'active', summary: 'A customer returns a paid order and gets the money back.', meta: { needs: ['svc:shop-api'] }, fields: { goal: 'The money of a returned order goes back to the card.', actors: ['Customer'], preconditions: [{ data: 'A customer with a paid order' }], steps: [{ step: 'Open the order', actor: 'Customer', service: 'svc:shop-api', expected: 'The order shows as paid' }, { step: 'Ask for the return', actor: 'Customer', service: 'svc:shop-api', expected: 'The return shows as pending' }], cases: [{ case: 'Reason left empty', expected: 'The form says the reason is required', kind: 'validation' }, { case: 'Order not paid', expected: 'The return is refused', kind: 'variation' }] } },
  },
  scenario: {
    type: 'scenario', prefix: 'scn', label: L('Scenario', 'Escenario'), question: L('What state must the system be in to test or show this?', '¿En qué estado tiene que estar el sistema para probar o enseñar esto?'),
    folder: 'scenarios', statuses: LIFECYCLE, livesIn: ['application', 'module', 'process'], stage: 'test', anchors: 'no',
    meta: [
      { name: 'env', hint: 'The env it is applied on; default local.' },
      { name: 'needs', ref: ['svc:', 'ds:', 'ext:'], list: true, hint: 'What must be running for its setup.' },
      { name: 'extends', ref: ['scn:'], hint: 'A scenario this one starts from: it shares its snapshot and only changes mocks and faults, with no setup of its own.' },
      { name: 'exclusive', hint: 'true when it needs a store that is empty, not only a fresh account: it runs alone, at the end of a run, restored from its snapshot. Without it a run seeds the scenario for each flow, with its own names, beside the others.' },
    ],
    fields: [
      { name: 'given', label: L('Given', 'Estado'), type: 'rows', required: true, max: 15, hint: 'What is true once it is applied, one row each: the data, who can sign in, how an external answers.', columns: [{ name: 'kind', label: L('Kind', 'Clase'), required: true, enum: ['data', 'identity', 'mock', 'fault'] }, { name: 'what', label: L('What', 'Qué'), required: true }] },
      { name: 'mocks', label: L('Mocks', 'Mocks'), type: 'rows', max: 10, hint: 'How each mocked dependency answers while it is applied.', columns: [{ name: 'service', label: L('Service', 'Servicio'), required: true }, { name: 'mode', label: L('Mode', 'Modo'), required: true, enum: ['contract', 'record', 'simulate', 'spy', 'script'] }] },
      { name: 'faults', label: L('Faults', 'Fallos'), type: 'rows', max: 10, hint: 'Faults on an edge while it is applied: latency in ms, a status answered instead, a probability. On a mail or SMS mailbox the method is the stage (CONNECT, AUTH, MAIL, RCPT, DATA, DELIVERY, POST), the path the recipient and the code the provider\'s own.', columns: [{ name: 'service', label: L('Service', 'Servicio'), required: true }, { name: 'latency', label: L('Latency (ms)', 'Latencia (ms)') }, { name: 'status', label: L('Status', 'Estado HTTP') }, { name: 'p', label: L('Probability', 'Probabilidad') }, { name: 'method', label: L('Method or stage', 'Método o etapa') }, { name: 'path', label: L('Path or recipient', 'Ruta o destinatario') }, { name: 'code', label: L('Provider code', 'Código del proveedor') }] },
      { name: 'mailbox', label: L('Mailbox', 'Buzón'), type: 'rows', max: 5, hint: 'What happens to the env\'s mailbox when it is applied: `clear` empties it; `inbound-sms` sends the app an incoming text once everything else is applied (detail: `+57300555…: STOP`, the number and the text).', columns: [{ name: 'action', label: L('Action', 'Acción'), required: true }, { name: 'detail', label: L('Detail', 'Detalle') }] },
      { name: 'restart', label: L('Restart', 'Reiniciar'), type: 'refs', ref: SERVICE, max: 10, hint: 'Services that keep state in memory and are restarted when it is applied.' },
    ],
    example: { title: 'A customer with a paid order', status: 'active', summary: 'One customer, one paid order, the card mocked.', meta: { needs: ['svc:shop-api'] }, fields: { given: [{ kind: 'identity', what: 'ana, a customer, signed in (password from vars.CUSTOMER_PASSWORD)' }, { kind: 'data', what: 'Order A-1042, paid with a card' }, { kind: 'mock', what: 'The card provider answers from its recordings' }], mocks: [{ service: 'stripe', mode: 'simulate' }] } },
  },
  runbook: {
    type: 'runbook', prefix: 'rb', label: L('Runbook', 'Runbook'), question: L('What do I do when it fails? (older: a guide of the application now)', '¿Qué hago cuando falla? (antiguo: ahora es una guía del aplicativo)'),
    folder: 'runbooks', statuses: LIFECYCLE, livesIn: ['service', 'datastore', 'external', 'application'], stage: 'operate', anchors: 'no',
    fields: [
      { name: 'symptoms', label: L('When to use it', 'Cuándo usarlo'), alias: ['Síntomas', 'Symptoms'], type: 'list', required: true, max: 12, hint: 'What you see when this happens.' },
      { name: 'diagnosis', label: L('Diagnosis', 'Diagnóstico'), type: 'list', required: true, max: 15, hint: 'Checks in order, with the exact command or screen.' },
      { name: 'fix', label: L('Fix', 'Arreglo'), type: 'list', required: true, max: 15, hint: 'What restores the service.' },
      { name: 'escalation', label: L('Escalation', 'Escalado'), type: 'markdown', max: 500, hint: 'Which team, and when.' },
      production('Name the participant: a service, a data store or an external.'),
      items('requirements', 'Requirements', 'Requisitos', 'What you need before you start: access, tools.', 'Qué necesitas antes de empezar: accesos, herramientas.', { max: 8 }),
      items('verify', 'Verification', 'Verificación', 'How you know it is fixed.', 'Cómo sabes que quedó arreglado.', { required: true, max: 8 }),
    ],
    example: { title: 'Refunds stuck as pending', status: 'active', summary: 'What to do when refunds stay pending: where to look, how to fix it and how to check.', fields: { symptoms: ['Returns stay pending for more than an hour'], diagnosis: ['Look at the worker logs for timeouts'], fix: ['Restart the worker; it retries pending refunds'], verify: ['The pending refunds count drops to zero'] } },
  },
  architecture: {
    type: 'architecture', prefix: 'arch', label: L('Architecture', 'Arquitectura'), question: L('How is it built, and why in that shape?', '¿Cómo está construido y por qué con esa forma?'),
    folder: 'architecture', statuses: LIFECYCLE, expects: ['decided_by'], livesIn: ['application'], stage: 'design', anchors: 'no',
    fields: [
      table('components', 'Key components', 'Componentes clave', 'The parts that matter and what each is for. The context (C4 level 1) and containers (level 2) are drawn from the map.', 'Las piezas que importan y para qué sirve cada una. El contexto (C4 nivel 1) y los contenedores (nivel 2) se dibujan desde el mapa.', [col('component', 'Component', 'Componente', { required: true }), col('role', 'Role', 'Papel', { required: true }), col('tech', 'Technology', 'Tecnología')], { required: true, max: 30 }),
      md('views', 'Views', 'Vistas', 'The system drawn (fenced mermaid blocks): its context (C4 level 1, who uses it and which systems it talks to) and its containers (C4 level 2, the deployable parts and how they talk). The map proposes both; the intent the code does not show is added here.', 'El sistema dibujado (bloques mermaid): su contexto (C4 nivel 1, quién lo usa y con qué sistemas habla) y sus contenedores (C4 nivel 2, las piezas desplegables y cómo se hablan). El mapa propone los dos; aquí se añade la intención que el código no muestra.', { required: true, diagram: 'required', kinds: ['c4-context', 'c4-container', 'integration'], max: 3000 }),
      { name: 'decisions', label: L('Decisions', 'Decisiones'), type: 'refs', required: true, ref: ['dec:'], max: 20, hint: 'The decisions that shaped it.', hintEs: 'Las decisiones que la moldearon.' },
      table('risks', 'Risks and debt', 'Riesgos y deuda', 'What could hurt and what is owed.', 'Qué podría doler y qué se debe.', [col('risk', 'Risk', 'Riesgo', { required: true }), col('mitigation', 'Mitigation', 'Mitigación')], { max: 15 }),
    ],
    example: { title: 'Shop architecture', status: 'active', summary: 'How the shop is put together: services, stores and the decisions behind them.', relations: { decided_by: ['dec:refunds-are-asynchronous'] }, fields: { components: [{ component: 'shop-api', role: 'Orders and payments', tech: 'Spring Boot' }, { component: 'postgres', role: 'Orders store', tech: 'PostgreSQL' }], views: '```mermaid\nC4Container\n  title Shop, containers\n  Person(customer, "Customer")\n  System_Boundary(shop, "Shop") {\n    Container(api, "shop-api", "Spring Boot", "Orders and payments")\n    ContainerDb(db, "postgres", "PostgreSQL", "Orders")\n  }\n  System_Ext(stripe, "Stripe", "Card payments")\n  Rel(customer, api, "Orders and pays", "HTTPS")\n  Rel(api, db, "Reads and writes", "JDBC")\n  Rel(api, stripe, "Charges", "REST")\n```', decisions: ['dec:refunds-are-asynchronous'], risks: [{ risk: 'One database for every service', mitigation: 'A schema per service' }] } },
  },
  versioning: {
    type: 'versioning', prefix: 'ver', label: L('Versioning', 'Versionamiento'), question: L('How do branches, versions and releases work here?', '¿Cómo funcionan aquí las ramas, las versiones y las entregas?'),
    folder: 'versioning', statuses: LIFECYCLE, expects: ['relates_to'], livesIn: ['application', 'repository'], stage: 'build', anchors: 'no',
    fields: [
      table('branches', 'Branch strategy', 'Estrategia de ramas', 'Each kind of branch: its pattern, what it is for, where it starts and how long it lives. Laru reads the live branches from git and checks them against this table.', 'Cada tipo de rama: su patrón, para qué sirve, de dónde sale y cuánto vive. Laru lee las ramas vivas de git y las contrasta con esta tabla.', [col('pattern', 'Pattern', 'Patrón', { required: true }), col('purpose', 'Purpose', 'Para qué', { required: true }), col('from', 'Starts from', 'Sale de'), col('lifetime', 'Lifetime', 'Vida máxima')], { required: true, max: 12 }),
      md('graph', 'Branches and releases', 'Ramas y entregas', 'The strategy drawn (a fenced mermaid gitGraph block): where each kind of branch starts and merges, where a release is tagged and how an urgent fix goes back.', 'La estrategia dibujada (un bloque mermaid gitGraph): de dónde sale y adónde vuelve cada tipo de rama, dónde se etiqueta una entrega y cómo regresa un arreglo urgente.', { required: true, diagram: 'required', kinds: ['versioning'] }),
      md('numbering', 'Version numbering', 'Numeración de versiones', 'How a version number is chosen (semver, calendar) and what bumps it.', 'Cómo se elige el número de versión (semver, calendario) y qué lo sube.', { required: true, max: 800 }),
      md('releases', 'Tags and releases', 'Tags y releases', 'How a release is cut, tagged and published.', 'Cómo se corta, se etiqueta y se publica una entrega.', { required: true, max: 800 }),
      md('changelog', 'Changelog', 'Changelog', 'Where changes are recorded and who writes them.', 'Dónde se anotan los cambios y quién los escribe.', { required: true, max: 600 }),
      md('support', 'Compatibility and support', 'Compatibilidad y soporte', 'Which versions are supported and for how long.', 'Qué versiones se soportan y por cuánto tiempo.', { max: 600 }),
    ],
    example: { title: 'Shop versioning', status: 'active', summary: 'Trunk-based branches and semantic versions for every repository.', relations: { relates_to: ['svc:shop-api'] }, fields: { branches: [{ pattern: 'main', purpose: 'Always releasable', from: '-', lifetime: 'permanent' }, { pattern: 'feature/*', purpose: 'One change', from: 'main', lifetime: '5 days' }], graph: '```mermaid\n---\ntitle: Shop branches\n---\ngitGraph\n  commit id: "start"\n  branch feature/returns\n  commit id: "partial returns"\n  checkout main\n  merge feature/returns tag: "v1.4.0"\n  branch hotfix/refund\n  commit id: "refund rounding"\n  checkout main\n  merge hotfix/refund tag: "v1.4.1"\n```', numbering: 'Semantic: a breaking API change bumps the major.', releases: 'A tag vX.Y.Z on main publishes the images.', changelog: 'CHANGELOG.md, written in the pull request.' } },
  },
  artifact: {
    type: 'artifact', prefix: 'artifact', label: L('Artifact', 'Artefacto'), question: L('What does it publish for others to consume, and how?', '¿Qué publica para que otros lo consuman y cómo?'),
    folder: 'artifacts', statuses: LIFECYCLE, livesIn: ['application', 'module', 'repository'], stage: 'build', anchors: 'optional',
    fields: [
      md('overview', 'What it is and what it solves', 'Qué es y qué resuelve', 'What it publishes (a library, a container image, a package, a reusable pipeline, a shared schema), for whom, and what it does NOT solve.', 'Qué publica (una librería, una imagen de contenedor, un paquete, un pipeline reutilizable, un esquema compartido), para quién y qué NO resuelve.', { required: true, max: 800 }),
      md('consumption', 'How it is consumed', 'Cómo se consume', 'The exact coordinate (group, name, version), the registry it lives in, and the smallest usage example.', 'La coordenada exacta (grupo, nombre, versión), el registro donde vive y el ejemplo de uso más pequeño.', { required: true, max: 800 }),
      md('versioning', 'Versioning and compatibility', 'Versionado y compatibilidad', 'Version scheme, which change breaks compatibility, how many versions are supported and how long a deprecation lasts.', 'Esquema de versiones, qué cambio rompe la compatibilidad, cuántas versiones se mantienen y cuánto dura una retirada.', { required: true, max: 600 }),
      table('consumers', 'Who consumes it', 'Quién lo consume', 'Consumer, the version it uses and since when: it says who to warn before breaking something.', 'Consumidor, la versión que usa y desde cuándo: dice a quién avisar antes de romper algo.', [col('consumer', 'Consumer', 'Consumidor', { required: true }), col('version', 'Version', 'Versión', { required: true }), col('since', 'Since', 'Desde')], { required: true, max: 20 }),
      md('publication', 'How it is published', 'Cómo se publica', 'What triggers publication, which pipeline builds it, where it is signed and who may publish by hand.', 'Qué dispara la publicación, qué pipeline lo construye, dónde se firma y quién puede publicar a mano.', { max: 600 }),
    ],
    example: { title: 'Payments client', status: 'active', summary: 'The Java client of the payments API: signs requests and remembers the idempotency key.', fields: {
      overview: 'A Java client for the payments API: it signs the request and turns a 202 into a future. It does not hide the API or retry for you.',
      consumption: 'com.example.payments:gateway-client:2.4.1, from the internal Maven registry.',
      versioning: 'Semantic versions; a removed method is a major change. The last two minors are supported.',
      consumers: [{ consumer: 'shop-api', version: '2.4.1', since: '2025-03' }],
    } },
  },
  stack: {
    type: 'stack', prefix: 'stack', label: L('Stack', 'Stack'), question: L('Which technologies does it run on, and how are they kept up to date?', '¿Sobre qué tecnologías corre y cómo se mantienen al día?'),
    folder: 'stacks', statuses: LIFECYCLE, livesIn: ['application', 'repository'], stage: 'build', anchors: 'no',
    fields: [
      md('overview', 'Summary', 'Resumen', 'The stack in a paragraph. Versions are extracted from the repos.', 'El stack en un párrafo. Las versiones se extraen de los repos.', { required: true, max: 800 }),
      table('critical', 'Critical dependencies', 'Dependencias críticas', 'What the application cannot live without and why.', 'Sin qué no puede vivir la aplicación y por qué.', [col('dependency', 'Dependency', 'Dependencia', { required: true }), col('why', 'Why', 'Por qué')], { max: 15 }),
      md('updates', 'Update policy', 'Política de actualización', 'How often and how dependencies are updated, and who decides.', 'Cada cuánto y cómo se actualizan las dependencias, y quién decide.', { required: true, max: 600 }),
    ],
    example: { title: 'Shop stack', status: 'active', summary: 'Java and Spring Boot services on PostgreSQL, with an Angular front end.', fields: { overview: 'Java 21 and Spring Boot 3 services, an Angular front end, PostgreSQL.', updates: 'Dependabot weekly; a major version needs a decision.' } },
  },
  infrastructure: {
    type: 'infrastructure', prefix: 'infra', label: L('Infrastructure', 'Infraestructura'), question: L('Where does it run in production, and how is it watched?', '¿Dónde corre en producción y cómo se vigila?'),
    folder: 'infrastructure', statuses: LIFECYCLE, expects: ['depends_on'], livesIn: ['application'], stage: 'operate', anchors: 'no',
    fields: [
      table('envs', 'Production environments', 'Entornos de producción', 'Each environment: its address, what it is for, who deploys and what data it holds.', 'Cada entorno: su dirección, para qué es, quién despliega y qué datos tiene.', [col('env', 'Environment', 'Entorno', { required: true }), col('url', 'URL', 'URL'), col('purpose', 'Purpose', 'Para qué'), col('deploys', 'Deployed by', 'Quién despliega'), col('data', 'Data', 'Datos')], { required: true, max: 10 }),
      md('topology', 'Production topology', 'Topología de producción', 'How the pieces are laid out in production, with a diagram (a fenced mermaid block, deployment style).', 'Cómo se reparten las piezas en producción, con un diagrama (un bloque mermaid, estilo despliegue).', { required: true, diagram: 'required', kinds: ['deployment'] }),
      md('network', 'Network and security', 'Red y seguridad', 'What is exposed, behind what, and how it is protected, with a diagram of the zones and the traffic allowed between them (a fenced mermaid block).', 'Qué se expone, detrás de qué y cómo se protege, con un diagrama de las zonas y el tráfico permitido entre ellas (un bloque mermaid).', { required: true, diagram: 'required', kinds: ['network'], max: 1500 }),
      md('observability', 'Observability', 'Observabilidad', 'Logs, metrics, traces, alerts and who gets paged.', 'Logs, métricas, trazas, alertas y a quién se avisa.', { required: true, max: 800 }),
      { ...production('Name the participant: a service, a data store or an external.'), label: L('Production aspects', 'Aspectos de producción') },
      md('continuity', 'Continuity', 'Continuidad', 'Backups, recovery targets and what happens when a zone fails.', 'Copias, objetivos de recuperación y qué pasa si cae una zona.', { max: 600 }),
      md('cost', 'Cost', 'Coste', 'What it costs and what drives it.', 'Lo que cuesta y qué lo mueve.', { max: 400 }),
    ],
    example: { title: 'Shop production', status: 'active', summary: 'Kubernetes in one region: how it is laid out, exposed and watched.', relations: { depends_on: ['svc:shop-api'] }, fields: { envs: [{ env: 'prod', url: 'https://shop.example', purpose: 'Customers', deploys: 'Platform team', data: 'Real' }], topology: '```mermaid\n---\ntitle: Production topology\n---\nflowchart LR\n  subgraph region["Region eu-west-1"]\n    k8s@{ icon: "logos:kubernetes", form: "square", label: "Cluster", pos: "b" }\n    db@{ icon: "logos:postgresql", form: "square", label: "Managed PostgreSQL", pos: "b" }\n  end\n  k8s -->|JDBC| db\n```', network: 'Only the ingress is public; services talk on the cluster network.\n\n```mermaid\n---\ntitle: Shop zones\n---\nflowchart LR\n  internet((Internet))\n  subgraph public["Public zone"]\n    ingress[Ingress]\n  end\n  subgraph cluster["Cluster network"]\n    api[shop-api]\n    db[(postgres)]\n  end\n  internet -->|HTTPS 443| ingress\n  ingress -->|HTTP| api\n  api -->|JDBC 5432| db\n```', observability: 'Logs to Loki, metrics to Prometheus, alerts to the platform on-call.' } },
  },
  secrets: {
    type: 'secrets', prefix: 'sec', label: L('Secrets', 'Secretos'), question: L('Which secrets does it need, where do they live and who rotates them?', '¿Qué secretos necesita, dónde viven y quién los rota?'),
    folder: 'secrets', statuses: LIFECYCLE, livesIn: ['application', 'module', 'service'], stage: 'operate', anchors: 'no',
    fields: [
      table('needs', 'What it needs', 'Qué necesita', 'Each secret by name (never its value): what for, where it lives, who rotates it and how often.', 'Cada secreto por su nombre (nunca su valor): para qué, dónde vive, quién lo rota y cada cuánto.', [col('secret', 'Secret', 'Secreto', { required: true }), col('purpose', 'Purpose', 'Para qué'), col('lives', 'Where it lives', 'Dónde vive'), col('rotates', 'Rotated by', 'Quién rota'), col('every', 'Every', 'Cada cuánto')], { required: true, max: 40 }),
      md('rotation', 'Rotation', 'Rotación', 'How a secret is rotated without downtime.', 'Cómo se rota un secreto sin caída.', { max: 600 }),
      items('never', 'What must never happen', 'Lo que nunca debe pasar', 'Rules about secrets: never in a repo, in a log, in a screenshot.', 'Reglas sobre secretos: nunca en un repo, en un log, en una captura.', { max: 8 }),
    ],
    example: { title: 'Shop secrets', status: 'active', summary: 'The secrets the shop needs, where each one lives and who rotates it, never its value.', fields: { needs: [{ secret: 'STRIPE_API_KEY', purpose: 'Charge cards', lives: 'The vault, level service', rotates: 'Platform team', every: '90 days' }] } },
  },
  glossary: {
    type: 'glossary', prefix: 'gls', label: L('Glossary', 'Glosario'), question: L('What do the words mean here?', '¿Qué significan aquí las palabras?'),
    folder: 'glossary', statuses: LIFECYCLE, livesIn: ['application', 'module'], stage: 'plan', anchors: 'no',
    fields: [
      table('terms', 'Terms', 'Términos', 'One row per word: its meaning, the other words people use, the names it takes in the code and where it applies.', 'Una fila por palabra: su significado, las otras palabras que se usan, los nombres que toma en el código y dónde aplica.', [col('term', 'Term', 'Término', { required: true }), col('definition', 'Definition', 'Definición', { required: true }), col('synonyms', 'Synonyms', 'Sinónimos'), col('code', 'In the code', 'En el código'), col('context', 'Context', 'Contexto')], { required: true, max: 80 }),
      items('avoid', 'Words we do not use', 'Palabras que no usamos', 'Words that mean something else here or are banned, and what to say instead.', 'Palabras que aquí significan otra cosa o están vetadas, y qué decir en su lugar.', { max: 15 }),
    ],
    example: { title: 'Shop glossary', status: 'active', summary: 'The words of the shop and what each one means, with the names they take in the code.', fields: { terms: [{ term: 'Credit note', definition: 'An invoice with negative amounts that cancels another one.', code: 'CreditNote' }] } },
  },
  term: {
    type: 'term', prefix: 'term', label: L('Term', 'Término'), question: L('What does this word mean here? (older: a glossary holds the words now)', '¿Qué significa esta palabra aquí? (antiguo: ahora las palabras van en un glosario)'),
    folder: 'terms', statuses: LIFECYCLE, livesIn: ['application', 'module'], anchors: 'no',
    fields: [
      { name: 'definition', label: L('Definition', 'Definición'), type: 'markdown', required: true, max: 600, hint: 'What it means in this application.' },
      { name: 'synonyms', label: L('Synonyms', 'Sinónimos'), type: 'list', max: 10, hint: 'Other words people use for it.' },
      { name: 'in-code', label: L('In the code', 'En el código'), type: 'list', max: 10, hint: 'Names it takes in the code: classes, tables, fields.' },
    ],
    example: { title: 'Credit note', status: 'active', summary: 'The invoice that cancels another one.', fields: { definition: 'An invoice with negative amounts that cancels all or part of an earlier one.', 'in-code': ['CreditNote', 'credit_notes'] } },
  },
  note: {
    type: 'note', prefix: 'note', label: L('Note', 'Nota'), question: L('What deserves to be remembered and fits nowhere else?', '¿Qué merece recordarse y no cabe en otra pieza?'),
    folder: 'notes', statuses: LIFECYCLE, livesIn: ANY, anchors: 'required',
    fields: [{ name: 'body', label: L('Note', 'Nota'), type: 'markdown', required: true, max: 1500, hint: 'Short, about the anchored code.' }],
    example: { title: 'Why the retry is 3', status: 'active', summary: 'The retry count matches Stripe idempotency windows.', anchors: ['shop:src/main/java/acme/RefundWorker.java'], fields: { body: 'Three retries fit in the 24 h idempotency window Stripe keeps.' } },
  },
};

/** The piece that holds each facet folder name: `decisions` → decision. */
for (const [t, s] of Object.entries(STANDARD)) for (const f of s.fields) f.hintEs ??= HINT_ES[`${t}.${f.name}`];

export const FACET_BY_FOLDER: Record<string, FacetType> = Object.fromEntries(FACETS.map((f) => [STANDARD[f].folder, f]));
export const CONTAINER_BY_FOLDER: Record<string, ContainerType> = Object.fromEntries(CONTAINERS.filter((c) => c !== 'application').map((c) => [STANDARD[c].folder, c]));
export const TYPE_BY_PREFIX: Record<string, PieceType> = Object.fromEntries(ALL_PIECE_TYPES.map((t) => [STANDARD[t].prefix, t]));

/** Which stages a container must cover, by class. The workspace profile can override it. */
export const DEFAULT_PROFILE: Record<string, Stage[]> = {
  application: ['plan', 'design', 'operate'],
  area: [],
  feature: ['design', 'build', 'test'],
  story: ['build', 'test'],
  process: ['design', 'test'],
  subprocess: ['test'],
  service: ['operate'],
};
