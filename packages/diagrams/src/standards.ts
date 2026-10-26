/**
 * The diagram standard, tied to the layers.
 *
 * A diagram is not a free drawing: every class has its Mermaid dialect, its shapes and its
 * colours, and whoever reads it has to understand it without asking. This file defines that
 * part of the standard —which classes exist, which layer each one answers from, which
 * question it answers, which shape means what and which rules it must respect— and checks
 * that a written diagram complies.
 *
 * Two things decide how a class is used. The **layer** says where it belongs, from what the
 * business is down to where it runs. The **origin** says who draws it: an `authored` class is
 * written by a person in a document; a `derived` one is computed by the system from the
 * catalogue and shown on the landscape pages. A derived class written by hand is a copy that
 * will rot, and the lint says so.
 *
 * C4 is the strictest case: its four levels have their own dialect in Mermaid (`C4Context`,
 * `C4Container`, `C4Component`) and drawing them with a hand-made `flowchart` is exactly what
 * makes a level 2 look nothing like a level 1.
 */
import { DIAGRAM_KINDS, SKINS, type DiagramKind, type DiagramSkin } from './kinds.ts';
import { fromMermaid, parseSequence, writeModel } from './model.ts';
import { paints, paintsKind } from './render/typed.ts';
import { propose } from './render/propose.ts';

const LAYERS = ['business', 'process', 'data', 'application', 'technology', 'infrastructure'] as const;
type Layer = (typeof LAYERS)[number];
type DataLevel = 'conceptual' | 'logical' | 'physical';
type DocType = string;
type NodeRole = 'repository' | 'application' | 'domain';

/*
 * The list of classes lives in `@laru/diagrams` because the web needs it too and
 * cannot import this package. Re-exported here so nothing that reads the core changes.
 */


/** Who draws the diagram: a person in a document, or the system from the catalogue. */
export type DiagramOrigin = 'authored' | 'derived';

export const DIAGRAM_ORIGIN_LABEL: Record<DiagramOrigin, string> = {
  authored: 'Written by hand',
  derived: 'Derived from the catalogue',
};

export interface DiagramRule {
  id: string;
  /** What it demands, in one sentence that reads well in the interface. */
  text: string;
  /** The values inside the sentence, for whoever writes it in another language. */
  params?: Record<string, string | number>;
  severity: 'error' | 'warning';
  /** Returns true when the code complies. Without a check, the rule is only guidance. */
  check?: (code: string) => boolean;
}


/*
 * The skin is how a diagram is drawn, so it lives with the renderer, in
 * `@laru/diagrams`. Re-exported here because the standard is what declares it.
 */


export interface DiagramStandard {
  kind: DiagramKind;
  label: string;
  /** The layer it answers from. */
  layer: Layer;
  /** The question it answers, in one line. */
  question: string;
  /** What it is for and what it must not be confused with. */
  purpose: string;
  /** Who draws it. A `derived` class is never written by hand. */
  origin: DiagramOrigin;
  /** Mandatory Mermaid dialect. The first one is what gets generated and what is expected. */
  dialect: string;
  /** Other accepted dialects, if any. */
  alsoAccepts: string[];
  /** What each shape or colour means: the legend that makes the diagram readable. */
  legend: Array<{ shape: string; means: string }>;
  rules: DiagramRule[];
  /** How many elements at most before it stops being readable. */
  maxNodes: number;
  /** Which document types it appears in. Empty on a derived class: it lives on its landscape page. */
  usedIn: DocType[];
  /**
   * How the engine paints it. Declared class by class as each renderer arrives; a class
   * without one is still drawn by Mermaid.
   */
  skin?: DiagramSkin;
  template: string;
  /**
   * The same template as the typed model, for every class the engine paints.
   *
   * The template has always been written in Mermaid and stays that way — it is the one copy,
   * and two copies of a drawing drift. But a drawing in this product **is** a typed block, so
   * what a reader, an author and an AI should be handed is the compiled form. It is attached
   * here for the same reason the skin is: so that everyone who shows a template shows the
   * same one. Before this, the page compiled it, the pack compiled it, and the editor did
   * not — three answers to one question, and the class that failed to compile fell back to
   * Mermaid in a manual whose whole point is that drawings are not written in Mermaid.
   *
   * Absent only where the engine cannot paint the class at all: `versioning`, whose gitGraph
   * is a history of commits rather than a graph of boxes.
   */
  typedTemplate?: string;
}

const countLines = (code: string, re: RegExp) => code.split('\n').filter((l) => re.test(l.trim())).length;

/** The lines that draw an edge, ignoring comments and the arrows inside labels. */
const edgeLines = (code: string) =>
  code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('%%') && /(--+>|==+>|-\.-*->|--+[ox]\b)/.test(l));

/** True when every edge says what travels through it, either as `|label|` or as `-- label -->`. */
const everyEdgeLabelled = (code: string) =>
  edgeLines(code).every((l) => /\|\s*\S[^|]*\|/.test(l) || /--+\s*[^-|>\s][^|>]*\s*--+>/.test(l) || /-\.\s*\S[^.]*\.-*->/.test(l));

