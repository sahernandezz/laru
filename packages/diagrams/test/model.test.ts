/**
 * El editor visual solo vale si lo que dibuja se escribe bien y lo escrito se vuelve a
 * leer: aquí se comprueban las dos direcciones y que el código generado cumple las reglas
 * de su clase (las mismas que evalúa `packages/core/src/diagrams.ts`).
 */
import { describe, expect, it } from './vitest.ts';
import type { DiagramStandard as Full } from '../src/index.ts';

/** The part of a class's standard these tests spell out; the real one also carries its layer, question and origin. */
type DiagramStandard = Omit<Full, 'layer' | 'question'>;
import {
  addEdge, addNode, emptyModel, failingRules, fromMermaid, isVisual, labelFromMeans,
  detectDialect, kindOfCode, lintDiagram, mermaidBlocks, modelErrors, modelIssues, paletteFor, parseClass, toMermaid,
  type DiagramModel,
} from '../src/index.ts';

/** Copia de la parte del estándar que necesita la paleta (la real llega por la API). */
const stdContenedores: DiagramStandard = {
  kind: 'c4-container', origin: 'authored',
  label: 'C4 nivel 2 · Contenedores',
  purpose: 'Las piezas desplegables del sistema.',
  dialect: 'C4Container',
  alsoAccepts: [],
  legend: [
    { shape: 'Container', means: 'Algo que se despliega y se ejecuta por separado.' },
    { shape: 'ContainerDb', means: 'Un almacén de datos.' },
    { shape: 'ContainerQueue', means: 'Una cola o un bus de eventos.' },
    { shape: 'Container_Boundary', means: 'El límite del sistema.' },
    { shape: 'System_Ext', means: 'Un sistema de fuera, en gris.' },
  ],
  rules: [
    { id: 'title', text: 'Has a title.', severity: 'warning' },
    { id: 'dialecto', text: 'Se escribe en C4Container.', severity: 'error' },
    { id: 'boundary', text: 'Our own pieces go inside a boundary.', severity: 'error' },
    { id: 'technology', text: 'Every Container declares its technology.', severity: 'error' },
  ],
  maxNodes: 20,
  usedIn: ['architecture'],
  template: [
    'C4Container',
    '    title Sistema · contenedores',
    '    Person(usuario, "Usuario", "Quién lo usa")',
    '    Container_Boundary(sistema, "Mi sistema") {',
    '        Container(web, "Aplicación web", "React", "Lo que ve el usuario")',
    '        ContainerDb(db, "Base de datos", "PostgreSQL 16", "Qué guarda")',
    '    }',
    '    System_Ext(externo, "Sistema externo", "Qué aporta")',
    '    Rel(usuario, web, "Usa", "HTTPS")',
  ].join('\n'),
};

const stdProceso: DiagramStandard = {
  kind: 'process', origin: 'authored', label: 'Proceso', purpose: 'El flujo de un proceso.', dialect: 'flowchart', alsoAccepts: ['stateDiagram-v2'],
  legend: [
    { shape: '`([texto])`', means: 'Inicio y fin del proceso.' },
    { shape: '`[texto]`', means: 'Un paso.' },
    { shape: '`{texto}`', means: 'Una decisión: de ella salen dos o más caminos etiquetados.' },
    { shape: '`[(texto)]`', means: 'Algo que se persiste.' },
  ],
  rules: [], maxNodes: 25, usedIn: ['process'],
  template: 'flowchart TD\n    inicio([Empieza]) --> paso[Primer paso]\n    paso --> decision{¿Se cumple X?}\n    decision -->|Sí| fin([Termina])',
};

