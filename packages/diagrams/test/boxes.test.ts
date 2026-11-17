/**
 * The renderer of boxes, arrows and nested boundaries.
 *
 * Two properties matter more than what any single drawing looks like. The same model has to
 * produce the same bytes — otherwise a snapshot means nothing, an export is not what was on
 * screen, and a diff of a regenerated diagram is noise. And no colour may appear in the
 * output: the tone is a class and the palette is the stylesheet, which is what makes light
 * and dark one decision instead of two.
 */
import { describe, expect, it } from './vitest.ts';
import { fromMermaid, renderBoxes, renderTyped, paintsBoxes, type DiagramModel, type Rendered } from '../src/index.ts';
import { REGISTERS } from '../src/render/sheet.ts';
import { DIAGRAM_STANDARDS } from '../src/standards.ts';

const container: DiagramModel = {
  kind: 'c4-container', title: 'Contenedores de VaultFlow', direction: 'TD',
  nodes: [
    { id: 'limite', shape: 'Container_Boundary', name: 'VaultFlow', x: 40, y: 40, w: 620, h: 420 },
    { id: 'nav', shape: 'System_Ext', name: 'Navegador', x: -220, y: 180 },
    { id: 'api', shape: 'Container', name: 'API Gateway', technology: 'Spring', x: 80, y: 180 },
    { id: 'db', shape: 'ContainerDb', name: 'PostgreSQL', technology: 'PostgreSQL 16', x: 400, y: 100 },
    { id: 'cola', shape: 'ContainerQueue', name: 'Kafka', technology: 'KRaft', x: 400, y: 300 },
  ],
  edges: [
    { id: 'e1', from: 'nav', to: 'api', label: 'cobra', technology: 'HTTPS' },
    { id: 'e2', from: 'api', to: 'db', label: 'lee y escribe' },
    { id: 'e3', from: 'api', to: 'cola', label: 'publica' },
  ],
};

const skinOf = (kind: keyof typeof DIAGRAM_STANDARDS) => DIAGRAM_STANDARDS[kind].skin;

