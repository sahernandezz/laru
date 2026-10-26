# Cambios

Todos los cambios de Laru que importan a quien lo usa quedan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones siguen
[Versionado Semántico](https://semver.org/lang/es/): mientras Laru esté en `0.x`, una versión menor puede cambiar cómo se usa.

## [Sin publicar]

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

[Sin publicar]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/sahernandezz/laru/releases/tag/v0.1.0-beta.1
