/**
 * What the documentation says about each topic against what the code does and what the runs saw: the contracts' events
 * (a topic, who publishes or consumes it, what it carries), the map's publishers and consumers, and the messages in the
 * last traces. Computed from files, so it reads the same with every env stopped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from './graph.ts';
import type { Row } from './knowledge/piece.ts';
import type { Knowledge } from './knowledge/store.ts';
import { stateDir, type Workspace } from './workspace.ts';

type Direction = 'publishes' | 'consumes';
export interface TopicContract {
  topic: string;
  /** what contracts write about it */
  declared: Array<{ piece: string; title: string; direction: Direction; service: string; payload?: string }>;
  /** what the code does: who publishes and who consumes, from the map */
  code: Array<{ service: string; direction: Direction }>;
  /** messages of this topic in the last played trace of each flow */
  seen?: { run: string; flow: string; count: number };
  /** the newest message seen, as the trace kept it (masked) */
  sample?: { run: string; flow: string; value: string };
  verdict: 'agrees' | 'differs' | 'declared-not-in-code' | 'code-not-declared' | 'only-seen';
  /** for «differs»: what the contract says and the code does not, and the other way round */
  missing?: string[];
  extra?: string[];
}

export function queueContracts(ws: Workspace, g: Graph | null, k: Knowledge): { topics: TopicContract[]; facts: number } {
  const by = new Map<string, TopicContract>();
  const topic = (t: string) => by.get(t) ?? by.set(t, { topic: t, declared: [], code: [], verdict: 'agrees' }).get(t)!;
  let facts = 0;
  for (const p of k.pieces) {
    if (p.type !== 'contract') continue;
    for (const e of (p.fields.events ?? []) as Row[]) {
      if (!e.topic || (e.direction !== 'publishes' && e.direction !== 'consumes')) continue;
      topic(String(e.topic)).declared.push({ piece: p.id, title: p.title, direction: e.direction, service: String(e.service ?? ''), payload: e.payload ? String(e.payload) : undefined });
    }
  }
  if (g) for (const f of g.map.facts) {
    if (!f.o.startsWith('topic:') || (f.p !== 'publishes' && f.p !== 'consumes')) continue;
    facts++;
    topic(f.o.slice(6)).code.push({ service: f.s, direction: f.p });
  }
  if (g) for (const n of g.ofType('topic')) topic(n.name.replace(/^topic:/, ''));
  // the last played trace of each flow: how many messages of each topic, and the newest
  const idx = join(stateDir(ws), 'runs', 'index.jsonl');
  if (existsSync(idx)) {
    const last = new Map<string, string>();
    for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l) as { run: string; flow: string; status: string }; if (x.status === 'passed' || x.status === 'failed') last.set(x.flow, x.run); }
    for (const [flow, run] of last) {
      const f = join(stateDir(ws), 'runs', run, 'flows', flow, 'trace.json');
      if (!existsSync(f)) continue;
      const t = JSON.parse(readFileSync(f, 'utf8')) as { exchanges?: Array<{ kind: string; topic?: string; to: string; t0: number; req?: { text?: string } }> };
      for (const e of t.exchanges ?? []) {
        if (e.kind !== 'kafka' || !e.topic || e.to !== 'kafka') continue; // a publication; its deliveries repeat it
        const c = topic(e.topic), n = (c.seen?.flow === flow ? c.seen.count : 0) + 1;
        if (!c.seen || c.seen.count < n) c.seen = { run, flow, count: n };
        if (e.req?.text && (!c.sample || run >= c.sample.run)) c.sample = { run, flow, value: e.req.text.slice(0, 600) };
      }
    }
  }
  const key = (x: { service: string; direction: Direction }) => `${x.service.replace(/^svc:/, '')} ${x.direction}`;
  for (const c of by.values()) {
    const d = new Set(c.declared.map(key)), real = new Set(c.code.map(key));
    c.missing = [...d].filter((x) => !real.has(x));
    c.extra = [...real].filter((x) => !d.has(x));
    c.verdict = !c.declared.length && !c.code.length ? 'only-seen' : !c.declared.length ? 'code-not-declared' : !c.code.length ? 'declared-not-in-code' : c.missing.length || c.extra.length ? 'differs' : 'agrees';
  }
  return { topics: [...by.values()].sort((a, b) => a.topic.localeCompare(b.topic)), facts };
}