/** Un nivel 2 completo construido pieza a pieza, como lo haría el ratón. */
function contenedoresDeEjemplo(): DiagramModel {
  const paleta = paletteFor(stdContenedores);
  const pick = (shape: string) => paleta.find((p) => p.shape === shape)!;
  let m = emptyModel('c4-container', 'Pasarela · contenedores');
  m = addNode(m, pick('Container_Boundary'), 40, 140, 'Pasarela de Pagos');
  m = addNode(m, pick('Person'), 40, 40, 'Comercio');
  m = addNode(m, pick('Container'), 80, 200, 'API de cobros');
  m = addNode(m, pick('ContainerDb'), 300, 200, 'Autorizaciones');
  m = addNode(m, pick('System_Ext'), 40, 520, 'Adquirente bancario');
  const set = (id: string, campos: Partial<DiagramModel['nodes'][number]>) =>
    { m = { ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, ...campos } : n)) }; };
  set('api_de_cobros', { technology: 'Java, Quarkus', description: 'Orquesta el cobro' });
  set('autorizaciones', { technology: 'PostgreSQL 16', description: 'Autorizaciones y capturas' });
  set('comercio', { description: 'Cobra en tienda' });
  set('adquirente_bancario', { description: 'Red de tarjetas' });
  m = addEdge(m, 'comercio', 'api_de_cobros');
  m = addEdge(m, 'api_de_cobros', 'autorizaciones');
  m = addEdge(m, 'api_de_cobros', 'adquirente_bancario');
  m = {
    ...m,
    edges: m.edges.map((e) => ({ ...e, label: 'Usa', technology: e.to === 'autorizaciones' ? 'JDBC' : 'REST' })),
  };
  return m;
}

describe('la paleta sale del estándar', () => {
  it('ofrece las formas de la leyenda y las que use la plantilla', () => {
    const paleta = paletteFor(stdContenedores).map((p) => p.shape);
    expect(paleta).toContain('ContainerDb');
    expect(paleta).toContain('Container_Boundary');
    // La leyenda del nivel 2 no nombra a la persona, pero su plantilla la dibuja.
    expect(paleta).toContain('Person');
    expect(paleta).not.toContain('Rel');
  });

  it('traduce la sintaxis de la leyenda de un flowchart a piezas con nombre', () => {
    const paleta = paletteFor(stdProceso);
    expect(paleta.map((p) => p.shape)).toEqual(['stadium', 'rect', 'diamond', 'cylinder']);
    expect(paleta.find((p) => p.shape === 'diamond')!.label).toBe('Decisión');
    expect(paleta.find((p) => p.shape === 'rect')!.label).toBe('Paso');
  });

  it('acorta el significado hasta dejar el nombre de la pieza', () => {
    expect(labelFromMeans('Un almacén de datos. Se dibuja como cilindro.')).toBe('Almacén de datos');
    expect(labelFromMeans('Inicio y fin del proceso.')).toBe('Inicio y fin del proceso');
  });

  it('no ofrece lienzo a las clases que no son un grafo de cajas', () => {
    expect(isVisual('versioning')).toBe(false);
    expect(isVisual('sequence')).toBe(false);
    /*
     * `c4-code` used to be here, on the grounds that a classDiagram is fields and methods
     * rather than loose boxes. The engine paints one — a class box with its band and its
     * fields — so what it lacks is a reader for hand-written Mermaid, not a silhouette, and
     * that is a different limit with a different answer: the editor keeps rows for the
     * Mermaid it cannot read and opens the canvas for a drawing that is already a model.
     */
    expect(isVisual('c4-code')).toBe(true);
    expect(fromMermaid('gitGraph\n  commit', 'versioning')).toBeNull();
    // And there is still no reader: a hand-written classDiagram comes back with no pieces
    // at all, which is exactly why the editor keeps the row table for that case.
    expect(fromMermaid('classDiagram\n  class A', 'c4-code')?.model.nodes).toEqual([]);
  });
});

