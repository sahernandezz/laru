/**
 * The standard in Spanish: what each section asks for (`type.field`) and the worked example of each type. The English
 * text stays in `standard.ts`, the source the AI and the tests read; a workspace documented in Spanish is shown these.
 * Ids, enum values and `svc:`-style references are the same in both languages: only the words change.
 */

export const HINT_ES: Record<string, string> = {
  'application.purpose': 'Qué hace y por qué existe, en dos o tres párrafos. No cómo está construido: eso lo dice el mapa.',
  'application.users': 'Quién lo usa y qué necesita cada uno.',
  'application.scope': 'Qué cubre, una línea cada cosa.',
  'application.out-of-scope': 'Lo que alguien podría esperar de él y no hace.',
  'application.constraints': 'Reglas que toda la aplicación debe respetar: normativa, plataformas, presupuestos.',
  'module.responsibilities': 'De qué se encarga, una línea cada cosa.',
  'module.boundaries': 'Lo que deliberadamente no hace, y quién lo hace en su lugar.',
  'module.acceptance': 'En una historia: las comprobaciones que dicen que está terminada.',
  'process.goal': 'Qué consigue el proceso y cuándo termina.',
  'process.actors': 'Roles y sistemas que participan. Equipos y roles, nunca personas.',
  'process.steps': 'Una fila por paso. La columna de servicio nombra ids `svc:` para poder contrastar el paso con el mapa.',
  'process.exceptions': 'Qué pasa cuando un paso falla.',
  'repository.responsibility': 'Por qué existe este repositorio aparte de los demás.',
  'repository.gotchas': 'Con qué tropieza quien trabaja aquí por primera vez.',
  'service.responsibility': 'De qué es dueño. Nunca una lista de endpoints, tablas o variables: eso se extrae.',
  'service.invariants': 'Lo que debe seguir cumpliéndose cambie lo que cambie.',
  'service.gotchas': 'Lo que sorprendió a alguien una vez.',
  'service.boundaries': 'Lo que deliberadamente no hace: «no llama a X a propósito».',
  'datastore.ownership': 'Qué equipo responde por él y qué servicio puede escribir dónde.',
  'datastore.contents': 'Esquemas, buckets o familias de topics y quién es dueño de cada uno.',
  'datastore.retention': 'Cuánto viven los datos y qué los borra.',
  'external.purpose': 'Para qué dependemos de él.',
  'external.failure-modes': 'Cómo falla y qué hacemos entonces. Es lo que reproducirán su mock y sus reglas de fallo.',
  'external.production': 'Lo que corre en producción y ningún fichero de los repos dice: imagen, perfil, memoria, cpus, protocolo, autenticación, modo (real, contrato, simular…), límite de subida o de lectura. El participante es por defecto este externo.',
  'plan.goal': 'Qué es cierto cuando el plan termina.',
  'plan.milestones': 'Hitos con fecha. Uno que sigue abierto pasada su fecha deja la etapa solo parcialmente cubierta.',
  'plan.risks': 'Qué podría detenerlo y qué se hace al respecto.',
  'decision.context': 'Las fuerzas en juego cuando se tomó la decisión.',
  'decision.decision': 'Qué se decidió, en voz activa.',
  'decision.alternatives': 'Qué más se consideró y por qué perdió.',
  'decision.tradeoffs': 'El precio de la decisión. Una decisión sin precio no se ha entendido.',
  'contract.purpose': 'Quién usa esta interfaz y para qué.',
  'contract.operations': 'Cada operación con el servicio que debería exponerla. Se contrasta con los endpoints extraídos en los dos sentidos.',
  'contract.events': 'Topics que publica o consume.',
  'contract.errors': 'Respuestas de error que quien llama debe manejar.',
  'data-model.purpose': 'Qué describe este modelo y a qué distancia: todo el sistema, una funcionalidad, un almacén.',
  'data-model.entities': 'Cada entidad con su tabla y el servicio que es su dueño. Se contrasta con las tablas extraídas.',
  'data-model.rules': 'Invariantes sobre los datos.',
  'convention.rule': 'La regla, en una o dos frases.',
  'convention.rationale': 'Qué sale mal sin ella.',
  'convention.good': 'Un ejemplo corto que la cumple, normalmente código.',
  'convention.bad': 'Un ejemplo corto que la rompe.',
  'convention.check': '`forbid: <regex>` o `require: <regex>`, aplicado a los ficheros que cubre la convención.',
  'guide.goal': 'Qué puedes hacer una vez que la has seguido.',
  'guide.steps': 'En orden, una acción cada una.',
  'guide.troubleshooting': 'Síntoma y arreglo.',
  'test-plan.strategy': 'Cómo se prueba y por qué: qué niveles cargan con el peso.',
  'test-plan.scope': 'Una fila por objetivo con los niveles que necesita: unitaria, integración, contrato, e2e.',
  'flow.goal': 'Qué demuestra el recorrido.',
  'flow.actors': 'Quién participa.',
  'flow.preconditions': 'Lo que existe antes del recorrido: una cuenta, un fichero. La especificación crea cada fila en prepare(), antes del primer paso de la historia; por debajo (la API, una sesión) solo cuando «Probado en» nombra un flujo que recorre ese camino en pantalla (su historia reproduce sus Pasos, y cada paso comprueba lo que la persona ve), no prepara por debajo esos mismos datos y se apoya solo en flujos que hacen lo mismo.',
  'flow.steps': 'La historia, paso a paso: lo que una persona hace en pantalla y lo que ve allí, y entre esos pasos las validaciones de cada formulario que rellena (vacío, formato, límites, permiso), cada una comprobando el mensaje mostrado (Tipo validation). Son los pasos de la única prueba grabada, sin ninguna llamada a la API dentro.',
  'flow.validated': 'Los flujos que guardan los pasos de validación de los formularios que esta historia rellena con una función compartida (inicio de sesión, subida) y no valida por sí misma: cada formulario así necesita aquí un flujo cuyo paso de validación, reproducido en pantalla, lo rellene él mismo en último lugar, en línea o con la función que lo rellena.',
  'scenario.given': 'Qué es cierto una vez aplicado, una fila cada cosa: los datos, quién puede iniciar sesión, cómo responde un externo.',
  'scenario.mocks': 'Cómo responde cada dependencia simulada mientras está aplicado.',
  'scenario.faults': 'Fallos en una arista mientras está aplicado: latencia en ms, un estado que se responde en su lugar, una probabilidad. En un buzón de correo o SMS el método es la etapa (CONNECT, AUTH, MAIL, RCPT, DATA, DELIVERY, POST), la ruta el destinatario y el código el del propio proveedor.',
  'scenario.mailbox': 'Qué pasa con el buzón del entorno al aplicarlo: `clear` lo vacía; `inbound-sms` envía a la aplicación un texto entrante cuando todo lo demás está aplicado (detalle: `+57300555…: STOP`, el número y el texto).',
  'scenario.restart': 'Servicios que guardan estado en memoria y se reinician al aplicarlo.',
  'runbook.symptoms': 'Lo que ves cuando esto ocurre.',
  'runbook.diagnosis': 'Comprobaciones en orden, con el comando o la pantalla exactos.',
  'runbook.fix': 'Qué restablece el servicio.',
  'runbook.escalation': 'Qué equipo, y cuándo.',
  'runbook.production': 'Lo que corre en producción y ningún fichero de los repos dice: imagen, perfil, memoria, cpus, protocolo, autenticación, modo (real, contrato, simular…), límite de subida o de lectura. Nombra al participante: un servicio, un almacén de datos o un externo.',
  'infrastructure.production': 'Lo que corre en producción y ningún fichero de los repos dice: imagen, perfil, memoria, cpus, protocolo, autenticación, modo (real, contrato, simular…), límite de subida o de lectura. Nombra al participante: un servicio, un almacén de datos o un externo.',
  'term.definition': 'Qué significa en esta aplicación.',
  'term.synonyms': 'Otras palabras con que la gente lo nombra.',
  'term.in-code': 'Nombres que toma en el código: clases, tablas, campos.',
  'note.body': 'Breve, sobre el código anclado.',
};

