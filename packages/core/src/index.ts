/** Laru core: the workspace, its repositories, the extracted map and the questions it answers. */
import { buildSystemMap } from './build.ts';
import { extractRepo, type ExtractStats } from './extract.ts';
import { saveMap } from './graph.ts';
import type { SystemMap } from './model.ts';
import { keepTree, shareFolder } from './folder.ts';
import { saveLock, type Workspace } from './workspace.ts';

export * from './model.ts';
export * from './workspace.ts';
export { addRepo, linkRepo, repoStatus, syncRepos, type RepoStatus } from './repos.ts';
export { loadExtraction, type ExtractStats } from './extract.ts';
export { Graph, loadGraph, loadObserved, mapFile, observedFile } from './graph.ts';
export { ask, context, docsTree, estimateTokens, path, render, resolveTarget, tree } from './query.ts';
export { IMAGE_KINDS, targetsIn, type Target } from './build.ts';
export { agentGuide, initWorkspace, writeAgentFiles } from './init.ts';
export { LIMIT_MAX, LIMIT_MIN, parseLimit } from './limit.ts';
export { git } from './git.ts';
export { evidenceDir, importEvidence, shareEvidence, withEvidence } from './evidence.ts';
export { withLock } from './lock.ts';
export { appOf, byCwd, idOf, loadRegistry, realRoot, register, resolveId, resolveRoot, touch, unregister, type Registered } from './registry.ts';
export { DEFAULT_IGNORE, gitOf, keepTree, refOf, scanFolder, shadowDir, shareFolder, shadowEnv, treeNow, type FolderScan } from './folder.ts';

/** Reads every repo at its reference branch and rebuilds the map. Unchanged files are not read again. */
export async function refreshMap(ws: Workspace): Promise<{ map: SystemMap; stats: ExtractStats[]; ms: number }> {
  const t0 = performance.now();
  const results = await Promise.all(ws.repos.map((r) => extractRepo(ws, r)));
  const map = buildSystemMap(ws, results.map((r) => r.extraction));
  saveMap(ws, map);
  // A folder's tree stays in its shadow while the map points at it, and its copy in projects/ is what the team reads.
  for (const r of ws.repos.filter((x) => x.source === 'folder')) {
    const ex = results.find((x) => x.extraction.repo === r.name);
    if (ex) { await keepTree(ws, r.name, 'map', ex.extraction.commit); await shareFolder(ws, r.name, ex.extraction.commit); }
  }
  return { map, stats: results.map((r) => r.stats), ms: Math.round(performance.now() - t0) };
}

/** Records the commits (a folder's tree hash) the map was read at as the verified ones. */
export async function verify(ws: Workspace, map: SystemMap): Promise<Record<string, string>> {
  ws.lock = Object.fromEntries(map.repos.map((r) => [r.name, r.commit]));
  saveLock(ws);
  for (const r of ws.repos.filter((x) => x.source === 'folder')) if (ws.lock[r.name]) await keepTree(ws, r.name, 'lock', ws.lock[r.name]);
  return ws.lock;
}

export { STANDARD, PIECE_TYPES, CONTAINERS, FACETS, STAGES, STAGE_LABEL, isContainer, type PieceType, type ContainerType, type FacetType, type Stage, type Lang } from './knowledge/standard.ts';
export { parsePiece, renderPiece, type Piece, type Row, type FieldValue } from './knowledge/piece.ts';
export { validatePiece, type Issue } from './knowledge/validate.ts';
export { scaffoldPieces } from './knowledge/scaffold.ts';
export { newPiece, movePiece, renamePiece } from './knowledge/ops.ts';
export { deriveDiagram, derivedList, protocolOf, relationsOf, type DerivedInfo, type EnvMembers } from './knowledge/derive.ts';
export { liveOf, serviceTests, testFolders, SECRET_NAME, type LiveData, type LiveEndpoint, type LiveTest } from './knowledge/live.ts';
export { sheetNote, acceptKey, owedLine, type SheetNote, type OwedItem } from './knowledge/sheet.ts';
export { migrateWorkspace, type MigrationReport } from './knowledge/migrate.ts';
export { documentNote, type DocNote, type NoteItem } from './knowledge/lint.ts';
export { loadKnowledge, ancestors, childrenOf, anchorResolver, fingerprint, freshness, type Knowledge, type Loaded, type Freshness, type FileIssue } from './knowledge/store.ts';
export { coverage, evaluateConventions, conventionsFor, scopeFiles, type StageCoverage, type CovState, type Reason, type ConventionResult } from './knowledge/coverage.ts';
export { knowledgeShape, knowledgeWrite, writeFlowGuide, verifyPiece, checkWorkspace, docsLang, slugify, type WriteInput, type WriteResult, type CheckResult } from './knowledge/write.ts';
export { scaffoldSpec, specSteps, checkFlowSpec, lintSpec, provesOnScreen, holdsValidations, codeOnly, specPath, type FlowCheck, type FlowCheckKey } from './flows.ts';
export { E2E_GUIDE, E2E_RULES } from './knowledge/e2e.ts';
export { changesFromWorktrees, impact, renderImpact, workspaceChanges, type Change, type Impact } from './impact.ts';
export { queueContracts, type TopicContract } from './queues.ts';
export { acceptFinding, computeFindings, findingsFile, loadAccepted, type Acceptance, type Finding, type FindingType } from './findings.ts';
export { preEdit, postEdit, type HookInput } from './hooks.ts';