describe('del modelo al Mermaid', () => {
  it('writes a c4-code in its own dialect, not in the family\'s', () => {
    /*
     * `c4-code` belongs to the C4 family on the sheet but its dialect is `classDiagram`. The
     * C4 writer speaks `class(id, "Name", "")`, so «copy as Mermaid» used to hand the author
     * C4 syntax under a `classDiagram` header — neither dialect — with every field dropped.
     */
    const model: DiagramModel = {
      kind: 'c4-code', title: 'Code · classes', direction: 'LR',
      nodes: [
        { id: 'order', shape: 'class', name: 'Order', attributes: ['string id', 'string status'], x: 40, y: 40 },
        { id: 'line', shape: 'class', name: 'Line', attributes: ['string id'], x: 360, y: 40 },
      ],
      edges: [{ id: 'e1', from: 'order', to: 'line', fromCard: '1', toCard: '0..*' }],
    };
    const code = toMermaid(model);
    expect(code).toContain('classDiagram');
    expect(code).not.toContain('class(');
    expect(code).not.toContain('Rel(');
    // The fields travel, which is the half the C4 writer silently threw away.
    expect(code).toContain('+string status');
    expect(code).toContain('Order "1" --> "0..*" Line');
    // And its own reader takes it back whole.
    const back = parseClass(code.replace(/^---[\s\S]*?---\n/, ''));
    expect(back.unsupported).toEqual([]);
    expect(back.model.classes.map((c) => c.name)).toEqual(['Order', 'Line']);
    expect(back.model.relations).toHaveLength(1);
  });

  it('escribe un nivel 2 que cumple todas las reglas de su clase', () => {
    const code = toMermaid(contenedoresDeEjemplo());
    expect(code.startsWith('C4Container')).toBe(true);
    expect(code).toContain('    title Pasarela · contenedores');
    expect(code).toContain('Container_Boundary(pasarela_de_pagos, "Pasarela de Pagos") {');
    expect(code).toContain('        Container(api_de_cobros, "API de cobros", "Java, Quarkus", "Orquesta el cobro")');
    expect(code).toContain('        ContainerDb(autorizaciones, "Autorizaciones", "PostgreSQL 16", "Autorizaciones y capturas")');
    expect(code).toContain('Rel(api_de_cobros, autorizaciones, "Usa", "JDBC")');
    expect(failingRules(code, 'c4-container')).toEqual([]);
  });

  it('mete dentro de la frontera lo que se suelta dentro y saca lo que se saca', () => {
    let m = contenedoresDeEjemplo();
    expect(toMermaid(m)).toContain('        Container(api_de_cobros');
    m = { ...m, nodes: m.nodes.map((n) => (n.id === 'api_de_cobros' ? { ...n, x: 1200, y: 900 } : n)) };
    const code = toMermaid(m);
    expect(code).toContain('    Container(api_de_cobros');
    expect(code).not.toContain('        Container(api_de_cobros');
  });

  it('reparte las filas del contexto cuando hay más de cuatro cajas', () => {
    const paleta = paletteFor({ ...stdContenedores, kind: 'c4-context' });
    let m = emptyModel('c4-context', 'Contexto');
    m = addNode(m, paleta.find((p) => p.shape === 'Person')!, 0, 0, 'Comercio');
    m = addNode(m, paleta.find((p) => p.shape === 'System')! ?? paleta[0], 0, 100, 'Pasarela');
    const code0 = toMermaid(m);
    expect(code0).not.toContain('UpdateLayoutConfig');
    for (const nombre of ['Uno', 'Dos', 'Tres', 'Cuatro']) m = addNode(m, paleta.find((p) => p.shape === 'System_Ext')!, 0, 200, nombre);
    expect(toMermaid(m)).toContain('UpdateLayoutConfig($c4ShapeInRow="3")');
  });

  it('titula el flowchart por el frontmatter, porque el dialecto no admite la palabra clave', () => {
    const paleta = paletteFor(stdProceso);
    let m = emptyModel('process', 'Alta de comercio');
    m = addNode(m, paleta.find((p) => p.shape === 'stadium')!, 40, 40, 'Llega la solicitud');
    m = addNode(m, paleta.find((p) => p.shape === 'diamond')!, 40, 200, '¿Documentación completa?');
    m = addNode(m, paleta.find((p) => p.shape === 'stadium')!, 40, 360, 'Queda dado de alta');
    m = addNode(m, paleta.find((p) => p.shape === 'rect')!, 300, 360, 'Se pide lo que falta');
    m = addEdge(m, 'llega_la_solicitud', 'documentacion_completa');
    m = addEdge(m, 'documentacion_completa', 'queda_dado_de_alta');
    m = addEdge(m, 'documentacion_completa', 'se_pide_lo_que_falta');
    m = { ...m, edges: m.edges.map((e, i) => ({ ...e, label: ['Se recibe', 'Sí', 'No'][i] })) };
    const code = toMermaid(m);
    expect(code.split('\n').slice(0, 4)).toEqual(['---', 'title: Alta de comercio', '---', 'flowchart TD']);
    expect(code).toContain('documentacion_completa{"¿Documentación completa?"}');
    expect(code).toContain('    documentacion_completa -->|Sí| queda_dado_de_alta');
    // El estándar admite el título del frontmatter, así que no falla ninguna regla.
    expect(failingRules(code, 'process')).toEqual([]);
  });

  it('escribe estados y entidades en su dialecto', () => {
    let s = emptyModel('state', 'Ciclo del pago');
    s = addNode(s, { shape: 'terminal', label: '[*]', hint: '', fields: [], group: false }, 40, 40, 'Inicio');
    s = addNode(s, { shape: 'state', label: 'Estado', hint: '', fields: ['name', 'description'], group: false }, 40, 160, 'Pendiente');
    s = addNode(s, { shape: 'state', label: 'Estado', hint: '', fields: ['name', 'description'], group: false }, 40, 300, 'Autorizado');
    s = addEdge(s, 'inicio', 'pendiente');
    s = addEdge(s, 'pendiente', 'autorizado');
    s = { ...s, edges: s.edges.map((e, i) => ({ ...e, label: ['', 'el banco responde'][i] })) };
    const code = toMermaid(s);
    expect(code.split('\n').slice(0, 2)).toEqual(['stateDiagram-v2', '    title Ciclo del pago']);
    expect(code).toContain('[*] --> pendiente');
    expect(code).toContain('pendiente --> autorizado: el banco responde');
    expect(failingRules(code, 'state')).toEqual([]);

    let e = emptyModel('data-model', 'Modelo de cobros');
    e = addNode(e, { shape: 'entity', label: 'Entidad', hint: '', fields: ['name', 'attributes'], group: false }, 40, 40, 'CLIENTE');
    e = addNode(e, { shape: 'entity', label: 'Entidad', hint: '', fields: ['name', 'attributes'], group: false }, 340, 40, 'PEDIDO');
    e = addEdge(e, 'cliente', 'pedido');
    const codeEr = toMermaid(e);
    expect(codeEr).toContain('title Modelo de cobros');
    expect(codeEr).toContain('CLIENTE ||--o{ PEDIDO : tiene');
    expect(codeEr).toContain('        uuid id PK');
    expect(failingRules(codeEr, 'data-model')).toEqual([]);
  });
});

