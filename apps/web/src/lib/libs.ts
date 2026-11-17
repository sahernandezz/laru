/**
 * What a library is for, said for a person who reads a service's sheet: the common ones of Java (Spring, Quarkus,
 * drivers, testing) and of JavaScript, by their coordinates. What is not here keeps its name and a link to its registry;
 * why this application needs it is the stack's (its «Dependencias críticas»), never guessed.
 */
import { tr } from './i18n.ts';

export interface LibInfo { name: string; what: string }

/** Spring Boot's starters, by what follows `spring-boot-starter-`. */
const STARTERS: Record<string, LibInfo> = {
  web: { name: 'Spring Web', what: tr('Servidor web y API REST: Spring MVC con un Tomcat dentro.') },
  webflux: { name: 'Spring WebFlux', what: tr('Servidor web reactivo, que atiende sin bloquear hilos (Netty).') },
  security: { name: 'Spring Security', what: tr('Autenticación y autorización: quién entra y qué puede hacer.') },
  'data-jpa': { name: 'Spring Data JPA', what: tr('Acceso a la base de datos relacional con JPA e Hibernate: entidades y repositorios.') },
  'data-jdbc': { name: 'Spring Data JDBC', what: tr('Acceso a la base de datos con SQL y repositorios, sin un ORM completo.') },
  jdbc: { name: 'Spring JDBC', what: tr('Acceso a la base de datos con SQL directo.') },
  'data-redis': { name: 'Spring Data Redis', what: tr('Acceso a Redis: caché y datos en memoria.') },
  'data-mongodb': { name: 'Spring Data MongoDB', what: tr('Acceso a MongoDB: documentos y repositorios.') },
  validation: { name: 'Bean Validation', what: tr('Valida los datos que llegan (@NotNull, @Email, @Size…) antes de usarlos.') },
  actuator: { name: 'Spring Boot Actuator', what: tr('Expone la salud, las métricas y la información del servicio por HTTP (/actuator).') },
  test: { name: 'Spring Boot Test', what: tr('Las pruebas: JUnit 5, Mockito, AssertJ y el arranque de Spring dentro de los tests.') },
  batch: { name: 'Spring Batch', what: tr('Procesos por lotes: trabajos con pasos, reintentos y su historial en la base.') },
  mail: { name: 'Spring Mail', what: tr('Envía correo por SMTP.') },
  amqp: { name: 'Spring AMQP', what: tr('Mensajería con RabbitMQ.') },
  'oauth2-resource-server': { name: 'OAuth2 Resource Server', what: tr('Valida los tokens OAuth2 o JWT de quien llama.') },
  'oauth2-client': { name: 'OAuth2 Client', what: tr('Inicia sesión contra un proveedor OAuth2 u OpenID (Keycloak, Google…).') },
  cache: { name: 'Spring Cache', what: tr('Guarda en caché lo que devuelve un método (@Cacheable).') },
  websocket: { name: 'Spring WebSocket', what: tr('Conexiones WebSocket con el navegador.') },
  thymeleaf: { name: 'Thymeleaf', what: tr('Páginas HTML generadas en el servidor.') },
  aop: { name: 'Spring AOP', what: tr('Lógica que envuelve a otros métodos sin tocarlos: logs, transacciones, permisos.') },
  quartz: { name: 'Quartz', what: tr('Tareas programadas.') },
  graphql: { name: 'Spring GraphQL', what: tr('Una API GraphQL.') },
};

