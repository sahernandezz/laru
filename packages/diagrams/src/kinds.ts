/**
 * The classes of diagram the standard defines, and the facts the model needs about one.
 *
 * The list lives here and not in the core because both the core and the web need it, and
 * the web cannot import the core. What each class *demands* — its dialect, its legend, its
 * rules, its template — is the documentation standard and stays in the core; this package
 * only needs to know that the classes exist and, of a given one, the five facts below.
 */
export const DIAGRAM_KINDS = [
  // Business
  'domain-map', 'value-stream',
  // Process
  'process-landscape', 'process', 'sequence', 'state',
  // Data
  'data-landscape', 'data-model', 'data-flow', 'data-lineage',
  // Application
  'application-landscape',
  'c4-landscape', 'c4-context', 'c4-container', 'c4-component', 'c4-code',
  'integration', 'dependency', 'packages', 'roadmap', 'lifecycle', 'versioning', 'capabilities',
  // Technology
  'stack-map',
  // Infrastructure
  'deployment', 'environment-map', 'network',
] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/**
 * What the model reads from the standard of a class.
 *
 * Structural on purpose: `DIAGRAM_STANDARDS[kind]` of the core satisfies it without this
 * package importing anything. If the model ever needs a sixth fact, it is added here and
 * the core keeps not knowing that this package exists.
 */
export interface StandardFacts {
  kind: DiagramKind;
  /** What each shape or colour means: the legend that makes the diagram readable. */
  legend: Array<{ shape: string; means: string }>;
  rules: Array<{ id: string; text: string; severity: 'error' | 'warning' }>;
  /** How many elements at most before it stops being readable. */
  maxNodes: number;
  template: string;
  /** The document types the class appears in. A derived class lists none. */
  usedIn: readonly string[];
  /** Who draws it: a person in a document, or the system from the catalogue. */
  origin: 'authored' | 'derived';
}

/**
 * How a piece of a class is drawn, so the engine paints the standard instead of a style.
 *
 * The legend of a class already says what each shape means, in prose, for a reader. The
 * skin says the same thing in data, for the renderer: same `shape` key on both sides, so a
 * C4 looks like a C4 because the standard says so and not because whoever drew it happened
 * to pick the right blue. A class without a skin is one whose renderer has not arrived: it
 * still draws through Mermaid.
 */
export interface SkinRole {
  /** The legend entry this paints, written exactly as the legend writes it. */
  shape: string;
  /**
   * The geometry the renderer draws.
   *
   * Silhouette is the channel a reader resolves first — before colour, before the label —
   * so it is the one that has to carry the difference between two classes that mean
   * different things. `node`, `chevron` and `pipe` exist for exactly that: a host, a stage
   * in time and a conduit were all being drawn as the same rectangle.
   */
  form:
    | 'rect' | 'rounded' | 'stadium' | 'cylinder' | 'queue' | 'person' | 'boundary'
    | 'class' | 'terminal' | 'entity' | 'diamond' | 'hexagon'
    | 'node' | 'chevron' | 'pipe' | 'document';
  /**
   * What this piece is on the ground, which is what carries its colour.
   *
   * A semantic slot and never a hex: the palette is the renderer's business. The names are
   * about the thing, not about its depth in a hierarchy — the previous set (`own`,
   * `container`, `component`) described position in a C4 drawing, which is why every class
   * that was not C4 ended up reusing the same three.
   */
  tone:
    | 'subject' | 'actor' | 'external' | 'runtime' | 'part'
    | 'store' | 'channel' | 'step' | 'gate' | 'frame' | 'zone';
  /** True on the ones that hold other pieces inside them. */
  wraps?: boolean;
  /**
   * The icon this role wears when the model does not name one.
   *
   * A type is never told apart by colour alone, and on a landscape it is the icon that does
   * the telling. Leaving it to every author to remember `pd:module` on every piece is how
   * half a drawing ends up unmarked.
   */
  icon?: string;
  /** Whether the piece shows its technology under the name. */
  technology?: boolean;
}

export interface SkinEdge {
  shape: string;
  stroke: 'solid' | 'dashed';
  head: 'arrow' | 'none';
  /** Whether the arrow is expected to say what travels and with which technology. */
  labelled?: boolean;
}

export interface DiagramSkin {
  roles: SkinRole[];
  edges: SkinEdge[];
}

/**
 * The skin of each class whose renderer exists.
 *
 * Here and not in the core so the web can paint without asking the API for it: the render
 * stays synchronous, there is no loading state and no fetch-gated mount. The core attaches
 * these to `DIAGRAM_STANDARDS` when it builds it, because the standard is what declares a
 * skin — but the data lives with the renderer that reads it.
 */