describe('el panorama de sistemas', () => {
  const plantilla = [
    'C4Context',
    '    title Empresa · panorama de sistemas',
    '    Person(cliente, "Cliente", "Compra y consulta")',
    '    Enterprise_Boundary(empresa, "Empresa") {',
    '        System(uno, "Sistema uno", "Qué hace")',
    '        System(dos, "Sistema dos", "Qué hace")',
    '    }',
    '    System_Ext(externo, "Proveedor externo", "Qué aporta")',
    '    Rel(cliente, uno, "Usa", "Web")',
    '    Rel(uno, dos, "Publica eventos", "Kafka")',
    '    Rel(dos, externo, "Consulta", "REST")',
    '    UpdateLayoutConfig($c4ShapeInRow="3")',
  ].join('\n');

  it('se lee, se vuelve a escribir y sigue cumpliendo sus reglas', () => {
    const r = fromMermaid(plantilla, 'c4-landscape')!;
    expect(r.unsupported).toEqual([]);
    expect(r.model.nodes.filter((n) => n.shape === 'System')).toHaveLength(2);
    const output = toMermaid(r.model);
    expect(output).toContain('Enterprise_Boundary(empresa, "Empresa") {');
    expect(output).toContain('        System(uno, "Sistema uno", "Qué hace")');
    expect(output).toContain('UpdateLayoutConfig($c4ShapeInRow="3")');
    expect(failingRules(output, 'c4-landscape')).toEqual([]);
    expect(toMermaid(fromMermaid(output, 'c4-landscape')!.model)).toBe(output);
  });

  it('avisa cuando el panorama se queda con un solo sistema propio', () => {
    const r = fromMermaid(plantilla, 'c4-landscape')!;
    const m = { ...r.model, nodes: r.model.nodes.filter((n) => n.id !== 'dos') };
    expect(modelIssues(m, 15).some((a) => /several systems of our own/.test(a.text))).toBe(true);
  });
});

