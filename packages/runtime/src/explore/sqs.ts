/**
 * An SQS-compatible queue service of an env (ElasticMQ, or LocalStack's SQS), read through the entrance Laru already
 * publishes for its HTTP port. Read only: queues with what is waiting, in flight and delayed, and a look at the messages
 * that asks the service to keep them visible (a receive that hides nothing, deletes nothing and sends nothing). Never a
 * send, a purge or a delete.
 */
import { request } from 'node:http';
import type { Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { inspectEnv, LABEL } from '../docker.ts';
import { envMasker } from '../env.ts';
import { status } from '../up.ts';

/** Where the service listens from here: the entrance's port, and the name it routes that port by. */
export interface Sqs { service: string; port: number; host: string }
export interface SqsQueue { name: string; url: string; visible: number; inFlight: number; delayed: number; createdAt?: string; deadLetter?: string }
export interface SqsMessage { id: string; body: string; sentAt?: string; receiveCount?: number; attributes: Record<string, string> }

export async function sqsOf(ws: Workspace, env: string): Promise<Sqs> {
  const c = (await inspectEnv(ws, env)).find((x) => x.state === 'running' && !x.labels[LABEL.run] && /elasticmq|localstack|sqs/i.test(x.image));
  if (!c) throw new Error(`${env} has no running SQS (ElasticMQ or LocalStack)`);
  const a = (await status(ws, env)).addresses.find((x) => x.service === c.service && x.kind === 'http');
  const m = a && /^http:\/\/([^:/]+):(\d+)/.exec(a.url);
  if (!m) throw new Error(`${c.service} has no address on the entrance`);
  return { service: c.service, host: m[1], port: Number(m[2]) };
}

const esc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const one = (xml: string, tag: string) => tags(xml, tag)[0];

/** One SQS Query-API call: a form POST to the queue's own path, answered as XML. The only actions this file ever sends are the three below. */
function call(s: Sqs, path: string, params: Record<string, string>): Promise<string> {
  const action = params.Action;
  if (!['ListQueues', 'GetQueueAttributes', 'ReceiveMessage'].includes(action)) throw new Error(`${action} is not a read`);
  const body = new URLSearchParams({ ...params, Version: '2012-11-05' }).toString();
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: s.port, path, method: 'POST', headers: { host: s.host, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) return fail(new Error(esc(one(text, 'Message') ?? `SQS answered ${res.statusCode}`)));
        ok(text);
      });
    });
    r.on('timeout', () => r.destroy(new Error('SQS did not answer')));
    r.on('error', fail);
    r.end(body);
  });
}
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return '/'; } };
const attrs = (xml: string) => Object.fromEntries(tags(xml, 'Attribute').map((a) => [one(a, 'Name') ?? '', esc(one(a, 'Value') ?? '')]));
const stamp = (v?: string) => (v && /^\d+$/.test(v) ? new Date(Number(v) * (v.length > 11 ? 1 : 1000)).toISOString() : undefined);

/** The queues with their counts, by name. */
export async function queues(s: Sqs): Promise<SqsQueue[]> {
  const urls = tags(await call(s, '/', { Action: 'ListQueues' }), 'QueueUrl').map(esc);
  const out = await Promise.all(urls.map(async (url): Promise<SqsQueue> => {
    const a = attrs(await call(s, pathOf(url), { Action: 'GetQueueAttributes', 'AttributeName.1': 'All' }));
    const dlq = /"deadLetterTargetArn"\s*:\s*"([^"]+)"/.exec(a.RedrivePolicy ?? '')?.[1];
    return { name: url.split('/').pop() ?? url, url, visible: Number(a.ApproximateNumberOfMessages ?? 0), inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0), delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0), createdAt: stamp(a.CreatedTimestamp), deadLetter: dlq?.split(':').pop() };
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Up to `n` (at most 10, what one receive gives) messages of a queue, masked, without hiding them from anyone. */
export async function peek(ws: Workspace, env: string, s: Sqs, queue: string, n = 10, m: Masker = envMasker(ws, env)): Promise<SqsMessage[]> {
  const q = (await queues(s)).find((x) => x.name === queue);
  if (!q) throw new Error(`no queue ${queue}`);
  const xml = await call(s, pathOf(q.url), { Action: 'ReceiveMessage', MaxNumberOfMessages: String(Math.min(10, Math.max(1, n))), VisibilityTimeout: '0', WaitTimeSeconds: '0', 'AttributeName.1': 'All' });
  return tags(xml, 'Message').map((x) => {
    const a = attrs(x);
    return { id: esc(one(x, 'MessageId') ?? ''), body: m.body(esc(one(x, 'Body') ?? ''), 'application/json'), sentAt: stamp(a.SentTimestamp), receiveCount: a.ApproximateReceiveCount ? Number(a.ApproximateReceiveCount) : undefined, attributes: a };
  });
}
