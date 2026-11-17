/**
 * An env by URL (`url:` in envs/<env>.yaml): the app already running at an address — yours on localhost, a QA, a
 * public site — which Laru never runs or changes. Nothing of Laru stands between the browser and it, so the browser is
 * its tap: what the session's browser or a runner's browser saw of each request (a hit) becomes a record of the env's
 * journal, masked as the tap masks, where everything else reads traffic from (capture, the evidence, the observer).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Workspace } from '@laru/core';
import { writeMaskFile, type BrowserHit, type Masker } from '@laru/trace';
import { LOG_ROTATE, openJournal, TEE, TEXTUAL } from '../tap/tap.ts';
import { readConfig } from './config.ts';
import { envDir, envMasker } from './env.ts';
import type { TrafficRecord } from './types.ts';

/** The env's tap folder, as a tap would leave it: its mask file says this machine's choice (masking is off unless `mask: true`); there are no secrets of a vault to know. */
export function urlTap(ws: Workspace, env: string): string {
  const dir = join(envDir(ws, env), 'tap');
  mkdirSync(dir, { recursive: true });
  writeMaskFile(join(dir, 'mask.json'), [], readConfig().mask);
  return dir;
}

/** A body as the tap records it: a textual one's first 64 KB, masked; any other only counted. */
function bodyOf(b64: string | undefined, bytes: number, ct: string, m: Masker): NonNullable<TrafficRecord['req']> {
  if (!bytes) return { bytes };
  if (b64 === undefined || !TEXTUAL.test(ct)) return { bytes, note: `${ct || 'no content-type'}: not recorded` };
  const head = Buffer.from(b64, 'base64').subarray(0, TEE + m.margin);
  const text = new StringDecoder('utf8').write(head);
  return bytes > head.length ? { bytes, text: m.cut(text, 'end', (t) => m.body(t, ct)), note: 'first 64 KB' } : { bytes, text: m.body(text, ct) };
}

/** A hit as the tap's record of it: `from` is who the tap would have seen (the session's browser on this Mac, or a runner). */
export function hitRecord(h: BrowserHit, from: string, m: Masker): TrafficRecord {
  const u = new URL(h.url);
  return {
    v: 1, id: randomUUID(), kind: 'http', t0: h.t0, t1: h.t1, from, ...(h.screen ? { screen: h.screen } : {}),
    svc: u.host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), method: h.method,
    path: m.text(u.pathname), query: u.search ? m.query(u.search.slice(1)) : undefined,
    ...(h.status !== undefined ? { status: h.status } : {}), reqHeaders: m.headers(h.reqHeaders), ...(h.resHeaders ? { resHeaders: m.headers(h.resHeaders) } : {}),
    req: bodyOf(h.req, h.reqBytes, h.reqHeaders['content-type'] ?? '', m),
    ...(h.resBytes !== undefined ? { res: bodyOf(h.res, h.resBytes, h.resHeaders?.['content-type'] ?? '', m) } : {}),
    ...(h.error ? { error: m.text(h.error) } : {}),
  };
}

/** A line of the browser's log in console.jsonl: `t0` as in the traffic journal, so one reader reads both from their recent end; its level as the console said it. */
export interface BrowserLogLine { t0: number; service: string; line: string; level?: 'error' | 'warn' | 'debug' | 'info' }

/**
 * The env's journals, open to append to (rotated as a tap's): the hits in traffic.jsonl, and in console.jsonl what the
 * page said in its console and the errors it threw, as the log of `service` (`browser`, or `browser:<screen>`). `close` when done.
 */
export function urlJournal(ws: Workspace, env: string) {
  const dir = urlTap(ws, env);
  const m = envMasker(ws, env);
  const report = (msg: string) => console.error(`laru: ${msg}`);
  const traffic = openJournal(join(dir, 'traffic.jsonl'), report), logs = openJournal(join(dir, 'console.jsonl'), report, LOG_ROTATE);
  return {
    add: (h: BrowserHit, from: string) => traffic.write(hitRecord(h, from, m)),
    log: (l: BrowserLogLine) => logs.write(JSON.stringify({ t0: l.t0, service: l.service, line: m.text(l.line).slice(0, 4000), ...(l.level ? { level: l.level } : {}) } satisfies BrowserLogLine)),
    close: () => Promise.all([traffic.close(), logs.close()]),
  };
}