/** Quarkus' extensions, by what follows `quarkus-`. */
const QUARKUS: Record<string, LibInfo> = {
  rest: { name: 'Quarkus REST', what: tr('La API REST del servicio.') },
  'resteasy-reactive': { name: 'RESTEasy Reactive', what: tr('La API REST del servicio.') },
  resteasy: { name: 'RESTEasy', what: tr('La API REST del servicio.') },
  'rest-jackson': { name: 'Quarkus REST Jackson', what: tr('JSON en la API REST, con Jackson.') },
  'resteasy-reactive-jackson': { name: 'RESTEasy Reactive Jackson', what: tr('JSON en la API REST, con Jackson.') },
  'rest-client': { name: 'REST Client', what: tr('Llama a otras API REST con una interfaz Java.') },
  'rest-client-reactive': { name: 'REST Client', what: tr('Llama a otras API REST con una interfaz Java.') },
  'hibernate-orm-panache': { name: 'Hibernate ORM Panache', what: tr('Acceso a la base de datos relacional: entidades y consultas simplificadas.') },
  'hibernate-orm': { name: 'Hibernate ORM', what: tr('Acceso a la base de datos relacional con JPA.') },
  'hibernate-validator': { name: 'Hibernate Validator', what: tr('Valida los datos que llegan (@NotNull, @Email, @Size…) antes de usarlos.') },
  'jdbc-postgresql': { name: 'JDBC PostgreSQL', what: tr('El driver con el que el servicio habla con PostgreSQL.') },
  'jdbc-mysql': { name: 'JDBC MySQL', what: tr('El driver con el que el servicio habla con MySQL.') },
  'jdbc-oracle': { name: 'JDBC Oracle', what: tr('El driver con el que el servicio habla con Oracle.') },
  'smallrye-openapi': { name: 'SmallRye OpenAPI', what: tr('Publica la documentación OpenAPI de la API, con Swagger UI.') },
  'smallrye-health': { name: 'SmallRye Health', what: tr('Expone si el servicio está vivo y listo (/q/health).') },
  'smallrye-jwt': { name: 'SmallRye JWT', what: tr('Valida y genera JWT.') },
  oidc: { name: 'OpenID Connect', what: tr('Inicio de sesión y validación de tokens con OpenID Connect (Keycloak…).') },
  arc: { name: 'ArC', what: tr('La inyección de dependencias de Quarkus (CDI).') },
  junit5: { name: 'Quarkus JUnit 5', what: tr('Las pruebas, con Quarkus arrancado dentro.') },
  'junit5-mockito': { name: 'Quarkus Mockito', what: tr('Dobles de prueba de los beans de Quarkus.') },
  'kafka-client': { name: 'Kafka Client', what: tr('Cliente de Kafka.') },
  'messaging-kafka': { name: 'Messaging Kafka', what: tr('Publica y consume mensajes de Kafka.') },
  'smallrye-reactive-messaging-kafka': { name: 'Reactive Messaging Kafka', what: tr('Publica y consume mensajes de Kafka.') },
  scheduler: { name: 'Scheduler', what: tr('Tareas programadas.') },
  cache: { name: 'Quarkus Cache', what: tr('Guarda en caché lo que devuelve un método.') },
  'micrometer-registry-prometheus': { name: 'Micrometer Prometheus', what: tr('Expone las métricas del servicio para Prometheus.') },
  micrometer: { name: 'Micrometer', what: tr('Las métricas del servicio.') },
  'container-image-docker': { name: 'Container Image Docker', what: tr('Construye la imagen Docker del servicio.') },
};

