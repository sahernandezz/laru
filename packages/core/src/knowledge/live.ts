/**
 * What a module's sheet shows beside what is written: the interfaces its code exposes (against the contracts that declare
 * them), the events and tables its code touches, the variables it reads (never their values) and the tests that belong to
 * it, by name and line. All of it comes from the map and the extraction; nothing here is stored.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFile, normalizePath } from '@laru/detect';
import { loadExtraction } from '../extract.ts';
import type { Graph } from '../graph.ts';
import type { Workspace } from '../workspace.ts';
import { endpointOwner, scopeFiles } from './coverage.ts';
import type { Row } from './piece.ts';
import { childrenOf, type Knowledge, type Loaded } from './store.ts';

export interface LiveEndpoint { id: string; method: string; path: string; handler?: string; file: string; line?: number; declared: boolean }
export interface LiveTest { file: string; level: string; cases: Array<{ name: string; line: number }>; count: number }
export interface LiveData {
  endpoints: LiveEndpoint[];
  /** operations a contract declares that the code does not have */
  declaredOnly: Array<{ contract: string; method: string; path: string }>;
  events: Array<{ topic: string; dir: 'publishes' | 'consumes'; file: string; line?: number }>;
  tables: Array<{ table: string; op: 'maps' | 'defines'; file: string; line?: number }>;
  vars: Array<{ name: string; secret: boolean; hasDefault: boolean; file: string; line?: number }>;
  tests: LiveTest[];
  /** a flow's known deviations: the `// app:` lines of its spec, where the application does not do what is documented */
  deviations: Array<{ line: number; text: string }>;
}

export const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/i;

/**
 * Where the tests of a piece live: for an anchor on a folder or a glob, that folder and its mirror under `src/test`; for an
 * anchor on one file, the tests beside or mirroring it whose name starts with the file's (`FileService` → `FileServiceTest`).
 */
