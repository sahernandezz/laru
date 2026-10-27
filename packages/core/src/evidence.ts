/**
 * The last passing evidence of each flow, kept in the workspace (`evidence/<flow>/`) so that git shares it with the
 * team: its story's trace, video, screenshots and short cases, and the run's events of that flow. The rest of a run
 * (raw capture, logs, failed and older runs) stays in the ignored state folder.
 *
 * Each machine numbers its own runs, so a shared evidence is imported as a run of this machine, with an id of its own,
 * the first time it is seen: everything that reads runs (the studio, coverage, impact) reads it as any other.
 * What comes through git is someone else's: only plain files with plain names are copied, never a link.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { plainPath as inside, stateDir, type Workspace } from './workspace.ts';

const NAME = /^[\w-]+$/;
const FILE = /^[\w.-]+$/;
export const evidenceDir = (ws: Pick<Workspace, 'root'>) => join(ws.root, 'evidence');
const runsOf = (ws: Pick<Workspace, 'root'>) => join(stateDir(ws), 'runs');
/** shared evidence already here: `<flow>@<when it ran>` → the local run that holds it */
const seenFile = (ws: Pick<Workspace, 'root'>) => join(runsOf(ws), 'shared.json');

interface Shared { run: Record<string, unknown> & { startedAt: string }; index: Record<string, unknown> & { at: string } }
const keyOf = (slug: string, at: string) => `${slug}@${at}`;
const readJson = <T>(f: string | undefined): T | undefined => { if (!f) return undefined; try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return undefined; } };
/** The plain files, with plain names, of a folder with no link on its way from `base`. */
const plainFiles = (base: string, ...parts: string[]) => {
  const dir = inside(base, ...parts);
  return dir ? readdirSync(dir).filter((n) => FILE.test(n) && lstatSync(join(dir, n)).isFile()).map((n) => join(dir, n)) : [];
};
const seen = (ws: Pick<Workspace, 'root'>) => readJson<Record<string, string>>(seenFile(ws)) ?? {};
const remember = (ws: Pick<Workspace, 'root'>, key: string, id: string) => { mkdirSync(runsOf(ws), { recursive: true }); writeFileSync(seenFile(ws), JSON.stringify({ ...seen(ws), [key]: id }, null, 2)); };
/** The run's events of one flow: those of its spec's tests, and those of no test. */
const eventsOf = (text: string, slug: string) => {
  const mine = new Set<string>();
  return text.split('\n').filter(Boolean).filter((l) => {
    let e: { e?: string; test?: string; file?: string } = {};
    try { e = JSON.parse(l); } catch { /* a torn line says nothing */ }
    if (e.e === 'test-begin' && e.test && e.file?.endsWith(`/${slug}.spec.ts`)) mine.add(e.test);
    return !e.test || mine.has(e.test);
  }).map((l) => l + '\n').join('');
};

/**
 * Keeps a passed flow of a run as the flow's shared evidence, unless a newer one is already there.
 * Called when a run ends, and again when a screen's video reaches a finished run.
 */