type Example = { title: string; summary: string; fields: Record<string, unknown> };

/** The worked example of each type, in Spanish. The ids it points at are the English example's (`svc:shop-api`...), which the validator knows. */
export const EXAMPLE_ES: Record<string, Example> = {
  application: {
    title: 'Tienda', summary: 'Tienda en línea: los clientes piden y pagan, soporte gestiona las devoluciones.',
    fields: {
      purpose: 'Permite a los clientes comprar del catálogo y pagar con tarjeta, y a soporte gestionar devoluciones sin tocar la base de datos.',
      users: [{ actor: 'Cliente', need: 'Pedir, pagar y devolver una compra' }, { actor: 'Soporte', need: 'Aprobar o rechazar una devolución' }],
      scope: ['Navegación por el catálogo', 'Pagos con tarjeta', 'Devoluciones'],
      'out-of-scope': ['Facturación a empresas'],
      constraints: ['Los datos de la tarjeta nunca se guardan: los custodia Stripe'],
      team: [{ part: 'Pedidos y pagos', team: 'Comercio' }, { part: 'Herramientas de soporte', team: 'Ingeniería de soporte' }],
    },
  },
  module: {
    title: 'Devoluciones', summary: 'Un cliente devuelve un pedido pagado; soporte lo aprueba o lo rechaza.',
    fields: {
      purpose: 'Un cliente pide devolver un pedido pagado, entero o en parte. Soporte lo aprueba o lo rechaza, y el reembolso vuelve por la tarjeta con que se pagó.',
      usecases: [{ case: 'Pedir una devolución', actor: 'Cliente', flow: 'flow:return-a-paid-order' }, { case: 'Aprobar o rechazar una devolución', actor: 'Soporte' }],
      built: 'Una devolución es una solicitud que vive en el servicio de pedidos. El portal la envía, soporte la revisa desde el back office y un worker manda el reembolso al proveedor de pagos.\n\n```mermaid\nC4Container\n  title Devoluciones, contenedores\n  Container_Boundary(shop, \"Tienda\") {\n    Container(api, \"API de la tienda\", \"Java, Spring Boot\", \"Registra devoluciones\")\n    Container(worker, \"Worker de reembolsos\", \"Java\", \"Envía los reembolsos\")\n  }\n  System_Ext(stripe, \"Stripe\", \"Pagos con tarjeta\")\n  Rel(api, worker, \"Pasa el reembolso\", \"AMQP\")\n  Rel(worker, stripe, \"Reembolsa\", \"REST\")\n```\n\nLa solicitud se registra primero y el reembolso se envía después, así un proveedor lento nunca deja al cliente esperando una respuesta.',
      responsibilities: ['Aceptar una solicitud de devolución', 'Reembolsar a través del proveedor de pagos'],
      boundaries: ['No emite notas de crédito: lo hace facturación'],
    },
  },
  process: {
    title: 'Del pedido al cobro', summary: 'Desde el pedido hasta el dinero en la cuenta.',
    fields: {
      goal: 'Un pedido se convierte en dinero: se paga, se envía y ya no se puede disputar.',
      actors: ['Cliente', 'Plataforma de pagos'],
      steps: [{ step: 'Hacer el pedido', actor: 'Cliente', service: 'svc:shop-api', data: 'orders' }, { step: 'Cobrar la tarjeta', actor: 'Plataforma de pagos', service: 'svc:shop-api', data: 'payments' }],
      flow: '```mermaid\n---\ntitle: Del pedido al cobro\n---\nflowchart TD\n  subgraph customer[\"Cliente\"]\n    place[Hacer el pedido]\n  end\n  subgraph platform[\"Plataforma de pagos\"]\n    charge[Cobrar la tarjeta]\n    paid([Pagado])\n  end\n  place --> charge\n  charge --> paid\n```',
      exceptions: [{ when: 'La tarjeta es rechazada', then: 'El pedido queda sin pagar durante 24 h y después se cancela' }],
    },
  },
  repository: {
    title: 'shop', summary: 'El repositorio del back end de la tienda: aquí vive todo servicio que toca dinero.',
    fields: { responsibility: 'Reúne todo servicio que toca dinero, para que una revisión de seguridad cubra un solo repositorio.', gotchas: ['Las pruebas de integración necesitan Docker en marcha'] },
  },
  service: {
    title: 'shop-api', summary: 'Es dueño de los pedidos y de su estado de pago; nada más escribe en la tabla de pedidos.',
    fields: { responsibility: 'Es dueño de los pedidos y de su estado de pago. Nada más escribe en la tabla de pedidos.', invariants: ['Un pedido se cobra como máximo una vez'] },
  },
  datastore: {
    title: 'postgres', summary: 'La base de datos relacional de la tienda, un esquema por servicio que la usa.',
    fields: {
      ownership: 'Equipo de plataforma. Cada servicio escribe solo en su propio esquema.', contents: [{ part: 'esquema shop', owner: 'svc:shop-api' }],
      dataflow: '```mermaid\n---\ntitle: Datos de los pedidos\n---\nflowchart LR\n  portal[Portal] -->|pedido| api[shop-api]\n  api -->|INSERT orders| db[(esquema shop)]\n  db -->|exportación nocturna| bi[Informes]\n```',
    },
  },
  external: {
    title: 'Stripe', summary: 'El proveedor externo que cobra y reembolsa tarjetas para que nunca guardemos datos de tarjeta.',
    fields: { purpose: 'Cobra y reembolsa tarjetas; guarda todos los números de tarjeta para que nosotros nunca lo hagamos.', 'failure-modes': [{ failure: 'Tiempo de espera agotado', effect: 'El reembolso queda pendiente', handling: 'El worker lo reintenta' }] },
  },
  plan: {
    title: 'Devoluciones parciales', summary: 'Devolución de una parte de un pedido, antes de diciembre.',
    fields: {
      goal: 'Un cliente puede devolver algunas líneas de un pedido.',
      team: [{ role: 'Back end', team: 'Comercio' }],
      done: 'Los clientes devuelven parte de un pedido desde el portal y el flujo pasa.',
      milestones: [{ milestone: 'Contrato acordado', date: '2026-11-15', done: 'no' }],
      risks: [{ risk: 'Límites de los reembolsos parciales de Stripe', mitigation: 'Prueba de concepto en la primera semana' }],
    },
  },
  decision: {
    title: 'Los reembolsos son asíncronos', summary: 'Los reembolsos pasan por una cola, no dentro de la petición.',
    fields: {
      context: 'Stripe puede tardar segundos en responder y la petición no debe retener una conexión tanto tiempo.',
      decision: 'La petición registra el reembolso como pendiente y un worker lo envía.',
      alternatives: [{ option: 'Llamar a Stripe dentro de la petición', 'why-not': 'Los tiempos de espera llegan al cliente' }],
      tradeoffs: 'El cliente no ve el resultado al instante; recibe un correo.',
    },
  },
  contract: {
    title: 'API de devoluciones', summary: 'Lo que llama el portal para devolver un pedido.',
    fields: {
      purpose: 'El portal pide una devolución y sigue su estado.',
      auth: 'El portal envía el token del cliente; solo el dueño del pedido puede pedir su devolución.',
      operations: [{ method: 'POST', path: '/returns', service: 'svc:shop-api', summary: 'Pedir una devolución' }],
      errors: [{ status: '409', when: 'El pedido ya fue devuelto' }],
    },
  },
  'data-model': {
    title: 'Datos de devoluciones', summary: 'Las tablas y reglas detrás de una devolución: qué se guarda, quién es su dueño y qué debe cumplirse.',
    fields: { purpose: 'Los datos de la funcionalidad de devoluciones.', level: 'logical', entities: [{ entity: 'Devolución', table: 'shop.returns', owner: 'svc:shop-api' }], rules: ['Una devolución nunca supera lo que se pagó'] },
  },
  convention: {
    title: 'Errores como problem details', summary: 'Los errores HTTP responden con problem details (RFC 9457).',
    fields: {
      rule: 'Toda respuesta 4xx y 5xx tiene la forma `application/problem+json`.',
      rationale: 'Los clientes manejan una sola forma de error en lugar de una por servicio.',
      good: '`return ResponseEntity.of(ProblemDetail.forStatus(404)).build();`',
      check: ['forbid: ResponseEntity\\.status\\(\\d+\\)\\.body\\(\"'],
    },
  },
  guide: {
    title: 'Añadir un endpoint', summary: 'Los pasos para añadir un endpoint, desde su contrato como borrador hasta un flujo en verde.',
    fields: { goal: 'Un endpoint nuevo, documentado y probado.', steps: ['Escribe el contrato como propuesto', 'Impleméntalo', 'Ejecuta los flujos afectados'] },
  },
  'test-plan': {
    title: 'Pruebas de devoluciones', summary: 'Pruebas de contrato y de extremo a extremo para las devoluciones.',
    fields: {
      strategy: 'El flujo carga con el peso: una devolución solo es real cuando el dinero se mueve.',
      environments: 'Las pruebas de contrato corren en el entorno local; el flujo corre en el completo con la tarjeta simulada.',
      criteria: 'Cada estado de una devolución tiene un flujo que pasa; un flujo que falla bloquea el lanzamiento.',
      scope: [{ target: 'mod:returns', levels: 'contrato, e2e', minimum: 'un flujo por estado' }],
    },
  },
  flow: {
    title: 'Devolver un pedido pagado', summary: 'Un cliente devuelve un pedido pagado y recupera el dinero.',
    fields: {
      goal: 'El dinero de un pedido devuelto vuelve a la tarjeta.',
      actors: ['Cliente'],
      preconditions: [{ data: 'Un cliente con un pedido pagado' }],
      steps: [
        { step: 'Abrir el pedido', actor: 'Cliente', service: 'svc:shop-api', expected: 'El pedido aparece como pagado' },
        { step: 'Pedir la devolución sin motivo', actor: 'Cliente', expected: 'El formulario dice que el motivo es obligatorio', kind: 'validation' },
        { step: 'Pedir la devolución', actor: 'Cliente', service: 'svc:shop-api', expected: 'La devolución aparece como pendiente' },
      ],
    },
  },
  scenario: {
    title: 'Un cliente con un pedido pagado', summary: 'Un cliente, un pedido pagado, la tarjeta simulada.',
    fields: {
      given: [
        { kind: 'identity', what: 'ana, una clienta, con la sesión iniciada (contraseña de vars.CUSTOMER_PASSWORD)' },
        { kind: 'data', what: 'Pedido A-1042, pagado con tarjeta' },
        { kind: 'mock', what: 'El proveedor de tarjetas responde desde sus grabaciones' },
      ],
      mocks: [{ service: 'stripe', mode: 'simulate' }],
    },
  },
  runbook: {
    title: 'Reembolsos atascados como pendientes', summary: 'Qué hacer cuando los reembolsos siguen pendientes: dónde mirar, cómo arreglarlo y cómo comprobarlo.',
    fields: {
      symptoms: ['Las devoluciones siguen pendientes más de una hora'],
      diagnosis: ['Mira en los logs del worker si hay tiempos de espera agotados'],
      fix: ['Reinicia el worker; reintenta los reembolsos pendientes'],
      verify: ['El número de reembolsos pendientes baja a cero'],
    },
  },
  architecture: {
    title: 'Arquitectura de la tienda', summary: 'Cómo está montada la tienda: servicios, almacenes y las decisiones detrás.',
    fields: {
      components: [{ component: 'shop-api', role: 'Pedidos y pagos', tech: 'Spring Boot' }, { component: 'postgres', role: 'Almacén de pedidos', tech: 'PostgreSQL' }],
      views: '```mermaid\nC4Container\n  title Tienda, contenedores\n  Person(customer, "Cliente")\n  System_Boundary(shop, "Tienda") {\n    Container(api, "shop-api", "Spring Boot", "Pedidos y pagos")\n    ContainerDb(db, "postgres", "PostgreSQL", "Pedidos")\n  }\n  System_Ext(stripe, "Stripe", "Pagos con tarjeta")\n  Rel(customer, api, "Pide y paga", "HTTPS")\n  Rel(api, db, "Lee y escribe", "JDBC")\n  Rel(api, stripe, "Cobra", "REST")\n```',
      decisions: ['dec:refunds-are-asynchronous'],
      risks: [{ risk: 'Una sola base de datos para todos los servicios', mitigation: 'Un esquema por servicio' }],
    },
  },
  versioning: {
    title: 'Versionado de la tienda', summary: 'Ramas de tronco único y versiones semánticas en todos los repositorios.',
    fields: {
      branches: [
        { pattern: 'main', purpose: 'Siempre publicable', from: '-', lifetime: 'permanente' },
        { pattern: 'feature/*', purpose: 'Un cambio', from: 'main', lifetime: '5 días' },
      ],
      graph: '```mermaid\n---\ntitle: Ramas de la tienda\n---\ngitGraph\n  commit id: "inicio"\n  branch feature/devoluciones\n  commit id: "devoluciones parciales"\n  checkout main\n  merge feature/devoluciones tag: "v1.4.0"\n  branch hotfix/reembolso\n  commit id: "redondeo del reembolso"\n  checkout main\n  merge hotfix/reembolso tag: "v1.4.1"\n```',
      numbering: 'Semántico: un cambio incompatible de la API sube la versión mayor.',
      releases: 'Una etiqueta vX.Y.Z en main publica las imágenes.',
      changelog: 'CHANGELOG.md, escrito en la pull request.',
    },
  },
  artifact: {
    title: 'Cliente de pagos', summary: 'El cliente Java de la API de pagos: firma las peticiones y recuerda la clave de idempotencia.',
    fields: {
      overview: 'Un cliente Java para la API de pagos: firma la petición y convierte un 202 en un futuro. No esconde la API ni reintenta por ti.',
      consumption: 'com.example.payments:gateway-client:2.4.1, del registro Maven interno.',
      versioning: 'Versiones semánticas; quitar un método es un cambio mayor. Se mantienen las dos últimas menores.',
      consumers: [{ consumer: 'shop-api', version: '2.4.1', since: '2025-03' }],
    },
  },
  stack: {
    title: 'Stack de la tienda', summary: 'Servicios Java y Spring Boot sobre PostgreSQL, con un front end Angular.',
    fields: { overview: 'Servicios Java 21 y Spring Boot 3, un front end Angular, PostgreSQL.', updates: 'Dependabot cada semana; una versión mayor necesita una decisión.' },
  },
  infrastructure: {
    title: 'Producción de la tienda', summary: 'Kubernetes en una región: cómo está montado, expuesto y vigilado.',
    fields: {
      envs: [{ env: 'prod', url: 'https://shop.example', purpose: 'Clientes', deploys: 'Equipo de plataforma', data: 'Reales' }],
      topology: '```mermaid\n---\ntitle: Topología de producción\n---\nflowchart LR\n  subgraph region[\"Región eu-west-1\"]\n    k8s@{ icon: \"logos:kubernetes\", form: \"square\", label: \"Clúster\", pos: \"b\" }\n    db@{ icon: \"logos:postgresql\", form: \"square\", label: \"PostgreSQL gestionado\", pos: \"b\" }\n  end\n  k8s -->|JDBC| db\n```',
      network: 'Solo el ingress es público; los servicios se hablan por la red del clúster.\n\n```mermaid\n---\ntitle: Zonas de la tienda\n---\nflowchart LR\n  internet((Internet))\n  subgraph public["Zona pública"]\n    ingress[Ingress]\n  end\n  subgraph cluster["Red del clúster"]\n    api[shop-api]\n    db[(postgres)]\n  end\n  internet -->|HTTPS 443| ingress\n  ingress -->|HTTP| api\n  api -->|JDBC 5432| db\n```',
      observability: 'Logs a Loki, métricas a Prometheus, alertas a la guardia de plataforma.',
    },
  },
  secrets: {
    title: 'Secretos de la tienda', summary: 'Los secretos que necesita la tienda, dónde vive cada uno y quién lo rota, nunca su valor.',
    fields: { needs: [{ secret: 'STRIPE_API_KEY', purpose: 'Cobrar tarjetas', lives: 'La bóveda, nivel servicio', rotates: 'Equipo de plataforma', every: '90 días' }] },
  },
  glossary: {
    title: 'Glosario de la tienda', summary: 'Las palabras de la tienda y qué significa cada una, con los nombres que toman en el código.',
    fields: { terms: [{ term: 'Nota de crédito', definition: 'Una factura con importes negativos que anula otra.', code: 'CreditNote' }] },
  },
  term: {
    title: 'Nota de crédito', summary: 'La factura que anula otra.',
    fields: { definition: 'Una factura con importes negativos que anula toda una factura anterior o una parte.', 'in-code': ['CreditNote', 'credit_notes'] },
  },
  note: {
    title: 'Por qué el reintento es 3', summary: 'El número de reintentos coincide con las ventanas de idempotencia de Stripe.',
    fields: { body: 'Tres reintentos caben en la ventana de idempotencia de 24 h que guarda Stripe.' },
  },
};