export function testFolders(p: Pick<Loaded, 'anchors'>): Array<{ repo: string; dir: string; stem?: string; method?: string }> {
  return (p.anchors ?? []).flatMap((a) => {
    const [repo, rest = ''] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1).replace(/#.*$/, '')];
    const head = rest.split('/').filter((s) => !/[*?]/.test(s));
    const isFile = /\.\w+$/.test(head.at(-1) ?? '') && !/[*?]/.test(rest.split('/').at(-1) ?? '');
    const dir = (isFile ? head.slice(0, -1) : head).join('/');
    const stem = isFile ? head.at(-1)!.replace(/\.\w+$/, '') : undefined;
    // `File.java#FileController.upload*` narrows to the cases named after that method.
    const method = isFile ? a.match(/#[\w$]+\.([\w$]+)\*?$/)?.[1] ?? a.match(/#([\w$]+)\*?$/)?.[1] : undefined;
    return [{ repo, dir, stem, method }, { repo, dir: dir.replace('src/main', 'src/test'), stem, method }];
  });
}

/** The tests under a service's directory, by name and line: what the service sheet's «Pruebas» shows. */
export function serviceTests(ws: Workspace, g: Graph, id: string): LiveTest[] {
  const n = g.nodes.get(id);
  if (!n?.repo) return [];
  const dir = String(n.attrs?.dir ?? '').replace(/^\.$/, '');
  const ex = loadExtraction(ws, n.repo);
  const out: LiveTest[] = [];
  for (const [path, ff] of Object.entries(ex?.files ?? {})) {
    if (dir && !path.startsWith(`${dir}/`)) continue;
    for (const f of ff.findings) if (f.kind === 'tests') out.push({ file: `${n.repo}:${path}`, level: f.level, count: f.count, cases: f.cases ?? [] });
  }
  return out;
}

export function liveOf(ws: Workspace, k: Knowledge, g: Graph | null, p: Loaded): LiveData {
  const out: LiveData = { endpoints: [], declaredOnly: [], events: [], tables: [], vars: [], tests: [], deviations: [] };
  if (p.type === 'flow') {
    // A flow's tests are its own spec, in the workspace: by name and line, and the places it records what the app really does.
    const spec = join(p.dir, `${p.id.replace(/^flow:/, '')}.spec.ts`), abs = join(ws.root, spec);
    if (existsSync(abs)) {
      const src = readFileSync(abs, 'utf8');
      for (const f of detectFile(spec, src)) if (f.kind === 'tests') out.tests.push({ file: spec, level: f.level, count: f.count, cases: f.cases ?? [] });
      src.split('\n').forEach((l, i) => { const m = l.match(/\/\/\s*app:\s*(.+)$/); if (m) out.deviations.push({ line: i + 1, text: m[1].trim() }); });
    }
    return out;
  }
  const files = new Set(scopeFiles(ws, k, p).map((f) => `${f.repo}:${f.file}`));
  const where = (a?: { repo: string; path: string; line?: number }) => (a && files.has(`${a.repo}:${a.path}`) ? { file: `${a.repo}:${a.path}`, line: a.line } : null);
  if (g && files.size) {
    const owns = endpointOwner(ws, p);
    const ops = childrenOf(k, p.id).filter((c) => c.type === 'contract').flatMap((c) => ((c.fields.operations ?? []) as Row[]).map((o) => ({ contract: c.id, method: o.method, path: o.path, key: `${o.method} ${normalizePath(o.path)}` })));
    const declared = new Set(ops.map((o) => o.key));
    const found = new Set<string>();
    for (const ep of g.ofType('endpoint')) {
      if (!ep.anchor || !owns(ep.anchor.repo, ep.anchor.path, String(ep.attrs?.handler ?? ''))) continue;
      const key = `${ep.attrs?.method} ${normalizePath(String(ep.attrs?.path))}`;
      found.add(key);
      out.endpoints.push({ id: ep.id, method: String(ep.attrs?.method), path: String(ep.attrs?.path), handler: ep.attrs?.handler as string | undefined, file: `${ep.anchor.repo}:${ep.anchor.path}`, line: ep.anchor.line, declared: declared.has(key) });
    }
    out.declaredOnly = ops.filter((o) => !found.has(o.key)).map(({ contract, method, path }) => ({ contract, method, path }));
    for (const f of g.map.facts) {
      const at = where(f.anchor);
      if (!at) continue;
      const name = g.nodes.get(f.o)?.name ?? f.o;
      if (f.p === 'publishes' || f.p === 'consumes') out.events.push({ topic: name, dir: f.p, ...at });
      else if (f.p === 'maps-table' || f.p === 'defines-table') out.tables.push({ table: name, op: f.p === 'maps-table' ? 'maps' : 'defines', ...at });
      else if (f.p === 'reads-var') out.vars.push({ name, secret: SECRET_NAME.test(name), hasDefault: f.note === 'has a default', ...at });
    }
  }
  // A test file is the piece's when some anchor reaches it; a method-narrowed anchor keeps only the cases named after the method.
  const found = new Map<string, LiveTest & { all: boolean }>();
  for (const { repo, dir, stem, method } of testFolders(p)) {
    const ex = loadExtraction(ws, repo);
    for (const [path, ff] of Object.entries(ex?.files ?? {})) {
      if (dir && !(path === dir || path.startsWith(`${dir}/`))) continue;
      if (stem && !(path.split('/').at(-1) ?? '').startsWith(stem)) continue;
      for (const f of ff.findings) {
        if (f.kind !== 'tests') continue;
        const key = `${repo}:${path}`;
        const cur = found.get(key) ?? { file: key, level: f.level, count: 0, cases: [], all: false };
        const cases = method ? (f.cases ?? []).filter((c) => c.name.toLowerCase().includes(method.toLowerCase())) : f.cases ?? [];
        if (method && !cases.length) continue;
        if (!method) { cur.all = true; cur.cases = f.cases ?? []; cur.count = f.count; }
        else if (!cur.all) { cur.cases = [...new Map([...cur.cases, ...cases].map((c) => [c.line, c])).values()]; cur.count = cur.cases.length; }
        found.set(key, cur);
      }
    }
  }
  out.tests = [...found.values()].map(({ all: _all, ...t }) => t);
  return out;
}