describe('del Mermaid al modelo (y vuelta)', () => {
  it('reconstruye las piezas de un nivel 2 escrito a mano', () => {
    const r = fromMermaid(stdContenedores.template, 'c4-container')!;
    expect(r.unsupported).toEqual([]);
    expect(r.model.title).toBe('Sistema · contenedores');
    expect(r.model.nodes.map((n) => n.id).sort()).toEqual(['db', 'externo', 'sistema', 'usuario', 'web']);
    const web = r.model.nodes.find((n) => n.id === 'web')!;
    expect(web.shape).toBe('Container');
    expect(web.technology).toBe('React');
    expect(web.description).toBe('Lo que ve el usuario');
    expect(r.model.edges).toEqual([{ id: 'e1', from: 'usuario', to: 'web', label: 'Usa', technology: 'HTTPS' }]);
    // La frontera se recoloca de forma que sus piezas siguen dentro al volver a escribir.
    expect(toMermaid(r.model)).toContain('        Container(web, "Aplicación web", "React", "Lo que ve el usuario")');
  });

  it('vuelve del código al modelo y del modelo al mismo código', () => {
    const ida = toMermaid(contenedoresDeEjemplo());
    const vuelta = toMermaid(fromMermaid(ida, 'c4-container')!.model);
    expect(vuelta).toBe(ida);
  });

  it('lee un flowchart con nodos declarados dentro de las flechas', () => {
    const r = fromMermaid(stdProceso.template, 'process')!;
    expect(r.unsupported).toEqual([]);
    expect(r.model.direction).toBe('TD');
    expect(r.model.nodes.map((n) => `${n.id}:${n.shape}`)).toEqual(['inicio:stadium', 'paso:rect', 'decision:diamond', 'fin:stadium']);
    expect(r.model.nodes.find((n) => n.id === 'decision')!.name).toBe('¿Se cumple X?');
    expect(r.model.edges.map((e) => e.label)).toEqual(['', '', 'Sí']);
    expect(toMermaid(toMermaid(r.model) === '' ? r.model : fromMermaid(toMermaid(r.model), 'process')!.model)).toBe(toMermaid(r.model));
  });

  it('conserva los subgrafos y lo que va dentro', () => {
    const code = [
      'flowchart TB',
      '    subgraph api["api"]',
      '        rest["Recursos REST"]',
      '    end',
      '    subgraph dom["domain"]',
      '        modelo["Entidades"]',
      '    end',
      '    rest --> modelo',
    ].join('\n');
    const r = fromMermaid(code, 'packages')!;
    expect(r.unsupported).toEqual([]);
    const output = toMermaid(r.model);
    expect(output).toContain('    subgraph api["api"]');
    expect(output).toContain('        rest["Recursos REST"]');
    expect(output).toContain('    subgraph dom["domain"]');
    expect(output).toContain('        modelo["Entidades"]');
    expect(toMermaid(fromMermaid(output, 'packages')!.model)).toBe(output);
  });

  it('conserva los nodos con icono de un diagrama de despliegue', () => {
    const code = [
      'flowchart TB',
      '    subgraph region["Región · eu-west-1"]',
      '        k8s@{ icon: "logos:kubernetes", form: "square", label: "Clúster", pos: "b" }',
      '        db@{ icon: "logos:postgresql", form: "square", label: "PostgreSQL gestionado", pos: "b" }',
      '    end',
      '    k8s --> db',
    ].join('\n');
    const r = fromMermaid(code, 'deployment')!;
    expect(r.unsupported).toEqual([]);
    expect(r.model.nodes.find((n) => n.id === 'k8s')).toMatchObject({ shape: 'icon', icon: 'logos:kubernetes', name: 'Clúster' });
    const output = toMermaid(r.model);
    expect(output).toContain('k8s@{ icon: "logos:kubernetes", form: "square", label: "Clúster", pos: "b" }');
    expect(failingRules(output, 'deployment')).toEqual(['title']);
    expect(toMermaid(fromMermaid(output, 'deployment')!.model)).toBe(output);
  });

  it('lee estados y entidades ya escritos', () => {
    const estados = fromMermaid('stateDiagram-v2\n    [*] --> Pendiente\n    Pendiente --> Pagado: cobro confirmado\n    Pagado --> [*]', 'state')!;
    expect(estados.unsupported).toEqual([]);
    expect(estados.model.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['__inicio>Pendiente', 'Pendiente>Pagado', 'Pagado>__fin']);
    expect(toMermaid(estados.model)).toContain('Pendiente --> Pagado: cobro confirmado');
    // Los estados que ya se llaman como su identificador no necesitan alias.
    expect(toMermaid(estados.model)).not.toContain('state "Pendiente"');

    const er = fromMermaid('erDiagram\n    CLIENTE ||--o{ PEDIDO : realiza\n    CLIENTE {\n        uuid id PK\n        string email\n    }', 'data-model')!;
    expect(er.unsupported).toEqual([]);
    expect(er.model.edges[0]).toMatchObject({ from: 'cliente', to: 'pedido', fromCard: '||', toCard: 'o{', label: 'realiza' });
    expect(er.model.nodes.find((n) => n.id === 'cliente')!.attributes).toEqual(['uuid id PK', 'string email']);
    expect(toMermaid(er.model)).toContain('CLIENTE ||--o{ PEDIDO : realiza');
  });

  it('dice qué línea no sabe interpretar en vez de tragársela', () => {
    /*
     * Los colores ya no son del autor: los decide la piel de la clase. Una línea de estilo
     * no bloquea nada, pero se dice, porque quien migra tiene derecho a saber qué dejó de
     * estar en sus manos.
     */
    const flow = fromMermaid('flowchart LR\n    a[Uno] --> b[Dos]\n    classDef rojo fill:#f00\n    class a rojo', 'process')!;
    expect(flow.unsupported).toEqual([]);
    expect(flow.notes).toEqual(['classDef rojo fill:#f00', 'class a rojo']);
    // Los retoques de colocación de un C4 ya no bloquean el lienzo: se conservan tal cual
    // y se vuelven a escribir, que es mejor que obligar a editar el diagrama como texto.
    const c4 = fromMermaid('C4Context\n    System(a, "A", "d")\n    UpdateElementStyle(a, $bgColor="red")', 'c4-context')!;
    expect(c4.unsupported).toEqual([]);
    expect(toMermaid(c4.model)).toContain('UpdateElementStyle(a, $bgColor="red")');
    // Una directiva de dibujo tampoco se pierde en silencio; un comentario se avisa aparte.
    const init = fromMermaid('%%{init: {"theme":"dark"}}%%\n%% lo dibujó el equipo\nflowchart LR\n    a[Uno] --> b[Dos]', 'process')!;
    expect(init.unsupported).toEqual(['%%{init: {"theme":"dark"}}%%']);
    expect(init.notes).toEqual(['%% lo dibujó el equipo']);
  });

  it('avisa de lo que entiende pero reescribe de otra forma', () => {
    const r = fromMermaid('flowchart LR\n    a[Uno] -.-> b[Dos]\n    b -- vuelve --> a', 'process')!;
    expect(r.unsupported).toEqual([]);
    expect(r.notes).toEqual(['a[Uno] -.-> b[Dos]']);
    expect(r.model.edges.map((e) => e.label)).toEqual(['', 'vuelve']);
  });
});

