/**
 * A store explored the way laru.yaml says: any database, queue or system, through the command its own container
 * already has (`stores.<name>.explore.query`). What the person types travels on stdin, never on an argv or in the
 * shell text; the answer is a table when it is CSV or TSV with a header, else text. Masked like every other peek.
 */
import type { StoreDecl, Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { docker, inspectEnv, LABEL } from '../docker.ts';
import { parseCsv } from '../db.ts';

export interface CustomStore { service: string; kind: string; container: string; tables: boolean }
export interface CustomAnswer { columns?: string[]; rows?: Array<Array<string | null>>; text?: string; truncated?: boolean; ms: number }

const declared = (ws: Workspace) => (ws.stores ?? []).filter((d): d is StoreDecl & { explore: NonNullable<StoreDecl['explore']> } => Boolean(d.explore?.query));

/** The declared stores with an `explore.query` that run in the env now, by their compose service name. */
export async function customStores(ws: Workspace, env: string): Promise<CustomStore[]> {
  const said = declared(ws);
  if (!said.length) return [];
  const running = (await inspectEnv(ws, env)).filter((c) => c.state === 'running' && !c.labels[LABEL.run]);
  return said.flatMap((d) => {
    const c = running.find((x) => x.service === d.name);
    return c ? [{ service: d.name, kind: d.kind, container: c.id, tables: Boolean(d.explore.tables) }] : [];
  }).sort((a, b) => a.service.localeCompare(b.service));
}

/** A header line and rows split by commas or tabs, the same count on every line: a table; anything else is text. */
export function readAnswer(out: string, limit = 1000): Omit<CustomAnswer, 'ms'> {
  const lines = out.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const tsv = lines[0]?.includes('\t');
  if (lines.length > 1 && (tsv || lines[0].includes(','))) {
    const rows = tsv ? lines.map((l) => l.split('\t').map((v) => (v === '' || v === 'NULL' ? null : v))) : parseCsv(out).rows;
    if (rows.length > 1 && rows.every((r) => r.length === rows[0].length)) {
      const [head, ...body] = rows;
      return { columns: head.map(String), rows: body.slice(0, limit), truncated: body.length > limit };
    }
  }
  return { text: out };
}

/**
 * `query`: what the person typed; `tables`: the declared listing; `table`: the declared opening of one table,
 * `{table}` replaced by its name. Each goes on stdin of the declared command, inside the store's container.
 */
export async function customRun(ws: Workspace, env: string, service: string, ask: { what: 'query' | 'tables' | 'table'; input?: string }, masker?: Masker): Promise<CustomAnswer> {
  const d = declared(ws).find((x) => x.name === service);
  const s = (await customStores(ws, env)).find((x) => x.service === service);
  if (!d || !s) throw new Error(`${service} is not running in ${env} with an explore.query in laru.yaml`);
  const input = ask.what === 'tables' ? d.explore.tables ?? ''
    : ask.what === 'table' ? (d.explore.table ?? '{table}').replaceAll('{table}', ask.input ?? '')
    : ask.input ?? '';
  const t0 = Date.now();
  const mask = (x: string) => (masker ? masker.text(x) : x);
  // a failing command's stderr can echo a password or a row: its error is masked like its answer
  const out = await docker(['exec', '-i', s.container, 'sh', '-c', d.explore.query], { input: input.endsWith('\n') ? input : `${input}\n`, timeoutMs: 30_000 })
    .catch((e: Error) => { throw new Error(mask(e.message)); });
  const answer = readAnswer(mask(out));
  return { ...answer, ms: Date.now() - t0 };
}
