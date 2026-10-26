/**
 * The manual of diagrams in Spanish: each class's label, question and purpose, and the text of its rules. The English
 * stays in `standards.ts` (what the AI pack and the linter read); this is what the interface shows. A rule is found by
 * `<class>.<id>`; those every class has are told once, and a derived class's rule says what it is built from.
 */
import type { DiagramStandard } from './standards.ts';

const COMMON: Record<string, (p: Record<string, string | number>) => string> = {
  title: () => 'Lleva título: `title` en la primera línea del diagrama, o en su frontmatter `---\ntitle: …\n---`.',
  size: (p) => `No más de ${p.max} elementos: por encima deja de leerse y hay que dividirlo.`,
  labels: () => 'Cada flecha dice qué pasa por ella, y con qué tecnología cuando importa.',
  semicolon: () => 'Sin punto y coma fuera de una etiqueta entre comillas: Mermaid lo lee como el fin de una sentencia, y una nota o un mensaje que lo lleve impide dibujar todo el diagrama. Usa una coma.',
};

/** What a derived class is built from, for its «Derivado» rule. */
const DERIVED_FROM: Record<string, string> = {
  'domain-map': 'los documentos `domain` y sus relaciones `owned_by`',
  'process-landscape': 'los documentos `process` y su campo `process:`',
  'data-landscape': 'los documentos `datastore` y las relaciones `persists_in`',
  'data-lineage': 'los documentos `integration` encadenados con las relaciones `persists_in`',
  'application-landscape': 'los documentos `application` y sus relaciones `depends_on`',
  dependency: 'las relaciones `depends_on` del catálogo',
  lifecycle: 'las facetas de la aplicación, etapa por etapa',
  capabilities: 'los documentos `module` de la aplicación y sus relaciones `serves`',
  'stack-map': 'los documentos `stack` de cada aplicación y repositorio',
  'environment-map': 'las relaciones `runs_on` y los documentos `infrastructure`',
};
const derived = (from: string) => `Derivado: la página del paisaje lo construye a partir de ${from}. No lo escribas a mano: borra el bloque; la página del paisaje lo genera. Expórtalo como Mermaid si lo necesitas dentro de un documento.`;

interface Es { label: string; question: string; purpose: string; rules?: Record<string, string> }

