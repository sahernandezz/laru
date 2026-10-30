/**
 * What the shell needs of the documentation without the documentation's screen: each kind of piece's icon, the tabs of the
 * classes with a sheet of their own, and the application's menu. The screen (pages/Docs.tsx) loads only when opened.
 */
import {
  Archive, BookOpen, Handshake, BookText, Bookmark, Box, Braces, CalendarRange, Cloud, Container, Database, DatabaseBackup, FileText, GitBranch, GitFork, Globe, KeyRound,
  Layers, LifeBuoy, ListChecks, Monitor, Network, Package, Puzzle, Quote, Radio, Route, Ruler, Scale, Server, StickyNote, Table, Tag, Workflow, type LucideIcon,
} from 'lucide-react';
import { forwardRef } from 'react';
import type { DocPiece, KnowledgeData } from '../api.ts';
import { FLOW_TABS } from '../components/FlowScope.tsx';
import { piecesLabel, STAGE } from './es.ts';
import { href } from './route.ts';
import type { Scope } from './scope.ts';
import { typeColor } from './typeColor.ts';

export const TYPE_ICON: Record<string, LucideIcon> = {
  application: Box, module: Layers, process: Workflow, repository: GitBranch, service: Server, datastore: Database, external: Globe,
  agreement: Handshake, plan: CalendarRange, decision: Scale, contract: Braces, 'data-model': Table, convention: Ruler, guide: BookOpen, 'test-plan': ListChecks, flow: Route, scenario: DatabaseBackup, artifact: Archive, runbook: LifeBuoy, architecture: Network, versioning: Tag, stack: Package, infrastructure: Cloud, secrets: KeyRound, glossary: BookText, term: Quote, note: StickyNote,
};
const SECTION_ICON: Record<string, LucideIcon> = {
  summary: FileText, arch: Network, built: Layers, modules: Layers, processes: Workflow, fronts: Monitor, flows: Route, envs: Container, gov: Scale, owed: ListChecks, doc: BookText, rel: GitFork,
  live: Radio, env: Database, scope: ListChecks, interfaces: Braces, data: Database, tests: ListChecks, vars: KeyRound, code: GitBranch,
};
const KIND_ICON: Record<string, LucideIcon> = { area: Layers, feature: Puzzle, story: Bookmark, subprocess: GitFork };
const tinted = new Map<LucideIcon, Map<string, LucideIcon>>();
/** The icon of a piece in the colour of its kind. One component per icon and colour, so the tree does not remount it on every render. */
export const iconOf = (p: { type: string; kind?: string }): LucideIcon => {
  const Base = KIND_ICON[p.kind ?? ''] ?? TYPE_ICON[p.type] ?? FileText, color = typeColor(p.type);
  let byColor = tinted.get(Base);
  if (!byColor) tinted.set(Base, (byColor = new Map()));
  let T = byColor.get(color);
  if (!T) byColor.set(color, (T = forwardRef<SVGSVGElement, Parameters<LucideIcon>[0]>((props, ref) => <Base ref={ref} color={color} {...props} />) as unknown as LucideIcon));
  return T;
};
export const CONTAINERS = ['application', 'module', 'process', 'repository', 'service', 'datastore', 'external'];

/** A container's own flows: the ones below it, and the ones that say they walk it (`realizes`). */
export function ownFlows(k: KnowledgeData, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => { for (const c of k.pieces) if (c.parent === x) { if (c.type === 'flow') out.push(c.id); else if (CONTAINERS.includes(c.type)) walk(c.id); } };
  walk(id);
  for (const c of k.pieces) if (c.type === 'flow' && ([] as string[]).concat(c.meta?.realizes ?? []).includes(id) && !out.includes(c.id)) out.push(c.id);
  return out;
}

/** The tabs of the classes that have their own sheet (as the approved mock has them): key and label. ⌘K reaches each one. */
export const TABS_OF: Record<string, Array<[string, string]>> = {
  application: [['summary', 'Resumen'], ['arch', 'Diagramas'], ['modules', 'Módulos'], ['processes', 'Procesos'], ['fronts', 'Clientes'], ['flows', 'Escenarios y flujos'], ['envs', 'Entornos'], ['owed', 'Lo que debe'], ['doc', 'Documento']],
  flow: FLOW_TABS,
  module: [['summary', 'Resumen'], ['flows', 'Escenarios y flujos'], ['owed', 'Lo que debe'], ['doc', 'Documento'], ['code', 'Código']],
};