/** Libraries by `group:artifact` (Maven) or package name (npm); a trailing `*` takes every artifact of that group or scope. */
const KNOWN: Record<string, LibInfo> = {
  'org.springframework.kafka:spring-kafka': { name: 'Spring Kafka', what: tr('Publica y consume mensajes de Kafka.') },
  'org.springframework.security:spring-security-test': { name: 'Spring Security Test', what: tr('Pruebas con usuarios y roles simulados (@WithMockUser).') },
  'org.springframework.cloud:spring-cloud-starter-gateway': { name: 'Spring Cloud Gateway', what: tr('Pasarela que enruta cada petición al servicio que toca.') },
  'org.springframework.cloud:spring-cloud-starter-openfeign': { name: 'OpenFeign', what: tr('Llama a otras API REST con una interfaz Java.') },
  'org.postgresql:postgresql': { name: 'PostgreSQL JDBC', what: tr('El driver con el que el servicio habla con PostgreSQL.') },
  'com.mysql:mysql-connector-j': { name: 'MySQL Connector/J', what: tr('El driver con el que el servicio habla con MySQL.') },
  'mysql:mysql-connector-java': { name: 'MySQL Connector/J', what: tr('El driver con el que el servicio habla con MySQL.') },
  'org.mariadb.jdbc:mariadb-java-client': { name: 'MariaDB Connector/J', what: tr('El driver con el que el servicio habla con MariaDB.') },
  'com.microsoft.sqlserver:mssql-jdbc': { name: 'SQL Server JDBC', what: tr('El driver con el que el servicio habla con SQL Server.') },
  'com.oracle.database.jdbc:*': { name: 'Oracle JDBC', what: tr('El driver con el que el servicio habla con Oracle.') },
  'com.h2database:h2': { name: 'H2', what: tr('Una base de datos en memoria: las pruebas corren sin una base real.') },
  'org.flywaydb:*': { name: 'Flyway', what: tr('Migraciones de la base de datos: cambios de esquema versionados en SQL.') },
  'org.liquibase:liquibase-core': { name: 'Liquibase', what: tr('Migraciones de la base de datos: cambios de esquema versionados.') },
  'org.projectlombok:lombok': { name: 'Lombok', what: tr('Escribe al compilar el código repetitivo de Java: getters, constructores, builders.') },
  'org.mapstruct:*': { name: 'MapStruct', what: tr('Genera al compilar el código que copia datos entre objetos (de entidad a DTO y de vuelta).') },
  'io.jsonwebtoken:jjwt-api': { name: 'JJWT', what: tr('Crea y valida JWT: la parte que usa el código.') },
  'io.jsonwebtoken:jjwt-impl': { name: 'JJWT impl', what: tr('La implementación de JJWT, que su API carga al arrancar.') },
  'io.jsonwebtoken:jjwt-jackson': { name: 'JJWT Jackson', what: tr('Lee y escribe con Jackson el JSON de dentro de cada JWT.') },
  'com.auth0:java-jwt': { name: 'java-jwt', what: tr('Crea y valida JWT.') },
  'com.fasterxml.jackson.core:*': { name: 'Jackson', what: tr('Convierte objetos Java en JSON y de vuelta.') },
  'com.fasterxml.jackson.datatype:*': { name: 'Jackson', what: tr('Enseña a Jackson tipos que no trae, como las fechas de java.time.') },
  'io.minio:minio': { name: 'MinIO Java SDK', what: tr('Cliente de MinIO o S3: sube, lee y borra ficheros en un almacenamiento de objetos.') },
  'software.amazon.awssdk:*': { name: 'AWS SDK', what: tr('Cliente de los servicios de AWS.') },
  'com.amazonaws:*': { name: 'AWS SDK', what: tr('Cliente de los servicios de AWS.') },
  'org.apache.kafka:kafka-clients': { name: 'Kafka Clients', what: tr('Cliente de Kafka.') },
  'org.testcontainers:*': { name: 'Testcontainers', what: tr('Arranca contenedores Docker reales (bases, colas) para las pruebas.') },
  'org.junit.jupiter:*': { name: 'JUnit 5', what: tr('El marco de pruebas de Java.') },
  'junit:junit': { name: 'JUnit 4', what: tr('El marco de pruebas de Java, en su versión anterior.') },
  'org.mockito:*': { name: 'Mockito', what: tr('Dobles de prueba: simula las dependencias de una clase.') },
  'org.assertj:assertj-core': { name: 'AssertJ', what: tr('Comprobaciones legibles en las pruebas.') },
  'io.rest-assured:*': { name: 'REST Assured', what: tr('Pruebas de una API REST por HTTP.') },
  'org.wiremock:*': { name: 'WireMock', what: tr('Simula otras API por HTTP en las pruebas.') },
  'com.github.tomakehurst:*': { name: 'WireMock', what: tr('Simula otras API por HTTP en las pruebas.') },
  'org.springdoc:*': { name: 'springdoc-openapi', what: tr('Publica la documentación OpenAPI de la API, con Swagger UI.') },
  'io.micrometer:*': { name: 'Micrometer', what: tr('Las métricas del servicio.') },
  'net.logstash.logback:logstash-logback-encoder': { name: 'Logstash encoder', what: tr('Escribe los logs en JSON.') },
  'org.apache.commons:commons-lang3': { name: 'Commons Lang', what: tr('Utilidades para textos, números y objetos.') },
  'commons-io:commons-io': { name: 'Commons IO', what: tr('Utilidades para ficheros y flujos de datos.') },
  'com.google.guava:guava': { name: 'Guava', what: tr('Utilidades de Google: colecciones, cachés y textos.') },
  'net.lingala.zip4j:zip4j': { name: 'zip4j', what: tr('Crea y abre ficheros ZIP, también cifrados.') },
  'com.itextpdf:*': { name: 'iText', what: tr('Genera documentos PDF.') },
  'org.apache.pdfbox:pdfbox': { name: 'PDFBox', what: tr('Lee y genera documentos PDF.') },
  'org.apache.poi:*': { name: 'Apache POI', what: tr('Lee y genera ficheros de Office (Excel, Word).') },
  'org.mindrot:jbcrypt': { name: 'jBCrypt', what: tr('Guarda las contraseñas cifradas con bcrypt.') },
  react: { name: 'React', what: tr('La librería de la interfaz: componentes que se pintan en el navegador.') },
  'react-dom': { name: 'React DOM', what: tr('Pinta los componentes de React en la página.') },
  'react-router-dom': { name: 'React Router', what: tr('Las rutas del front: qué pantalla corresponde a cada dirección.') },
  next: { name: 'Next.js', what: tr('Marco de React con servidor: páginas, rutas y renderizado en el servidor.') },
  vue: { name: 'Vue', what: tr('El marco de la interfaz: componentes que se pintan en el navegador.') },
  nuxt: { name: 'Nuxt', what: tr('Marco de Vue con servidor: páginas, rutas y renderizado en el servidor.') },
  svelte: { name: 'Svelte', what: tr('El marco de la interfaz, que compila los componentes a JavaScript.') },
  '@angular/core': { name: 'Angular', what: tr('El marco del front: componentes, inyección de dependencias y detección de cambios.') },
  '@angular/common': { name: 'Angular Common', what: tr('Lo común de Angular, incluido su cliente HTTP.') },
  '@angular/router': { name: 'Angular Router', what: tr('Las rutas del front: qué pantalla corresponde a cada dirección.') },
  '@angular/forms': { name: 'Angular Forms', what: tr('Los formularios y su validación.') },
  '@angular/cli': { name: 'Angular CLI', what: tr('La herramienta que crea, sirve y construye el proyecto.') },
  '@angular/*': { name: 'Angular', what: tr('Una parte de Angular.') },
  express: { name: 'Express', what: tr('Servidor web y API en Node.js.') },
  fastify: { name: 'Fastify', what: tr('Servidor web y API en Node.js.') },
  koa: { name: 'Koa', what: tr('Servidor web y API en Node.js.') },
  '@nestjs/core': { name: 'NestJS', what: tr('Marco de servidor en Node.js: módulos, controladores e inyección de dependencias.') },
  '@nestjs/*': { name: 'NestJS', what: tr('Una parte de NestJS.') },
  axios: { name: 'Axios', what: tr('Cliente HTTP para llamar a otras API.') },
  rxjs: { name: 'RxJS', what: tr('Flujos de eventos (Observables): respuestas HTTP, cambios y temporizadores.') },
  'zone.js': { name: 'Zone.js', what: tr('Avisa a Angular de cuándo repintar la interfaz.') },
  typescript: { name: 'TypeScript', what: tr('JavaScript con tipos, comprobados antes de ejecutar.') },
  vite: { name: 'Vite', what: tr('Servidor de desarrollo y empaquetado del front.') },
  webpack: { name: 'webpack', what: tr('Empaqueta el código del front.') },
  jest: { name: 'Jest', what: tr('El marco de pruebas de JavaScript.') },
  vitest: { name: 'Vitest', what: tr('El marco de pruebas de JavaScript, sobre Vite.') },
  '@playwright/test': { name: 'Playwright', what: tr('Pruebas de punta a punta en un navegador de verdad.') },
  cypress: { name: 'Cypress', what: tr('Pruebas de punta a punta en un navegador de verdad.') },
  jsdom: { name: 'jsdom', what: tr('Un navegador simulado en Node, para probar el front sin abrir uno.') },
  '@testing-library/*': { name: 'Testing Library', what: tr('Pruebas de la interfaz como la usa una persona: por textos y roles.') },
  eslint: { name: 'ESLint', what: tr('Revisa el código en busca de errores y de estilo.') },
  prettier: { name: 'Prettier', what: tr('Da formato al código.') },
  tailwindcss: { name: 'Tailwind CSS', what: tr('Estilos con clases utilitarias en el propio HTML.') },
  '@tailwindcss/*': { name: 'Tailwind CSS', what: tr('Una parte de Tailwind CSS.') },
  postcss: { name: 'PostCSS', what: tr('Transforma el CSS al construir (lo usa Tailwind).') },
  zod: { name: 'Zod', what: tr('Valida datos con esquemas.') },
  lodash: { name: 'Lodash', what: tr('Utilidades para listas, objetos y textos.') },
  dayjs: { name: 'Day.js', what: tr('Fechas y horas.') },
  'date-fns': { name: 'date-fns', what: tr('Fechas y horas.') },
  moment: { name: 'Moment.js', what: tr('Fechas y horas.') },
  jsonwebtoken: { name: 'jsonwebtoken', what: tr('Crea y valida JWT.') },
  bcrypt: { name: 'bcrypt', what: tr('Guarda las contraseñas cifradas con bcrypt.') },
  bcryptjs: { name: 'bcrypt.js', what: tr('Guarda las contraseñas cifradas con bcrypt.') },
  dotenv: { name: 'dotenv', what: tr('Carga las variables de entorno de un fichero .env.') },
  cors: { name: 'cors', what: tr('Deja que la API reciba llamadas de otros orígenes (CORS).') },
  helmet: { name: 'Helmet', what: tr('Añade las cabeceras HTTP de seguridad.') },
  pg: { name: 'node-postgres', what: tr('Cliente de PostgreSQL.') },
  mysql2: { name: 'MySQL2', what: tr('Cliente de MySQL.') },
  mongoose: { name: 'Mongoose', what: tr('MongoDB con modelos y validación.') },
  prisma: { name: 'Prisma', what: tr('Acceso a la base de datos con tipos, y sus migraciones.') },
  '@prisma/client': { name: 'Prisma Client', what: tr('Acceso a la base de datos con tipos.') },
  typeorm: { name: 'TypeORM', what: tr('Acceso a la base de datos con entidades.') },
  sequelize: { name: 'Sequelize', what: tr('Acceso a la base de datos con modelos.') },
  ioredis: { name: 'ioredis', what: tr('Cliente de Redis.') },
  redis: { name: 'node-redis', what: tr('Cliente de Redis.') },
  kafkajs: { name: 'KafkaJS', what: tr('Cliente de Kafka.') },
  'socket.io': { name: 'Socket.IO', what: tr('Comunicación en tiempo real con el navegador.') },
  'socket.io-client': { name: 'Socket.IO', what: tr('Comunicación en tiempo real con el servidor.') },
  multer: { name: 'Multer', what: tr('Recibe los ficheros que se suben (multipart).') },
  winston: { name: 'winston', what: tr('Escribe los logs.') },
  pino: { name: 'pino', what: tr('Escribe los logs en JSON.') },
};