describe('los incumplimientos que se enseñan mientras se edita', () => {
  it('señala la pieza a la que le falta la tecnología', () => {
    let m = contenedoresDeEjemplo();
    m = { ...m, nodes: m.nodes.map((n) => (n.id === 'api_de_cobros' ? { ...n, technology: '' } : n)) };
    const avisos = modelIssues(m, 20);
    expect(avisos.some((a) => a.nodeId === 'api_de_cobros' && /technology/i.test(a.text))).toBe(true);
    // La regla del estándar se conforma con que algún contenedor la declare: por eso hace
    // falta el aviso por pieza, que sí dice cuál es el que se ha quedado sin tecnología.
    expect(failingRules(toMermaid(m), 'c4-container')).toEqual([]);
  });

  it('avisa de que una base de datos no puede ir como caja normal', () => {
    let m = contenedoresDeEjemplo();
    m = { ...m, nodes: m.nodes.map((n) => (n.id === 'autorizaciones' ? { ...n, shape: 'Container' } : n)) };
    expect(modelIssues(m, 20).some((a) => /ContainerDb/.test(a.text))).toBe(true);
  });

  it('exige un único sistema propio en el contexto', () => {
    const paleta = paletteFor({ ...stdContenedores, kind: 'c4-context' });
    let m = emptyModel('c4-context', 'Contexto');
    m = addNode(m, { shape: 'System', label: 'System', hint: '', fields: ['name', 'description'], group: false }, 0, 0, 'Uno');
    m = addNode(m, { shape: 'System', label: 'System', hint: '', fields: ['name', 'description'], group: false }, 0, 120, 'Dos');
    const avisos = modelIssues(m, 12);
    expect(avisos.some((a) => /2 systems of our own/.test(a.text))).toBe(true);
    expect(avisos.some((a) => a.severity === 'warning' && /Uno/.test(a.text))).toBe(true);
    expect(avisos.some((a) => /no person/i.test(a.text))).toBe(true);
    expect(paleta.length).toBeGreaterThan(0);
  });

  it('devuelve el texto de la regla que sirve la API', () => {
    const issues = lintDiagram('C4Container\n    Container(a, "A")', stdContenedores);
    expect(issues.map((i) => i.rule).sort()).toEqual(['boundary', 'technology', 'title']);
    expect(issues.find((i) => i.rule === 'boundary')!.severity).toBe('error');
    expect(issues.find((i) => i.rule === 'boundary')!.text).toBe('Our own pieces go inside a boundary.');
  });
});

