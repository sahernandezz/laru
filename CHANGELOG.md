# Cambios

Todos los cambios de Laru que importan a quien lo usa quedan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones siguen
[Versionado Semántico](https://semver.org/lang/es/): mientras Laru esté en `0.x`, una versión menor puede cambiar cómo se usa.

## [Sin publicar]

## [0.1.0-beta.21] - 2026-11-17

### Añadido

- **Flujos contra una aplicación que ya corre fuera de Laru: el entorno por URL.** Hasta ahora «Probar en vivo» y «Ejecutar» pedían un entorno levantado por Laru desde el compose de un proyecto, así que una app en tu máquina, un QA desplegado o un sitio público no se podía grabar ni probar. Ahora basta su dirección: «Nuevo entorno por URL» en Entornos, `laru env init <nombre> --url <dirección>` en la terminal o `url:` en `envs/<nombre>.yaml`.
  - Laru no la levanta, no la para y no la cambia. El entorno «Responde» mientras la app contesta en esa dirección, aunque sea con una redirección a su inicio de sesión o con un certificado en el que solo confía tu Mac.
  - El navegador es la traza. Cada petición de la página es un salto del flujo: método, dirección, estado, cabeceras, el cuerpo cuando es texto (sus primeros 64 KB), cuánto tardó y el error si falló. Lo que la página dice en su consola y los errores que lanza son el log del «Navegador», cada línea con su nivel.
  - En el estudio («Abrir en el estudio», o «Probar en vivo» desde la ficha de un flujo) la app se abre en el navegador de la sesión, que solo navega dentro de esa dirección. Al parar, «Convertir en flujo» escribe su borrador como con cualquier entorno.
  - Sus pruebas corren contra esa dirección: «Probar aquí», «Ejecutar prueba automática», «Ejecutar en…» en la ficha del flujo o `laru test --env <nombre>`. El runner llega a una app de tu `localhost` sin cambiarle la dirección, así que sus cookies y su CORS siguen igual. También acepta el certificado de un QA firmado por la CA de tu empresa.
  - El mapa de un run o de una sesión se dibuja con lo observado cuando no hay código leído, por ejemplo Navegador → `localhost:4200`.
  - Lo que pasa detrás de la app (sus servicios, bases y colas) no se ve, porque no corre en Laru. Por eso este entorno no tiene pantallas de datos ni entorno propio por flujo, y no admite escenarios: sus datos viven donde vive la app. Una sesión o un run que pida un escenario lo dice en vez de fallar por dentro.
  - El agente lo sabe: su guía explica cuándo crearlo, y `flow_run` con ese entorno juega ahí.

### Cambiado

- **La ficha de un servicio explica lo que enseña.** Sus pestañas Pruebas, Librerías, Variables y Conexiones listaban ficheros, coordenadas y rutas sin decir para qué era cada cosa, todo con el mismo peso.
  - **Pruebas:** cada caso dice lo que comprueba con sus propias palabras, que son su `@DisplayName` o el texto de su `it`, con el método al lado. Los casos se ven sin abrir nada. Cada nivel explica qué arranca y qué señala su fallo: una unitaria prueba una clase sola, una de integración arranca la aplicación.
  - **Librerías:** dice qué es cada una. Laru conoce las comunes de Spring, Quarkus, los drivers, las pruebas y JavaScript; de las demás da un enlace a Maven Central o npm. Si las «Dependencias críticas» del stack lo explican, añade por qué la necesita la aplicación. La versión es la de verdad: «3.4.1, la que fija Spring Boot 3.4.1» o «0.12.6, de la propiedad jjwt.version», en vez de «la que fije su build».
  - **Variables y secretos:** es una sola tabla. Cada variable dice para qué es, dónde la lee su código, quién se la pasa y su valor legible («86.400.000 ms · 1 d»). El para qué sale de la pieza «Secretos», del significado de las comunes como `SPRING_PROFILES_ACTIVE` o de lo que dice su nombre. Un secreto se ve solo al pulsar «Mostrar», también en la documentación.
  - **Conexiones:** cada pieza se resume en una frase: cuántas llamadas hace, a cuántos endpoints, a través de quién y si los runs lo han visto. Cada llamada dice la ruta que llama su código, a qué endpoint llega, para qué es según su contrato (también tras un gateway) y dónde está en el código. Las notas del mapa salen en español.
  - **En la documentación:** el id de una pieza (`flow:registro-e-inicio`, `[[mod:carpetas]]`) se lee por su título y la abre. El texto corrido va en un tono más suave, para que destaquen los títulos, las negritas y los nombres.
  - **Para verlo:** los títulos de los casos y las versiones resueltas aparecen después de «Releer el código».
- **Los diagramas ya no tienen un fondo propio en los temas oscuros.** Antes cada diagrama de la documentación, del visor y del editor de Excalidraw se dibujaba sobre un papel casi negro fijo, que chocaba con el fondo del tema. Ahora toma el fondo del tema, incluidos los halos que separan las líneas que se cruzan. En los temas claros conserva su papel oscuro, porque sus colores están pensados para él, y el SVG que se descarga también lo conserva.
- **Los eventos y los reenvíos del gateway enseñan su contrato.** En la pestaña Eventos cada tema solo tenía una línea «Contenido:», y una ruta del gateway que reenvía (`/api/files/**`) solo decía a qué servicio.
  - **Eventos:** cada tema es una tarjeta con su contrato y, aparte, lo que vieron los runs. El contrato dice para qué es, qué lleva y por qué clave va, y debajo de cada cosa lo que dice su código: el tipo que envía o recibe con sus campos (`FileEvent`: `fileId UUID`, `storedName String`…), el tipo de su clave y el grupo en el que consume. También dice quién más lo publica o lo consume, con lo que lleva cada uno y su grupo.
  - **Reenvíos:** una ruta que solo reenvía lista las operaciones que alcanza (`GET /api/files/**` alcanza cada GET de file-service bajo `/api/files`), cada una con su para qué, lo que recibe, lo que responde y su contrato. La fila dice cuántas tienen contrato y cuenta como documentada cuando todas lo tienen. Si no alcanza ninguna, lo dice: «batch-service no tiene ninguna operación PUT bajo /api/batch/».
  - **Endpoints:** cuando el cuerpo que recibe o lo que devuelve es un tipo con campos en su código, se ven esos campos.
  - **Contratos:** la tabla de eventos tiene ahora «Para qué» y «Clave». Un evento sin su para qué o sin su contenido baja la nota del contrato y queda pendiente para el agente, como ya pasaba con las operaciones.
  - **Para verlo:** los tipos, las claves y los grupos del código aparecen después de «Releer el código».
- **Un diagrama ya no parece una rejilla de bordes.** En un modelo de datos, el contorno de cada tabla tenía el mismo color y grosor que sus relaciones, así que una relación que pasaba al lado se leía como un segundo borde. Además, el diagrama iba dentro de un marco propio, dentro de la sección.
  - El contorno de una tabla es ahora suave: la tabla se reconoce por su cabecera y las líneas son las relaciones. El diagrama de la documentación ya no lleva marco.
  - Dos relaciones ya no comparten tramo. Las que salen de un mismo lado se reparten en el orden en que se alejan, así que no se cruzan al salir. Las que giran hacia el mismo lado lo hacen a distancias distintas, también al llegar. En los 49 diagramas de cajas de VaultFlow, los tramos compartidos bajan de 65 a 28.
  - De cada diagrama se trazan las dos versiones, la de antes y la nueva, y se queda la que menos estorba a quien lee: líneas que atraviesan piezas, tramos compartidos, etiquetas que se pisan o caen sobre una pieza, y cruces.
  - La relación de una tabla consigo misma (una carpeta que contiene carpetas) es un bucle a la derecha de la tabla, con su etiqueta al lado. Antes atravesaba la tabla y salía por donde llegaban las demás relaciones.
  - Cada cardinalidad queda fuera de su tabla. La de una relación que salía por debajo se escribía dentro de la caja, donde no se leía.
- **El índice de una pieza marca dónde estás.** La sección o el apartado que tienes en pantalla aparece resaltado, con una barra sobre la línea del índice; si es un apartado, también su sección. Al pulsar un enlace se marca ese apartado, y al llegar al final de la página, el último.

### Corregido

- En un diagrama de entidades, un campo con comentario (`scan_status "PENDING, CLEAN o INFECTED"`) se escribía encima de su tipo, porque cada entidad medía 220 px, dijeran lo que dijeran sus campos. Ahora la entidad es tan ancha como su campo más largo, hasta un tope. Pasado el tope, el nombre se corta con «…» antes del tipo y se lee entero en su tooltip.

- El nombre de un entorno conjunto nuevo no se comprobaba en el formulario: su patrón tenía un guion sin escapar, que los navegadores actuales rechazan, y aceptaba cualquier cosa hasta que respondía el servicio.

## [0.1.0-beta.20] - 2026-11-17

### Añadido

- **Cada servicio, almacén y externo lleva el logo de su tecnología, como en Docker Desktop.** Antes todos tenían el mismo icono genérico de servidor, base de datos o globo.
  - Se ve en el mapa de «Mapa y servicios», en su tabla de componentes, en la cabecera de la ficha de cada pieza, en «Servicios por entorno» y en el mapa de cada run.
  - Laru reconoce la tecnología así: un almacén por la imagen que corre (`postgres:16-alpine` es PostgreSQL y `confluentinc/cp-kafka` es Kafka), un externo por su host (`api.stripe.com` es Stripe) y un servicio por el marco que dicen sus librerías (`@angular/core` es Angular; Next antes que React y Nest antes que Express). Un driver de base de datos no cuenta como el marco del servicio.
  - Un servicio sin marco conocido se reconoce, por este orden, por cómo está hecho su front, por la imagen de la que parte su Dockerfile y por el lenguaje de sus librerías. Por ejemplo, `eclipse-temurin` es Java, `nginx:alpine` es nginx y unas librerías npm son Node.js. Si no, por su tipo (`spring`, `quarkus`). El mapa guarda ahora esa imagen de partida, el último `FROM`, tras resolver las etapas y `--platform`, y la lee al refrescarse.
  - Lo que no tiene marca dice qué hace: un escudo para un antivirus (ClamAV), un sobre para un servidor de correo (SMTP, Mailpit), un matraz para un mock (WireMock) y una nube para LocalStack. Laru lo reconoce por su imagen, por la de su Dockerfile o por su nombre (`payments-mock`); el nombre de un servicio nunca le da una marca (`kafka-consumer` no es Kafka).
  - Hay 184 logos de bases de datos, colas, almacenamiento, infraestructura, lenguajes, marcos, nubes y servicios externos. Salen a todo color del juego «logos» de Iconify y, donde no lo hay, en el color de la marca de simple-icons. Los dos son de dominio público (CC0) y van dentro de Laru: no se piden a internet y se cargan aparte la primera vez que hacen falta.
  - Las partes casi negras de un logo (Kafka, Express, GitHub…) toman el color del texto, para verse en los temas oscuros.
  - Solo conserva el icono genérico de servidor, base de datos o globo lo que Laru no reconoce de ninguna de estas formas.

- **Una pieza de la documentación se puede eliminar.** Hasta ahora no se podía borrar ninguna, ni desde la documentación, ni el agente, ni la terminal. Al agente se le prohíbe tocar `docs/` a mano, así que lo único que le quedaba era marcarla «Retirado», que la conserva como historia. Ahora hay «Eliminar» en la cabecera de cada pieza, `knowledge_delete` para el agente y `laru docs delete <id>` en la terminal.
  - Una faceta (una convención, una decisión…) se va con su fichero.
  - Un flujo se va con su carpeta, que incluye su especificación, y con su evidencia compartida.
  - Un contenedor con piezas dentro se elimina con ellas solo si se pide (`--contents`). En la documentación, el aviso las enumera.
  - Antes de borrar, el aviso dice qué se va y qué piezas la siguen nombrando. Esas piezas quedan con una referencia rota que `laru check` señala hasta que se actualizan.
  - La guía del agente le dice que eliminar es eliminar: «Retirado» es para lo que la aplicación tuvo y ya no tiene.
  - El aplicativo y la guía e2e de Laru no se eliminan, porque Laru la volvería a escribir.
- **Cada endpoint de un servicio dice su contrato.** En «Mapa y servicios», la pestaña Endpoints de un servicio enseñaba la lista de endpoints y lo que habían visto los runs, pero no qué era cada uno ni qué intercambia. Ahora:
  - Los endpoints se agrupan por el contrato que los documenta: su título, para qué es y su autenticación encabezan el grupo. Los que ningún contrato documenta se agrupan por el recurso de su ruta (`/api/files/trash`), y los que solo reenvían a otro servicio van al final.
  - Cada endpoint abre su contrato: para qué sirve, qué recibe, qué responde y los errores que el contrato le da a esa operación. Debajo de cada parte, lo que dice su código: sus parámetros con su tipo, lo que devuelve y los estados que responde. Lo que el contrato explica de él en su propio apartado se despliega al final.
  - Aparte, «Datos reales»: lo que vieron los runs (las llamadas, una petición real, las respuestas vistas) y en qué se apartan del contrato: un estado de error que no lista para esa operación, otro éxito, parámetros de consulta o campos que ningún contrato del servicio nombra, lo que vio un mock.
  - Nada queda en blanco: lo que no se sabe dice qué falta y qué lo trae (el escaneo del agente, el primer run de un flujo, una sesión de «Probar en vivo»).
  - La página de un contrato enseña también la petición, la respuesta y los errores propios de cada operación.
- **El agente escribe el contrato de cada endpoint.** El contrato tiene ahora, por operación, su petición y su respuesta junto al resumen, que dice para qué sirve, y cada error dice qué operaciones lo responden.
  - Las tres columnas se deben: la nota del documento dice qué operaciones no las tienen.
  - Cada endpoint de un servicio se debe a algún contrato. Al escribir un contrato, Laru nombra los endpoints de sus servicios que siguen sin él; `laru check` los lista por servicio y la hoja del servicio los debe. Las rutas de un gateway que solo reenvían no lo deben: su contrato es el del servicio al que llegan.
  - La guía del agente, el arquitecto y las herramientas MCP le dicen que un contrato no es un inventario y que el escaneo no deja ningún endpoint sin su operación.
  - `context` sobre un endpoint da lo que su código recibe, devuelve y responde: el punto de partida de su operación. El mapa lo lee de los handlers de Spring, JAX-RS y Quarkus REST, Express, Fastify y Nest, y de un fichero OpenAPI, que da también su resumen.
  - En un workspace con `policies.documento`, un contrato escrito antes, sin petición ni respuesta, queda por debajo de la nota exigida: `laru check` lo marca hasta que el agente lo complete.
- **Las demás pestañas de la ficha, igual.** Cada una dice para qué es, agrupa lo que muestra, pone aparte como «Datos reales» lo que vieron los runs y dice qué falta en vez de quedar vacía.
  - Eventos: por lo que publica y lo que consume, cada tema con el contenido que dice su contrato y los mensajes vistos.
  - Conexiones: por relación y por la pieza del otro lado, con lo que dice el código de cada llamada y cuándo la vieron los runs.
  - Datos: cada tabla con lo que dicen su modelo, su código y sus runs.
  - Variables: dónde la lee su código y qué le da valor.
  - Librerías: con las que corre y, aparte, las que solo usan sus pruebas.
  - Pruebas: por nivel, cada fichero con la clase que prueba y sus casos; aparte, los flujos que pasaron por el servicio y cuántos de sus endpoints recorrieron.
  - Flujos: los que fallan primero, con los endpoints que recorrió cada uno.

### Cambiado

- **«Lo que debe» se aparta del camino.**
  - Ya no está en el menú lateral ni en las pestañas del aplicativo y de los módulos.
  - El árbol de la documentación, las tarjetas de módulos y las listas de piezas ya no llevan el círculo con la nota.
  - El resumen del aplicativo deja el recuadro «Documentación · N cosas por completar».
  - Cada pieza lo guarda plegado al final de su página, con su nota y sus hallazgos, en vez de abierto arriba.
  - El agente lo sigue recibiendo igual.
- **El agente entiende más de la aplicación con el mismo contexto.** Medido en VaultFlow: el contexto de file-service usaba 2.026 tokens, la mayoría repitiendo tres veces cada llamada, y dejaba fuera sus endpoints, sus datos, sus variables y sus librerías. Ahora lo dice todo en 1.690.
  - Un servicio dice cada endpoint en un renglón: su handler, quién lo llama y a través de qué gateway, cuántas veces lo vieron los runs y cuántos flujos lo recorren. Cada tabla y cada tema van también en un renglón, con lo que el servicio hace con ellos en su código y en los runs.
  - Un endpoint dice qué hizo en los runs: las tablas que leyó o escribió, los almacenes que usó y los mensajes que publicó mientras atendía esa petición. No cuenta lo que hizo después quien consumió sus mensajes. Los runs lo graban desde esta versión.
  - Un endpoint, una tabla, un tema, un almacén o un servicio dicen qué flujos pasaron por ellos en su último run: lo que hay que correr después de cambiarlos.
  - El contexto y `tree` avisan cuando tu copia del repo va por delante o por detrás de lo que leyó el mapa, o tiene cambios sin commit, y cuando la rama de referencia avanzó. Dicen también qué hacer: `impact` o `map_refresh`.
  - `ask` entiende preguntas con tildes y en español («¿quién escribe la tabla files?»). Pone primero lo del tipo y el verbo que nombras, y busca también en la documentación: si la pregunta usa las palabras del negocio («cuarentena»), llega a las piezas que las usan y a lo que esas piezas nombran.
  - Un diagrama se nombra por su clase y su título en vez de copiar su código cortado.
- **El selector de workspaces solo dice si cada uno está en marcha.** Antes listaba cada entorno levantado («f-editar-perfil, local…»), y con muchos la fila se desbordaba. Ahora dice «en marcha» o «parado». Los nombres de los entornos aparecen al pasar el ratón.

### Arreglado

- **Una decisión aceptada sigue al día y se sustituye en un solo paso.** Laru no dejaba tocar nada de una decisión aceptada, ni siquiera lo que la propia decisión pide mantener al día: su «Estado de cumplimiento», sus anclas al código, sus relaciones o su dueño. Tampoco dejaba llenar una sección vacía que la nota del documento le pedía. Al agente se le pedía además actualizar las decisiones que un cambio contradice, y Laru se lo rechazaba. Y la pista de `supersedes` prometía que la decisión sustituida pasaba a «Sustituida», pero nadie la marcaba: quedaban dos decisiones aceptadas que se contradecían, y marcar la vieja a mano exigía reenviarla idéntica carácter por carácter. Ahora una decisión aceptada conserva lo que decidió (título, resumen, `supersedes` y todas sus secciones menos «Estado de cumplimiento»), y un espacio de más o columnas en otro orden no cuentan como cambio. Lo que dice de hoy sí se actualiza, y una sección vacía se puede llenar. Para cambiar lo decidido se escribe otra decisión con `supersedes`, y al aceptarla Laru marca la vieja como sustituida sin tocar nada más. El rechazo dice qué cambiaría y cómo hacerlo. La guía del agente le pide escribir la decisión como propuesta hasta que el texto sea definitivo. Una actualización que no indica el estado conserva el que tenía; antes lo devolvía a propuesta o borrador.
- **Las pistas de los metadatos salen en el idioma elegido.** En el formulario de una pieza, las pistas de `supersedes`, `number`, `needs`, `scenario`, `timeout`, `screen`, `extends`, `exclusive` y las demás salían en inglés aunque la interfaz estuviera en español. Ahora salen en el idioma de la interfaz, como las de cada sección, y el agente las recibe en el idioma de la documentación. Una prueba exige que cada una tenga su español.

## [0.1.0-beta.19] - 2026-11-16

### Añadido

- **Laru en español y en inglés.** Toda la interfaz se puede usar en inglés: menús, pantallas, avisos, las frases de «Paso a paso» y «Cadena», las pistas del estándar y los fallos que inyecta el interceptor. Se elige en Ajustes › Idioma; de entrada sigue el idioma del navegador y la elección se recuerda en él, como el tema. Las fechas, los números y las listas siguen el idioma elegido («0.25×» en inglés, «0,25×» en español). La documentación de cada workspace no cambia: sigue en su idioma. Lo que el servicio ya dice en inglés (motivos, errores, hallazgos) se muestra tal cual en inglés y traducido en español. Una prueba comprueba que cada texto tenga su traducción, que no quede ninguna traducción sin uso y que no se cuele un texto en español sin traducir.

### Cambiado

- **Cada botón dice qué hace.** Los botones que solo mostraban un icono propio de Laru (abrir el vídeo en una ventana, ir al fallo, marcar los avisos como vistos, ajustar un diagrama) llevan ahora su palabra al lado: «Vídeo», «Ventana», «Ir al fallo», «Marcar como vistos», «Vaciar» y «Ajustar». Mientras une las pantallas de un run, el botón del vídeo dice «Uniendo las pantallas…» en vez de solo girar. Los textos no quitan sitio: en una columna estrecha, como la del estudio, las herramientas del vídeo bajan a su propia línea en vez de cortarse. «Ir al fallo» pasa junto a «Paso a paso» y solo aparece cuando algo falló. «Ventana» va al pie de cada pantalla en vez de taparla. Sin palabra quedan solo los iconos que se leen igual en cualquier aplicación (cerrar, reproducir, flechas, zoom, paneles, copiar, borrar, descargar), y una prueba lo vigila.

- **Los datos de un flujo son los que dejó su último run, y se ven con el entorno apagado, en las mismas pantallas que en vivo.** «Bases de datos», «Colas», «Almacenamiento», «Correo y mensajes» y «Variables y secretos» de un flujo consultaban su entorno en vivo, así que con el entorno apagado no mostraban nada. Ahora cada run graba al terminar lo que esas pantallas leen (las tablas de cada base con sus filas, las colecciones de Mongo, las claves de Redis, los topics de Kafka con sus últimos mensajes, las colas de RabbitMQ y SQS, cada bucket con sus ficheros, también las imágenes y los PDF, los correos y SMS con lo que se ve de ellos, y las variables de cada nivel, sin el valor de ningún secreto), sin tocar el entorno y enmascarado como el resto de la evidencia: con el enmascarado activo (`mask: true`), ningún texto grabado conserva un valor del vault ni los códigos y tokens que aprendió el buzón (tampoco un mensaje de error ni la dirección de una imagen bloqueada de un correo), aunque la pantalla en vivo los enseñe para que la persona los use, y no se graba nada que guarde texto que no se puede enmascarar: un PDF, un fichero binario, el original de un correo y sus adjuntos (las imágenes se guardan, como el vídeo del run); con el enmascarado apagado, que es como viene, se graba todo en claro, como el resto de la evidencia, y la banda lo dice: no se saca ningún mensaje de una cola. El menú del flujo lleva, bajo «Datos del último run», a esas mismas pantallas sobre la grabación del último run que lo jugó (un resultado reutilizado lleva al run del que viene): se recorren, se filtran, se ordenan y se paginan igual que en vivo, y no ofrecen nada que cambie datos (editar una fila, lanzar una consulta, publicar, borrar una clave, vaciar el buzón, cambiar una variable), que el servicio también rechaza. Una banda dice qué run es, cuándo terminó y cómo salió, si algo pasó de los límites de la grabación, y lleva a «Ver en vivo»; las pantallas en vivo llevan su banda «En vivo». Un run que no pudo grabar sus datos lo dice, sin mostrar en su lugar los de otro run más viejo.

- **La limpieza guarda los últimos 5 runs de cada flujo y, siempre, su último verde.** Antes un run se borraba a los 30 días, salvo el último verde y el último fallido de cada flujo. Ahora de cada flujo quedan sus últimos 5 runs (`keepRuns` en `retention` de `~/.laru/config.yaml`) y los anteriores se borran; su último run verde es el pivote y no se borra nunca, ni su vídeo, por viejo que sea, aunque después haya fallado muchas veces. Un run cuenta para cada flujo que ejecutó, y uno que dio un resultado reutilizado («cached») mantiene el run del que viene su evidencia. Los vídeos de los demás runs siguen borrándose a los 7 días y el tope de 5 GB sigue en pie, sin tocar nunca el pivote. Cada run dice en su ficha por qué se conserva: el último verde de qué flujo, o uno de sus últimos 5. `runDays` ya no existe.

### Quitado

- **La réplica de la página ya no existe.** Era una prueba de concepto: la historia de cada flujo grababa además la página con rrweb, «Réplica» la ponía en lugar del vídeo y «MP4 de la réplica» la filmaba. Los runs ya no la graban ni Laru la abre o la filma, y salen sus dos dependencias (`@rrweb/record` y `@rrweb/replay`). La grabación de cada flujo sigue siendo su vídeo. Los runs anteriores conservan su `replay.json` hasta que la limpieza los borra.

### Arreglado

- **Un Postgres con su `command` escrito como texto arranca.** Para que cada consulta llegue a la traza, Laru añade sus opciones al `command` de Postgres, y cuando el compose lo escribía como texto (por ejemplo `command: >` en varias líneas) lo partía por los espacios: el salto de línea final se convertía en un argumento vacío y Postgres no arrancaba, y las comillas de `listen_addresses='*'` le llegaban tal cual. Ahora se parte como lo haría la shell.
- **Una base construida desde un Dockerfile sigue siendo una base.** El interceptor ponía un proxy HTTP delante de todo servicio con `build:`, así una réplica de Postgres hecha con `FROM postgres:16` y su propio entrypoint respondía a psql y a JDBC con HTTP, y no conectaban. Ahora Laru mira el último `FROM` del Dockerfile (sin contar las etapas de compilación): una base se trata como base, y una Postgres pasa por el proxy de Postgres, con sus consultas en la traza.
- **Un frontend abierto por su entrada habla con su API por la suya.** En el navegador, el interceptor cambia Host, Origin y Referer a los nombres de dentro del entorno y devuelve los del navegador en `Location` y `Access-Control-Allow-Origin`, pero solo devolvía el del propio servicio: cuando el origen era otro servicio del entorno (un frontend que llama a su API), el API respondía con el nombre interno y el navegador rechazaba la respuesta por CORS. Ahora vuelven todos los nombres que se cambiaron.
- **Las pantallas pequeñas ya no cortan nada.** En un móvil, los grupos de entornos van uno debajo de otro (antes el segundo quedaba cortado por la derecha), los controles del reproductor bajan de línea sin salirse, los nombres largos de dispositivo acaban en «…», las claves del vault se leen en una línea y la tabla se desplaza de lado, el comando del buzón se parte dentro de su caja, la etiqueta de cada escenario se ve entera, el nombre del workspace cabe en la barra y el botón del menú dice si lo abre o lo cierra. «Vídeo grande» vuelve a ocultarse en pantallas estrechas en los dos idiomas.
- **Laru va rápido en un workspace grande.** Cada pantalla volvía a pedir la documentación entera (1,8 MB con 120 flujos), los flujos (1,1 MB) y el mapa, y el servicio los rehacía cada vez: leer y analizar todos los Markdown, sus notas, sus convenciones, los resultados de cada flujo, los hallazgos y lo que tocan los cambios, que además leía la última traza de cada flujo aunque no hubiera ningún cambio. Ahora el servicio guarda lo que deriva y lo rehace solo cuando cambia algo de lo que sale (los ficheros de `docs/`, `envs/`, `vault/`, `laru.yaml`, `findings.yaml`, el mapa, las extracciones del código, el índice de runs, la forma de trabajo, y el estado de cada entorno, los de cada flujo incluidos, con el de sus escenarios: una preparación que falla sale en los hallazgos en la siguiente lectura); lo que la página ya tiene no se vuelve a descargar (cada respuesta lleva una etiqueta y, si no cambió, el servicio contesta sin cuerpo); una pantalla no vuelve a pedir lo que acaba de llegar; y «Qué tocan tus cambios» contesta al momento si no hay cambios. Medido con 120 flujos y 360 runs: «Estado» pasa de 835 ms a 26, un módulo de 365 a 54, «Entornos» de 213 a 27, y cambiar de pantalla deja de descargar de 2 a 4 MB cada vez. Lo que cambia en disco por fuera del servicio se ve en la siguiente lectura pasado un cuarto de segundo; lo que se guarda desde la página, al instante.
- **Un fichero guardado con «..» en el nombre se abre.** En «Almacenamiento», un nombre como `captura 8.21.34 p.m..png` se rechazaba como ruta no válida (la protección contra `..` miraba el texto entero); ahora solo se rechaza un tramo de la ruta que sea `..`.
- **Los flujos vuelven a arrancar.** Desde el estándar de pantallas, el fixture de los flujos importaba los tamaños de pantalla de otro archivo de su paquete, y dentro del runner Node no podía cargarlo: ningún flujo llegaba a empezar (`SyntaxError: Unexpected token 'export'`). Ahora el fixture no importa nada de su paquete (los tamaños le llegan del config del runner) y una prueba lo vigila.
- **Las pantallas aguantan un workspace grande con nombres largos.** Con decenas de servicios de nombre largo (`servicio-de-consulta-de-conciliacion-bancaria-interbancaria`), los nombres se salían de sus cajas en el mapa y se montaban sobre los vecinos, la tabla de componentes partía cada nombre en cinco líneas porque la ruta del proyecto se llevaba todo el ancho, el árbol de la documentación mostraba tres submódulos idénticos («Conciliacion bancaria inte…») y las cabeceras del recorrido de un run se cortaban en «servicio-de-», sin decir cuál. Se revisaron todas las pantallas con un workspace del peor caso (30 servicios, 300 endpoints, módulos con títulos largos) y ahora: un nombre que no cabe se corta por el medio, por palabras, conservando su principio y su final (`servicio-…interbancaria`, `api-publica-…tiempo-real`), en el mapa, en el recorrido y en los carriles del estudio; en el árbol, un submódulo omite lo que su título repite del padre («Subproceso 0 de validación…»); en las tablas, las rutas y los ids se parten donde haga falta sin empujar la tabla fuera de su caja y la columna «Dónde» queda en una línea; todo texto cortado con «…» dice su nombre entero al pasar el ratón. Los chips que se envuelven en varias filas tienen aire entre filas (en «Qué contiene a qué» y en todas las fichas), un chip con un nombre muy largo no pasa del ancho de su celda, un selector con muchas opciones largas (los proyectos del mapa) es una lista desplegable en vez de una pared de botones, el resumen del mapa dice «leído de 6 proyectos» en vez de la lista entera, y la barra lateral, la barra superior y las migas de pan cortan un nombre largo en su línea en vez de partirlo en cuatro. En un contrato, cada operación bajo su ruta dice su método y lo que hace en vez de repetir la ruta, y los pasos de una guía salen numerados.
- **Los documentos se leen con su estructura.** La vista de una pieza solo entendía párrafos y viñetas: las listas numeradas salían pegadas en un párrafo, y las tablas, los títulos y las citas como texto corrido. Ahora el Markdown de cada sección se dibuja entero, como en GitHub: tablas, listas numeradas y anidadas, títulos, citas, cursiva y enlaces, con los diagramas, el código y los enlaces `[[id]]` como antes. El HTML que traiga un campo no se pinta nunca y un enlace `javascript:` se anula. Cada sección lleva su título bien visible, y una pieza de tres secciones o más tiene al lado su índice («Contenido»), que la acompaña al bajar e incluye los títulos de dentro de cada sección.
- **Cada sesión empieza sabiendo cómo se trabaja con Laru y qué es la aplicación.** Una sesión nueva no sabía usar el Docker de Laru ni qué módulos había, y había que explicárselo todo otra vez. Ahora empieza con la aplicación tal como la documenta el workspace (su resumen, sus módulos y procesos en árbol, cada uno con su resumen, y los servicios y almacenes del mapa) y con cómo se hace aquí cada cosa con Laru: Docker y los entornos, el código, la documentación y los flujos. Se lee del workspace cada vez, así que nunca se queda vieja. Un agente sin hooks (Codex, Kiro) la pide con `laru start`, que su guía le manda lanzar antes de nada.
- **Los flujos navegan como una persona y a su ritmo.** El agente escribía historias que saltaban de ruta en ruta con `page.goto()`, recargaban para ver cada cambio y corrían a velocidad de máquina, y el vídeo no parecía de nadie. Ahora cada pantalla entra una vez por su dirección (el inicio o la página de acceso) y `laru check` avisa (`flow-e2e-navigation`) de una ruta abierta otra vez a mitad de la historia, de un `reload()` fuera de un paso que trate de recargar y de mover `location` a mano; un enlace que da la aplicación (el de un correo) se sigue con `goto`, como lo pulsaría la persona. La historia grabada hace además una pausa humana antes de cada acción (300 ms; `storyPaceMs` en `~/.laru/config.yaml`, 0 para la velocidad de máquina); los escenarios y las pruebas sin vídeo siguen a toda velocidad. La guía del agente y la de flujos e2e lo explican.
- **El agente ya no se pelea con Docker.** Su sesión le decía que Docker es de Laru, pero era solo un consejo: en Windows, con Docker dentro de WSL, su terminal no alcanza el motor, y probaba `docker`, luego `wsl docker`, abriendo y cerrando terminales sin llegar. Ahora el hook rechaza `docker`, `docker compose`, `podman` y `wsl docker` desde la terminal del agente, como sea que se escriba (tras `sudo`, `env`, `command`, `xargs` o `timeout`, con una variable delante, entre comillas, con su ruta, o dentro de `bash -c`, `pwsh -Command` o `cmd /c`), y le dice qué hace Laru en su lugar (estado, levantar, logs, bases de datos, colas, almacenamiento). Para lo que se hacía con `docker exec` hay `laru exec <servicio> -- <orden>`, que entra al contenedor como Laru llega a Docker y enmascara los valores del entorno.
- **Las pantallas de un flujo siguen un estándar, y el vídeo exportado respeta su forma.** Nada guiaba al agente: daba a la segunda pantalla de pc otro tamaño (quedaba más pequeña que la primera), abría un navegador propio con `browser.newContext()` o cambiaba el tamaño con `setViewportSize()`, y el vídeo salía con franjas grises. Ahora cada pantalla es de un tipo: `otherScreen('luis')` es un pc del mismo tamaño que la historia (el `screen` del flow.md), `otherScreen('luis', 'phone')` un móvil (390x844) y `'tablet'` una tableta (820x1180). `laru check` avisa (`flow-e2e-screen`) de un pc de otro tamaño, de una pantalla vertical sin su tipo, de un navegador propio y de `setViewportSize()`, cada uno con cómo hacerlo, y la guía del agente y la de flujos e2e lo explican. El vídeo de varias pantallas ya no mete cada una en una casilla fija de 960x540: todas a la misma altura (la de la más alta, hasta 1080) y cada una con su ancho, así un pc de 1920x1080 sale entero y un móvil sale vertical, sin franjas. Un vídeo exportado antes con las casillas viejas se rehace la próxima vez que se pide.
- **«Cómo se trabaja» son tus instrucciones para el agente, y le llegan en el momento que toca.** La forma de trabajo tiene ahora una sección libre, «Instrucciones para el agente» (la que antes era «Notas»): cómo quieres que trabaje aquí, con tus palabras y agrupado con títulos, sea lo que sea (cómo entrega un PR o un commit, cómo prueba, cómo informa). Va aparte de la documentación del proyecto, que dice cómo es el proyecto. El agente la recibe entera al empezar la sesión, y además cada sección le llega cuando toca: con cada petición que habla de ella (por las palabras de su título y su texto, y por los momentos que nombra: PR, commit, Jira), y antes de un `git commit`, un `git push`, un PR (`gh pr`, `glab mr`, `az repos pr`) o un ticket, que se detiene una vez para mostrarle las secciones de eso (también ante cualquier orden que una sección nombre con `cmd: <regex>`). Un agente sin hooks las pide con `laru rules --for "<tarea>"` o `laru rules pr`. Para que una sección con sus propios títulos se guarde entera, un `#` o `##` dentro de cualquier campo de una pieza baja a `###` al escribirse: antes cortaba el campo en ese título al volver a leerlo.
- **Los vídeos ya no empiezan con una pantalla morada.** Cada historia grabada abre con una marca de Laru (una página negra que se pone magenta en un instante conocido) para que el vídeo y la traza compartan reloj, y la página se quedaba magenta hasta que la prueba abría la aplicación. Ahora vuelve a negro en cuanto la marca queda grabada (4 fotogramas), y el reproductor y la ventana flotante tapan esos fotogramas con «Abriendo el navegador…»: miraban el píxel de la esquina, donde la marca dibuja un cuadradito que parpadea, y nunca veían el magenta; ahora miran el centro, cada fotograma. Los vídeos ya grabados también se ven tapados.
- **Un diagrama en «Diagramas» se lee como uno dibujado a mano.** Donde la sección no sugiere ninguna clase, un flowchart con carriles empataba con una clase que Laru deriva del mapa (el paisaje de procesos) y se avisaba de que «se desfasará», y uno de izquierda a derecha se tomaba por cadena de valor. Ahora se lee primero como las clases sugeridas de esa pieza y después como las que se dibujan a mano, empezando por la de proceso.
- **El diagrama de hitos (`gantt`) ya se puede escribir.** Laru tenía dos copias de la función que reconoce el lenguaje de un diagrama y la que valida lo escrito no conocía `gantt`: un plan con su hoja de ruta se rechazaba como «diagrama de ninguna clase», incluso con la plantilla que da el propio `knowledge_shape`. Queda una sola, y cada clase del catálogo se comprueba con su propia plantilla.
- **`laru docs write` dice cada aviso, no solo cuántos.** Escribía «(3 warnings)» y el agente no sabía qué corregir; ahora cada aviso sale debajo con dónde está y por qué (un endpoint que el código no tiene, una frase vaga, una sección que repite el resumen).
- **Los mapas por capas ya no ponen un servicio antes de quien lo llama.** Cuando dos servicios se llaman en los dos sentidos (un frontend que llama a su backend y un backend que llama de vuelta), el mapa cortaba ese ciclo según el orden en que leía los nodos, y el backend podía quedar en «Entrada», delante del frontend. Ahora el ciclo se corta recorriendo desde la entrada (las personas primero, después los servicios a los que nadie llama), así cada servicio queda detrás de quien llega a él primero.

## [0.1.0-beta.18] - 2026-11-12

### Arreglado

- **La limpieza ya no toca la caché de compilación de otros proyectos.** La caché de Docker es de toda la máquina, sin dueño, y el recorte a 20 GB alcanzaba también la de compilaciones ajenas. Ahora Laru compila con su propio builder (`laru`, de `docker buildx`, que lleva la marca de Laru), así su caché queda aparte y es la única que recorta; la de Docker no se toca nunca, ni un builder llamado `laru` que Laru no creó. Un entorno que ese builder no puede compilar (una imagen base que solo está en la máquina, un registro detrás de su propio certificado o red) se compila con el de Docker desde entonces, y esa caché tampoco se toca. La primera compilación con el builder nuevo empieza sin caché.
- **La limpieza solo borra imágenes que Laru construyó.** Elegía las imágenes de apps por el nombre (`ks-<app>/…`); ahora exige además la etiqueta de Laru, así una imagen ajena con un nombre parecido nunca se toca. El runner se sigue reconociendo por su nombre (`laru/runner`), que es el único que llevan los de versiones anteriores.

## [0.1.0-beta.17] - 2026-11-11

### Cambiado

- **Documentar sin techo: se mide que sea asertivo, no que sea corto.** Ninguna sección tiene ya límite de caracteres ni de elementos (solo el título y el resumen, que salen en listas y tarjetas). Lo que se mide es que cada afirmación pueda comprobarse: un endpoint nombrado (`GET /ruta`) que el código no tiene, las frases vagas o de relleno («probablemente», «etc.», «TODO»…) y una sección que repite el resumen se avisan y bajan la nota; un diagrama la sube. La guía del agente y `knowledge_shape` le dicen que escriba todo lo necesario, estructurado, y sin dudas que podría comprobar.
- **Cualquier diagrama en cualquier pieza.** Cada tipo de pieza trae sus diagramas sugeridos, con cómo se dibuja cada uno, y el catálogo completo de las 27 clases; los sugeridos son un punto de partida, no un límite. Ninguna sección rechaza un diagrama por su clase: solo se rechaza el que no se dibuja. Todas las piezas tienen una sección «Diagramas» para el que no encaja en otra, cualquier sección de texto del formulario tiene «Añadir un diagrama», el editor ofrece primero las clases sugeridas y luego todas, y una sección propia de una pieza ya no se marca como falta. `knowledge_shape` con `diagram: <clase>` da cómo se dibuja cualquiera.

### Quitado

- **Las piezas antiguas ya no existen: runbook, término y nota.** Laru no las conoce ni las ofrece. Lo que hacía un runbook es una guía de la aplicación que nombra lo que opera (la etapa «Operar» la busca así), las palabras van en el glosario y lo que merece recordarse va en los problemas conocidos de su servicio o repositorio. `laru docs migrate` solo pone al día títulos de sección y estados antiguos.

## [0.1.0-beta.16] - 2026-11-10

### Añadido

- **Cada flujo elige el tamaño de su pantalla.** `screen: 1920x1080` (o `390x844` para un móvil) en el flow.md abre el navegador a ese tamaño y graba el vídeo entero a ese tamaño; sin él sigue en 1280x720. El agente lo sabe por su guía y Laru avisa si el valor no es válido. Las otras pantallas del flujo toman ese tamaño salvo que pidan otro.
- **Réplica de la página (prueba de concepto).** Además del vídeo, la historia de cada flujo graba la página como datos con [rrweb](https://www.rrweb.io/): el HTML y cada cambio, no una imagen. En el reproductor, el botón de pantalla cambia el vídeo por la réplica, que sigue el mismo reloj, se ve nítida a cualquier tamaño y pesa bastante menos que el vídeo. Lo escrito en campos de contraseña, clave o código se enmascara en el propio navegador, y los valores del almacén de secretos se enmascaran antes de guardarse. Por ahora solo graba la primera pantalla de la historia, y las imágenes y fuentes que no van incrustadas se cargan desde el entorno, que tiene que seguir levantado.
- **Vídeo hecho desde la réplica, cuando lo pides:** el botón de película genera un MP4 (H.264, se abre en QuickTime y en cualquier reproductor) reproduciendo la réplica en Chrome al tamaño con que se grabó, y lo descarga. Usa el Chrome del equipo y el ffmpeg de Laru, como las sesiones en vivo.

### Cambiado

- **Docker ocupa menos.** Tras cada `up` (y con `laru prune images`), Laru quita sus imágenes que ningún contenedor usa: de cada servicio conserva solo la más nueva, así un entorno parado vuelve a levantarse sin construir; las de apps sin espacio de trabajo en esta máquina (restos de pruebas) se van todas, igual que sus volúmenes, y también el runner de una versión anterior o con el nombre antiguo. El `compose.yml` de cada entorno se queda: es su memoria. `up` además quita los contenedores que el compose ya no declara. Solo se toca lo que lleva la etiqueta de Laru; la caché de build de Docker es de toda la máquina y no se vacía, solo se recorta (abajo).
- **La caché de compilación de Docker tiene tope: 20 GB.** Cada compilación del Dockerfile de un proyecto deja sus capas (un `npm ci` entero por cada cambio del código) y Docker no las recorta por su cuenta: en una PC con WSL llegó a 182 GB. Por encima del tope, Laru borra primero lo menos usado y mide el resultado; si Docker la deja por encima (con el almacén de imágenes de containerd ignora ese límite), borra toda la caché que ninguna compilación está usando. No se pierden datos ni imágenes: la siguiente compilación de cada imagen empieza de cero. El informe da los tamaños medidos antes y después, o el motivo si falló. Es la caché de toda la máquina, no lleva etiqueta: el tope se cambia con `buildCacheGB` en `~/.laru/config.yaml` y con `0` Laru no la toca.
- **Limpieza de Docker como política, no solo al construir.** Se aplica tras cada levantamiento, tras cada run, al arrancar el servicio y cada 6 horas, así lo que un agente construyó a mano también se recorta. Quita además las imágenes de Laru que se quedaron sin nombre al reconstruir una etiqueta (el runner incluido, que ahora lleva la etiqueta de Laru). «Archivos locales» y `laru where` muestran la política, el tamaño de la caché de compilación y la última limpieza, con el motivo si la caché no se pudo recortar.
- **Lo que pesa cada workspace, en el inicio.** Una sección nueva lista cada workspace de la máquina, del más pesado al más ligero, parte por parte: su carpeta, los runs, los entornos, el resto del estado, las instantáneas y las imágenes de Docker de su app; debajo, la carpeta de Laru y la caché de compilación de Docker con su tope, y el total, donde las imágenes e instantáneas de una app cuentan una vez.
- **Un aviso cada vez que Laru limpia.** Cuando la limpieza de Docker borra algo (imágenes, volúmenes, caché de compilación) o la retención borra o aligera runs, sale un aviso con lo que liberó, en el inicio y dentro de cada workspace, y queda en la campana. Si la caché no se pudo recortar, el aviso es una alerta con el motivo y se queda hasta cerrarlo. Una limpieza que no encontró nada que borrar no avisa.
- **La limpieza no confunde las apps de la máquina con restos.** Un Laru con otra carpeta (`LARU_HOME`, como un banco de pruebas) también tiene en cuenta los workspaces registrados en la carpeta de Laru de la máquina, así que nunca borra sus imágenes ni sus volúmenes por creerlos de una app que ya no existe. Varios levantamientos o runs seguidos lanzan una sola limpieza (como mucho una cada 2 minutos), y `LARU_DOCKER_CLEANUP=0` apaga la limpieza automática tras levantar y tras cada run.
- **El agente ya no reconstruye sin caché para recoger código.** Su guía y la herramienta `env_up` le dicen que un `up` normal ya construye lo que cambió y que `rebuild` (sin caché) es solo para cuando cambió una dependencia que se descarga al construir; nunca `docker build` ni `--no-cache` a mano. Cada reconstrucción sin caché dejaba una copia entera de `node_modules`: de ahí los 104 `npm ci` guardados en la PC con WSL.
- **El reproductor se adapta al vídeo:** el recuadro toma la forma de la grabación (un móvil de pie, una pantalla ancha tumbada) y cabe en la ventana, sin cortes ni franjas de más. La ventana flotante del vídeo se abre también con su forma.

### Arreglado

- **El vídeo de un flujo ya no se detiene cuando Laru se actualiza solo.** Cada refresco automático (un agente que cambia algo) pausaba y volvía a arrancar el vídeo que estabas viendo; a veces la barra seguía avanzando y la imagen se quedaba quieta. Ahora un refresco de los datos no toca el vídeo.

## [0.1.0-beta.15] - 2026-11-03

### Arreglado

- **Editar una pieza ya no pierde lo escrito cuando algo cambia el workspace.** Con el refresco automático, el formulario volvía al texto guardado cada vez que un agente tocaba cualquier archivo. Ahora solo sigue a la pieza si su texto cambió y no estabas escribiendo. Si cambió fuera mientras la editabas, lo avisa, conserva tus cambios y ofrece cargar la versión nueva.
- **El paso a paso ya no mueve la página:** al cambiar de paso, la cadena de mensajes y la lista junto al vídeo se desplazan solo dentro de su recuadro. Antes bajaban la página y había que subir otra vez a los controles. Si bajas por la secuencia, aparece abajo una barra flotante con anterior, siguiente, las acciones, dónde vas, volver a los controles y salir.
- **Las herramientas del árbol de documentación se quedan fijas** (ocultar, filtrar, estado) y solo se desplaza el árbol.
- **El menú oculto sigue oculto al recargar,** en este navegador.
- **El panel de avisos se cierra al pulsar fuera de él.**
- **El menú ya no rebota:** al pulsar una sección, el menú marcaba primero otra (la de antes, o la vista general mientras cargaba) y después la pulsada. Ahora el menú se calcula a partir de la dirección, en el mismo momento que la pantalla, y las pestañas de las hojas salen de la dirección sin copia propia. Las direcciones antiguas se corrigen antes de dibujar nada.
- **Sin parpadeos al navegar:** lo que una pantalla ya cargó se muestra al instante al volver y se actualiza por detrás, y el menú y la pantalla comparten lo que leen. El código de todas las pantallas se carga en segundo plano tras la primera, el menú ya no se desliza cuando cambia de nivel y la pantalla ya no aparece con un fundido. Antes cada cambio de ruta dejaba la pantalla en blanco un momento y el menú de un flujo cambiaba de título y se deslizaba otra vez.
- **Docker vigilado en un solo sitio:** mientras hay una página abierta, el servicio pregunta a Docker cada 5 segundos, y las pantallas leen lo que vio en vez de preguntar cada una. La lista de workspaces ya no espera a `docker ps`.
- **Docker caído o colgado ya no bloquea Laru:** el estudio pregunta primero, en 5 segundos como mucho, si Docker responde. Si no, los entornos se ven como «Docker no responde» y el resto de pantallas (evidencia, documentos, flujos) carga sin esperarlo. Antes las peticiones que esperaban a Docker ocupaban las conexiones del navegador y todo lo demás se quedaba cargando.

### Añadido

- **La pantalla de un mock muestra lo que hizo:**
  - «Lo que respondió»: cada endpoint con cuántas veces lo llamaron, con qué estados respondió y cuánto tarda normalmente.
  - «Peticiones»: las últimas que grabó el interceptor y, encima, las que llegan en vivo. Cada una se abre con la petición y la respuesta completas.
  - Si no tiene mock, el bloque YAML para simularlo, listo para copiar.
  
  Antes solo salía lo que llegaba con la pantalla abierta, así que casi siempre estaba vacía.
- **Cada entorno muestra su buzón y sus mocks:** en su página, el buzón (qué recibe, cuántos correos y mensajes, los últimos) o el aviso de que no tiene. También cada dependencia que tiene delante el interceptor, real, con mock o buzón, con sus fallos; todo enlazado a su pantalla.
- **El buzón de Laru recibe cualquier sistema de mensajería:** además de correo por SMTP y SMS por Twilio, un buzón `sink: api` recibe la API HTTP de cualquier proveedor de correo, SMS, WhatsApp o notificaciones. Lee el destinatario, el texto, el remitente y el asunto por sus nombres habituales (también anidados), o por los campos que se le indiquen (`fields`). Lo guarda como mensaje o correo, con sus códigos y enlaces, y responde como un proveedor (`reply`). Todo se ve en «Correo y mensajes».
- **Un mock de mensajería se conecta al buzón de Laru:** cada entorno tiene `http://laru-mailbox/messages`. El mock que reciba el correo, los SMS, WhatsApp o las notificaciones de la app (el que monte el agente, a la medida de cada app) publica allí cada mensaje con un `POST` y se ve en «Correo y mensajes». Puede mandar los campos (`kind`, `to`, `from`, `subject`, `body`, `html`, `channel`, `source`) o el correo original en `eml`, que se guarda entero con sus adjuntos. Laru no adivina ni sustituye el mock: el mock avisa. El buzón aparece en cuanto llega algo, aunque el entorno no declare ningún buzón propio. Hace falta volver a levantar el entorno para que exista la dirección.
- **El agente conecta su mock al buzón:** la guía le explica que todo mock de mensajería que monte publique cada mensaje en `http://laru-mailbox/messages`, porque un mock que no publica es un buzón que nadie ve. Al empezar cada sesión recibe qué recibe cada entorno y cuántos mensajes tiene.
- **La forma de trabajo muestra lo que recibe el agente:** su hoja dice por dónde le llega (Claude Code, el servidor MCP, los hooks) y si cada vía está activa en ese workspace. Muestra las ramas protegidas con candado. Marca cada regla de «Nunca» y «Pedir confirmación» como «Laru la bloquea», «Laru te pregunta» (las órdenes `cmd:`, que el hook hace cumplir) o «Indicación» (lo que el agente solo lee). Al final está el texto exacto que lee el agente, con un botón para copiarlo.
- **Un botón para los dos paneles:** el botón de la izquierda de la cabecera (y `⌘B`) oculta a la vez el menú lateral y el árbol de documentación, y la hoja ocupa todo el ancho. Vuelve a pulsarlo para sacar los dos. Cada panel sigue ocultándose por separado con su propio botón.
- **«En curso» flotante:** lo que corre aparece en una tarjeta abajo a la derecha, con el número del run, qué corre y en qué entorno, la fase en una barra, el tiempo que lleva y un enlace. Se pliega en una píldora (lo recuerda el navegador) y se va sola cuando nada corre. Los mensajes breves pasan abajo al centro.
- **Avisos que llegan solos:** lo que pasa mientras la página está abierta aparece arriba a la derecha sin abrir nada, según lo que importa. Un run que falló o Docker que dejó de responder se quedan hasta que se resuelven o los cierras. Un run que pasó o Docker que volvió se van en unos segundos. Que algo cambió el workspace y la pantalla se actualizó es una línea breve con los archivos. Pasar el ratón por encima retiene la tarjeta, y la de un run lleva a él.
- **Docker caído, a la vista:** mientras Docker no responde, una franja en lo alto de cada pantalla dice desde cuándo y qué dijo, y se va sola cuando vuelve.
- **Cabecera más limpia:** Docker es una cápsula con su punto de color y su versión. Si cae, se pone roja y dice «Docker caído». Al pulsarla se abre el panel con el detalle y el historial de avisos, y un contador rojo marca los fallos que no has visto. Ya no hay campana. El selector de workspace muestra también el servicio: un punto con su estado y cuántos workspaces hay. Su lista empieza por el servicio local (dirección y estado) y lleva a todos los workspaces.
- **El historial de avisos:** guarda los avisos de la sesión con el estado de Docker arriba (versión, desde cuándo, el error completo) y agrupa los cambios seguidos.
- **Las pantallas se actualizan solas:** cuando un agente, un editor o la CLI cambia algo del workspace (un documento, un flujo, una corrida que termina, el estado de un entorno), las páginas abiertas vuelven a pedir sus datos en unos 3 segundos, sin recargar ni perder dónde estabas. Lo que guardas desde la propia página no provoca otro refresco.

### Cambiado

- **Los mapas de servicios, de flujos y de entornos se leen por capas:** después de la entrada y de los servicios por nivel de llamada, cada tipo de pieza tiene su propia columna: Mensajería (colas), Datos (bases de datos, almacenamiento) y Sistemas externos. Antes iban todas juntas en «Datos e infraestructura». Una columna con más de cinco piezas se parte en varias del mismo nivel, una junto a otra, en vez de crecer hacia abajo. Antes, cuando el navegador llamaba directamente a muchos servicios, quedaban todos en una sola columna larga.
- **La barra del reproductor, ordenada en dos filas:** arriba el tiempo (reproducir, la posición, la línea con los pasos, la duración e ir al fallo); abajo cómo recorrerlo («Seguimiento» y «Paso a paso» a un lado, la velocidad y el dispositivo al otro). La leyenda http/sql/sse pasa junto a la pestaña «Secuencia», que es lo que describe. El dispositivo se elige con botones como los de la velocidad («Todos» y cada dispositivo con su icono y cuántos mensajes envió). Con más de tres dispositivos pasa a ser un desplegable compacto.
- **«Entornos» tiene su propia sección en el menú,** junto a «Mapa y servicios» (antes «Servicios y entornos», con dos pestañas). Las bases de datos, colas, almacenamiento, correo y variables cuelgan de ella.

## [0.1.0-beta.14] - 2026-11-03

### Añadido

- **El agente empieza sabiendo dónde está:** al abrir una sesión de Claude Code en el workspace, un hook nuevo (`laru hook start`) le dice qué workspace es, dónde llega Laru a Docker, en qué estado está cada entorno, qué flujos hay con su último resultado y tu forma de trabajo. Antes solo tenía la guía general y a menudo no usaba las herramientas de Laru.
- **El agente también se puede abrir en la carpeta de Laru:** la carpeta donde instalaste Laru trae ahora su guía para el agente (`AGENTS.md` y `CLAUDE.md`), el servidor MCP y el hook de inicio. Abierto ahí, el agente trabaja sobre el último workspace que abriste en Laru, recibe la guía completa y sabe que no debe tocar el código de Laru. `laru workspace list` muestra los demás y `LARU_WORKSPACE=<id>` elige otro.

### Cambiado

- **Un flujo, su entorno:** `laru test <flujo>` y `flow_run` de un solo flujo, sin `--env`, lo juegan en el entorno propio del flujo (`f-<flujo>`) cuando está levantado. La guía del agente le dice ahora que trabaje cada flujo en su entorno (`flow_env`) y nunca en uno que usan otros flujos o una persona.
- **Docker es cosa de Laru:** la guía le dice al agente que su terminal puede no ver Docker aunque Laru sí lo vea (por ejemplo en Windows con Docker dentro de WSL). Así no concluye que no hay Docker ni maneja los entornos con `docker` o `compose` por su cuenta.
- **Los archivos del agente se actualizan solos:** al arrancar, el servidor MCP reescribe `CLAUDE.md`, `AGENTS.md` y los hooks como los escribe la versión instalada, así que una actualización de Laru llega al agente en la siguiente sesión.
- **El menú enlaza a GitHub sin el nombre de usuario:** el pie del menú dice «GitHub» en vez de la dirección del repositorio.

## [0.1.0-beta.13] - 2026-10-30

### Seguridad

- **El servicio pide siempre el token:** cualquier contenedor de tus entornos (el aplicativo bajo prueba, una imagen del compose, un flujo) llegaba al `127.0.0.1` de tu máquina por `host.docker.internal` y podía usar la API entera sin identificarse: leer los secretos, cambiar variables, lanzar runs o consultar las bases de datos. Ahora `laru serve` y `laru open` piden siempre el token (ya no hace falta `--token`): ábrelo con la dirección que da `laru open`. La cookie se guarda en `~/.laru/session` y sigue valiendo tras reiniciar el servicio, y una dirección vieja con otro token ya no da error a quien la tiene.

### Cambiado

- **ffmpeg viene con Laru:** `pnpm install` descarga un ffmpeg para tu sistema ([ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)), así que ya no hay que instalarlo. Sin él, el vídeo de una prueba se alineaba con su traza por un desfase fijo en vez de por su marca, las sesiones en vivo no tenían vídeo y no se podían unir las pantallas de una prueba con varios usuarios. Es opcional: si tu sistema no tiene build de ffmpeg-static o la descarga falla (sin red, por ejemplo), la instalación sigue y Laru usa el `ffmpeg` que tengas instalado.

### Corregido

- **El rótulo del paso, una sola vez en el estudio:** al reproducir el vídeo de un flujo se veía dos veces, el que el vídeo trae grabado (abajo a la izquierda) y otro que el estudio pintaba encima. Ahora el estudio solo pinta el suyo cuando no hay vídeo o el run es una sesión en vivo, cuyo vídeo no lo trae. El `video.webm` suelto conserva su rótulo.

## [0.1.0-beta.12] - 2026-10-29

### Cambiado

- **La versión completa y el autor, en el menú:** el pie del menú dice la versión exacta (como `laru 0.1.0-beta.12`, no `0.1.0`), con un enlace a lo que trae, y el GitHub de Laru.
- **README al día:** capturas nuevas con el tema Abyssal, la forma de trabajo y los hooks que hacen cumplir, los temas y una sección de autor.

## [0.1.0-beta.11] - 2026-10-29

### Añadido

- **Tu «Forma de trabajo» en cada workspace:** una pieza nueva (Piezas › Formas de trabajo) con para qué usas el workspace, tus ramas, las ramas en las que no se edita código, lo que nunca se hace y lo que pide confirmación. Es de cada persona y no entra en git: se guarda en la carpeta de estado del workspace (`.laru/agreement.md`), porque varias personas comparten el workspace y cada una trabaja a su manera. Solo hay una por persona. El agente la lee siempre: `CLAUDE.local.md` (también fuera de git) la importa y el servidor MCP la incluye en sus instrucciones; `CLAUDE.md` y `AGENTS.md`, que sí se comparten, solo dicen dónde está, con las mismas palabras para todos. `laru check` avisa si encuentra una en `docs/`.
- **Hooks que hacen cumplir:** el agente no puede escribir a mano una pieza de `docs/` (se le manda a `knowledge_write`), ni editar código en una rama que la forma de trabajo protege. Un comando de shell que esta lista como `cmd: <regex>` en «Nunca» se rechaza, y uno de «Pedir confirmación» se detiene a preguntarte. Al terminar, si `laru check` tiene errores o el agente editó código que describen piezas que no revisó, se le pide que lo haga antes de cerrar (una vez por turno). `laru sync` registra los hooks nuevos.
- **El estándar de diagramas, para el agente:** `knowledge_shape` le da, para cada sección con diagrama, las clases que acepta con su dialecto, sus formas, sus reglas y una plantilla. `knowledge_write` y `laru docs write` rechazan un diagrama de una clase que la sección no acepta, uno que rompe las reglas de error de su estándar y una pieza por debajo de la nota mínima de `policies.documento`. Desde la web se sigue pudiendo guardar, con avisos.

### Cambiado

- **Temas de Lusitania, en Ajustes › Tema:** las 8 variantes del tema de VS Code (Trench, Midnight, Abyssal, Abyssal Deep, Steel, Oceanic y las claras Surface y Abyssal Light), cada una con su tarjeta de muestra; se aplica al momento y se guarda en el navegador. Abyssal es la de siempre: fondos azul abismal, acento teal y la paleta Material Oceanic en el código, las peticiones y los registros (claves en azul, textos en verde, números en naranja, palabras clave en violeta). Los estados toman el verde, amarillo y rojo del mismo tema, siempre con su palabra o su forma. Donde un color del tema no se lee bien sobre un fondo, se ajusta lo justo; la prueba de contraste mide las 8. Los diagramas conservan su lámina oscura en todas.

### Corregido

- **El diagrama de un módulo vuelve a su resumen:** «Cómo está construido», con su diagrama y su decisión de diseño, solo salía en «Documento» desde que «Construcción» dejó el menú del módulo.
- **Convenciones en archivos nuevos:** un archivo que el agente acaba de crear recibe las convenciones de su carpeta antes de editarlo y se bloquea si las rompe, sin esperar a que llegue a la rama de referencia. `impact` también tiene en cuenta las convenciones ancladas al propio archivo.
- **Rendimiento:** el índice del código se lee una vez por proceso y no en cada consulta; un `laru check` de VaultFlow pasa de 355 ms a 126.

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

[Sin publicar]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.21...HEAD
[0.1.0-beta.21]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.20...v0.1.0-beta.21
[0.1.0-beta.20]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.19...v0.1.0-beta.20
[0.1.0-beta.19]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.18...v0.1.0-beta.19
[0.1.0-beta.18]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.17...v0.1.0-beta.18
[0.1.0-beta.17]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.16...v0.1.0-beta.17
[0.1.0-beta.16]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.15...v0.1.0-beta.16
[0.1.0-beta.15]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.14...v0.1.0-beta.15
[0.1.0-beta.14]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.13...v0.1.0-beta.14
[0.1.0-beta.13]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.12...v0.1.0-beta.13
[0.1.0-beta.12]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.11...v0.1.0-beta.12
[0.1.0-beta.11]: https://github.com/sahernandezz/laru/compare/v0.1.0-beta.10...v0.1.0-beta.11
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