/** Rules that hold for every class: without them no diagram reads. */
const common = (max: number): DiagramRule[] => [
  // Mermaid accepts the title inline (`title X`) or in its own frontmatter (`---\ntitle: X\n---`).
  { id: 'title', text: 'Has a title: `title` on the first line of the diagram, or in its frontmatter `---\ntitle: …\n---`.', severity: 'warning', check: (c) => /^\s*title[:\s]\s*\S/m.test(c) },
  { id: 'size', text: `No more than ${max} elements: above that it stops reading and has to be split.`, params: { max }, severity: 'warning' },
  { id: 'labels', text: 'Every arrow says what goes through it, and with which technology when that matters.', severity: 'warning' },
  /*
   * A semicolon ends a statement in Mermaid. Written inside a note or a message it splits
   * the sentence in two, the second half is read as a new statement, and the whole diagram
   * fails to parse — not the line, the diagram. It is invisible in the source and obvious
   * on the screen, which is the worst way round.
   */
  {
    id: 'semicolon',
    text: 'No semicolons outside a quoted label: Mermaid reads one as the end of a statement, and a note or a message containing one stops the whole diagram from drawing. Use a comma.',
    severity: 'error',
    check: (c) => !c.split('\n').some((line) => {
      const code = line.replace(/%%.*$/, '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
      return code.includes(';');
    }),
  },
];

/** The rule that says a class is not written by hand. The check lives in `lintDiagram`. */
const derivedRule = (from: string): DiagramRule => ({
  id: 'derived-diagram-authored',
  text: `Derived: the landscape page builds it from ${from}. Do not write it by hand — delete the block; the landscape page generates it. Export it as Mermaid if you need it inside a document.`,
  severity: 'error',
});

export const DIAGRAM_STANDARDS: Record<DiagramKind, DiagramStandard> = {
  // ── Business ────────────────────────────────────────────────────────────────

  'domain-map': {
    kind: 'domain-map',
    label: 'Domain map',
    layer: 'business',
    question: 'Which domains exist and how do they relate to each other?',
    purpose: 'The areas the business is made of and what each one owes the others. It is the first picture of the organisation, before any application appears: what is drawn here are domains, never systems.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'container', means: 'A domain, with the icon of its type: the icon is what tells one kind of piece from another, never the colour.' },
      { shape: 'facet', means: 'A document written about one of them: an architecture, a runbook, a decision.' },
      { shape: 'store', means: 'A data store, drawn as a cylinder.' },
      { shape: 'group', means: 'A frame around what goes together: a domain and its subdomains, or the pieces of one kind.' },
      { shape: '-->', means: 'A relation between domains, labelled with what one gives the other.' },
    ],
    rules: [
      ...common(20),
      derivedRule('the `domain` documents and their `owned_by` relations'),
      { id: 'dialect', text: 'Written in `flowchart`, with a `subgraph` per domain.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'domains', text: 'Every box is a domain, not an application: an application belongs in the application landscape.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) },
      { id: 'icons', text: 'The domains carry the `pd:domain` pack so they are told apart by shape and icon, not by colour.', severity: 'warning', check: (c) => /icon:\s*"pd:/.test(c) },
    ],
    maxNodes: 20,
    usedIn: [],
    template: [
      '---',
      'title: Domain map',
      '---',
      'flowchart LR',
      '    subgraph sales["Sales"]',
      '        s1@{ icon: "pd:domain", form: "square", label: "Ordering", pos: "b" }',
      '        s2@{ icon: "pd:domain", form: "square", label: "Billing", pos: "b" }',
      '    end',
      '    subgraph ops["Operations"]',
      '        o1@{ icon: "pd:domain", form: "square", label: "Fulfilment", pos: "b" }',
      '    end',
      '    s1 -->|confirmed orders| o1',
      '    o1 -->|delivery notes| s2',
    ].join('\n'),
  },

  'value-stream': {
    kind: 'value-stream',
    label: 'Value stream',
    layer: 'business',
    question: 'How is value created from end to end?',
    purpose: 'The chain of stages that turns a customer request into something delivered, with who owns each stage and how long it takes. It is written from the outside in: the stages are named after what the customer gets, never after the application that does it.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'A stage of the stream, named after the value it adds.' },
      { shape: 'group', means: 'The domain that owns a run of stages.' },
      { shape: '-->', means: 'A handover between stages, labelled with what is handed over and, when it is known, the lead time.' },
    ],
    rules: [
      ...common(15),
      { id: 'dialect', text: 'Written in `flowchart LR`: a value stream is read left to right, like time.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\s+LR\b/m.test(c) },
      { id: 'value', text: 'The stages are named after the value added ("Order accepted"), not after the application that does it.', severity: 'warning' },
      { id: 'handover', text: 'Every handover says what is handed over; if the lead time is known, it goes in the same label.', severity: 'warning', check: everyEdgeLabelled },
      { id: 'owner', text: 'Each run of stages sits inside the `subgraph` of the domain that owns it.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) },
    ],
    maxNodes: 15,
    usedIn: ['domain', 'process'],
    template: [
      '---',
      'title: Order to cash',
      '---',
      'flowchart LR',
      '    subgraph sales["Sales"]',
      '        a["Request received"]',
      '        b["Order accepted"]',
      '    end',
      '    subgraph ops["Operations"]',
      '        c["Goods delivered"]',
      '    end',
      '    subgraph fin["Finance"]',
      '        d["Payment collected"]',
      '    end',
      '    a -->|qualified request · 1 d| b',
      '    b -->|confirmed order · 2 d| c',
      '    c -->|delivery note · 1 d| d',
    ].join('\n'),
  },

  // ── Process ─────────────────────────────────────────────────────────────────

  'process-landscape': {
    kind: 'process-landscape',
    label: 'Process landscape',
    layer: 'process',
    question: 'Which processes exist and which contains which?',
    purpose: 'The tree of processes of the organisation: the top-level ones and the subprocesses hanging off each. It answers where a process sits, not how it runs — that is the process diagram.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'A process. What hangs off it is drawn inside its group.' },
      { shape: 'icon', means: 'The same process wearing the pack of its type, so it is recognised without being read.' },
      { shape: 'group', means: 'A parent process; inside it, its subprocesses.' },
      { shape: '-->', means: 'Precedence: the first process hands over to the second.' },
    ],
    rules: [
      ...common(30),
      derivedRule('the `process` documents and their `process:` field'),
      { id: 'dialect', text: 'Written in `flowchart` with nested `subgraph`s: the nesting is the hierarchy.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'hierarchy', text: 'A subprocess is drawn inside its parent, never as a loose box next to it.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) },
      { id: 'no-steps', text: 'Processes only: the steps of one process belong in that process diagram.', severity: 'warning' },
    ],
    maxNodes: 30,
    usedIn: [],
    template: [
      '---',
      'title: Process landscape',
      '---',
      'flowchart TB',
      '    subgraph sell["Selling"]',
      '        s1@{ icon: "pd:process", form: "square", label: "Quoting", pos: "b" }',
      '        s2@{ icon: "pd:process", form: "square", label: "Contracting", pos: "b" }',
      '    end',
      '    subgraph serve["Serving"]',
      '        v1@{ icon: "pd:process", form: "square", label: "Onboarding", pos: "b" }',
      '    end',
      '    s2 --> v1',
    ].join('\n'),
  },

  process: {
    kind: 'process',
    label: 'Process',
    layer: 'process',
    question: 'How does this process run, step by step and by whom?',
    purpose: 'The flow of a business or operational process: where it starts, what gets decided, who does each step and how it ends. The swimlanes are what turn a drawing into a process: without them nobody knows who is responsible for what.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: ['stateDiagram-v2'],
    legend: [
      { shape: 'stadium', means: 'Where the process starts and where it ends.' },
      { shape: 'rect', means: 'A step: something somebody does, in one sentence.' },
      { shape: 'diamond', means: 'A decision: two or more labelled paths come out of it.' },
      { shape: 'cylinder', means: 'Something that gets persisted.' },
      { shape: 'hexagon', means: 'Something outside the process: another system, or an event that leaves it.' },
      { shape: 'group', means: 'A swimlane: one role, one team or one application. Every step sits in exactly one.' },
      { shape: '-->', means: 'What comes next. Out of a decision, every path carries the answer that takes it.' },

    ],
    rules: [
      ...common(25),
      { id: 'dialect', text: 'Written in `flowchart` (or `stateDiagram-v2` when what is told are states).', severity: 'error', check: (c) => /^\s*(flowchart|graph|stateDiagram(-v2)?)\b/m.test(c) },
      { id: 'swimlanes', text: 'It has swimlanes: at least one `subgraph` per role, and every step inside one. A process without lanes does not say who does what.', severity: 'error', check: (c) => /stateDiagram/.test(c) || countLines(c, /^subgraph\b/) >= 1 },
      { id: 'direction', text: 'States its direction: `flowchart TD` top down, `LR` left to right.', severity: 'warning', check: (c) => /^\s*(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/m.test(c) || /stateDiagram/.test(c) },
      { id: 'decisions', text: 'Every branch out of a decision is labelled: `-->|Yes|`.', severity: 'warning', check: (c) => !/\{[^}]+\}/.test(c) || /--?>\|/.test(c) },
      { id: 'end', text: 'The process ends: there is at least one end node.', severity: 'warning' },
    ],
    maxNodes: 25,
    usedIn: ['process', 'runbook', 'adr', 'domain', 'module'],
    template: [
      '---',
      'title: Process',
      '---',
      'flowchart TD',
      '    subgraph customer["Customer"]',
      '        start([Starts when…])',
      '    end',
      '    subgraph agent["Support agent"]',
      '        step[First step]',
      '        decision{Does X hold?}',
      '        other[Alternative path]',
      '    end',
      '    subgraph system["Billing system"]',
      '        ok[Normal path]',
      '        done([Ends with…])',
      '    end',
      '    start --> step',
      '    step --> decision',
      '    decision -->|Yes| ok',
      '    decision -->|No| other',
      '    ok --> done',
      '    other --> done',
    ].join('\n'),
  },

  sequence: {
    kind: 'sequence',
    label: 'Sequence',
    layer: 'process',
    question: 'Who talks to whom, and in which order?',
    purpose: 'The order of the messages between parties in one concrete interaction: who calls whom, what comes back and what happens when it fails. It answers a single scenario, not the whole process.',
    origin: 'authored',
    dialect: 'sequenceDiagram',
    alsoAccepts: [],
    legend: [
      { shape: 'participant', means: 'Each party that takes part, in the order it appears.' },
      { shape: '->>', means: 'A call.' },
      { shape: '-->>', means: 'A reply.' },
      { shape: 'alt / opt', means: 'Alternative or optional paths.' },
    ],
    rules: [
      ...common(10),
      { id: 'dialect', text: 'Written in `sequenceDiagram`.', severity: 'error', check: (c) => /^\s*sequenceDiagram\b/m.test(c) },
      { id: 'participants', text: 'Participants are declared with `participant` and their real name, not with single letters.', severity: 'warning', check: (c) => /^\s*participant\s+\w+\s+as\s+\S|^\s*participant\s+[A-Za-zÁÉÍÓÚÑ][\w\s]{2,}/m.test(c) },
      { id: 'errors', text: 'The failing path is drawn too: an `alt` with the error, or a note saying what happens.', severity: 'warning', check: (c) => /\b(alt|opt|critical|break)\b/.test(c) },
    ],
    maxNodes: 10,
    usedIn: ['api', 'process', 'adr', 'module', 'integration'],
    template: [
      'sequenceDiagram',
      '    title Integration · main flow',
      '    participant C as Client',
      '    participant A as API',
      '    participant S as External system',
      '    C->>A: POST /v1/resource',
      '    A->>S: Query',
      '    alt Replies in time',
      '        S-->>A: 200 OK',
      '        A-->>C: 201 Created',
      '    else Times out',
      '        A-->>C: 202 Accepted',
      '    end',
    ].join('\n'),
  },

  state: {
    kind: 'state',
    label: 'States',
    layer: 'process',
    question: 'Which states does it go through, and what moves it between them?',
    purpose: 'The lifecycle of an entity or of a request: which states it can be in and what moves it from one to another. It is the diagram that catches the states nobody had thought about.',
    origin: 'authored',
    dialect: 'stateDiagram-v2',
    alsoAccepts: [],
    legend: [
      { shape: 'state', means: 'A state the thing can be in, with the name it is called by.' },
      { shape: 'terminal', means: 'Where it starts and where it ends. A filled circle, `[*]` in Mermaid.' },
      { shape: '-->', means: 'A transition, labelled with what triggers it.' },
    ],
    rules: [
      ...common(15),
      { id: 'dialect', text: 'Written in `stateDiagram-v2`.', severity: 'error', check: (c) => /^\s*stateDiagram(-v2)?\b/m.test(c) },
      { id: 'start', text: 'States the initial state with `[*] -->`.', severity: 'warning', check: (c) => /\[\*\]\s*-->/.test(c) },
      { id: 'transitions', text: 'Every transition says what triggers it: `Pending --> Paid: payment confirmed`.', severity: 'warning', check: (c) => /-->\s*\w+\s*:/.test(c) },
    ],
    maxNodes: 15,
    usedIn: ['process', 'data-model', 'module'],
    template: [
      '---',
      'title: States of the entity',
      '---',
      'stateDiagram-v2',
      '    [*] --> Pending',
      '    Pending --> Confirmed: approved',
      '    Pending --> Rejected: denied',
      '    Confirmed --> [*]',
      '    Rejected --> [*]',
    ].join('\n'),
  },

  // ── Data ────────────────────────────────────────────────────────────────────

  'data-landscape': {
    kind: 'data-landscape',
    label: 'Data landscape',
    layer: 'data',
    question: 'Which data stores exist, in which domain, and who uses them?',
    purpose: 'Every data store with an identity of its own and the applications that write into it. It is what shows the same data living in three places, which is something no single document can say.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'An application that persists into one of the stores.' },
      { shape: 'icon', means: 'A data store, with the icon pack of the type.' },
      { shape: 'group', means: 'The domain that owns the stores inside it.' },
      { shape: '-->', means: 'A `persists_in` relation: the application stores data there.' },
    ],
    rules: [
      ...common(30),
      derivedRule('the `datastore` documents and the `persists_in` relations'),
      { id: 'dialect', text: 'Written in `flowchart`, with a `subgraph` per domain.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'stores', text: 'The stores carry the `pd:datastore` pack: a plain box for a database misleads.', severity: 'warning', check: (c) => /icon:\s*"pd:datastore"/.test(c) },
      { id: 'who-uses', text: 'Every store shows who persists in it; a store nobody uses is a finding, not a drawing.', severity: 'warning', check: (c) => edgeLines(c).length > 0 },
    ],
    maxNodes: 30,
    usedIn: [],
    template: [
      '---',
      'title: Data landscape',
      '---',
      'flowchart LR',
      '    subgraph sales["Sales"]',
      '        orders@{ icon: "pd:datastore", form: "square", label: "Orders DB", pos: "b" }',
      '    end',
      '    subgraph analytics["Analytics"]',
      '        lake@{ icon: "pd:datastore", form: "square", label: "Data lake", pos: "b" }',
      '    end',
      '    shop@{ icon: "pd:application", form: "square", label: "Online shop", pos: "b" }',
      '    etl@{ icon: "pd:application", form: "square", label: "Nightly ETL", pos: "b" }',
      '    shop -->|persists in| orders',
      '    etl -->|persists in| lake',
    ].join('\n'),
  },

  'data-model': {
    kind: 'data-model',
    label: 'Entity-relationship model',
    layer: 'data',
    question: 'Which entities and relations are there, at which level: conceptual, logical or physical?',
    purpose: 'The entities, their keys and their cardinalities. The three levels are three different diagrams: the conceptual one is the shared language of a domain, the logical one belongs to the application and the physical one is the schema a repository really creates.',
    origin: 'authored',
    dialect: 'erDiagram',
    alsoAccepts: [],
    legend: [
      { shape: 'entity', means: 'A thing with a name and its fields, listed under it; `PK` and `FK` mark the keys.' },
      { shape: '--', means: 'A relation, with its cardinality written at each end: `||` one, `o{` many.' },
    ],
    rules: [
      ...common(12),
      { id: 'dialect', text: 'Written in `erDiagram`.', severity: 'error', check: (c) => /^\s*erDiagram\b/m.test(c) },
      { id: 'cardinality', text: 'Every relation carries cardinality at both ends and the verb that explains it.', severity: 'error', check: (c) => /\|\|--|\}o--|\|o--|\}\|--/.test(c) },
      { id: 'keys', text: 'The main entities declare their fields with `PK` and `FK` where it applies.', severity: 'warning', check: (c) => /\bPK\b/.test(c) },
      { id: 'level', text: 'The level goes where it belongs: `level: physical` only in a repository —it is the schema the code creates— and `level: conceptual` only in the domain, which is where the shared language lives. The logical one belongs to the application.', severity: 'error' },
    ],
    maxNodes: 12,
    usedIn: ['data-model', 'datastore'],
    template: [
      '---',
      'title: Data model',
      '---',
      'erDiagram',
      '    CUSTOMER ||--o{ ORDER : places',
      '    ORDER ||--|{ LINE : contains',
      '    CUSTOMER {',
      '        uuid id PK',
      '        string email',
      '    }',
      '    ORDER {',
      '        uuid id PK',
      '        uuid customer_id FK',
      '        int amount_cents',
      '    }',
    ].join('\n'),
  },

  'data-flow': {
    kind: 'data-flow',
    label: 'Data flow',
    layer: 'data',
    question: 'How does a piece of data move between applications and stores?',
    purpose: 'The journey of one kind of data: where it is produced, what transforms it and where it comes to rest. It answers about the data, not about the systems: the same application can appear twice if it touches the data twice.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'Something that produces or transforms the data.' },
      { shape: 'cylinder', means: 'Where the data rests. A cylinder, never a plain box.' },
      { shape: 'group', means: 'A zone that holds several of them: a domain, an environment, a stage.' },
      { shape: '-->', means: 'A movement, labelled with what travels and how (file, event, API).' },
    ],
    rules: [
      ...common(20),
      { id: 'dialect', text: 'Written in `flowchart LR`: the data is read in the direction it travels.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\s+LR\b/m.test(c) },
      { id: 'what-travels', text: 'Every arrow says which data travels and by which mechanism; without that it is only boxes.', severity: 'error', check: everyEdgeLabelled },
      { id: 'stores', text: 'The stores are cylinders `[(…)]` and match a `datastore` of the catalogue.', severity: 'warning', check: (c) => /\[\(/.test(c) },
      { id: 'derivable', text: 'It can also be derived from the `integration` documents: if what is drawn is a plain hop between two applications, declare the integration and let it be generated.', severity: 'warning' },
    ],
    maxNodes: 20,
    usedIn: ['data-model', 'datastore', 'integration'],
    template: [
      '---',
      'title: Data flow',
      '---',
      'flowchart LR',
      '    shop["Online shop"] -->|order placed · Kafka| etl["Nightly ETL"]',
      '    etl -->|normalised order · batch| lake[("Data lake")]',
      '    lake -->|daily aggregate · SQL| bi["Reporting"]',
    ].join('\n'),
  },

  'data-lineage': {
    kind: 'data-lineage',
    label: 'Data lineage',
    layer: 'data',
    question: 'Where does this piece of data come from and where does it end up?',
    purpose: 'The chain of origins of one field or one dataset, hop by hop, so it can be answered who is to blame when a figure is wrong. It is the same picture the audit asks for.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'cylinder', means: 'A stage where the data rests.' },
      { shape: 'rect', means: 'What transforms it: an integration, a job, a view.' },
      { shape: '-->', means: 'A hop, labelled with the transformation applied.' },
    ],
    rules: [
      ...common(20),
      derivedRule('the `integration` documents chained with the `persists_in` relations'),
      { id: 'dialect', text: 'Written as a chained `flowchart LR`: lineage is a chain, not a cloud.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\s+LR\b/m.test(c) },
      { id: 'chain', text: 'One line per hop, from origin to destination, with no forks that are not real.', severity: 'warning', check: (c) => edgeLines(c).length > 0 },
      { id: 'transformation', text: 'Every hop says what changed: without the transformation, lineage does not explain a wrong figure.', severity: 'warning', check: everyEdgeLabelled },
    ],
    maxNodes: 20,
    usedIn: [],
    template: [
      '---',
      'title: Data lineage',
      '---',
      'flowchart LR',
      '    src[("Orders DB")] -->|change data capture| bus["Event bus"]',
      '    bus -->|normalise currency| etl["Nightly ETL"]',
      '    etl -->|aggregate by day| lake[("Data lake")]',
      '    lake -->|revenue view| bi["Revenue report"]',
    ].join('\n'),
  },

  // ── Application ─────────────────────────────────────────────────────────────

  'application-landscape': {
    kind: 'application-landscape',
    label: 'Application landscape',
    layer: 'application',
    question: 'Which applications exist, in which domain, and who depends on whom?',
    purpose: 'The full map of applications grouped by domain, with the dependencies between them. Unlike the C4 landscape it is not drawn: it comes out of what the child nodes federate, so it cannot go stale.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'container', means: 'An application, with the icon of its type.' },
      { shape: 'facet', means: 'A document written about one of them: an architecture, a runbook, a decision.' },
      { shape: 'store', means: 'A data store, drawn as a cylinder.' },
      { shape: 'group', means: 'A frame around what goes together: the domain that owns them, or the pieces of one kind.' },
      { shape: '-->', means: 'A `depends_on` relation between applications.' },
    ],
    rules: [
      ...common(40),
      derivedRule('the `application` documents and their `depends_on` relations'),
      { id: 'dialect', text: 'Written in `flowchart`, with a `subgraph` per domain.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'grouping', text: 'Every application sits inside the `subgraph` of its domain; one without a domain is a finding.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) },
      { id: 'scale', text: 'Above forty applications it is filtered by domain or by status instead of being drawn whole.', severity: 'warning' },
    ],
    maxNodes: 40,
    usedIn: [],
    template: [
      '---',
      'title: Application landscape',
      '---',
      'flowchart LR',
      '    subgraph sales["Sales"]',
      '        shop@{ icon: "pd:application", form: "square", label: "Online shop", pos: "b" }',
      '        crm@{ icon: "pd:application", form: "square", label: "CRM", pos: "b" }',
      '    end',
      '    subgraph fin["Finance"]',
      '        bill@{ icon: "pd:application", form: "square", label: "Billing", pos: "b" }',
      '    end',
      '    shop -->|depends on| crm',
      '    shop -->|depends on| bill',
    ].join('\n'),
  },

  'c4-landscape': {
    kind: 'c4-landscape',
    label: 'C4 · System landscape',
    layer: 'application',
    question: 'Which systems does the organisation have and how do they integrate?',
    purpose: 'The map of every system of the company and how they integrate with each other. Unlike the context there is no protagonist here: several systems of our own are drawn, and it is the first diagram someone joining the organisation looks at.',
    origin: 'authored',
    dialect: 'C4Context',
    alsoAccepts: [],
    legend: [
      { shape: 'System', means: 'A system of our own. There are several here: that is what tells the landscape apart from the context.' },
      { shape: 'System_Ext', means: 'A third-party system we depend on.' },
      { shape: 'Person', means: 'The kinds of user that cut across several systems.' },
      { shape: 'Enterprise_Boundary', means: 'The boundary of the company: ours inside, theirs outside.' },
      { shape: 'Rel', means: 'An integration between two systems, with what it does and the technology in brackets.' },
    ],
    rules: [
      ...common(15),
      { id: 'dialect', text: 'Written in `C4Context`, like the context: what changes is that there are several systems of our own.', severity: 'error', check: (c) => /^\s*C4Context\b/m.test(c) },
      { id: 'several', text: 'It has more than one `System` of our own; with just one, what fits is a context diagram.', severity: 'warning', check: (c) => countLines(c, /^System\s*\(/) !== 1 },
      { id: 'boundary', text: 'An `Enterprise_Boundary` is recommended, to separate ours from third parties.', severity: 'warning', check: (c) => /Enterprise_Boundary|System_Ext/.test(c) },
    ],
    maxNodes: 15,
    usedIn: ['architecture'],
    template: [
      'C4Context',
      '    title Company · system landscape',
      '    Person(customer, "Customer", "Buys and checks")',
      '    Enterprise_Boundary(company, "Company") {',
      '        System(one, "System one", "What it does")',
      '        System(two, "System two", "What it does")',
      '    }',
      '    System_Ext(external, "External provider", "What it gives us")',
      '    Rel(customer, one, "Uses", "Web")',
      '    Rel(one, two, "Publishes events", "Kafka")',
      '    Rel(two, external, "Queries", "REST")',
    ].join('\n'),
  },

  'c4-context': {
    kind: 'c4-context',
    label: 'C4 level 1 · Context',
    layer: 'application',
    question: 'What is this system, who uses it and which other systems does it talk to?',
    purpose: 'What the system is, who uses it and which other systems it talks to. It is the first diagram someone new looks at, and it does not go into how it is built inside.',
    origin: 'authored',
    dialect: 'C4Context',
    alsoAccepts: [],
    legend: [
      { shape: 'Person', means: 'A person or a role that uses the system. Light blue with a silhouette.' },
      { shape: 'Person_Ext', means: 'A person from outside the organisation: a customer, a supplier. Grey silhouette.' },
      { shape: 'System', means: 'The system this document describes. Solid blue: it is the protagonist, and there is only one.' },
      { shape: 'System_Ext', means: 'A system outside the scope: another team, another company. Grey.' },
      { shape: 'Rel', means: 'A relation, with what it does and the technology in brackets.' },
    ],
    rules: [
      ...common(12),
      { id: 'dialect', text: 'Written in `C4Context`, not in `flowchart`: that is what gives the shapes and colours of the standard.', severity: 'error', check: (c) => /^\s*C4Context\b/m.test(c) },
      { id: 'one-system', text: 'Exactly one `System` of our own: the one being documented. The rest are `System_Ext`.', severity: 'error', check: (c) => countLines(c, /^System(_Boundary)?\s*\(/) === 1 },
      { id: 'people', text: 'At least one `Person`: a system nobody uses has no context.', severity: 'warning', check: (c) => /\bPerson(_Ext)?\s*\(/.test(c) },
      { id: 'technology', text: 'Every `Rel` carries its technology as the third argument: `Rel(a, b, "Charges with", "REST")`.', severity: 'warning', check: (c) => !/^\s*Rel\w*\([^)]*\)\s*$/m.test(c) || /Rel\w*\([^)]*,[^)]*,[^)]*,[^)]*\)/.test(c) },
    ],
    maxNodes: 12,
    usedIn: ['architecture'],
    template: [
      'C4Context',
      '    title System · context',
      '    Person(user, "User", "Who uses it and what for")',
      '    System(system, "My system", "What it does, in one sentence")',
      '    System_Ext(external, "External system", "Whose it is and what it gives us")',
      '    Rel(user, system, "Uses", "Web")',
      '    Rel(system, external, "Queries", "REST")',
    ].join('\n'),
  },

  'c4-container': {
    kind: 'c4-container',
    label: 'C4 level 2 · Containers',
    layer: 'application',
    question: 'What gets deployed, and where does each piece of data live?',
    purpose: 'The deployable pieces of the system —services, applications, databases, queues— and how they talk to each other.',
    origin: 'authored',
    dialect: 'C4Container',
    alsoAccepts: [],
    legend: [
      { shape: 'Person', means: 'A person or a role that uses the system, outside every boundary.' },
      { shape: 'Container', means: 'Something deployed and run separately: a service, a web app, a job. It carries its technology.' },
      { shape: 'ContainerDb', means: 'A data store. Drawn as a cylinder, not as a box.' },
      { shape: 'ContainerQueue', means: 'A queue or an event bus.' },
      { shape: 'Container_Boundary', means: 'The boundary of the system: ours inside, theirs outside.' },
      { shape: 'System_Boundary', means: 'The same boundary when the drawing holds more than one system of ours.' },
      { shape: 'System_Ext', means: 'A system from outside, in grey.' },
      { shape: 'SystemQueue_Ext', means: 'A queue or a bus that belongs to somebody else: corporate Kafka, a partner\u2019s topic.' },
      { shape: 'Rel', means: 'A call between two pieces, with what it does and the protocol in brackets.' },
    ],
    rules: [
      ...common(20),
      { id: 'dialect', text: 'Written in `C4Container`. A hand-drawn `flowchart` is not a level 2: it loses the shapes, the colours and the technology of each piece.', severity: 'error', check: (c) => /^\s*C4Container\b/m.test(c) },
      { id: 'boundary', text: 'Our own pieces go inside a `Container_Boundary` or a `System_Boundary`.', severity: 'error', check: (c) => /_Boundary\s*\(/.test(c) },
      { id: 'technology', text: 'Every `Container` declares its technology: `Container(api, "API", "Java, Quarkus", "…")`.', severity: 'error', check: (c) => !/Container\w*\(/.test(c) || /Container\w*\([^)]*,[^)]*,[^)]*,/.test(c) },
      { id: 'data', text: 'Databases are `ContainerDb` and queues `ContainerQueue`: a plain box for a database misleads.', severity: 'warning', check: (c) => !/(postgres|mysql|mongo|database|data store|kafka|rabbit|queue)/i.test(c) || /(ContainerDb|ContainerQueue|SystemDb|SystemQueue)/.test(c) },
    ],
    maxNodes: 20,
    usedIn: ['architecture'],
    template: [
      'C4Container',
      '    title System · containers',
      '    Person(user, "User", "Who uses it")',
      '    Container_Boundary(system, "My system") {',
      '        Container(web, "Web application", "React", "What the user sees")',
      '        Container(api, "API", "Java, Quarkus", "Business rules")',
      '        ContainerDb(db, "Database", "PostgreSQL 16", "What it stores")',
      '        ContainerQueue(bus, "Events", "Kafka", "What it publishes")',
      '    }',
      '    System_Ext(external, "External system", "What it gives us")',
      '    Rel(user, web, "Uses", "HTTPS")',
      '    Rel(web, api, "Calls", "REST/JSON")',
      '    Rel(api, db, "Reads and writes", "JDBC")',
      '    Rel(api, bus, "Publishes", "Avro")',
      '    Rel(api, external, "Queries", "REST")',
    ].join('\n'),
  },

  'c4-component': {
    kind: 'c4-component',
    label: 'C4 level 3 · Components',
    layer: 'application',
    question: 'What is inside one container, and which dependencies are allowed?',
    purpose: 'The inner pieces of ONE container and the dependencies allowed between them. It is only drawn for the main container, or for one whose structure cannot be guessed.',
    origin: 'authored',
    dialect: 'C4Component',
    alsoAccepts: ['flowchart'],
    legend: [
      { shape: 'Component', means: 'A piece inside the container: a package, a module, an adapter. It carries its technology.' },
      { shape: 'ComponentDb', means: 'A component that holds state.' },
      { shape: 'Container_Boundary', means: 'The container whose inside is being opened.' },
      { shape: 'Rel', means: 'A dependency between two components, with what it asks for.' },
    ],
    rules: [
      ...common(15),
      { id: 'dialect', text: 'Written in `C4Component`; a `flowchart` with a `subgraph` per layer is accepted when the diagram is about code packages.', severity: 'warning', check: (c) => /^\s*(C4Component|flowchart)\b/m.test(c) },
      { id: 'one-container', text: 'It opens a single container: if two are needed, they are two diagrams.', severity: 'warning', check: (c) => countLines(c, /^Container_Boundary\s*\(/) <= 1 },
      { id: 'dependencies', text: 'The arrows go in the direction of the allowed dependency, and the domain depends on nothing.', severity: 'warning' },
    ],
    maxNodes: 15,
    usedIn: ['architecture', 'repository', 'module'],
    template: [
      'C4Component',
      '    title API · components',
      '    Container_Boundary(api, "API") {',
      '        Component(rest, "REST resource", "JAX-RS", "HTTP entry point")',
      '        Component(usecase, "Use cases", "Java", "Business rules")',
      '        Component(domain, "Domain", "Java", "Entities and invariants")',
      '        ComponentDb(repo, "Repository", "Hibernate", "Persistence")',
      '    }',
      '    Rel(rest, usecase, "Invokes")',
      '    Rel(usecase, domain, "Uses")',
      '    Rel(usecase, repo, "Queries")',
    ].join('\n'),
  },

  'c4-code': {
    kind: 'c4-code',
    label: 'C4 level 4 · Code',
    layer: 'application',
    question: 'Which key entities or interfaces cannot be guessed from level 3?',
    purpose: 'The key entities or interfaces, when the model cannot be guessed from level 3. It is optional and ages fast: only draw what will be maintained.',
    origin: 'authored',
    dialect: 'classDiagram',
    alsoAccepts: [],
    legend: [
      { shape: 'class', means: 'An entity or an interface, with its important fields.' },
      { shape: '-->', means: 'An association, with its cardinality.' },
    ],
    rules: [
      ...common(10),
      { id: 'dialect', text: 'Written in `classDiagram`.', severity: 'error', check: (c) => /^\s*classDiagram\b/m.test(c) },
      { id: 'key-only', text: 'Only the entities you must understand to work here; it is not the full schema, which lives in the data model.', severity: 'warning' },
    ],
    maxNodes: 10,
    usedIn: ['architecture'],
    template: [
      '---',
      'title: Code · classes',
      '---',
      'classDiagram',
      '    class Order {',
      '        +string id',
      '        +string status',
      '    }',
      '    class Line {',
      '        +string id',
      '        +int amount',
      '    }',
      '    Order "1" --> "0..*" Line',
    ].join('\n'),
  },

  integration: {
    kind: 'integration',
    label: 'Integration',
    layer: 'application',
    question: 'How do these applications talk to each other, and what travels between them?',
    purpose: 'The hop between two or more applications: which mechanism carries it, which data goes through and how often. It is the diagram of the `integration` document, and every edge is a contract someone has to keep.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: ['sequenceDiagram'],
    legend: [
      { shape: 'rect', means: 'Each end of the integration, named as it is in the catalogue.' },
      { shape: 'cylinder', means: 'A store one of the ends reads from or writes into.' },
      { shape: 'group', means: 'A boundary that holds several of them: a company, a network, an environment.' },
      { shape: '-->', means: 'The hop. The label carries the mechanism (REST, Kafka, SFTP) and what travels.' },
    ],
    rules: [
      ...common(15),
      { id: 'dialect', text: 'Written in `flowchart LR`: an integration is read from origin to destination.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\s+LR\b/m.test(c) || /^\s*sequenceDiagram\b/m.test(c) },
      { id: 'labelled-edges', text: 'Every edge carries a label with the mechanism and the data: `A -->|order placed · Kafka| B`. An unlabelled arrow says nothing that can be verified.', severity: 'error', check: (c) => /^\s*sequenceDiagram\b/m.test(c) || everyEdgeLabelled(c) },
      { id: 'direction', text: 'The arrow points the way the data travels, not the way the call goes: a pull is drawn from the source to the consumer.', severity: 'warning' },
      { id: 'frequency', text: 'When the frequency matters (nightly, on demand, real time) it goes in the label too.', severity: 'warning' },
    ],
    maxNodes: 15,
    usedIn: ['integration', 'api', 'architecture'],
    template: [
      '---',
      'title: Integration',
      '---',
      'flowchart LR',
      '    shop["Online shop"] -->|order placed · Kafka · real time| erp["ERP"]',
      '    erp -->|stock level · REST · on demand| shop',
      '    erp -->|daily invoices · SFTP · nightly| bill["Billing"]',
    ].join('\n'),
  },

  dependency: {
    kind: 'dependency',
    label: 'Dependency map',
    layer: 'application',
    question: 'What breaks if this one goes down?',
    purpose: 'What an application needs and what needs it, at one and two hops. It is the picture you look at before a maintenance window, and it comes out of the declared relations so it cannot lie.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'container', means: 'An application of the catalogue. The one being looked at is the one in the middle.' },
      { shape: 'facet', means: 'A document written about one of them: an architecture, a runbook, a decision.' },
      { shape: 'store', means: 'A data store, drawn as a cylinder.' },
      { shape: 'group', means: 'A frame around what goes together: the domain that owns them, or the pieces of one kind.' },
      { shape: '-->', means: 'A `depends_on` relation: the source needs the target to work.' },
    ],
    rules: [
      ...common(25),
      derivedRule('the `depends_on` relations of the catalogue'),
      { id: 'dialect', text: 'Written in `flowchart`.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'depth', text: 'Two hops at most from the application being looked at: further out it is the application landscape.', severity: 'warning' },
      { id: 'direction', text: 'The arrow goes from who needs to who is needed, always the same way, or the map cannot be read.', severity: 'warning' },
    ],
    maxNodes: 25,
    usedIn: [],
    template: [
      '---',
      'title: Dependencies',
      '---',
      'flowchart LR',
      '    crm["CRM"] --> shop["Online shop"]',
      '    portal["Customer portal"] --> shop',
      '    shop --> bill["Billing"]',
      '    shop --> auth["Identity provider"]',
    ].join('\n'),
  },

  packages: {
    kind: 'packages',
    label: 'Packages of a repository',
    layer: 'application',
    question: 'How is the code organised, and what may depend on what?',
    purpose: 'The layers of a repository and what may depend on what. It is what keeps infrastructure from creeping into the domain.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: ['C4Component', 'classDiagram'],
    legend: [
      { shape: 'rect', means: 'A package, named as it is in the code.' },
      { shape: 'group', means: 'A layer or a root package.' },
      { shape: '-->', means: 'An allowed dependency. If the arrow is missing, the dependency is not allowed.' },
    ],
    rules: [
      ...common(20),
      { id: 'dialect', text: 'Written in `flowchart` with a `subgraph` per layer.', severity: 'error', check: (c) => /^\s*(flowchart|graph|C4Component|classDiagram)\b/m.test(c) },
      { id: 'layers', text: 'Each layer is a `subgraph` with its real package name.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) },
      { id: 'table', text: 'The diagram comes with the "package → may depend on" table, which is the part that can be checked.', severity: 'warning' },
    ],
    maxNodes: 20,
    usedIn: ['repository'],
    template: [
      '---',
      'title: Packages',
      '---',
      'flowchart TB',
      '    subgraph api["api"]',
      '        rest["REST resources"]',
      '    end',
      '    subgraph app["application"]',
      '        usecases["Use cases"]',
      '    end',
      '    subgraph dom["domain"]',
      '        model["Entities"]',
      '    end',
      '    subgraph infra["infrastructure"]',
      '        repo["Repositories"]',
      '    end',
      '    rest --> usecases',
      '    usecases --> model',
      '    infra --> model',
    ].join('\n'),
  },

  roadmap: {
    kind: 'roadmap',
    label: 'Roadmap',
    layer: 'application',
    question: 'What gets delivered, and when?',
    purpose: 'The milestones of the planning manifest on a timeline. It is not a wish list: every milestone here is a row of the `plan` table, with its date and its scope, and both must say the same thing.',
    origin: 'authored',
    dialect: 'gantt',
    alsoAccepts: ['timeline'],
    legend: [
      { shape: 'phase', means: 'A phase or a release train: the `section` of the gantt, and it holds its milestones.' },
      { shape: 'milestone', means: 'A milestone already delivered (`done`), with its date. Same name as in the `plan` table.' },
      { shape: 'active', means: 'A milestone in progress (`active`).' },
      { shape: 'risk', means: 'A milestone at risk (`crit`).' },
    ],
    rules: [
      ...common(20),
      { id: 'dialect', text: 'Written in `gantt` with dates, or in `timeline` when only the order matters.', severity: 'error', check: (c) => /^\s*(gantt|timeline)\b/m.test(c) },
      { id: 'dates', text: 'A `gantt` declares `dateFormat` and real dates: a bar without a date is decoration.', severity: 'error', check: (c) => !/^\s*gantt\b/m.test(c) || /dateFormat/.test(c) },
      { id: 'plan-match', text: 'A hand-written roadmap names the same milestones as the `plan` table; if they differ it is the finding `roadmap-plan-mismatch`. It is better to let it be derived from the table.', severity: 'error' },
      { id: 'state', text: 'Delivered milestones are marked `done` and the ones at risk `crit`, so the picture says how it is going and not only what was intended.', severity: 'warning', check: (c) => !/^\s*gantt\b/m.test(c) || /\b(done|active|crit)\b/.test(c) },
    ],
    maxNodes: 20,
    usedIn: ['plan', 'application'],
    template: [
      'gantt',
      '    title Application · roadmap',
      '    dateFormat YYYY-MM-DD',
      '    section Foundations',
      '        Catalogue online     :done,    m1, 2026-01-15, 1d',
      '        Contracts published  :active,  m2, 2026-03-01, 1d',
      '    section Growth',
      '        Self-service portal  :         m3, 2026-06-30, 1d',
    ].join('\n'),
  },

  lifecycle: {
    kind: 'lifecycle',
    label: 'Lifecycle coverage',
    layer: 'application',
    question: 'Which stage of the lifecycle is covered, and which is not?',
    purpose: 'The six stages an application goes through —plan, design, build, test, deploy, operate— with what covers each one and what is missing. An application is not documented because it has an architecture: it is documented when every stage has its piece.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'A covered stage: the facets of that stage exist. The six always appear, in the same order.' },
      { shape: 'empty', means: 'A stage partial or empty, drawn with a broken keyline: the finding `lifecycle-stage-empty` says what is missing.' },
      { shape: '-->', means: 'The order of the stages; it never branches.' },
    ],
    rules: [
      ...common(10),
      derivedRule('the facets of the application, stage by stage'),
      { id: 'dialect', text: 'Written in `flowchart LR`.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\s+LR\b/m.test(c) },
      { id: 'six-stages', text: 'The six stages always appear, in order, even the empty ones: what is missing is the point of the diagram.', severity: 'error', check: (c) => /plan/i.test(c) && /design/i.test(c) && /build/i.test(c) && /test/i.test(c) && /deploy/i.test(c) && /operat/i.test(c) },
      { id: 'not-colour-alone', text: 'The state of a stage is told by shape and text, never by colour alone.', severity: 'warning' },
    ],
    maxNodes: 10,
    usedIn: [],
    template: [
      '---',
      'title: Lifecycle',
      '---',
      'flowchart LR',
      '    plan["Plan · 1 plan"] --> design["Design · 3 pieces"]',
      '    design --> build["Build · 2 repositories"]',
      '    build --> test["Test · missing"]',
      '    test --> deploy["Deploy · 1 infrastructure"]',
      '    deploy --> operate["Operate · 4 runbooks"]',
      '    style test stroke-dasharray: 4 4',
    ].join('\n'),
  },

  versioning: {
    kind: 'versioning',
    label: 'Branches and releases',
    layer: 'application',
    question: 'How does it branch and how does it release?',
    purpose: 'The branching strategy: where each release comes from and how an urgent fix finds its way back.',
    origin: 'authored',
    dialect: 'gitGraph',
    alsoAccepts: [],
    legend: [
      { shape: 'branch / checkout', means: 'The long-lived branches and the working ones.' },
      { shape: 'tag', means: 'A published version.' },
    ],
    rules: [
      ...common(20),
      { id: 'dialect', text: 'Written in `gitGraph`.', severity: 'error', check: (c) => /^\s*gitGraph\b/m.test(c) },
      { id: 'tags', text: 'Published versions carry a `tag`, with whichever versioning scheme is used.', severity: 'warning', check: (c) => /tag:/.test(c) },
      { id: 'hotfix', text: 'The urgent fix is drawn too: where it comes from and where it goes back to.', severity: 'warning' },
    ],
    maxNodes: 20,
    usedIn: ['versioning'],
    template: [
      '---',
      'title: Versioning',
      '---',
      'gitGraph',
      '    commit id: "start"',
      '    branch develop',
      '    commit',
      '    branch feature/x',
      '    commit',
      '    checkout develop',
      '    merge feature/x',
      '    checkout main',
      '    merge develop tag: "v1.0.0"',
    ].join('\n'),
  },

  capabilities: {
    kind: 'capabilities',
    label: 'Capability map',
    layer: 'application',
    question: 'What does this application know how to do?',
    purpose: 'The modules of an application drawn as what they let people do, grouped by the domain they serve. It is the map of modules read from the business side, and it comes out of the catalogue: a capability nobody implements is a finding, not a box someone forgot.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'A capability; underneath, the module that implements it.' },
      { shape: 'group', means: 'The application, or the domain the capabilities belong to.' },
      { shape: '-->', means: 'What implements the capability.' },
    ],
    rules: [
      ...common(20),
      derivedRule('the `module` documents of the application and their `serves` relations'),
      { id: 'dialect', text: 'Written in `flowchart`.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'implemented-by', text: 'Every capability links to the module that implements it, or it is said that nobody implements it.', severity: 'warning' },
    ],
    maxNodes: 20,
    usedIn: [],
    template: [
      '---',
      'title: Capabilities',
      '---',
      'flowchart TB',
      '    subgraph app["Online shop"]',
      '        cap1["Browse the catalogue"]',
      '        cap2["Place an order"]',
      '    end',
      '    cap1 --> mod1["Module · catalogue"]',
      '    cap2 --> mod2["Module · checkout"]',
    ].join('\n'),
  },

  // ── Technology ──────────────────────────────────────────────────────────────


  'stack-map': {
    kind: 'stack-map',
    label: 'Stack map',
    layer: 'technology',
    question: 'Who uses which technology, and in which version?',
    purpose: 'Each technology with the applications and repositories that really use it and the version each one is on. It is the picture you look at before an upgrade or when a vulnerability appears, and it comes out of the `stack` documents.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'icon', means: 'A catalogue technology.' },
      { shape: 'rect', means: 'An application or repository that uses it.' },
      { shape: '-->', means: 'Which version that user is on: the arrow carries it. Different versions are different arrows.' },
    ],
    rules: [
      ...common(30),
      derivedRule('the `stack` documents of every application and repository'),
      { id: 'dialect', text: 'Written in `flowchart`, from the technology to the ones that use it.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'versions', text: 'Every edge carries the version: without it the map does not answer who is left behind.', severity: 'error', check: everyEdgeLabelled },
      { id: 'grouping', text: 'One technology per group; the same application appears as many times as technologies it uses.', severity: 'warning' },
    ],
    maxNodes: 30,
    usedIn: [],
    template: [
      '---',
      'title: Technology map',
      '---',
      'flowchart LR',
      '    pg@{ icon: "pd:technology", form: "square", label: "PostgreSQL", pos: "b" }',
      '    java@{ icon: "pd:technology", form: "square", label: "Java", pos: "b" }',
      '    pg -->|16.2| shop["Online shop"]',
      '    pg -->|13.9| legacy["Legacy ERP"]',
      '    java -->|21| shop',
      '    java -->|8| legacy',
    ].join('\n'),
  },

  // ── Infrastructure ──────────────────────────────────────────────────────────

  deployment: {
    kind: 'deployment',
    label: 'Deployment and infrastructure',
    layer: 'infrastructure',
    question: 'Where does each container actually run?',
    purpose: 'Where each thing runs: regions, networks, clusters and managed services, with the icon of each technology.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: ['C4Deployment'],
    legend: [
      { shape: 'rect', means: 'A piece that runs: a service, a job, a gateway.' },
      { shape: 'cylinder', means: 'A managed store: a database, a bucket, a queue.' },
      { shape: 'icon', means: 'The real service drawn with its own logo, so it is recognised without reading it.' },
      { shape: 'group', means: 'An infrastructure boundary: region, VPC, cluster, environment.' },
      { shape: '-->', means: 'What talks to what, with the port or the protocol when it matters.' },
    ],
    rules: [
      ...common(25),
      { id: 'dialect', text: 'Written as a typed `pd-diagram` of class `deployment`. What is still in Mermaid is a `flowchart` with icons; `architecture-beta` is not accepted, it misplaces nodes with nested groups.', severity: 'error', check: (c) => !/^\s*architecture-beta\b/m.test(c) },
      { id: 'icons', text: 'Managed services carry their icon: `id@{ icon: "logos:aws-rds", label: "…" }`.', severity: 'warning', check: (c) => /icon:\s*"/.test(c) || /^\s*C4Deployment\b/m.test(c) },
      { id: 'boundaries', text: 'Network or region boundaries are `subgraph`s, not loose boxes.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) || /^\s*C4Deployment\b/m.test(c) },
    ],
    maxNodes: 25,
    usedIn: ['infrastructure'],
    template: [
      '---',
      'title: Deployment',
      '---',
      'flowchart TB',
      '    subgraph region["Region · eu-west-1"]',
      '        subgraph vpc["Private VPC"]',
      '            k8s@{ icon: "logos:kubernetes", form: "square", label: "Cluster", pos: "b" }',
      '            db@{ icon: "logos:postgresql", form: "square", label: "Managed PostgreSQL", pos: "b" }',
      '        end',
      '    end',
      '    k8s --> db',
    ].join('\n'),
  },

  'environment-map': {
    kind: 'environment-map',
    label: 'Environment map',
    layer: 'infrastructure',
    question: 'Which environments exist and what runs in each one?',
    purpose: 'Development, staging, production and whatever else exists, with what runs in each. It answers the question that always comes up during an incident —is this in production?— and it is derived from the `runs_on` relations, so it does not go stale on its own.',
    origin: 'derived',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'Something that runs in that environment.' },
      { shape: 'group', means: 'An environment. The order goes from the least to the most critical.' },
      { shape: '-->', means: 'The promotion path between environments.' },
    ],
    rules: [
      ...common(30),
      derivedRule('the `runs_on` relations and the `infrastructure` documents'),
      { id: 'dialect', text: 'Written in `flowchart` with a `subgraph` per environment.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'environments', text: 'Every environment is a `subgraph`, and what runs in it goes inside: an application in no environment is a finding.', severity: 'warning', check: (c) => /\bsubgraph\b/.test(c) },
      { id: 'promotion', text: 'The promotion path is drawn from environment to environment, always in the same direction.', severity: 'warning' },
    ],
    maxNodes: 30,
    usedIn: [],
    template: [
      '---',
      'title: Environment map',
      '---',
      'flowchart LR',
      '    subgraph dev["Development"]',
      '        d1["Online shop"]',
      '    end',
      '    subgraph stg["Staging"]',
      '        s1["Online shop"]',
      '        s2["Billing"]',
      '    end',
      '    subgraph prod["Production"]',
      '        p1["Online shop"]',
      '        p2["Billing"]',
      '    end',
      '    dev --> stg',
      '    stg --> prod',
    ].join('\n'),
  },

  network: {
    kind: 'network',
    label: 'Network and zones',
    layer: 'infrastructure',
    question: 'Which networks, zones and accesses are there?',
    purpose: 'The security zones, what sits in each and which traffic is allowed to cross between them. It is the only diagram where a missing arrow is a decision: what is not drawn does not go through.',
    origin: 'authored',
    dialect: 'flowchart',
    alsoAccepts: [],
    legend: [
      { shape: 'rect', means: 'A gateway, a load balancer, a cluster.' },
      { shape: 'cylinder', means: 'A store inside a zone: a database, a bucket.' },
      { shape: 'group', means: 'A zone: public, DMZ, private, data. Nested zones are subnets.' },
      { shape: '-->', means: 'Traffic allowed between zones. Anything not drawn is not allowed.' },
    ],
    rules: [
      ...common(25),
      { id: 'dialect', text: 'Written in `flowchart` with a `subgraph` per zone.', severity: 'error', check: (c) => /^\s*(flowchart|graph)\b/m.test(c) },
      { id: 'zones', text: 'Every element sits inside a zone: an element in no zone is a hole nobody has decided on.', severity: 'error', check: (c) => /\bsubgraph\b/.test(c) },
      { id: 'traffic', text: 'Every arrow between zones says the port and the protocol; without that it is not a network diagram.', severity: 'error', check: everyEdgeLabelled },
      { id: 'closed-by-default', text: 'What is not drawn is not allowed: say so in the legend so nobody reads the missing arrows as an oversight.', severity: 'warning' },
    ],
    maxNodes: 25,
    usedIn: ['infrastructure'],
    template: [
      '---',
      'title: Network',
      '---',
      'flowchart TB',
      '    subgraph public["Public zone"]',
      '        cdn["CDN"]',
      '    end',
      '    subgraph dmz["DMZ"]',
      '        gw["API gateway"]',
      '    end',
      '    subgraph private["Private zone"]',
      '        app["Application cluster"]',
      '    end',
      '    subgraph data["Data zone"]',
      '        db[("PostgreSQL")]',
      '    end',
      '    cdn -->|443 · HTTPS| gw',
      '    gw -->|8443 · mTLS| app',
      '    app -->|5432 · TLS| db',
    ].join('\n'),
  },
};

/** The classes of one layer, in the order they are declared. */
export function kindsOfLayer(layer: Layer): DiagramKind[] {
  return DIAGRAM_KINDS.filter((k) => DIAGRAM_STANDARDS[k].layer === layer);
}

/** The classes the system generates on its own. They are never written by hand. */
export const DERIVED_KINDS: DiagramKind[] = DIAGRAM_KINDS.filter((k) => DIAGRAM_STANDARDS[k].origin === 'derived');

/** The Mermaid dialect of a block, read from its first line with content. */
export function detectDialect(code: string): string {
  // Mermaid accepts a frontmatter of its own (`---\ntitle: …\n---`) before the dialect.
  const withoutFrontmatter = /^\s*---\n[\s\S]*?\n---\n/.test(code) ? code.replace(/^\s*---\n[\s\S]*?\n---\n/, '') : code;
  const first = withoutFrontmatter.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) ?? '';
  const m = /^(C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|classDiagram|erDiagram|sequenceDiagram|stateDiagram-v2|stateDiagram|gitGraph|flowchart|graph|architecture-beta|mindmap|timeline|journey|pie|quadrantChart|gantt|requirementDiagram|sankey-beta|xychart-beta|block-beta)\b/.exec(first);
  return m?.[1] ?? 'unknown';
}

/** The class of diagram a dialect corresponds to, when it is unambiguous. */
export function kindOfDialect(dialect: string): DiagramKind | undefined {
  const direct: Record<string, DiagramKind> = {
    C4Context: 'c4-context', C4Container: 'c4-container', C4Component: 'c4-component',
    erDiagram: 'data-model', gitGraph: 'versioning', sequenceDiagram: 'sequence',
    'stateDiagram-v2': 'state', stateDiagram: 'state', classDiagram: 'c4-code',
    gantt: 'roadmap', timeline: 'roadmap',
  };
  return direct[dialect];
}

export interface DiagramIssue {
  rule: string;
  severity: 'error' | 'warning';
  text: string;
  /** What to do about it, when there is one obvious move. */
  fix?: string;
}

/**
 * What the linter knows about the document the block lives in. Everything is optional: a
 * caller that only has the code still gets every rule that can be checked from the code.
 */
export interface DiagramContext {
  /** The role of the node the document belongs to: repository, application or domain. */
  role?: NodeRole;
  /** The level a data model declares, when it declares one. */
  level?: DataLevel;
  /** True when the system itself produced the block: a derived class is then exactly right. */
  generated?: boolean;
}

/**
 * Checks a diagram against the standard of its class. Only the rules that know how to look
 * at the code are evaluated; the rest stay as guidance for whoever writes it. The context is
 * optional and adds the checks that need to know where the document lives.
 */
export function lintDiagram(code: string, kind: DiagramKind, ctx: DiagramContext = {}): DiagramIssue[] {
  const std = DIAGRAM_STANDARDS[kind];
  const issues: DiagramIssue[] = [];
  for (const rule of std.rules) {
    if (!rule.check) continue;
    if (!rule.check(code)) issues.push({ rule: rule.id, severity: rule.severity, text: rule.text });
  }
  // A derived class found inside a document was written by hand: it will drift the day the
  // catalogue changes, and the landscape page already draws it right.
  if (std.origin === 'derived' && !ctx.generated) {
    issues.push({
      rule: 'derived-diagram-authored',
      severity: 'error',
      text: `\`${std.label}\` is derived from the catalogue, not written: hand-writing it guarantees it will disagree with the catalogue.`,
      fix: 'delete the block; the landscape page generates it',
    });
  }
  // The level of a data model says where it belongs: the physical schema is what the code
  // creates, and the conceptual one is the shared language of the business.
  if (kind === 'data-model' && ctx.level && ctx.role) {
    if (ctx.level === 'physical' && ctx.role !== 'repository') {
      issues.push({ rule: 'data-model-level', severity: 'error', text: 'A `level: physical` data model is only accepted in a repository: it is the schema the code creates.', fix: 'move it to the repository that creates the schema, or lower the level to logical' });
    }
    if (ctx.level === 'conceptual' && ctx.role !== 'domain') {
      issues.push({ rule: 'data-model-level', severity: 'error', text: 'A `level: conceptual` data model is only accepted in the domain: it is the shared language of the business, not of one application.', fix: 'move it to the domain node, or raise the level to logical' });
    }
  }
  // Attribute blocks (`ENTITY { … }`) are not nodes: counting them would exaggerate the size.
  const withoutAttributes = code.replace(/\{[^{}]*\}/gs, '');
  const nodes = withoutAttributes.split('\n').filter((l) => /^\s*\w+[\s(\[]/.test(l)).length;
  if (nodes > std.maxNodes * 2) {
    issues.push({ rule: 'size', severity: 'warning', text: `It looks too big to read at a glance (recommended maximum: ${std.maxNodes} elements).`, fix: 'split it into several diagrams, or filter it by domain' });
  }
  return issues;
}

const LAYER_TITLE: Record<Layer, string> = {
  business: 'Business',
  process: 'Process',
  data: 'Data',
  application: 'Applications',
  technology: 'Technology',
  infrastructure: 'Infrastructure',
};

/** The diagram standard in Markdown, for the pack the AI reads and for the web. */
/*
 * The skin of a class lives with the renderer that reads it, in `@laru/diagrams`, so
 * the web can paint without asking the API. The standard is still what declares one, which
 * is why it is attached here rather than looked up at every call site.
 */
for (const kind of DIAGRAM_KINDS) {
  const skin = SKINS[kind];
  if (skin) DIAGRAM_STANDARDS[kind].skin = skin;
}
/*
 * Compiled once, at the door, rather than by each of the four places that show a template.
 * Measured before making it eager: 47 ms for all twenty-seven, which is less than the cost of
 * being wrong about which of them is typed.
 */
for (const kind of DIAGRAM_KINDS) {
  DIAGRAM_STANDARDS[kind].typedTemplate = typedTemplate(kind);
}

/**
 * The template of a class as the typed model somebody would write.
 *
 * There is one template per class and it is written in Mermaid, because that is what it has
 * always been; for a class the engine paints, it is compiled here rather than kept twice.
 * Two copies of the same drawing drift, and the one nobody looks at is the one that rots.
 *
 * With one exception, and it is the exception that proves the rule: painting and reading are
 * two capabilities, and `c4-code` has the first without the second. The engine draws a class
 * box with its band and its fields, but nothing reads `classDiagram` back into a model, so
 * there is no compiling its template — it is written out below instead. It says exactly what
 * the Mermaid above it says (the same two classes, the same fields, the same cardinalities)
 * and it carries its positions, because a template is an authored drawing and an authored
 * drawing places its own pieces. The day a `classDiagram` reader arrives, this goes and the
 * compiler takes it back.
 */
function typedTemplate(kind: DiagramKind): string | undefined {
  if (!paintsKind(kind)) return undefined;
  if (kind === 'c4-code') {
    return writeModel({
      kind,
      title: 'Code · classes',
      direction: 'LR',
      nodes: [
        { id: 'order', shape: 'class', name: 'Order', attributes: ['string id', 'string status'], x: 40, y: 40 },
        { id: 'line', shape: 'class', name: 'Line', attributes: ['string id', 'int amount'], x: 360, y: 40 },
      ],
      edges: [{ id: 'e1', from: 'order', to: 'line', fromCard: '1', toCard: '0..*' }],
    });
  }
  try {
    if (kind === 'sequence') {
      const read = parseSequence(DIAGRAM_STANDARDS[kind].template);
      return read.model.participants.length ? writeModel({ kind, ...read.model }) : undefined;
    }
    const skin = SKINS[kind];
    if (!skin) return undefined;
    const read = fromMermaid(DIAGRAM_STANDARDS[kind].template, kind);
    if (!read || read.model.nodes.length === 0) return undefined;
    /*
     * A template is written in Mermaid and Mermaid has no word for a `container`: the reader
     * reports the geometry it saw and only the skin knows what that is on this sheet. Three
     * classes had no typed template at all for want of it — the maps of the catalogue, whose
     * roles are named after the thing and not after the box. It is the reader's own job now,
     * so every caller gets it and not just this one.
     */
    const placed = propose(read.model, { kind, skin }).model;
    return paints(placed) ? writeModel(placed) : undefined;
  } catch {
    return undefined;
  }
}

export function buildDiagramsPack(): string {
  const L: string[] = ['# Diagram standard', '',
    'A diagram is not a free drawing: every class has its shapes, its colours and its rules, and whoever',
    'reads it must understand it without asking. The classes are grouped by layer, from what the business',
    'is down to where it runs, and each one answers one question.',
    '',
    '**How a diagram is written.** Most classes are drawn by the engine of Laru from a typed model',
    'inside a ```` ```pd-diagram ```` fence: JSON with the class, the pieces and — for a class somebody',
    'draws — where each piece goes. You place them; the engine measures the result and refuses a drawing',
    'that cannot be read, naming what is wrong and what to change. The classes the engine does not paint',
    'yet are still written in their Mermaid dialect, and the table below says which is which.',
    '',
    'Two origins. **Written**: a person draws it inside a document. **Derived**: the system builds it from',
    'the catalogue and shows it on the landscape page of its layer. A derived class written by hand is a',
    'copy that will rot — export it as Mermaid if you need it somewhere, but do not maintain it.',
    '',
    '**Where the model ends up.** Write it inside the fence and `docs_write` files it: a drawing lives in',
    '`diagrams/<document id>.<heading>.json` beside the document, and the fence keeps',
    '`{ "$ref": "diagrams/…json" }` in its place. The `.md` stays the index — it says the order of the',
    'drawings and the heading each one sits under — and a document does not grow by two hundred lines',
    'because somebody moved a box. When you read a document back, the fence you get is the model: it is',
    'resolved for you.',
    '',
    '**A piece can wear a glyph.** `"icon": "logos:aws-lambda"` for the official mark of a real service,',
    '`"icon": "stencil:bpmn/task"` for notation and for the services no official mark exists for — BPMN,',
    'ArchiMate, UML, the integration patterns, AWS, Google, Azure, Kubernetes, network topology. Where',
    'both have it, use `logos:`. The glyph never carries the meaning on its own: the shape does.',
    '',
    '| Class | Layer | Question | Written as | Origin |',
    '|---|---|---|---|---|'];
  for (const kind of DIAGRAM_KINDS) {
    const s = DIAGRAM_STANDARDS[kind];
    const how = paintsKind(kind) ? `\`pd-diagram\` · \`${s.kind}\`` : `Mermaid \`${s.dialect}\``;
    L.push(`| \`${s.kind}\` · ${s.label} | ${LAYER_TITLE[s.layer]} | ${s.question} | ${how} | ${DIAGRAM_ORIGIN_LABEL[s.origin]} |`);
  }
  L.push('');
  for (const layer of LAYERS) {
    const kinds = kindsOfLayer(layer);
    if (!kinds.length) continue;
    L.push(`## ${LAYER_TITLE[layer]}`, '');
    for (const kind of kinds) {
      const s = DIAGRAM_STANDARDS[kind];
      L.push(`### ${s.label} (\`${s.kind}\`)`, '',
        `**Question**: ${s.question}`, '',
        s.purpose, '',
        `**Origin**: ${DIAGRAM_ORIGIN_LABEL[s.origin]}.${s.origin === 'derived' ? ' It is not written by hand: the landscape page generates it.' : s.usedIn.length ? ` Appears in ${s.usedIn.map((t) => `\`${t}\``).join(', ')}.` : ''}`, '',
        paintsKind(kind)
          ? `**Written as**: a \`pd-diagram\` fence with \`"kind": "${s.kind}"\`. At most ${s.maxNodes} elements.`
          : `**Written as**: Mermaid \`${s.dialect}\`${s.alsoAccepts.length ? ` (also accepted: ${s.alsoAccepts.map((d) => `\`${d}\``).join(', ')})` : ''}. At most ${s.maxNodes} elements.`, '',
        '**What each shape means**', '', '| Shape | What it represents |', '|---|---|');
      for (const l of s.legend) L.push(`| ${l.shape} | ${l.means} |`);
      L.push('', '**Rules**', '');
      /*
       * The dialect rule is not printed for a class the engine paints: the line above
       * already said it is written as a typed block, and «Required: written in erDiagram»
       * under it is the standard contradicting itself in the same breath.
       */
      for (const r of s.rules) {
        if (r.id === 'dialect' && paintsKind(kind)) continue;
        L.push(`- ${r.severity === 'error' ? '**Required**' : 'Recommended'}: ${r.text}`);
      }
      // The one the standard carries, so the pack and the page cannot disagree about it.
      const typed = s.typedTemplate;
      L.push('', ...(typed ? ['```pd-diagram', typed, '```'] : ['```mermaid', s.template, '```']), '');
    }
  }
  return L.join('\n');
}