describe('los diagramas que ya están dentro de un documento', () => {
  const cuerpo = [
    '## Contexto', '', '```mermaid', 'C4Context', '    title X', '    System(a, "A", "d")', '```', '',
    'Texto entre medias.', '', '```mermaid', 'flowchart TD', '    a[Uno] --> b[Dos]', '```', '',
  ].join('\n');

  it('encuentra cada bloque con su sitio exacto', () => {
    const bloques = mermaidBlocks(cuerpo);
    expect(bloques).toHaveLength(2);
    expect(bloques[0].code.startsWith('C4Context')).toBe(true);
    expect(cuerpo.slice(bloques[1].start, bloques[1].end)).toBe('```mermaid\nflowchart TD\n    a[Uno] --> b[Dos]\n```');
    // Sustituir un bloque deja el resto del documento intacto.
    const b = bloques[0];
    expect(cuerpo.slice(0, b.start) + '```mermaid\nnuevo\n```' + cuerpo.slice(b.end)).toContain('Texto entre medias.');
  });

  it('reconoce la clase de lo que ya está escrito, y desempata por el tipo de documento', () => {
    expect(detectDialect('---\ntitle: X\n---\nflowchart TD\n  a-->b')).toBe('flowchart');
    expect(kindOfCode('C4Container\n  Container(a,"A","J","d")')).toBe('c4-container');
    expect(kindOfCode('flowchart TB\n  a-->b', ['packages'])).toBe('packages');
    // Contexto y panorama comparten dialecto: desempata cuántas reglas cumple cada uno.
    const contexto = 'C4Context\n  title X\n  Person(p, "P", "d")\n  System(a, "A", "d")\n  System_Ext(b, "B", "d")\n  Rel(p, a, "Usa", "Web")';
    const panorama = 'C4Context\n  title X\n  Person(p, "P", "d")\n  System(a, "A", "d")\n  System(b, "B", "d")\n  System_Ext(c, "C", "d")\n  Rel(p, a, "Usa", "Web")';
    expect(kindOfCode(contexto, ['c4-landscape', 'c4-context'])).toBe('c4-context');
    expect(kindOfCode(panorama, ['c4-landscape', 'c4-context'])).toBe('c4-landscape');
    // Un flowchart con subgrafos y sin iconos es de paquetes antes que de despliegue.
    expect(kindOfCode('flowchart TB\n  subgraph api["api"]\n    a[Uno]\n  end\n  a --> b[Dos]', ['deployment', 'packages'])).toBe('packages');
    expect(kindOfCode('flowchart TB\n  a-->b')).toBe('process');
    expect(kindOfCode('gitGraph\n  commit')).toBe('versioning');
    expect(kindOfCode('pie\n  "a": 1')).toBeUndefined();
  });
});