/**
 * What the code says about a module lives with the piece that says it in writing: the endpoints in the contracts, the tables
 * and dependencies in the data models, the tests in the test plans, the variables in the secrets.
 */
export const CODE_OF: Record<string, string> = { contract: 'interfaces', 'data-model': 'data', 'test-plan': 'tests', secrets: 'vars' };
/** What a piece does not list among its pieces: these have their own place (the tree, the map, the scenarios and flows tab). */
const NOT_HERE = ['module', 'process', 'repository', 'service', 'datastore', 'external', 'flow', 'scenario'];

/** The kinds of piece that may live in a container, with how many there are under it. */
/** A kind with nothing in it is not listed (the «Añadir» menu still creates one); the one open stays, so its page does not vanish under the person. */
export function kindsOf(k: KnowledgeData, byId: Map<string, DocPiece>, owner: DocPiece, keep?: string) {
  if (owner.type !== 'application' && owner.type !== 'module') return [];
  const under = (x: DocPiece): boolean => { for (let c = byId.get(x.parent ?? ''); c; c = byId.get(c.parent ?? '')) if (c.id === owner.id) return true; return false; };
  return Object.values(k.shapes).filter((s) => (s.livesIn as string[]).includes(owner.type) && !NOT_HERE.includes(s.type)).map((s) => ({ type: s.type as string, stage: s.stage as string, n: k.pieces.filter((x) => x.type === s.type && under(x)).length })).filter((x) => x.n > 0 || keep === x.type || (owner.type === 'application' && (x.type === 'secrets' || x.type === 'agreement')) || (owner.type === 'module' && Boolean(owner.anchors?.length) && x.type in CODE_OF));
}


const STAGES = Object.keys(STAGE);
/** A container's sections: its own tabs, then a section per kind of piece it holds, all under «Piezas», in the order of the stage each answers to. */
export function sectionsOf(k: KnowledgeData, byId: Map<string, DocPiece>, owner: DocPiece, keep?: string, fronts = 0): Scope['sections'] {
  const counts: Record<string, number | undefined> = { modules: k.pieces.filter((x) => x.parent === owner.id && x.type === 'module').length, processes: k.pieces.filter((x) => x.parent === owner.id && x.type === 'process').length, flows: ownFlows(k, owner.id).length, owed: owner.sheet?.owed.length ?? 0, code: owner.anchors?.length };
  return [
    // a tab with nothing in it that the application may lack is not shown: clients nobody recognised, processes nobody wrote
    ...TABS_OF[owner.type].filter(([key]) => (key !== 'fronts' || fronts) && (key !== 'processes' || counts.processes)).map(([key, label]) => ({ key, label, n: key === 'fronts' ? fronts : counts[key], icon: SECTION_ICON[key], to: key === 'summary' ? href('docs', owner.id) : href('docs', owner.id, 't', key) })),
    ...kindsOf(k, byId, owner, keep).sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))
      .map((x) => ({ key: `p-${x.type}`, label: piecesLabel(x.type), n: x.n || undefined, icon: iconOf({ type: x.type }), to: href('docs', owner.id, 't', `p-${x.type}`), group: 'Piezas' })),
  ];
}

/**
 * The application's own menu: what is written about it (summary, diagrams, modules, flows, what is owed, the document and
 * every kind of living piece) is one menu with the rest of the system's, not a second one inside it. «Entornos» is
 * «Servicios y entornos», in that menu already.
 */
export function appMenuOf(k: KnowledgeData, fronts = 0): { title: string; sections: Scope['sections'] } | undefined {
  const app = k.pieces.find((x) => x.type === 'application');
  if (!app) return undefined;
  return { title: app.title, sections: sectionsOf(k, new Map(k.pieces.map((x) => [x.id, x])), app, undefined, fronts).filter((x) => x.key !== 'envs') };
}
