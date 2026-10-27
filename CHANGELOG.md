# Cambios

Todos los cambios de Laru que importan a quien lo usa quedan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones siguen
[Versionado Semántico](https://semver.org/lang/es/): mientras Laru esté en `0.x`, una versión menor puede cambiar cómo se usa.

## [Sin publicar]

## [0.1.0-beta.3] - 2026-10-27

### Añadido

- **La evidencia se comparte por git:** el último run que pasó de cada flujo se guarda en `evidence/<flujo>/` dentro del workspace, con su traza, su vídeo, sus capturas y sus casos. El resto de runs sigue fuera de git.
  - Quien clona el workspace ve cada flujo con su último resultado y abre su estudio sin ejecutarlo: Laru importa esa evidencia como un run de su máquina, con su propio número, así que los runs de dos personas nunca chocan.
  - `laru test --affected` no repite un flujo cuyo código no cambió desde la pasada compartida.
  - `laru runs share` comparte el último run que pasó de cada flujo en un workspace que ya tenía runs.
  - Un proyecto que es una carpeta sin git viaja como copia en `projects/<nombre>/`, que cada `laru map` actualiza sin `.env`, sin lo ignorado y sin ficheros de más de 50 MB. Quien clona el workspace la lee de ahí sin enlazar nada. Un proyecto con git sigue viajando solo como referencia: su URL y su rama.

### Cambiado

- **Menos tokens para el agente de IA:** lo que el agente carga al empezar cada sesión baja de unos 11.300 a unos 7.100 tokens (un 37 % menos).
  - La lista de herramientas MCP ya no repite en cada herramienta datos que ningún modelo lee.
  - Las herramientas de MongoDB y Redis solo aparecen si el aplicativo los usa.
  - Las instrucciones del servidor MCP no repiten la guía cuando el workspace ya tiene `CLAUDE.md` y `AGENTS.md`.
  - Las descripciones de las herramientas y sus parámetros son más cortas y conservan las reglas que importan: qué pide confirmación, qué va sin enmascarar y qué es solo lectura.
  - El contexto de una pieza (`context`) da primero lo que la pieza declara y después lo que dice su código, así que el presupuesto nunca se lleva lo declarado. Las convenciones heredadas y lo que dice el código solo salen en las piezas bajo las que se escribe código: un aplicativo, un módulo, un servicio. Los endpoints sin contrato y las variables van una vez cada uno, con la ruta del fichero una sola vez. En VaultFlow, el contexto de las 79 piezas baja un 18 %; el de una convención, de unos 2.800 a unos 800 tokens.
  - `knowledge_shape` pesa la mitad: la pista de cada campo va una vez y en el idioma de la documentación, «obligatorio» solo donde lo es, y el ejemplo una vez, en la forma que recibe `knowledge_write`.

- **Más diagramas en la documentación:** el estándar pedía diagrama solo en módulos, procesos e infraestructura, así que las demás piezas quedaban en tablas y texto. Ahora también lo piden:
  - **Versionamiento:** «Ramas y entregas», un `gitGraph` con de dónde sale cada rama, dónde se etiqueta una entrega y cómo vuelve un arreglo urgente.
  - **Arquitectura:** «Vistas», el contexto y los contenedores en C4.
  - **Almacén de datos:** «Recorrido de los datos», de dónde llegan sus datos y adónde van.
  - **Infraestructura:** «Red y seguridad» dibuja las zonas y el tráfico permitido entre ellas.
  - **Repositorio:** «Capas», opcional, para un repositorio con capas.

  En un workspace existente, la nota de esas piezas baja hasta que se dibujan, y `laru check` lo dice.

### Corregido

- **Pantallas más rápidas:** el estado de un entorno y la página de la máquina tardaban unos 2 s en cada refresco, esperando a `docker stats`. Ahora responden en unos 0,1 s con la última medida de CPU y memoria y toman una nueva por detrás.
- **Windows con Docker dentro de WSL:**
  - Nuevo `laru doctor --fix`: deja Docker Engine configurado para WSL. Activa systemd para que arranque solo, arranca el demonio y añade tu usuario al grupo `docker`, enseñando cada comando con `sudo` antes de ejecutarlo.
  - `laru doctor` funciona aunque todavía no haya un workspace.
  - Cuando Docker no responde, Laru dice qué hacer.
  - En WSL sin servicio de secretos, la clave de la bóveda se guarda en un fichero `0600` en vez de fallar con `secret-tool`.
  - Si se lanza desde Windows en vez de desde WSL, lo dice y da los pasos.
  - El README explica la instalación en Windows paso a paso.
- Cuando `git` no puede leer un proyecto, la documentación muestra lo que dice `git` (por ejemplo, que en macOS falta aceptar la licencia de Xcode), no solo su código de salida.
- El mapa del sistema se dibuja también cuando ningún servicio llama a otro (solo publican, consumen o guardan). Antes, todos los nodos quedaban amontonados en un punto.

## [0.1.0-beta.2] - 2026-10-26

### Seguridad

- **`laru.yaml`:** un `laru.yaml` compartido ya no puede hacer que `git` ejecute un comando.
  - Las URL y ramas de los proyectos se validan al leerlo y al añadir un proyecto.
  - `git clone` recibe la URL después de `--`.
  - Antes, una URL como `--upload-pack=<comando>` ejecutaba ese comando al sincronizar.
- **Dependencias:** las transitivas con avisos de seguridad pasan a versiones corregidas: `nanoid`, `lodash-es` y `katex` de Excalidraw, y `body-parser` del SDK de MCP. `pnpm audit` sale limpio.
- **Imágenes por digest:** la imagen del tap y la base del runner se fijan por digest.
- **Interfaz:** se sirve solo desde su propia carpeta.
- **Política de seguridad:** nuevo `SECURITY.md`, con cómo avisar de una vulnerabilidad y qué protege Laru.

## [0.1.0-beta.1] - 2026-10-26

Primera beta pública.

### Añadido

- **Workspaces.** Un workspace por aplicativo, fuera de sus repositorios, con sus proyectos clonados o enlazados.
  Un solo servicio local los sirve todos en `127.0.0.1`.
- **Mapa del sistema.** Laru lee el código de cada proyecto y construye el mapa del sistema:
  - servicios, endpoints, llamadas entre ellos, almacenes, colas y externos;
  - para cada dato, de qué línea del código sale.
- **Documentación viva.**
  - Piezas con un estándar: aplicativo, módulos, flujos, escenarios, decisiones, modelos de datos, guías, arquitectura y más.
  - Nota de completitud por pieza y validación para CI (`laru check`).
  - Diagramas con su clase y sus reglas, y un editor con lienzo (Excalidraw) y texto (Mermaid).
- **Entornos.** Levanta el sistema entero en Docker con sus datos, y lo explora:
  - bases de datos, colas Kafka y RabbitMQ, almacenamiento S3 y MinIO;
  - correo y SMS atrapados en local;
  - variables y secretos cifrados en disco.
- **Flujos y runs.** Pruebas de extremo a extremo con Playwright. Cada run graba:
  - el vídeo;
  - la traza de todo el sistema: HTTP, SQL con sus filas, Kafka, eventos del servidor y logs;
  - lo que cambió frente al comportamiento aprobado.
- **Estudio.** Un run como en un editor de vídeo: vídeo, «Recorrido», secuencia, mapa y línea de tiempo con una pista por pieza.
  «Recorrido» muestra, paso a paso, lo que llevó y lo que recibió cada petición.
- **En vivo.** Usas el aplicativo tú mismo mientras Laru lee la traza del sistema entero.
  La sesión se guarda como un run y se convierte en flujo o en escenario.
- **Impacto.** Qué flujos toca el cambio de tu copia de trabajo, y ejecutar solo esos (`laru test --affected`).
- **Para los agentes de IA.**
  - Servidor MCP con el contexto exacto de cada pieza.
  - `CLAUDE.md` y `AGENTS.md` generados.
  - Hooks para Claude Code.

[Sin publicar]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.3...HEAD
[0.1.0-beta.3]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/sahernandezz/laru/releases/tag/v0.1.0-beta.1
