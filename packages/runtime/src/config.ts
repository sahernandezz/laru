/**
 * `~/.laru/config.yaml`: this machine's knobs. One reader for everyone, and a writer that keeps the file's comments
 * and every key it does not change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { laruHome } from '@laru/core';

/** Applied per workspace: videos and screenshots older than videoDays go, then runs older than runDays, then the oldest until under maxGB. */
export interface Retention { videoDays: number; runDays: number; maxGB: number }
export interface MachineConfig {
  /** how many persistent envs may run at once on this machine */
  maxEnvs: number;
  /** the video clock against the trace clock, measured by `laru calibrate` */
  videoOffsetMs: number;
  retention: Retention;
  /** runners that play a run's flows at once; 0: as many as Docker's memory leaves room for, at most 3 */
  workers: number;
  /** how long a recorded story holds the screen still at the end of each step, so its video can be followed */
  stepHoldMs: number;
}

export const CONFIG_DEFAULTS: MachineConfig = { maxEnvs: 1, videoOffsetMs: 0, retention: { videoDays: 7, runDays: 30, maxGB: 5 }, workers: 0, stepHoldMs: 0 };
const file = () => join(laruHome(), 'config.yaml');
const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : dflt);

export function readConfig(): MachineConfig {
  const raw = (existsSync(file()) ? parseDocument(readFileSync(file(), 'utf8')).toJS() : null) as Record<string, any> | null;
  const r = raw?.retention ?? {}, d = CONFIG_DEFAULTS;
  return {
    maxEnvs: num(raw?.maxEnvs, d.maxEnvs), videoOffsetMs: num(raw?.videoOffsetMs, d.videoOffsetMs), workers: num(raw?.workers, d.workers), stepHoldMs: Math.max(0, num(raw?.stepHoldMs, d.stepHoldMs)),
    retention: { videoDays: num(r.videoDays, d.retention.videoDays), runDays: num(r.runDays, d.retention.runDays), maxGB: num(r.maxGB, d.retention.maxGB) },
  };
}

/** Sets the keys given; comments and the rest of the file stay as they were. */
export function writeConfig(patch: { maxEnvs?: number; videoOffsetMs?: number; retention?: Partial<Retention> }): MachineConfig {
  const doc = existsSync(file()) ? parseDocument(readFileSync(file(), 'utf8')) : new Document({});
  if (!doc.contents) doc.contents = doc.createNode({});
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'retention') { for (const [rk, rv] of Object.entries(v as Partial<Retention>)) if (rv !== undefined) doc.setIn(['retention', rk], rv); }
    else doc.set(k, v);
  }
  mkdirSync(laruHome(), { recursive: true });
  writeFileSync(file(), doc.toString());
  return readConfig();
}