describe('renderBoxes', () => {
  it('draws the same bytes for the same model', () => {
    expect(renderBoxes(container, skinOf('c4-container')).svg).toBe(renderBoxes(container, skinOf('c4-container')).svg);
  });

  it('carries its own palette, because an export resolves no external CSS', () => {
    const { svg } = renderBoxes(container, skinOf('c4-container'));
    // Every piece is still classed by its semantic tone; what changed is that the sheet
    // that paints those classes travels inside the file.
    expect(svg).toContain('class="pd-node pd-runtime"');
    expect(svg).toContain('class="pd-node pd-store"');
    expect(svg).toContain('class="pd-node pd-external"');
    expect(svg).toContain('<style>');
    expect(svg).toContain('.pd-runtime > rect');
    // And a face, so the export measures the same text the estimate sized the boxes for —
    // with the interface face behind it, because a drawing opened where Excalifont never
    // loaded still has to be readable and `cursive` is whatever that machine decided it is.
    expect(svg).toMatch(/font-family: 'Inter'/);
    /*
     * No piece paints itself: colour reaches it through its class and nowhere else. It has
     * to name `path` too — a hand-drawn silhouette is a path, and a guard that only looked
     * at rects and circles stopped inspecting anything the day the ink arrived.
     */
    expect(svg.split('<style>')[0] + svg.split('</style>')[1]).not.toMatch(/<(rect|circle|path|ellipse)[^>]*fill="#/);
  });

  it('scopes its sheet to itself, so one drawing does not repaint the one beside it', () => {
    /*
     * An SVG's `<style>` applies to the whole document it lands in, not to the SVG that
     * carries it, and an architecture page shows four drawings at once. Before the scope,
     * the last one parsed gave every other drawing on the page its own route colour.
     */
    const flow = renderBoxes({ ...container, kind: 'data-flow' }, skinOf('c4-container')).svg;
    const app = renderBoxes(container, skinOf('c4-container')).svg;
    expect(flow).toContain('pd-reg-data');
    expect(app).toContain('pd-reg-application');
    for (const rule of flow.split('<style>')[1].split('</style>')[0].split('\n')) {
      if (rule.trim()) expect(rule.trim().startsWith('.pd-reg-data')).toBe(true);
    }
    // And the two disagree about exactly the thing that is per-sheet. Taken from the
    // registers rather than typed here, so re-tempering the palette does not fail a test
    // that is about scoping.
    expect(flow).toContain(`stroke: ${REGISTERS.data.route}`);
    expect(app).toContain(`stroke: ${REGISTERS.application.route}`);
    expect(REGISTERS.data.route).not.toBe(REGISTERS.application.route);
  });

  it('lets the marks that are not the tint keep their own fill', () => {
    /*
     * The band of an entity, the index down a box, the ground of a region and the keyline
     * around it all exist to differ from the tone's fill — and a rule of the form
     * `.pd-zone > rect` outranks a plain `.pd-band`, so each of them got silently repainted
     * with the very fill it is there to contrast against. It cost a flat entity header, and
     * a boundary keyline that filled itself in and hid the region texture underneath.
     *
     * The property that has to hold: for every tone, each of those four selectors carries at
     * least as many classes as the generic one and is declared after it.
     */
    const sheet = renderBoxes(container, skinOf('c4-container')).svg.split('<style>')[1].split('</style>')[0];
    const rules = sheet.split('\n').filter((r) => r.includes('{'));
    const classes = (rule: string) => (rule.split('{')[0].match(/\./g) ?? []).length / (rule.split('{')[0].split(',').length);
    for (const tone of ['store', 'zone', 'runtime']) {
      const generic = rules.findIndex((r) => r.includes(`.pd-node.pd-${tone} > rect`));
      expect(generic, `${tone} has a generic rule`).toBeGreaterThan(-1);
      for (const mark of ['.pd-index', '.pd-region', '.pd-neat']) {
        const at = rules.findIndex((r, i) => i > generic && r.includes(`pd-${tone}`) && r.includes(mark));
        expect(at, `${tone} ${mark} is declared after the generic rule`).toBeGreaterThan(generic);
        expect(classes(rules[at])).toBeGreaterThanOrEqual(classes(rules[generic]));
      }
    }
  });

  it('never declares a fill for what a pattern fills, because the declaration would win', () => {
    /*
     * The region hatch carries its pattern in a `fill="url(#…)"` attribute,
     * and a CSS declaration beats a presentation attribute — a `fill: none` in the rule for
     * those elements made the ruling vanish with nothing to show for it anywhere.
     */
    const sheet = renderBoxes(container, skinOf('c4-container')).svg.split('<style>')[1].split('</style>')[0];
    for (const cls of ['.pd-hatch']) {
      const rule = sheet.split('\n').find((r) => r.includes(`${cls} {`));
      expect(rule, `${cls} has a rule`).toBeTruthy();
      expect(rule).not.toMatch(/fill:/);
    }
  });

  it('prefixes the ids it defines, so two drawings on one page do not share them', () => {
    const a = renderBoxes(container, skinOf('c4-container'), { idPrefix: 'uno' });
    const b = renderBoxes(container, skinOf('c4-container'), { idPrefix: 'dos' });
    expect(a.svg).toContain('id="uno-arrow"');
    expect(a.svg).toContain('url(#uno-arrow)');
    expect(b.svg).toContain('id="dos-arrow"');
    expect(a.svg).not.toContain('dos-arrow');
  });

  it('says what it is, for a reader who cannot see it', () => {
    const { svg } = renderBoxes(container, skinOf('c4-container'));
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>Contenedores de VaultFlow</title>');
    // An intrinsic size as well as a viewBox: inside an <img> a viewBox alone can be nothing.
    expect(svg).toMatch(/<svg [^>]*width="\d+" height="\d+"/);
  });

  it('refuses to draw what it cannot place, instead of an empty card', () => {
    const loose = { ...container, nodes: [{ id: 'x', shape: 'Container', name: 'X' } as never] };
    expect(() => renderBoxes(loose, skinOf('c4-container'))).toThrow(/has no position/);
    expect(() => renderBoxes({ ...container, nodes: [] }, skinOf('c4-container'))).toThrow(/no pieces/);
  });

  it('escapes the class it writes into the root element', () => {
    const nasty = { ...container, kind: '"><script>' as never };
    expect(renderBoxes(nasty, skinOf('c4-container')).svg).not.toContain('<script>');
  });

  it('gives every piece the geometry its role asks for', () => {
    // Con la regla: aquí se comprueba la silueta, no la tinta con la que se recorre.
    const { svg } = renderBoxes(container, skinOf('c4-container'), { hand: false });
    // A store is a cylinder and a queue is a queue, which is the whole point of a skin.
    expect(svg).toMatch(/pd-store[^]*?<path d="M400 \d+ a\d+/);
    expect(svg).toContain('pd-lid');
    expect(svg.match(/<rect [^>]*rx="10"/g)?.length).toBeGreaterThan(0);
  });

  it('puts the boundary under everything it holds', () => {
    const { svg } = renderBoxes(container, skinOf('c4-container'));
    const body = svg.slice(svg.indexOf('</style>'));
    expect(body.indexOf('pd-boundary')).toBeLessThan(body.indexOf('pd-node'));
  });

  it('reports where every piece and every label ended up', () => {
    const { boxes } = renderBoxes(container, skinOf('c4-container'));
    expect(boxes.filter((b) => b.kind === 'node')).toHaveLength(5);
    expect(boxes.filter((b) => b.kind === 'label').map((b) => b.id)).toEqual(['e1', 'e2', 'e3']);
    for (const b of boxes) expect(b.fontSize, b.id).toBeGreaterThan(0);
  });

  it('fits the drawing in its box, with room around it', () => {
    const { viewBox } = renderBoxes(container, skinOf('c4-container'));
    const [x, y, w, h] = viewBox;
    expect(x).toBeLessThan(-220);
    expect(y).toBeLessThan(40);
    expect(w).toBeGreaterThan(660 - x);
    expect(h).toBeGreaterThan(0);
  });

  it('says which classes it can already paint', () => {
    expect(paintsBoxes(container, skinOf('c4-container'))).toBe(true);
    // A piece whose shape the skin does not know is a class the engine has not reached.
    expect(paintsBoxes({ ...container, nodes: [{ id: 'x', shape: 'gantt-bar', name: 'x', x: 0, y: 0 }] }, skinOf('c4-container'))).toBe(false);
    expect(paintsBoxes(container, undefined)).toBe(false);
  });
});

describe('every C4 level paints', () => {
  const levels = [
    ['c4-landscape', 'System', 'System_Ext', 'Person'],
    ['c4-context', 'Person', 'System', 'System_Ext'],
    ['c4-container', 'Container', 'ContainerDb', 'ContainerQueue'],
    ['c4-component', 'Component', 'ComponentDb', 'Container_Boundary'],
  ] as const;

  for (const [kind, ...shapes] of levels) {
    it(`draws a ${kind} with the shapes of its legend`, () => {
      const model: DiagramModel = {
        kind, title: kind, direction: 'TD',
        nodes: shapes.map((shape, i) => ({ id: `n${i}`, shape, name: `Pieza ${i}`, x: i * 240, y: 0, ...(shape.endsWith('_Boundary') ? { w: 300, h: 200 } : {}) })),
        edges: [{ id: 'e', from: 'n0', to: 'n1', label: 'usa' }],
      };
      const { svg, boxes } = renderBoxes(model, skinOf(kind));
      expect(svg.startsWith('<svg')).toBe(true);
      expect(boxes.filter((b) => b.kind === 'node')).toHaveLength(shapes.length);
      for (const role of DIAGRAM_STANDARDS[kind].skin!.roles) {
        if (shapes.includes(role.shape as never)) expect(svg, `${kind}/${role.shape}`).toContain(`pd-${role.tone}`);
      }
    });
  }
});

describe('the relations of a data model', () => {
  // VaultFlow's glossary: an owner over a column of three tables, one of them related to itself, and a table to the side two of them reach
  const code = `erDiagram
    USUARIO ||--o{ FICHERO : "es dueño de"
    USUARIO ||--o{ CARPETA : "es dueño de"
    CARPETA |o--o{ CARPETA : "contiene"
    CARPETA |o--o{ FICHERO : "contiene"
    FICHERO ||--o{ COMPARTIDO : "se comparte con"
    USUARIO ||--o{ COMPARTIDO : "recibe"
    USUARIO |o--o{ INFORME : "aparece en"
    USUARIO {
        uuid id PK
        string username
        string role "USER o ROOT"
        boolean enabled
    }
    FICHERO {
        uuid id PK
        uuid owner_id FK
        uuid folder_id FK
        string scan_status "PENDING, CLEAN o INFECTED"
        string bucket "quarantine o files"
        boolean deleted "en la papelera"
        string threat_detail "la amenaza"
    }
    CARPETA {
        uuid id PK
        uuid parent_id FK
        uuid owner_id FK
    }
    COMPARTIDO {
        uuid id PK
        uuid file_id FK
        uuid shared_with_id FK
        string permission "VIEW o DOWNLOAD"
    }
    INFORME {
        uuid id PK
        uuid owner_id FK
        string report_path
    }`;
  const drawn = renderTyped(fromMermaid(code, 'data-model')!.model) as Rendered;
  const tables = drawn.boxes.filter((b) => b.kind === 'node');
  const inside = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => p.x > b.x + 1 && p.x < b.x + b.w - 1 && p.y > b.y + 1 && p.y < b.y + b.h - 1;
  const segments = (points: Array<{ x: number; y: number }>) => points.slice(1).map((q, i) => ({ a: points[i], b: q }));

  it('never runs two relations along one stretch, where they read as one line', () => {
    const shared: string[] = [];
    for (const [i, one] of drawn.lines.entries()) for (const other of drawn.lines.slice(i + 1)) {
      for (const s of segments(one.points)) for (const t of segments(other.points)) {
        const vertical = s.a.x === s.b.x && t.a.x === t.b.x && s.a.x === t.a.x, flat = s.a.y === s.b.y && t.a.y === t.b.y && s.a.y === t.a.y;
        const [lo1, hi1, lo2, hi2] = vertical ? [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y), Math.min(t.a.y, t.b.y), Math.max(t.a.y, t.b.y)] : [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x), Math.min(t.a.x, t.b.x), Math.max(t.a.x, t.b.x)];
        if ((vertical || flat) && Math.min(hi1, hi2) - Math.max(lo1, lo2) > 0) shared.push(`${one.id} ${other.id}`);
      }
    }
    expect(shared).toEqual([]);
  });

  it('draws a relation of a table with itself as a loop outside it', () => {
    const carpeta = tables.find((b) => b.id === 'carpeta')!;
    const own = drawn.lines.find((l) => drawn.svg.includes(`data-id="${l.id}" data-ends="carpeta carpeta"`))!;
    expect(own.points.length).toBeGreaterThan(2);
    expect(own.points.filter((p) => inside(p, carpeta))).toEqual([]);
    expect(own.points.slice(1, -1).every((p) => p.x > carpeta.x + carpeta.w)).toBe(true);
  });

  it('writes every cardinality outside the tables, where it can be read', () => {
    const marks = [...drawn.svg.matchAll(/<text class="pd-card[^"]*" x="(-?[\d.]+)" y="(-?[\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) - 4 }));
    expect(marks.length).toBe(14);
    expect(marks.filter((m) => tables.some((b) => inside(m, b)))).toEqual([]);
  });

  it('keeps the keyline of a table quieter than its relations, so a relation beside it is not a second border', () => {
    expect(drawn.svg).toContain('class="pd-table"');
    expect(drawn.svg).toMatch(/\.pd-node > \.pd-table \{ stroke-opacity: 0\.4; \}/);
  });
});
