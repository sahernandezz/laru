/**
 * A variable of a service said for a person: what it is for (the documented purpose of a secret first, then what the
 * common ones mean, then what its name says of its unit), and its value read as a person reads it (86400000 ms is a
 * day). What only this application gives it a meaning for is the documentation's to say.
 */
import { LOCALE, tr } from './i18n.ts';

/** Variables whose meaning is the framework's or the platform's, the same in every application. */
const KNOWN: Array<[RegExp, string]> = [
  [/^SPRING_PROFILES_ACTIVE$/, tr('Los perfiles de Spring activos: además de application.yml, carga el application-<perfil>.yml de cada uno.')],
  [/^QUARKUS_PROFILE$/, tr('El perfil de Quarkus activo (dev, test, prod…), que elige qué parte de su configuración vale.')],
  [/^(?:SPRING_DATASOURCE|QUARKUS_DATASOURCE(?:_JDBC)?)_URL$|^DATABASE_URL$|^DB_URL$/, tr('La dirección de su base de datos.')],
  [/^(?:SPRING_DATASOURCE|QUARKUS_DATASOURCE)_USERNAME$|^DB_USER(?:NAME)?$/, tr('El usuario con el que entra en su base de datos.')],
  [/^(?:SPRING_DATASOURCE|QUARKUS_DATASOURCE)_PASSWORD$|^DB_PASS(?:WORD)?$/, tr('La contraseña con la que entra en su base de datos.')],
  [/^(?:SERVER_)?PORT$|^QUARKUS_HTTP_PORT$/, tr('El puerto en el que escucha.')],
  [/^NODE_ENV$/, tr('El modo de Node.js: development o production.')],
  [/^JAVA_(?:OPTS|TOOL_OPTIONS)$/, tr('Opciones de la JVM: memoria, depuración y propiedades del sistema.')],
  [/^TZ$/, tr('La zona horaria del proceso.')],
  [/^LOG_LEVEL$|^LOGGING_LEVEL_/, tr('Cuánto detalle escriben sus logs.')],
  [/KAFKA_BOOTSTRAP_SERVERS$|^KAFKA_BROKERS$/, tr('Dónde están los brokers de Kafka.')],
  [/^REDIS_(?:URL|HOST)$/, tr('Dónde está Redis.')],
];

/** What a variable is for, by what its name means alone; nothing when its name says nothing a person can rely on. */
export function knownPurpose(name: string): string | undefined {
  const k = KNOWN.find(([re]) => re.test(name))?.[1];
  if (k) return k;
  if (/EXPIR|TTL/.test(name) && unitOf(name)) return tr('Cuánto dura antes de caducar.');
  if (/TIMEOUT/.test(name) && unitOf(name)) return tr('Cuánto espera antes de darse por vencido.');
  return undefined;
}

const UNITS: Array<[RegExp, number, string]> = [[/(?:_MS|_MILLIS|_MILLISECONDS)$/, 1, 'ms'], [/(?:_S|_SEC|_SECS|_SECONDS)$/, 1000, 's'], [/(?:_MIN|_MINS|_MINUTES)$/, 60_000, 'min'], [/(?:_H|_HOURS)$/, 3_600_000, 'h'], [/_DAYS$/, 86_400_000, 'd']];
const unitOf = (name: string) => UNITS.find(([re]) => re.test(name));

/** A length of time in the largest units that say it whole: «1 d», «2 h 30 min», «45 s». */
function duration(ms: number): string {
  const parts: string[] = [];
  for (const [n, u] of [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min'], [1000, 's']] as const) {
    if (ms >= n) { parts.push(`${Math.floor(ms / n)} ${u}`); ms %= n; }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || `${ms} ms`;
}

/** A value as a person reads it: a number with the unit its name says, and that time spelled out. */
export function readValue(name: string, value: string): { value: string; note?: string } {
  const u = unitOf(name);
  if (u && /^\d+$/.test(value.trim())) {
    const n = Number(value), ms = n * u[1];
    return { value: `${n.toLocaleString(LOCALE)} ${u[2]}`, note: ms >= 1000 && u[2] !== duration(ms).split(' ')[1] ? duration(ms) : undefined };
  }
  return { value };
}