export const SKINS: Partial<Record<DiagramKind, DiagramSkin>> = {
  'c4-landscape': {
    roles: [
      { shape: 'System', form: 'rounded', tone: 'subject' },
      { shape: 'System_Ext', form: 'rounded', tone: 'external' },
      { shape: 'Person', form: 'person', tone: 'actor' },
      { shape: 'Enterprise_Boundary', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: 'Rel', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'c4-context': {
    roles: [
      { shape: 'Person', form: 'person', tone: 'actor' },
      { shape: 'Person_Ext', form: 'person', tone: 'external' },
      { shape: 'System', form: 'rounded', tone: 'subject' },
      { shape: 'System_Ext', form: 'rounded', tone: 'external' },
    ],
    edges: [{ shape: 'Rel', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'c4-container': {
    roles: [
      { shape: 'Person', form: 'person', tone: 'actor' },
      { shape: 'Container', form: 'rounded', tone: 'runtime', technology: true },
      { shape: 'ContainerDb', form: 'cylinder', tone: 'store', technology: true },
      { shape: 'ContainerQueue', form: 'pipe', tone: 'channel', technology: true },
      { shape: 'Container_Boundary', form: 'boundary', tone: 'zone', wraps: true },
      { shape: 'System_Boundary', form: 'boundary', tone: 'zone', wraps: true },
      { shape: 'System_Ext', form: 'rounded', tone: 'external' },
      { shape: 'SystemQueue_Ext', form: 'pipe', tone: 'external' },
    ],
    edges: [{ shape: 'Rel', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'c4-component': {
    roles: [
      { shape: 'Component', form: 'rounded', tone: 'part', technology: true },
      { shape: 'ComponentDb', form: 'cylinder', tone: 'store', technology: true },
      { shape: 'Container_Boundary', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: 'Rel', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'c4-code': {
    roles: [{ shape: 'class', form: 'class', tone: 'part' }],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  state: {
    roles: [
      { shape: 'state', form: 'stadium', tone: 'step' },
      { shape: 'terminal', form: 'terminal', tone: 'subject' },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'data-model': {
    roles: [{ shape: 'entity', form: 'entity', tone: 'store' }],
    edges: [{ shape: '--', stroke: 'solid', head: 'none', labelled: true }],
  },
  /*
   * A decision is the only red on any sheet, and a lane is a grouping rather than a
   * territory — it says who does the work, not where the work lives, so it gets the broken
   * keyline and no ground of its own.
   */
  process: {
    roles: [
      { shape: 'stadium', form: 'stadium', tone: 'subject' },
      { shape: 'rect', form: 'rect', tone: 'step' },
      { shape: 'diamond', form: 'diamond', tone: 'gate' },
      { shape: 'cylinder', form: 'cylinder', tone: 'store' },
      { shape: 'hexagon', form: 'hexagon', tone: 'external' },
      { shape: 'group', form: 'boundary', tone: 'frame', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * A landscape of processes is a tree, not a flow: the parent is a territory that owns the
   * subprocesses drawn inside it, and each process is a unit of work typed by its pack
   * rather than by its silhouette — the soft rectangle keeps it from reading as a step of a
   * process diagram, where the hard rect already means exactly that.
   */
  'process-landscape': {
    roles: [
      { shape: 'rect', form: 'rounded', tone: 'step', icon: 'pd:process' },
      { shape: 'icon', form: 'rounded', tone: 'step', icon: 'pd:process' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /* A stage in a stream is a stage in time, and the notch says which way to read it. */
  'value-stream': {
    roles: [
      { shape: 'rect', form: 'chevron', tone: 'step' },
      { shape: 'group', form: 'boundary', tone: 'frame', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * Six stages that never branch, which is the drawing a value stream already is: the notch
   * says which way to read it and spares the reader the arrowheads. A stage nothing covers
   * is the same silhouette with a broken keyline — what the legend calls a dashed box — and
   * `external` is the tone that draws one, so the state is told by the line and the label
   * and never by the colour, which is what this class's own rule asks for.
   */
  lifecycle: {
    roles: [
      { shape: 'rect', form: 'chevron', tone: 'step' },
      { shape: 'empty', form: 'chevron', tone: 'external' },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'data-flow': {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'step' },
      { shape: 'cylinder', form: 'cylinder', tone: 'store' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * The stores are the subject and the domain that owns them is the ground. A plain box on
   * this sheet is the application that persists into one — the only other thing the legend
   * draws — so it keeps the tone of something deployed and running.
   */
  'data-landscape': {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'runtime' },
      { shape: 'icon', form: 'cylinder', tone: 'store', icon: 'pd:datastore' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * Three roles because the legend has three: somewhere the data rests, something that
   * transforms it, and the hop between them. No ground of its own — lineage is a chain, and
   * a frame around it would be saying something the class does not.
   */
  'data-lineage': {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'step' },
      { shape: 'cylinder', form: 'cylinder', tone: 'store' },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * Told apart from a data flow by its register and its ends, not by redefining what the
   * author wrote: the legend of this class says a cylinder is a store, so it stays one.
   */
  integration: {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'runtime' },
      { shape: 'cylinder', form: 'cylinder', tone: 'store' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  packages: {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'part' },
      { shape: 'group', form: 'boundary', tone: 'frame', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * A capability is something the application has, not a step it runs: the soft rectangle
   * says so against the hard one of a process sheet, and the module that implements it is
   * the same kind of piece — both are parts of the application. The subgraph is the
   * application or the domain it serves, which is a territory and not a «these go together».
   */
  capabilities: {
    roles: [
      { shape: 'rect', form: 'rounded', tone: 'part' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * A gantt drawn as pieces. A section is a phase and holds its milestones; the three states
   * are told apart by silhouette first — settled, still moving, flagged — and the tone only
   * reinforces it. There are no arrows on a roadmap: what orders it is the calendar.
   */
  roadmap: {
    roles: [
      { shape: 'phase', form: 'boundary', tone: 'zone', wraps: true },
      { shape: 'milestone', form: 'stadium', tone: 'runtime' },
      /*
       * A soft box and not a chevron, though a chevron says «still moving» better. `roomIn`
       * keys the writing area off the **shape's name**, not off the form the skin declares,
       * so a shape called `active` drawn as a chevron is measured as if it were a plain box:
       * the estimate wraps at 170px, the renderer wraps at 134, and the three longest task
       * names in the real plan hung out of the bottom of their bars.
       */
      { shape: 'active', form: 'rounded', tone: 'subject' },
      { shape: 'risk', form: 'hexagon', tone: 'gate' },
    ],
    edges: [],
  },
  /*
   * A technology is a piece the system is built from and wears its pack; what uses it is
   * something deployed and running. Two silhouettes and two tones, and the version travels
   * on the arrow because that is the question this sheet is asked.
   */
  'stack-map': {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'runtime' },
      { shape: 'icon', form: 'rounded', tone: 'part', icon: 'pd:technology' },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /* A deployed thing is a site on the ground: the octagon is the map glyph for an
   * installation and nothing else in the product wears it. */
  deployment: {
    roles: [
      { shape: 'rect', form: 'node', tone: 'runtime' },
      { shape: 'cylinder', form: 'cylinder', tone: 'store' },
      { shape: 'icon', form: 'node', tone: 'runtime' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /*
   * An environment is the textbook zone — a territory that means something — and what runs
   * inside it is a runtime, the same tone it wears on the deployment sheet next door.
   */
  'environment-map': {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'runtime' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  /* A gateway, a balancer and a firewall are all controlled crossings: on this sheet the
   * pieces are red and the territories are trust zones. */
  network: {
    roles: [
      { shape: 'rect', form: 'rect', tone: 'gate' },
      { shape: 'cylinder', form: 'cylinder', tone: 'store' },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  },
  'domain-map': catalogue(),
  'application-landscape': catalogue(),
  dependency: catalogue(),
};

/**
 * The skin the maps of the catalogue share.
 *
 * A map drawn from the catalogue has four kinds of piece, whatever the class: something
 * that holds other things, something written about one of them, something that stores
 * data, and the frame around a group. What tells a domain from an application from a
 * runbook is the icon of its type, never the colour — that is a rule of the product and
 * the reason the renderer takes an icon pack at all. Twenty-four tones would be a palette
 * nobody could learn; four shapes and an icon is a drawing that reads.
 */
function catalogue(): DiagramSkin {
  return {
    roles: [
      { shape: 'container', form: 'rounded', tone: 'subject', technology: true },
      { shape: 'facet', form: 'document', tone: 'part', technology: true },
      { shape: 'store', form: 'cylinder', tone: 'store', technology: true },
      { shape: 'group', form: 'boundary', tone: 'zone', wraps: true },
    ],
    edges: [{ shape: '-->', stroke: 'solid', head: 'arrow', labelled: true }],
  };
}