/** What a library is, by its coordinates; nothing for one Laru does not know. */
export function libInfo(coords: string): LibInfo | undefined {
  const starter = coords.match(/^org\.springframework\.boot:spring-boot-starter(?:-(.+))?$/);
  if (starter) return STARTERS[starter[1] ?? ''] ?? (starter[1] ? { name: `Spring Boot ${starter[1]}`, what: tr('Un módulo de Spring Boot ya configurado.') } : { name: 'Spring Boot', what: tr('El núcleo de Spring Boot: arranque, configuración y logs.') });
  const quarkus = coords.match(/^io\.quarkus:quarkus-(.+)$/);
  if (quarkus) return QUARKUS[quarkus[1]] ?? { name: `Quarkus ${quarkus[1]}`, what: tr('Una extensión de Quarkus.') };
  const scope = coords.includes(':') ? coords.slice(0, coords.indexOf(':')) : coords.match(/^(@[^/]+)\//)?.[1];
  return KNOWN[coords] ?? (scope ? KNOWN[`${scope}:*`] ?? KNOWN[`${scope}/*`] : undefined);
}

/** Where a person reads about it: Maven Central or npm. */
export const registryOf = (coords: string, ecosystem?: string): { url: string; label: string } =>
  ecosystem === 'npm' || !coords.includes(':')
    ? { url: `https://www.npmjs.com/package/${coords}`, label: 'npm' }
    : { url: `https://central.sonatype.com/artifact/${coords.replace(':', '/')}`, label: 'Maven Central' };

/** The parents and BOMs that fix a version, by a name a person knows. */
export const managedName = (by: string) => by
  .replace(/^spring-boot-(?:starter-parent|dependencies)\b/, 'Spring Boot')
  .replace(/^quarkus-(?:universe-)?bom\b/, 'Quarkus')
  .replace(/^spring-cloud-dependencies\b/, 'Spring Cloud');