describe('lo que el lienzo conserva aunque no sepa dibujarlo', () => {
  it('no pierde los retoques de colocación de un C4', () => {
    const code = [
      'C4Context',
      '    title Contexto',
      '    Person(u, "Usuario", "Compra")',
      '    System(s, "Pasarela", "Cobra")',
      '    Rel(u, s, "Paga", "HTTPS")',
      '    UpdateRelStyle(u, s, $offsetX="-150", $offsetY="90")',
    ].join('\n');
    const r = fromMermaid(code, 'c4-context');
    expect(r?.unsupported).toEqual([]);
    expect(r?.model.styleHints).toEqual(['UpdateRelStyle(u, s, $offsetX="-150", $offsetY="90")']);
    expect(toMermaid(r!.model)).toContain('UpdateRelStyle(u, s, $offsetX="-150", $offsetY="90")');
  });
});

describe('las vistas de un diagrama', () => {
  const base = {
    kind: 'c4-container' as const, title: 'T', direction: 'TD' as const,
    nodes: [
      { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
      { id: 'b', shape: 'Container', name: 'B', x: 300, y: 0 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b' }],
  };
  const facts = { kind: 'c4-container' as const, origin: 'authored' as const, maxNodes: 20 };

  it('acepta una vista que enciende piezas que existen', () => {
    const model = { ...base, views: [{ name: 'Cobrar', note: 'lo que toca un pago', ids: ['a', 'b'] }] };
    expect(modelErrors(model, facts)).toEqual([]);
  });

  it('rechaza una vista sin nombre, sin piezas o con una pieza que no está', () => {
    const model = {
      ...base,
      views: [
        { name: '', ids: ['a'] },
        { name: 'Vacía', ids: [] },
        { name: 'Fantasma', ids: ['z'] },
      ],
    };
    expect(modelErrors(model, facts).map((e) => e.path)).toEqual(['views[0].name', 'views[1].ids', 'views[2].ids[0]']);
  });
});

describe('cadenas en una línea', () => {
  const read = (code: string) => fromMermaid(code, 'process')!;
  const edges = (code: string) => read(code).model.edges.map((e) => `${e.from}${e.label ? ` -[${e.label}]-` : ' -'}> ${e.to}`);

  it('lee una cadena que empieza con una flecha etiquetada', () => {
    /*
     * El lector partía la línea solo cuando todas las flechas eran la pelada, porque el
     * comentario decía que «una cadena con etiqueta no es algo que nadie escriba». Siete
     * dibujos reales de tres catálogos escriben justo eso, y los ocho bloques que los
     * contenían se rechazaban enteros.
     */
    const { model, unsupported } = read('flowchart TD\n  G{¿Vale?} -- No --> H[401 JSON] --> Z([Fin])');
    expect(unsupported).toEqual([]);
    expect(edges('flowchart TD\n  G{¿Vale?} -- No --> H[401 JSON] --> Z([Fin])')).toEqual([
      'G -[No]-> H', 'H -> Z',
    ]);
    expect(model.nodes.map((n) => n.id)).toEqual(['G', 'H', 'Z']);
  });

  it('no parte una flecha punteada por la mitad, ni le quita su etiqueta', () => {
    // `-.->` se cortaba en su punto y el `-` de delante quedaba de extremo suelto; y el
    // `|texto|` que va DESPUÉS de la punta se leía como si fuera la pieza siguiente.
    expect(edges('flowchart TD\n  K[Buscar] -.->|Sin fragmentos| O[No lo encuentra] --> M[Responder]')).toEqual([
      'K -[Sin fragmentos]-> O', 'O -> M',
    ]);
  });

  it('sigue leyendo la cadena pelada que ya leía', () => {
    expect(edges('flowchart LR\n  a[Uno] --> b[Dos] --> c[Tres]')).toEqual(['a -> b', 'b -> c']);
  });

  it('no parte por una flecha escrita dentro de la etiqueta de una pieza', () => {
    /*
     * El escáner mira a profundidad cero de corchetes y fuera de comillas, así que esa
     * flecha es texto y no un conector: la línea no se parte por ahí.
     *
     * Leerla entera es otra cosa y sigue sin saberse hacer —las formas de abajo buscan el
     * conector con una expresión regular y encuentran antes el de la etiqueta—, pero ahora
     * se rechaza limpia: antes se inventaba una pieza `b` y dejaba el resto por el camino.
     * Un bloque con esta línea no llega a disco, que es lo que tiene que pasar.
     */
    const { model, unsupported } = read('flowchart LR\n  a["de a --> b"] --> b[Dos]');
    expect(unsupported).toHaveLength(1);
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
  });
});