export const DIAGRAM_ES: Record<string, Es> = {
  'domain-map': {
    label: 'Mapa de dominios', question: '¿Qué dominios existen y cómo se relacionan?',
    purpose: 'Las áreas de las que se compone el negocio y qué le debe cada una a las demás. Es la primera imagen de la organización, antes de que aparezca ninguna aplicación: lo que se dibuja aquí son dominios, nunca sistemas.',
    rules: { dialect: 'Escrito en `flowchart`, con un `subgraph` por dominio.', domains: 'Cada caja es un dominio, no una aplicación: una aplicación va en el paisaje de aplicaciones.', icons: 'Los dominios llevan el paquete `pd:domain` para distinguirse por forma e icono, no por color.' },
  },
  'value-stream': {
    label: 'Cadena de valor', question: '¿Cómo se crea valor de punta a punta?',
    purpose: 'La cadena de etapas que convierte la petición de un cliente en algo entregado, con quién es dueño de cada etapa y cuánto tarda. Se escribe de fuera hacia dentro: las etapas se nombran por lo que recibe el cliente, nunca por la aplicación que lo hace.',
    rules: { dialect: 'Escrito en `flowchart LR`: una cadena de valor se lee de izquierda a derecha, como el tiempo.', value: 'Las etapas se nombran por el valor que añaden («Pedido aceptado»), no por la aplicación que lo hace.', handover: 'Cada traspaso dice qué se traspasa; si se conoce el plazo, va en la misma etiqueta.', owner: 'Cada tramo de etapas va dentro del `subgraph` del dominio que es su dueño.' },
  },
  'process-landscape': {
    label: 'Paisaje de procesos', question: '¿Qué procesos existen y cuál contiene a cuál?',
    purpose: 'El árbol de procesos de la organización: los de primer nivel y los subprocesos que cuelgan de cada uno. Responde dónde está un proceso, no cómo se ejecuta: eso es el diagrama de proceso.',
    rules: { dialect: 'Escrito en `flowchart` con `subgraph`s anidados: el anidamiento es la jerarquía.', hierarchy: 'Un subproceso se dibuja dentro de su padre, nunca como una caja suelta a su lado.', 'no-steps': 'Solo procesos: los pasos de un proceso van en el diagrama de ese proceso.' },
  },
  process: {
    label: 'Proceso', question: '¿Cómo se ejecuta este proceso, paso a paso y por quién?',
    purpose: 'El flujo de un proceso de negocio u operativo: dónde empieza, qué se decide, quién hace cada paso y cómo termina. Los carriles son lo que convierte un dibujo en un proceso: sin ellos nadie sabe quién responde de qué.',
    rules: { dialect: 'Escrito en `flowchart` (o `stateDiagram-v2` cuando lo que se cuenta son estados).', swimlanes: 'Tiene carriles: al menos un `subgraph` por rol, y cada paso dentro de uno. Un proceso sin carriles no dice quién hace qué.', direction: 'Declara su dirección: `flowchart TD` de arriba abajo, `LR` de izquierda a derecha.', decisions: 'Cada rama que sale de una decisión lleva etiqueta: `-->|Sí|`.', end: 'El proceso termina: hay al menos un nodo final.' },
  },
  sequence: {
    label: 'Secuencia', question: '¿Quién habla con quién, y en qué orden?',
    purpose: 'El orden de los mensajes entre las partes en una interacción concreta: quién llama a quién, qué vuelve y qué pasa cuando falla. Responde a un único escenario, no a todo el proceso.',
    rules: { dialect: 'Escrito en `sequenceDiagram`.', participants: 'Los participantes se declaran con `participant` y su nombre real, no con letras sueltas.', errors: 'También se dibuja el camino que falla: un `alt` con el error, o una nota que diga qué pasa.' },
  },
  state: {
    label: 'Estados', question: '¿Por qué estados pasa, y qué lo mueve de uno a otro?',
    purpose: 'El ciclo de vida de una entidad o de una petición: en qué estados puede estar y qué la lleva de uno a otro. Es el diagrama que descubre los estados en los que nadie había pensado.',
    rules: { dialect: 'Escrito en `stateDiagram-v2`.', start: 'Declara el estado inicial con `[*] -->`.', transitions: 'Cada transición dice qué la dispara: `Pendiente --> Pagado: pago confirmado`.' },
  },
  'data-landscape': {
    label: 'Paisaje de datos', question: '¿Qué almacenes de datos existen, en qué dominio y quién los usa?',
    purpose: 'Cada almacén de datos con identidad propia y las aplicaciones que escriben en él. Es lo que muestra el mismo dato viviendo en tres sitios, algo que ningún documento suelto puede decir.',
    rules: { dialect: 'Escrito en `flowchart`, con un `subgraph` por dominio.', stores: 'Los almacenes llevan el paquete `pd:datastore`: una caja simple para una base de datos engaña.', 'who-uses': 'Cada almacén muestra quién persiste en él; un almacén que nadie usa es un hallazgo, no un dibujo.' },
  },
  'data-model': {
    label: 'Modelo entidad-relación', question: '¿Qué entidades y relaciones hay, y a qué nivel: conceptual, lógico o físico?',
    purpose: 'Las entidades, sus claves y sus cardinalidades. Los tres niveles son tres diagramas distintos: el conceptual es el lenguaje compartido de un dominio, el lógico pertenece a la aplicación y el físico es el esquema que un repositorio crea de verdad.',
    rules: { dialect: 'Escrito en `erDiagram`.', cardinality: 'Cada relación lleva la cardinalidad en los dos extremos y el verbo que la explica.', keys: 'Las entidades principales declaran sus campos con `PK` y `FK` donde corresponde.', level: 'Cada nivel va donde le corresponde: `level: physical` solo en un repositorio (es el esquema que crea el código) y `level: conceptual` solo en el dominio, donde vive el lenguaje compartido. El lógico pertenece a la aplicación.' },
  },
  'data-flow': {
    label: 'Flujo de datos', question: '¿Cómo se mueve un dato entre aplicaciones y almacenes?',
    purpose: 'El recorrido de un tipo de dato: dónde se produce, qué lo transforma y dónde descansa. Responde sobre el dato, no sobre los sistemas: la misma aplicación puede aparecer dos veces si toca el dato dos veces.',
    rules: { dialect: 'Escrito en `flowchart LR`: el dato se lee en la dirección en que viaja.', 'what-travels': 'Cada flecha dice qué dato viaja y por qué mecanismo; sin eso son solo cajas.', stores: 'Los almacenes son cilindros `[(…)]` y coinciden con un `datastore` del catálogo.', derivable: 'También se puede derivar de los documentos `integration`: si lo dibujado es un simple salto entre dos aplicaciones, declara la integración y deja que se genere.' },
  },
  'data-lineage': {
    label: 'Linaje de datos', question: '¿De dónde viene este dato y adónde acaba yendo?',
    purpose: 'La cadena de orígenes de un campo o de un conjunto de datos, salto a salto, para poder responder de quién es la culpa cuando una cifra está mal. Es la misma imagen que pide la auditoría.',
    rules: { dialect: 'Escrito como un `flowchart LR` encadenado: el linaje es una cadena, no una nube.', chain: 'Una línea por salto, del origen al destino, sin bifurcaciones que no sean reales.', transformation: 'Cada salto dice qué cambió: sin la transformación, el linaje no explica una cifra equivocada.' },
  },
  'application-landscape': {
    label: 'Paisaje de aplicaciones', question: '¿Qué aplicaciones existen, en qué dominio y quién depende de quién?',
    purpose: 'El mapa completo de aplicaciones agrupadas por dominio, con las dependencias entre ellas. A diferencia del paisaje C4 no se dibuja: sale de lo que federan los nodos hijos, así que no puede quedar obsoleto.',
    rules: { dialect: 'Escrito en `flowchart`, con un `subgraph` por dominio.', grouping: 'Cada aplicación va dentro del `subgraph` de su dominio; una sin dominio es un hallazgo.', scale: 'Por encima de cuarenta aplicaciones se filtra por dominio o por estado en lugar de dibujarse entero.' },
  },
  'c4-landscape': {
    label: 'C4 · Paisaje de sistemas', question: '¿Qué sistemas tiene la organización y cómo se integran?',
    purpose: 'El mapa de todos los sistemas de la empresa y cómo se integran entre sí. A diferencia del contexto, aquí no hay protagonista: se dibujan varios sistemas propios, y es el primer diagrama que mira quien entra en la organización.',
    rules: { dialect: 'Escrito en `C4Context`, como el contexto: lo que cambia es que hay varios sistemas propios.', several: 'Tiene más de un `System` propio; con uno solo, lo que corresponde es un diagrama de contexto.', boundary: 'Se recomienda un `Enterprise_Boundary`, para separar lo nuestro de lo de terceros.' },
  },
  'c4-context': {
    label: 'C4 nivel 1 · Contexto', question: '¿Qué es este sistema, quién lo usa y con qué otros sistemas habla?',
    purpose: 'Qué es el sistema, quién lo usa y con qué otros sistemas habla. Es el primer diagrama que mira alguien nuevo, y no entra en cómo está construido por dentro.',
    rules: { dialect: 'Escrito en `C4Context`, no en `flowchart`: eso es lo que da las formas y los colores del estándar.', 'one-system': 'Exactamente un `System` propio: el que se documenta. El resto son `System_Ext`.', people: 'Al menos una `Person`: un sistema que nadie usa no tiene contexto.', technology: 'Cada `Rel` lleva su tecnología como tercer argumento: `Rel(a, b, "Cobra con", "REST")`.' },
  },
  'c4-container': {
    label: 'C4 nivel 2 · Contenedores', question: '¿Qué se despliega, y dónde vive cada dato?',
    purpose: 'Las piezas desplegables del sistema (servicios, aplicaciones, bases de datos, colas) y cómo hablan entre sí.',
    rules: { dialect: 'Escrito en `C4Container`. Un `flowchart` dibujado a mano no es un nivel 2: pierde las formas, los colores y la tecnología de cada pieza.', boundary: 'Las piezas propias van dentro de un `Container_Boundary` o un `System_Boundary`.', technology: 'Cada `Container` declara su tecnología: `Container(api, "API", "Java, Quarkus", "…")`.', data: 'Las bases de datos son `ContainerDb` y las colas `ContainerQueue`: una caja simple para una base de datos engaña.' },
  },
  'c4-component': {
    label: 'C4 nivel 3 · Componentes', question: '¿Qué hay dentro de un contenedor, y qué dependencias se permiten?',
    purpose: 'Las piezas internas de UN contenedor y las dependencias permitidas entre ellas. Solo se dibuja para el contenedor principal, o para uno cuya estructura no se puede adivinar.',
    rules: { dialect: 'Escrito en `C4Component`; se acepta un `flowchart` con un `subgraph` por capa cuando el diagrama trata de paquetes de código.', 'one-container': 'Abre un solo contenedor: si hacen falta dos, son dos diagramas.', dependencies: 'Las flechas van en el sentido de la dependencia permitida, y el dominio no depende de nada.' },
  },
  'c4-code': {
    label: 'C4 nivel 4 · Código', question: '¿Qué entidades o interfaces clave no se pueden adivinar desde el nivel 3?',
    purpose: 'Las entidades o interfaces clave, cuando el modelo no se puede adivinar desde el nivel 3. Es opcional y envejece rápido: dibuja solo lo que se vaya a mantener.',
    rules: { dialect: 'Escrito en `classDiagram`.', 'key-only': 'Solo las entidades que hay que entender para trabajar aquí; no es el esquema completo, que vive en el modelo de datos.' },
  },
  integration: {
    label: 'Integración', question: '¿Cómo hablan entre sí estas aplicaciones, y qué viaja entre ellas?',
    purpose: 'El salto entre dos o más aplicaciones: qué mecanismo lo lleva, qué datos pasan y cada cuánto. Es el diagrama del documento `integration`, y cada arista es un contrato que alguien tiene que cumplir.',
    rules: { dialect: 'Escrito en `flowchart LR`: una integración se lee del origen al destino.', 'labelled-edges': 'Cada arista lleva una etiqueta con el mecanismo y el dato: `A -->|pedido hecho · Kafka| B`. Una flecha sin etiqueta no dice nada que se pueda verificar.', direction: 'La flecha apunta hacia donde viajan los datos, no hacia donde va la llamada: una lectura se dibuja de la fuente al consumidor.', frequency: 'Cuando la frecuencia importa (cada noche, bajo demanda, en tiempo real) también va en la etiqueta.' },
  },
  dependency: {
    label: 'Mapa de dependencias', question: '¿Qué se rompe si este cae?',
    purpose: 'Lo que una aplicación necesita y lo que la necesita a ella, a uno y dos saltos. Es la imagen que se mira antes de una ventana de mantenimiento, y sale de las relaciones declaradas, así que no puede mentir.',
    rules: { dialect: 'Escrito en `flowchart`.', depth: 'Dos saltos como máximo desde la aplicación que se mira: más allá es el paisaje de aplicaciones.', direction: 'La flecha va de quien necesita a quien es necesitado, siempre en el mismo sentido, o el mapa no se puede leer.' },
  },
  packages: {
    label: 'Paquetes de un repositorio', question: '¿Cómo está organizado el código, y qué puede depender de qué?',
    purpose: 'Las capas de un repositorio y qué puede depender de qué. Es lo que evita que la infraestructura se cuele en el dominio.',
    rules: { dialect: 'Escrito en `flowchart` con un `subgraph` por capa.', layers: 'Cada capa es un `subgraph` con el nombre real de su paquete.', table: 'El diagrama viene con la tabla «paquete → puede depender de», que es la parte que se puede comprobar.' },
  },
  roadmap: {
    label: 'Hoja de ruta', question: '¿Qué se entrega, y cuándo?',
    purpose: 'Los hitos del manifiesto de planificación sobre una línea de tiempo. No es una lista de deseos: cada hito de aquí es una fila de la tabla `plan`, con su fecha y su alcance, y las dos cosas deben decir lo mismo.',
    rules: { dialect: 'Escrito en `gantt` con fechas, o en `timeline` cuando solo importa el orden.', dates: 'Un `gantt` declara `dateFormat` y fechas reales: una barra sin fecha es decoración.', 'plan-match': 'Una hoja de ruta escrita a mano nombra los mismos hitos que la tabla `plan`; si difieren es el hallazgo `roadmap-plan-mismatch`. Es mejor dejar que se derive de la tabla.', state: 'Los hitos entregados se marcan `done` y los que están en riesgo `crit`, para que la imagen diga cómo va y no solo lo que se pretendía.' },
  },
  lifecycle: {
    label: 'Cobertura del ciclo de vida', question: '¿Qué etapa del ciclo de vida está cubierta, y cuál no?',
    purpose: 'Las seis etapas por las que pasa una aplicación (planificar, diseñar, construir, probar, desplegar, operar) con lo que cubre cada una y lo que falta. Una aplicación no está documentada porque tenga una arquitectura: está documentada cuando cada etapa tiene su pieza.',
    rules: { dialect: 'Escrito en `flowchart LR`.', 'six-stages': 'Las seis etapas aparecen siempre, en orden, incluso las vacías: lo que falta es el sentido del diagrama.', 'not-colour-alone': 'El estado de una etapa se dice con forma y texto, nunca solo con color.' },
  },
  versioning: {
    label: 'Ramas y versiones', question: '¿Cómo se ramifica y cómo se publica?',
    purpose: 'La estrategia de ramas: de dónde sale cada versión y cómo vuelve una corrección urgente.',
    rules: { dialect: 'Escrito en `gitGraph`.', tags: 'Las versiones publicadas llevan un `tag`, sea cual sea el esquema de versionado.', hotfix: 'La corrección urgente también se dibuja: de dónde sale y adónde vuelve.' },
  },
  capabilities: {
    label: 'Mapa de capacidades', question: '¿Qué sabe hacer esta aplicación?',
    purpose: 'Los módulos de una aplicación dibujados como lo que permiten hacer a las personas, agrupados por el dominio al que sirven. Es el mapa de módulos leído desde el lado del negocio, y sale del catálogo: una capacidad que nadie implementa es un hallazgo, no una caja que alguien olvidó.',
    rules: { dialect: 'Escrito en `flowchart`.', 'implemented-by': 'Cada capacidad enlaza con el módulo que la implementa, o se dice que nadie la implementa.' },
  },
  'stack-map': {
    label: 'Mapa de tecnologías', question: '¿Quién usa qué tecnología, y en qué versión?',
    purpose: 'Cada tecnología con las aplicaciones y repositorios que de verdad la usan y la versión en que está cada uno. Es la imagen que se mira antes de una actualización o cuando aparece una vulnerabilidad, y sale de los documentos `stack`.',
    rules: { dialect: 'Escrito en `flowchart`, de la tecnología a quienes la usan.', versions: 'Cada arista lleva la versión: sin ella el mapa no responde quién se ha quedado atrás.', grouping: 'Una tecnología por grupo; la misma aplicación aparece tantas veces como tecnologías use.' },
  },
  deployment: {
    label: 'Despliegue e infraestructura', question: '¿Dónde corre realmente cada contenedor?',
    purpose: 'Dónde corre cada cosa: regiones, redes, clústeres y servicios gestionados, con el icono de cada tecnología.',
    rules: { dialect: 'Escrito como un `pd-diagram` tipado de la clase `deployment`. Lo que sigue en Mermaid es un `flowchart` con iconos; `architecture-beta` no se acepta, coloca mal los nodos con grupos anidados.', icons: 'Los servicios gestionados llevan su icono: `id@{ icon: "logos:aws-rds", label: "…" }`.', boundaries: 'Los límites de red o de región son `subgraph`s, no cajas sueltas.' },
  },
  'environment-map': {
    label: 'Mapa de entornos', question: '¿Qué entornos existen y qué corre en cada uno?',
    purpose: 'Desarrollo, preproducción, producción y lo demás que exista, con lo que corre en cada uno. Responde la pregunta que siempre sale durante un incidente («¿esto está en producción?») y se deriva de las relaciones `runs_on`, así que no se queda obsoleto por sí solo.',
    rules: { dialect: 'Escrito en `flowchart` con un `subgraph` por entorno.', environments: 'Cada entorno es un `subgraph`, y lo que corre en él va dentro: una aplicación que no está en ningún entorno es un hallazgo.', promotion: 'El camino de promoción se dibuja de entorno a entorno, siempre en el mismo sentido.' },
  },
  network: {
    label: 'Red y zonas', question: '¿Qué redes, zonas y accesos hay?',
    purpose: 'Las zonas de seguridad, lo que hay en cada una y qué tráfico puede cruzar entre ellas. Es el único diagrama donde una flecha que falta es una decisión: lo que no se dibuja no pasa.',
    rules: { dialect: 'Escrito en `flowchart` con un `subgraph` por zona.', zones: 'Cada elemento está dentro de una zona: un elemento sin zona es un agujero sobre el que nadie ha decidido.', traffic: 'Cada flecha entre zonas dice el puerto y el protocolo; sin eso no es un diagrama de red.', 'closed-by-default': 'Lo que no está dibujado no está permitido: dilo en la leyenda para que nadie lea las flechas ausentes como un descuido.' },
  },
};

/** The class as the interface shows it: label, question, purpose and the text of every rule in Spanish (what has no translation stays). */
export function inSpanish<T extends Pick<DiagramStandard, 'kind' | 'label' | 'question' | 'purpose' | 'rules'>>(c: T): T {
  const es = DIAGRAM_ES[c.kind];
  if (!es) return c;
  return {
    ...c, label: es.label, question: es.question, purpose: es.purpose,
    rules: c.rules.map((r) => ({
      ...r,
      text: r.id === 'derived-diagram-authored' && DERIVED_FROM[c.kind] ? derived(DERIVED_FROM[c.kind]) : es.rules?.[r.id] ?? COMMON[r.id]?.(r.params ?? {}) ?? r.text,
    })),
  };
}
