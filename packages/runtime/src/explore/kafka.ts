/**
 * A Kafka broker of an env, through its own tools inside its own container (apache, bitnami and confluent images
 * keep them in different places). Topics with their partitions and end offsets, consumer groups with their lag,
 * recent messages read from the broker's log segments (masked), and a publish that goes through stdin.
 */
import type { Workspace } from '@laru/core';
import { parseKafkaDump, type KafkaLine, type Masker } from '@laru/trace';
import { docker, DockerError, inspectEnv, LABEL } from '../docker.ts';
import { envMasker } from '../env.ts';

const HEAP = ['-e', 'KAFKA_HEAP_OPTS=-Xmx96m'];
/** The tool, wherever this image keeps it. */
const tool = (name: string) => `t=$(command -v ${name}.sh || command -v ${name} || ls /opt/kafka/bin/${name}.sh /opt/bitnami/kafka/bin/${name}.sh 2>/dev/null | head -1); exec "$t"`;

export interface Broker { service: string; container: string; image: string }
export async function brokerOf(ws: Workspace, env: string): Promise<Broker> {
  const c = (await inspectEnv(ws, env)).find((x) => x.state === 'running' && !x.labels[LABEL.run] && /kafka|redpanda/.test(x.image));
  if (!c) throw new Error(`${env} has no running Kafka`);
  return { service: c.service, container: c.id, image: c.image };
}

const run = (b: Broker, script: string, input?: string) => docker(['exec', ...(input !== undefined ? ['-i'] : []), ...HEAP, b.container, 'sh', '-c', script], { input, timeoutMs: 60_000 });

export interface Topic { name: string; partitions: Array<{ partition: number; end: number }>; messages: number }
export interface GroupLag { group: string; topic: string; partition: number; current: number | null; end: number; lag: number | null; consumer?: string; host?: string }

/** The topics, internal ones left out; a broker without any has none (its tool says so as an error). */
export async function topics(b: Broker): Promise<Topic[]> {
  let out: string;
  try { out = await run(b, `${tool('kafka-get-offsets')} --bootstrap-server localhost:9092`); }
  catch (e) { if (e instanceof DockerError && /Could not match any topic-partitions/.test(e.stderr)) return []; throw e; }
  const by = new Map<string, Topic>();
  for (const l of out.split('\n')) {
    const m = /^(.+):(\d+):(\d+)$/.exec(l.trim());
    if (!m || m[1].startsWith('__')) continue;
    const t = by.get(m[1]) ?? { name: m[1], partitions: [], messages: 0 };
    t.partitions.push({ partition: Number(m[2]), end: Number(m[3]) });
    t.messages += Number(m[3]);
    by.set(m[1], t);
  }
  for (const t of by.values()) t.partitions.sort((x, y) => x.partition - y.partition);
  return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export async function groups(b: Broker): Promise<GroupLag[]> {
  const out = await run(b, `${tool('kafka-consumer-groups')} --bootstrap-server localhost:9092 --describe --all-groups 2>/dev/null`);
  const rows: GroupLag[] = [];
  for (const l of out.split('\n')) {
    const c = l.trim().split(/\s+/);
    if (c.length < 6 || c[0] === 'GROUP' || !/^\d+$/.test(c[2])) continue;
    const num = (x: string) => (x === '-' ? null : Number(x));
    rows.push({ group: c[0], topic: c[1], partition: Number(c[2]), current: num(c[3]), end: Number(c[4]), lag: num(c[5]), consumer: c[6] === '-' ? undefined : c[6], host: c[7]?.replace(/^\//, '') });
  }
  return rows;
}

/** The last `n` messages of a topic, across partitions, newest first. */
export async function peek(ws: Workspace, env: string, b: Broker, topic: string, n = 20, m: Masker = envMasker(ws, env)): Promise<KafkaLine[]> {
  if (!/^[\w.-]+$/.test(topic)) throw new Error('a topic name is letters, digits, . _ -');
  const files = (await run(b, `for d in \${KAFKA_LOG_DIRS:-/tmp/kafka-logs} /var/lib/kafka/data /bitnami/kafka/data; do ls -d "$d"/${topic}-*/*.log 2>/dev/null; done; true`)).split('\n').filter(Boolean);
  if (!files.length) return [];
  const out = await run(b, `${tool('kafka-dump-log')} --print-data-log --files ${files.map((f) => `'${f}'`).join(',')}`);
  const msgs: KafkaLine[] = [];
  for (const section of out.split(/^Dumping /m).slice(1)) {
    const p = /-(\d+)\/[^/]+\.log$/.exec(section.slice(0, section.indexOf('\n')));
    if (p) msgs.push(...parseKafkaDump(section, b.service, topic, Number(p[1])));
  }
  return msgs.sort((x, y) => y.t - x.t).slice(0, n).map((k) => ({ ...k, key: k.key && m.text(k.key), value: k.value && m.body(k.value, 'application/json') }));
}

/** Publishes one message (key optional) through the console producer, the value on stdin. */
export async function publish(b: Broker, topic: string, value: string, key?: string): Promise<void> {
  if (!/^[\w.-]+$/.test(topic)) throw new Error('a topic name is letters, digits, . _ -');
  if (/[\r\n]/.test(value) || (key && /[\t\r\n]/.test(key))) throw new Error('one line per message; tabs are not allowed in the key');
  await run(b, `${tool('kafka-console-producer')} --bootstrap-server localhost:9092 --topic ${topic}${key !== undefined ? " --property parse.key=true --property 'key.separator=\t'" : ''} 2>&1`, `${key !== undefined ? `${key}\t` : ''}${value}\n`);
}