export function shareEvidence(ws: Workspace, id: string, slug: string): boolean {
  if (!NAME.test(id) || !NAME.test(slug)) return false;
  const runDir = join(runsOf(ws), id);
  const run = readJson<Record<string, any>>(join(runDir, 'run.json'));
  const result = run?.results?.[slug];
  if (!run || run.kind === 'session' || result?.status !== 'passed') return false;
  const index = readFileSync(join(runsOf(ws), 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).findLast((x) => x.run === id && x.flow === slug);
  if (!index) return false;
  if (existsSync(evidenceDir(ws)) && !inside(ws.root, 'evidence')) return false;
  mkdirSync(evidenceDir(ws), { recursive: true });
  const dest = join(evidenceDir(ws), slug);
  const there = readJson<Shared>(inside(ws.root, 'evidence', slug, 'evidence.json'));
  if (there && there.run.startedAt > run.startedAt) return false;
  const tmp = join(evidenceDir(ws), `.${slug}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'flows', slug), { recursive: true });
  for (const f of plainFiles(runsOf(ws), id, 'flows', slug)) copyFileSync(f, join(tmp, 'flows', slug, basename(f)));
  const events = plainFiles(runsOf(ws), id, 'out').find((f) => basename(f) === 'events.jsonl');
  if (events) { mkdirSync(join(tmp, 'out')); writeFileSync(join(tmp, 'out', 'events.jsonl'), eventsOf(readFileSync(events, 'utf8'), slug)); }
  const { pid: _pid, results: _r, flows: _f, id: _id, ...rest } = run;
  const shared: Shared = { run: { ...rest, origin: id, flows: [slug], results: { [slug]: result }, status: 'passed', startedAt: String(run.startedAt) }, index: { ...index, run: undefined } };
  writeFileSync(join(tmp, 'evidence.json'), JSON.stringify(shared, null, 2) + '\n');
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
  remember(ws, keyOf(slug, run.startedAt), id);
  return true;
}

/** Imports the shared evidence this machine has not seen yet as runs of its own. Returns the new run ids. */
export function importEvidence(ws: Workspace): string[] {
  const root = inside(ws.root, 'evidence');
  if (!root) return [];
  const known = seen(ws), added: string[] = [];
  for (const slug of readdirSync(root).filter((n) => NAME.test(n))) {
    const dir = inside(ws.root, 'evidence', slug);
    if (!dir || !lstatSync(dir).isDirectory()) continue;
    const s = readJson<Shared>(inside(ws.root, 'evidence', slug, 'evidence.json'));
    const result = (s?.run?.results as Record<string, { status?: string }> | undefined)?.[slug];
    if (!s || typeof s.run.startedAt !== 'string' || typeof s.index?.at !== 'string' || result?.status !== 'passed' || known[keyOf(slug, s.run.startedAt)]) continue;
    const id = nextRunId(ws);
    const to = join(runsOf(ws), id);
    mkdirSync(join(to, 'flows', slug), { recursive: true });
    for (const f of plainFiles(ws.root, 'evidence', slug, 'flows', slug)) copyFileSync(f, join(to, 'flows', slug, basename(f)));
    const events = plainFiles(ws.root, 'evidence', slug, 'out').find((f) => basename(f) === 'events.jsonl');
    if (events) { mkdirSync(join(to, 'out')); copyFileSync(events, join(to, 'out', 'events.jsonl')); }
    const { kind: _kind, pid: _pid, ...run } = s.run;
    writeFileSync(join(to, 'run.json'), JSON.stringify({ ...run, id, flows: [slug], results: { [slug]: result }, phase: 'done', status: 'passed', shared: true }, null, 2));
    addToIndex(ws, { ...s.index, run: id, flow: slug, status: 'passed' });
    remember(ws, keyOf(slug, s.run.startedAt), id);
    known[keyOf(slug, s.run.startedAt)] = id;
    added.push(id);
  }
  return added;
}

/** The workspace, with the shared evidence it carries already imported: what every entry point (CLI, service, MCP) loads. */
export function withEvidence<T extends Workspace>(ws: T): T {
  try { importEvidence(ws); } catch { /* a broken evidence folder never stops the workspace from opening */ }
  return ws;
}

function nextRunId(ws: Workspace): string {
  mkdirSync(runsOf(ws), { recursive: true });
  const ids = readdirSync(runsOf(ws)).filter((d) => /^\d+$/.test(d)).map(Number);
  for (let n = (ids.length ? Math.max(...ids) : 0) + 1; ; n++) {
    try { mkdirSync(join(runsOf(ws), String(n))); return String(n); } catch { /* taken by a run starting now */ }
  }
}

/** The index is read in order, the last line of a flow being its result: an imported line goes where its time puts it. */
function addToIndex(ws: Workspace, line: Record<string, unknown> & { at: string }) {
  const f = join(runsOf(ws), 'index.jsonl');
  const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  if (!lines.length || (JSON.parse(lines.at(-1)!).at ?? '') <= line.at) { appendFileSync(f, JSON.stringify(line) + '\n'); return; }
  const all = [...lines.map((l) => ({ l, at: String(JSON.parse(l).at ?? '') })), { l: JSON.stringify(line), at: line.at }];
  writeFileSync(f, all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((x) => x.l).join('\n') + '\n');
}
