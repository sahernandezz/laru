# Seguridad

## Cómo avisar de una vulnerabilidad

No la publiques en un issue. Repórtala en privado desde la pestaña **Security → Report a vulnerability**
de este repositorio. Respondemos en un plazo de 7 días y, cuando la corrección esté publicada,
te damos crédito en el CHANGELOG si quieres.

## Versiones con soporte

Mientras Laru esté en beta, solo la última versión publicada recibe correcciones de seguridad.

## Qué protege Laru y qué no

Laru corre en tu máquina y trabaja con el código de tus aplicativos. Estas son las garantías que da y
lo que da por hecho.

### El servicio local

- **Solo tu máquina:** escucha únicamente en `127.0.0.1` y solo acepta las cabeceras `Host` `localhost` y `127.0.0.1`, lo que corta los ataques de DNS rebinding.
- **Solo su propia página:** rechaza las peticiones que hace otra página (Fetch Metadata), los `POST` que no son JSON y que lo incrusten en otra web (`frame-ancestors`, `X-Frame-Options`).
- **Máquinas con varios usuarios:** sin `--token`, cualquier programa de tu propia cuenta puede llamar a su API. En una máquina en la que inician sesión otras personas, arráncalo con `laru serve --token`. El token se guarda en `~/.laru/daemon.json` con permisos `0600`.

### Secretos

- **Cifrado:** los secretos del workspace se cifran con AES‑256‑GCM. La clave vive en el llavero del sistema (Keychain en macOS, Secret Service en Linux), nunca en el workspace.
- **Enmascarado:** los valores secretos se enmascaran en las trazas, los logs, los resultados SQL y los cuerpos que muestra la interfaz.
- **Correo y SMS:** los que envía un entorno se quedan en ese entorno; no salen de tu máquina.

### Lo que Laru ejecuta

- **Código de tus proyectos:** `laru up` construye y arranca los servicios con los `Dockerfile` y `docker-compose` de tus proyectos, y `laru test` ejecuta sus flujos (Playwright). **Eso es ejecutar el código de esos repositorios**: añade solo proyectos en los que confías, igual que harías al clonarlos y ejecutarlos a mano.
- **El `laru.yaml` del workspace:** se comparte con el equipo, así que se valida al leerlo. Una URL o una rama que `git` interpretaría como una opción o como un programa se rechaza, y `git clone` recibe la URL siempre después de `--`.
- **Imágenes propias:** las imágenes de Laru (la del tap que ve el tráfico y la base del runner) están fijadas por digest.

### Agentes de IA

- **Qué se le da al agente:** el servidor MCP le da contexto y herramientas sobre tus entornos locales. Ninguna herramienta revela el valor de un secreto, los resultados van enmascarados y las acciones destructivas piden confirmación explícita.
- **Inyección de instrucciones:** el agente lee contenido de tus repositorios, de tu documentación y de las trazas. Un texto malicioso en ellos puede intentar darle instrucciones. Revisa lo que el agente propone antes de aprobarlo, como con cualquier agente.

### Dependencias

- **Pocas y fijadas:** las dependencias directas son pocas y van con versión fijada en `pnpm-lock.yaml`.
- **Vulnerabilidades conocidas:** las transitivas con avisos de seguridad se fuerzan a versiones corregidas (`overrides` en `pnpm-workspace.yaml`). `pnpm audit` debe salir limpio antes de cada versión.
