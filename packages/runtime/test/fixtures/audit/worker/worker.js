// audit-worker: every scan verdict VaultFlow publishes becomes an entry.
const { Pool } = require('pg');
const { Kafka, logLevel } = require('kafkajs');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
db.on('error', () => {});
const kafka = new Kafka({ clientId: 'audit-worker', brokers: (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(','), logLevel: logLevel.WARN, retry: { retries: 50 } });
const consumer = kafka.consumer({ groupId: 'audit-worker' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (;;) { try { await db.query('create table if not exists entries (file_id text primary key, name text, status text, at timestamptz default now())'); break; } catch { await sleep(1000); } }
  // VaultFlow's file-service creates its topics when it starts: wait for them rather than create them with other settings
  const admin = kafka.admin();
  await admin.connect();
  for (let t = await admin.listTopics(); !t.includes('file.clean') || !t.includes('file.infected'); t = await admin.listTopics()) await sleep(2000);
  await admin.disconnect();
  await consumer.connect();
  await consumer.subscribe({ topic: 'file.clean', fromBeginning: true });
  await consumer.subscribe({ topic: 'file.infected', fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const e = JSON.parse(String(message.value));
      await db.query('insert into entries (file_id, name, status) values ($1, $2, $3) on conflict (file_id) do update set status = excluded.status', [String(e.fileId), e.originalName, e.status]);
    },
  });
})().catch((e) => { console.error(e); process.exit(1); });
