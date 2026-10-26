/**
 * Extraction reads the reference branch of each repo straight from git — `ls-tree` and `cat-file` — so the working
 * copy is never touched and a file whose blob did not change is never read twice. A folder project is read the same
 * way, at the tree its shadow index hashed (folder.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DETECTORS_VERSION, detectFile, isRelevant, type Finding } from '@laru/detect';
import { gitOf, refOf } from './folder.ts';
import { lsTree, readBlobs } from './git.ts';
import { stateDir, type RepoConfig, type Workspace } from './workspace.ts';

export interface FileFindings { blob: string; findings: Finding[] }
export interface RepoExtraction {
  repo: string; commit: string; ref: string; detectors: number;
  files: Record<string, FileFindings>;
  /** every file at the commit with its blob hash: what code anchors resolve against */
  tree: Record<string, string>;
}
export interface ExtractStats { repo: string; commit: string; files: number; read: number; reused: number; ms: number }

const MAX_BYTES = 512 * 1024;
const cacheFile = (ws: Workspace, repo: string) => join(stateDir(ws), 'extract', `${repo}.json`);

export function loadExtraction(ws: Workspace, repo: string): RepoExtraction | null {
  const f = cacheFile(ws, repo);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RepoExtraction) : null;
}

export async function extractRepo(ws: Workspace, repo: RepoConfig): Promise<{ extraction: RepoExtraction; stats: ExtractStats }> {
  const t0 = performance.now();
  const { cwd: checkout, env } = gitOf(ws, repo.name);
  const ref = await refOf(ws, repo.name);

  const prev = loadExtraction(ws, repo.name);
  const reuse = prev && prev.detectors === DETECTORS_VERSION ? prev.files : {};
  const all = await lsTree(checkout, ref.commit, env);
  const relevant = all.filter((f) => f.size <= MAX_BYTES && isRelevant(f.path));
  const files: Record<string, FileFindings> = {};
  const toRead = relevant.filter((f) => reuse[f.path]?.blob !== f.blob);
  const contents = await readBlobs(checkout, [...new Set(toRead.map((f) => f.blob))], env);
  for (const f of relevant) {
    const cached = reuse[f.path];
    files[f.path] = cached && cached.blob === f.blob ? cached : { blob: f.blob, findings: detectFile(f.path, contents.get(f.blob) ?? '') };
  }
  const extraction: RepoExtraction = { repo: repo.name, commit: ref.commit, ref: ref.name, detectors: DETECTORS_VERSION, files, tree: Object.fromEntries(all.map((f) => [f.path, f.blob])) };
  mkdirSync(join(stateDir(ws), 'extract'), { recursive: true });
  writeFileSync(cacheFile(ws, repo.name), JSON.stringify(extraction));
  return { extraction, stats: { repo: repo.name, commit: ref.commit, files: relevant.length, read: toRead.length, reused: relevant.length - toRead.length, ms: Math.round(performance.now() - t0) } };
}
