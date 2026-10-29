# Cambios

Todos los cambios de Laru que importan a quien lo usa quedan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones siguen
[Versionado Semántico](https://semver.org/lang/es/): mientras Laru esté en `0.x`, una versión menor puede cambiar cómo se usa.

## [Sin publicar]

## [0.1.0-beta.10] - 2026-10-29

### Cambiado

- **El estudio en vivo es el de los runs:** sus paneles (el aplicativo, la evidencia y las pistas) se redimensionan y se ocultan desde su borde, y guardan el mismo tamaño que en el estudio de un run; tiene «Dispositivo» para seguir a uno solo y «Atajos».
- **El árbol agrupa por tipo:** debajo de cada pieza salen primero los módulos, luego los procesos y luego los flujos, y cuando hay más de un tipo cada grupo lleva su nombre (Módulos, Procesos; Submódulos, Flujos dentro de un módulo), con cuántos tiene, y se pliega como los grupos del menú; abrir una pieza de un grupo plegado lo abre.
- **Procesos en el menú:** el aplicativo tiene una pestaña «Procesos», con una tarjeta por proceso; solo aparece si hay alguno. Los procesos siguen también en el árbol.
- **Menú plegable, con Sistema arriba:** cada grupo del menú (Sistema, el aplicativo, Piezas, Manual, Ajustes) lleva delante una flecha, su nombre en versalitas y cuántas entradas tiene, y se pliega con un clic en esa línea; y este navegador recuerda los que cierras; el grupo de la página abierta se abre solo. «Sistema» pasa encima del aplicativo.

### Corregido

- **«Atajos» del estudio:** la lista se abría fuera de su sitio desde la beta 9; vuelve a salir bajo el botón.

## [0.1.0-beta.9] - 2026-10-29

### Cambiado

- **Un flujo es una sola historia, en un solo vídeo; desaparecen los casos cortos:** «Casos cortos» sale del estándar de los flujos, de la plantilla, de `laru check` y de la guía del agente, y con él `apiCase()`. Las validaciones de cada formulario pasan a ser pasos de la historia, con Tipo `validation` en «Pasos», y «Validaciones en» apunta a esos pasos. Un `test()` o un `apiCase()` junto a la historia sale en `laru check` como `flow-e2e-case`. El run y el estudio ya no muestran la tira de casos, y `run_evidence` y `laru runs show` pierden `case`. Los flujos que ya tengan «Casos cortos» los conservan como texto, sin que se jueguen aparte: hay que pasarlos a pasos.

### Corregido

- **Workspaces creados antes de llamarse Laru:** sus flujos no llegaban a correr. La bóveda (`vault/secrets.enc`) no se abría con su propia clave, porque se cifró con el nombre anterior; ahora se abre, y se vuelve a cifrar con el nombre nuevo la próxima vez que se guarda. El runner escondía `.laru`, que esos workspaces no tienen, y fallaba al montarlo; ahora esconde su carpeta de estado, `.keelson`, que guarda `mask.json`. Y los specs que importan `@keelson/flow` vuelven a encontrarlo.
- **Buzón:** dos mensajes recibidos en el mismo milisegundo salían en el orden de llegada; ahora sale primero el más reciente, como el resto.

## [0.1.0-beta.8] - 2026-10-29

### Añadido

- **Seguir un dispositivo en el estudio:** «Dispositivo», junto a «Seguimiento», deja ver solo lo que envió un dispositivo y lo que eso provocó en el sistema (gateway, servicios, bases, colas). Laru distingue los dispositivos por su User-Agent («Safari en iPhone», «Chrome en Windows»), por su dirección cuando no es ningún servicio («Equipo 172.30.1.12»), por la pantalla de la prueba, o como «Prueba» para las llamadas que hace la propia prueba. Funciona también en «Paso a paso». Los eventos SSE guardan el User-Agent de su conexión, aunque esta se abriera antes de la traza.
- **0,25×** entre las velocidades, y es con la que empieza todo run: se lee, no se mira.

### Cambiado

- **Sin enmascarar por defecto:** Laru corre en tu máquina y enseña lo que pasó, tal cual: cuerpos, cabeceras, filas, logs, correo, colas y lo que ve la IA. `mask: true` en `~/.laru/config.yaml` lo vuelve a activar en el siguiente `laru up` de cada entorno. Los runs ya grabados siguen enmascarados.
- **El estudio, menos cargado:** la cabecera deja el título, las pruebas del flujo (con todo el ancho) y «Salir»; los atajos de teclado van en «Atajos». Vídeo, Inspector y Pistas se ocultan y se muestran con una pestaña en el borde de cada panel; en una pantalla estrecha se ven todos.

## [0.1.0-beta.7] - 2026-10-28

### Añadido

- **Más cosas declarables en `laru.yaml`:** `stores:` dice qué es un contenedor cuya imagen Laru no conoce, o un almacén o sistema que no está en ningún compose, con un `kind` libre (`queue`, `relational`, `event-store`…) y `external: true` si es de fuera. Un servicio puede llevar su propio `group` (el aplicativo, por encima del de su proyecto), `publishes` y `consumes` (temas o colas), y puede no tener `repo` cuando ninguna parte del código lo contiene, como un gateway gestionado. Las instrucciones para la IA del proyecto lo enumeran todo.

- **Cualquier base de datos o cola se explora desde Laru:** `stores.<nombre>.explore` dice qué orden de su propio contenedor la lee (`query`), qué le pregunta para listar lo que hay (`tables`) y cómo abrir una parte (`table`, con `{table}`). Aparece en «Bases» o, si su `kind` es de mensajería, en «Colas», con la consola y el resultado como tabla (CSV o TSV con cabecera) o como texto, enmascarado como lo demás. Lo que se escribe va por la entrada estándar, nunca en la línea de órdenes.

### Cambiado

- **Sin límite de entornos a la vez:** por defecto pueden correr todos los que quieras; «Esta máquina» deja poner un límite si lo prefieres. Si la memoria parece no alcanzar, se avisa y se levanta igual.
- **Lo que Laru no conoce ya no bloquea:** una clave de `envs/*.yaml` que Laru no lee se deja como está y se nombra al levantar; el `role` de un proyecto puede ser cualquier palabra, y una política o una etapa de `profile` que Laru no mide no impide cargar el workspace.
- **La documentación ya no rechaza lo que solo se sale del estándar:** un título o un resumen largos, más elementos de los previstos, un `kind` o un estado fuera de la lista, una pieza en un padre de otro tipo, un ancla a código que aún no está en la rama de referencia, una referencia a una pieza que todavía no existe, y las secciones o columnas que el estándar no tiene. Ahora se guarda y queda un aviso para mejorarlo; las secciones y columnas propias se escriben y se vuelven a leer tal cual. Siguen bloqueando un id, un tipo o un título vacíos, y los formatos que usa Laru para funcionar (la duración de un flujo, el número de una decisión, una expresión regular que no compila).

## [0.1.0-beta.6] - 2026-10-28

### Añadido

- **Lo que el código no muestra, declarado en `laru.yaml`:** cada entrada de `services:` puede llevar `kind` (su tecnología), `endpoints` (`GET /usuarios`, o solo la ruta) y `calls` (a quién llama: `pagos`, `"pagos POST /cobros"`, `postgres` o cualquier host). Sin `dir`, un nombre que el compose del proyecto levanta desde una imagen pasa a ser ese contenedor, por ejemplo un gateway, y deja de ser infraestructura. Así se dibujan las Lambdas con router propio, los gateways y las direcciones que solo están en un `.env`. Las instrucciones que Laru escribe para la IA del proyecto (`CLAUDE.md`, `AGENTS.md`) le piden declarar ahí lo que el mapa no vea; se reescriben con `laru sync`.
- **Estudio del run a tu medida:** el vídeo, el inspector y las pistas se ensanchan o se estrechan arrastrando sus separadores (o con las flechas del teclado), y cada uno se oculta y se vuelve a mostrar desde la barra. El estudio recuerda cómo lo dejaste.
- **Pantallas en ventana flotante:** el vídeo de la historia y cada pantalla de otra persona se abren en una ventana que se mueve desde su barra y cambia de tamaño desde su esquina, al compás de la reproducción. Se pueden abrir varias.
- **Pantallas de teléfono:** `otherScreen('ana', { width: 390, height: 844 })` graba esa pantalla con su tamaño; sin tamaño sigue siendo 1280×720. El estudio la muestra entera.
- **Historias más fáciles de seguir:** con `stepHoldMs` en `~/.laru/config.yaml`, una historia grabada se detiene ese tiempo al final de cada paso. Sin él, no cambia nada.
- **El mapa, dividido por aplicación:** en un workspace con varias aplicaciones, cada proyecto de `laru.yaml` puede llevar `group: <aplicación>`. El mapa del sistema, el de cada flujo y el de las sesiones en vivo dibujan una franja por aplicación. Un externo va en la franja de quien lo usa, o en «Compartido» si lo usan varias. En el mapa del sistema, la línea que va de una aplicación a otra se resalta. Sin `group`, o con una sola aplicación, el mapa queda como antes.
- **El mapa de un run, solo con lo que tocó:** dibuja las piezas por las que pasó alguna de sus pruebas, no el sistema entero.
- **Externos que no son el sistema:** `ignore-externals: [www.buscador.example, "*.proveedor.example"]` en `laru.yaml` quita esos hosts del mapa, junto con las líneas que llegan a ellos. `*` vale por cualquier tramo. Un host que declara un proyecto en su compose se queda.
- **A qué aplicativo pertenece cada servicio:** con `group` en varios proyectos, «Componentes», «Servicios por entorno» y la lista de servicios de un entorno tienen la columna «Aplicativo», y las dos primeras agrupan las piezas de cada uno.
- **Ambientes conjuntos:** el runner se une también a la red del primer proyecto. Un flujo llega por nombre a lo que alcanzaría en el ambiente de ese proyecto, como los puertos de administración de sus mocks.
- **El estudio, en su propia dirección:** `#/studio/<run>/<flujo>/<prueba>` ocupa toda la ventana y solo monta el estudio; la página desde la que se abrió ya no queda cargada debajo. «Salir del estudio» y Esc vuelven a esa página, y el enlace se puede guardar o compartir.
- **Cada pantalla carga solo lo suyo:** el código de cada página se descarga la primera vez que se abre. Lo que se carga al entrar baja de 1,09 MB a 264 KB.

### Corregido

- **Las otras pantallas de una prueba se ven sin ffmpeg:** cuando no se pudo medir su desfase, arrancan con el de la grabación principal (`videoOffsetMs`) en vez de no mostrarse.
- **Un entorno deja fuera los servicios de otros ficheros compose:** el mapa lee todos los ficheros compose del proyecto, pero el entorno solo importaba el de `from`, así que esos servicios se listaban y no se levantaban. Ahora `from` admite varios ficheros (`from: app:docker-compose.yml,docker-compose.infra.yml`) y suma el `docker-compose.override.yml` que haya junto al principal, como `docker compose up`. Si un servicio que el mapa conoce está en un fichero que el entorno no lee, al levantarlo se avisa con el fichero que falta.
- **Un entorno levanta los servicios que su compose pone bajo un perfil (`profiles:`):** Laru los listaba, pero `docker compose` los saltaba y se quedaban esperando hasta que el entorno fallaba por tiempo. Ahora decide el entorno: los de su lista `services`, o todos.
- **«Sin conexión con el servicio» solo cuando el servicio no está:** antes salía cuando el servicio tardaba en contestar, porque estaba ocupado o porque el navegador dejaba el aviso en cola detrás de otras peticiones. Ahora una respuesta lenta pesa un tercio, y el aviso tarda en salir medio minuto sin respuesta.
- **Los entornos ya no arrancan solos al encender el PC:** Laru conservaba el `restart: always` o `unless-stopped` del compose del proyecto, y al proxy de Laru (`ks-tap`) le ponía `unless-stopped`, así que Docker los levantaba al iniciarse. Ahora usan `on-failure`: un servicio que se cae con error se reinicia, pero el entorno solo se levanta cuando se pide. Los contenedores que ya existen cambian la próxima vez que se levante su entorno, o con `laru down`.
- **Docker ya no se cuelga con una sesión en vivo abierta:** cada segundo, la sesión volvía a pedir a Docker la lista de contenedores y los logs completos de todos ellos a la vez; con muchos servicios, Docker Desktop en Windows se quedaba colgado. Ahora pide solo las líneas nuevas, reutiliza la lista de contenedores durante 10 s y lanza como mucho 4 órdenes a la vez. Kafka se lee cada 5 s en vez de cada 3.
- **Más rápido con un sistema grande:** el mapa se calcula en un tercio del tiempo (con 80 servicios, la página pasa de 1,3 s a 0,7 s) y dibuja lo mismo. Las vistas que piden lo mismo a la vez comparten una sola petición, y el servicio comparte durante 2 s lo que Docker le dice del estado de cada entorno y de sus contenedores, en vez de preguntarle una vez por cada vista.
- **Límite de tiempo y URL base por flujo con `story`, `apiCase` y `scenario`:** estas pruebas no encontraban los suyos, porque Playwright las atribuía a `flow.ts` y no al spec del flujo.
- **Windows:** el servicio local vuelve a servir la interfaz. Desde la 0.1.0-beta.2 comparaba rutas con `/`, y en Windows cada fichero de la interfaz se respondía con la página de inicio.

## [0.1.0-beta.5] - 2026-10-27

### Añadido

- **Zoom en los mapas:** el del sistema, el de cada prueba y el de las sesiones en vivo se acercan y se alejan con sus botones o con ⌘/Ctrl y la rueda (o pellizcando en el trackpad), alrededor del puntero. «Ver el mapa entero» lo encaja en la caja, y un mapa más pequeño que su caja queda centrado.

### Corregido

- **El mapa de una prueba ya no pierde altura con muchos servicios:** sin la nota de debajo, que listaba las piezas que no tocó (el mapa ya las marca con «no lo usó»).

## [0.1.0-beta.4] - 2026-10-27

### Corregido

- **Windows sin WSL vuelve a funcionar.** La 0.1.0-beta.3 se negaba a arrancar en PowerShell o `cmd` y pedía usar WSL2. WSL2 es una opción más: Laru corre directamente en Windows con Docker Desktop, como antes.

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

[Sin publicar]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.10...HEAD
[0.1.0-beta.10]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.9...v0.1.0-beta.10
[0.1.0-beta.9]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.8...v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.7...v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.6...v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.5...v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.4...v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/sahernandezz/laru/releases/tag/v0.1.0-beta.1
