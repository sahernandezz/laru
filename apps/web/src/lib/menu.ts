/**
 * The side menu, as a function of the address. The shell computes it in the same render as the screen, from the route
 * and what the page has loaded (the shared cache), so a click moves the menu and the screen together: no screen declares
 * the menu after it is drawn, nothing shows the menu of the screen before for a moment, and nothing waits for a
 * screen's data to put the menu up.
 *
 * Two shapes: the main menu (the general sections and the application's own, with the one open lit up), or the menu of
 * one thing — a flow, a module, an environment, a service, a kind of piece — with a way back, its card and its sections.
 */
import { ArrowLeftRight, BookText, Container, Database, FileText, Globe, HardDrive, KeyRound, Mail, Radio, ScrollText, Server, Workflow, type LucideIcon } from 'lucide-react';
import type { DocPiece, EnvSummary, FlowInfo, Indexed, KnowledgeData, MapNode, RunInfo, StandardData } from '../api.ts';
import type { DotState } from '../components/ui.tsx';
import { ENV_STATE, KIND, lastWord, flowDot, pieceLabel } from './es.ts';
import { nodeParts, nodeTab } from './nodeTabs.ts';
import { CONTAINERS, FLOW_TABS, iconOf, sectionsOf, TABS_OF } from './pieceMenu.ts';
import { href, pageOf, splitStop } from './route.ts';
import { inProgress } from './service.ts';
import { homeOf } from './sysmap.ts';

export interface Section { key: string; label: string; to: string; n?: number; icon?: LucideIcon; group?: string }
export interface ScopeMenu {
  kind: 'scope';
  back: { label: string; to: string };
  card: { icon?: LucideIcon; kind: string; title: string; sub?: string; state?: DotState };
  sections: Section[];
  active: string;
}
/** `active`: the main menu's section; `app`: the section of the application's menu, when a piece of it is open. */
export interface MainMenu { kind: 'main'; active: string; app?: string }
export type Menu = MainMenu | ScopeMenu;

/** What the menu reads besides the address; each may still be loading. */
/** `session`: the run a live session's address names, read on its own (an old one is past the runs list). */
export interface MenuData { k?: KnowledgeData; flows?: FlowInfo[]; envs?: EnvSummary[]; runs?: RunInfo[]; session?: { id: string; env: string }; g?: Indexed | null; std?: StandardData; fronts?: number }

export const EXPLORERS = ['data', 'queues', 'storage', 'mail', 'vars'];
const NODE_ICON: Record<string, LucideIcon> = { service: Server, datastore: Database, external: Globe };

/** The env each live session ran on, as last seen: a saved session no longer in the runs list keeps its env's menu. */
const sessionEnv = new Map<string, string>();

/**
 * What the code says about a module lives with the piece that says it in writing; «Entorno» was folded into «Probar en
 * vivo»; the application's and modules' old sections were folded into others. The tab a piece's address asks for, put right.
 */
const KIND_OF_CODE: Record<string, string> = { interfaces: 'contract', data: 'data-model', tests: 'test-plan', vars: 'secrets' };
export function docsTab(p: Pick<DocPiece, 'type'>, asked?: string): string | undefined {
  if (p.type === 'module' && asked && KIND_OF_CODE[asked]) return `p-${KIND_OF_CODE[asked]}`;
  if (asked === 'env') return 'live';
  if ((p.type === 'application' && (asked === 'built' || asked === 'gov' || asked === 'rel')) || (p.type === 'module' && asked === 'built')) return undefined;
  return asked;
}

/** The container whose menu a piece keeps: its own when it has sections, or the nearest one above it that has (never a flow). */
export function ownerOf(p: DocPiece, byId: Map<string, DocPiece>): DocPiece | undefined {
  if (p.type === 'flow') return undefined;
  if (TABS_OF[p.type]) return p;
  for (let x = byId.get(p.parent ?? ''); x; x = byId.get(x.parent ?? '')) if (TABS_OF[x.type] && x.type !== 'flow') return x;
  return undefined;
}

function flowMenu(id: string, active: string, d: MenuData): ScopeMenu {
  const slug = id.replace(/^flow:/, ''), env = `f-${slug}`;
  const p = d.k?.pieces.find((x) => x.id === id), info = d.flows?.find((f) => f.id === id);
  const app = d.k?.pieces.find((x) => x.type === 'application');
  const at = (screen: string) => href(screen, env);
  return {
    kind: 'scope',
    back: { label: 'Todos los flujos', to: app ? href('docs', app.id, 't', 'flows') : href('docs') },
    card: { icon: Workflow, kind: 'Flujo', title: p?.title ?? slug, sub: info ? lastWord(info)[1] : undefined, state: info ? flowDot(info) : undefined },
    sections: [
      ...FLOW_TABS.map(([key, label]) => ({ key, label, to: key === 'summary' ? href('docs', id) : href('docs', id, 't', key), icon: { summary: FileText, live: Radio, doc: BookText }[key] })),
      // each flow runs isolated in its own environment: its data are that environment's, never another's
      { key: 'data', label: 'Bases de datos', to: at('data'), icon: Database, group: `Datos de ${env}` },
      { key: 'queues', label: 'Colas', to: at('queues'), icon: ArrowLeftRight, group: `Datos de ${env}` },
      { key: 'storage', label: 'Almacenamiento', to: at('storage'), icon: HardDrive, group: `Datos de ${env}` },
      { key: 'mail', label: 'Correo y mensajes', to: at('mail'), icon: Mail, group: `Datos de ${env}` },
      { key: 'vars', label: 'Variables y secretos', to: at('vars'), icon: KeyRound, group: `Datos de ${env}` },
    ],
    active,
  };
}

function envMenu(env: string, active: string, d: MenuData, session?: string): ScopeMenu {
  const e = d.envs?.find((x) => x.env === env);
  const open = d.runs && inProgress(d.runs).find((r) => r.kind === 'session' && r.env === env)?.id;
  const live = session ?? open;
  return {
    kind: 'scope',
    back: { label: 'Todos los entornos', to: href('envs') },
    card: { icon: Container, kind: /^f-/.test(env) ? 'Entorno de un flujo' : 'Entorno', title: env, sub: !e ? undefined : e.op && !e.op.done ? (e.op.kind === 'up' ? 'Levantando' : 'Destruyendo') : ENV_STATE[e.state] },
    sections: [
      { key: 'state', label: 'Estado y servicios', to: href('envs', env), icon: Container },
      { key: 'data', label: 'Bases de datos', to: href('data', env), icon: Database },
      { key: 'queues', label: 'Colas', to: href('queues', env), icon: ArrowLeftRight },
      { key: 'storage', label: 'Almacenamiento', to: href('storage', env), icon: HardDrive },
      { key: 'mail', label: 'Correo y mensajes', to: href('mail', env), icon: Mail },
      { key: 'vars', label: 'Variables y secretos', to: href('vars', env), icon: KeyRound },
      ...(live ? [{ key: 'live', label: `Sesión ${live} en vivo`, to: href('live', live), icon: Radio }] : []),
    ],
    active,
  };
}

function nodeMenu(g: Indexed, node: MapNode, asked: string | undefined, d: MenuData): ScopeMenu {
  const parts = nodeParts(g, node, d.k, d.flows);
  return {
    kind: 'scope',
    back: { label: 'Mapa y servicios', to: href('map') },
    card: { icon: NODE_ICON[node.type] ?? Server, kind: pieceLabel(node.type), title: node.name, sub: (KIND[node.kind ?? ''] ?? node.kind) || node.repo },
    sections: parts.tabs.map((t) => ({ key: t.key, label: t.label, n: t.n, to: href('map', node.id, 't', t.key) })),
    active: nodeTab(parts, asked),
  };
}

function docsMenu(id: string, rest: string[], d: MenuData): Menu {
  const [second, third] = rest;
  if (id.startsWith('flow:')) return flowMenu(id, second === 'edit' ? 'edit' : second === 't' ? (third === 'env' ? 'live' : third ?? 'summary') : 'summary', d);
  const k = d.k, p = k?.pieces.find((x) => x.id === id);
  if (!k || !p) return { kind: 'main', active: 'docs' };
  if (second === 'edit') return { kind: 'scope', back: { label: p.title, to: pageOf(p.id) }, card: { icon: iconOf(p), kind: 'Editando', title: p.title }, sections: [], active: '' };
  const byId = new Map(k.pieces.map((x) => [x.id, x]));
  const owner = ownerOf(p, byId);
  if (!owner) return { kind: 'main', active: 'docs' };
  const tab = docsTab(p, second === 't' ? third : undefined) ?? 'summary';
  const active = owner === p ? tab : `p-${p.type}`;
  if (owner.type === 'application') return { kind: 'main', active: 'docs', app: active };
  const parent = byId.get(owner.parent ?? '');
  return {
    kind: 'scope',
    back: parent ? { label: parent.title, to: pageOf(parent.id) } : { label: 'Resumen', to: href('overview') },
    card: { icon: iconOf(owner), kind: pieceLabel(owner.type), title: owner.title },
    sections: sectionsOf(k, byId, owner, active.startsWith('p-') ? active.slice(2) : undefined, d.fronts ?? 0),
    active,
  };
}

function standardMenu(type: string, std: StandardData): Menu {
  const current = std.types.find((t) => t.type === type);
  if (!current) return { kind: 'main', active: 'standard' };
  const order = [...std.types.filter((t) => CONTAINERS.includes(t.type)), ...std.types.filter((t) => !CONTAINERS.includes(t.type))];
  return {
    kind: 'scope',
    back: { label: 'Todas las piezas', to: href('standard') },
    card: { icon: ScrollText, kind: 'Cómo se documenta', title: pieceLabel(current.type), sub: current.question },
    sections: order.map((t) => ({ key: t.type, label: pieceLabel(t.type), to: href('standard', t.type), icon: iconOf({ type: t.type }) })),
    active: current.type,
  };
}

/** The menu of an address. */
export function menuOf(route: string[], d: MenuData): Menu {
  const [screen = 'overview', ...rest] = splitStop(route)[0];
  const [a, b, c] = rest;
  for (const r of d.runs ?? []) if (r.kind === 'session') sessionEnv.set(r.id, r.env);
  if (d.session) sessionEnv.set(d.session.id, d.session.env);
  if (screen === 'docs' && a && a !== 'new') return docsMenu(a, rest.slice(1), d);
  if (EXPLORERS.includes(screen) && a) return /^f-./.test(a) ? flowMenu(`flow:${a.slice(2)}`, screen, d) : envMenu(a, screen, d);
  if (screen === 'envs' && a && (!d.envs || d.envs.some((e) => e.env === a))) return envMenu(a, 'state', d);
  if (screen === 'live' && a && sessionEnv.has(a)) return envMenu(sessionEnv.get(a)!, 'live', d, a);
  if (screen === 'map' && a && d.g) {
    const node = d.g.nodes.get(homeOf(d.g, a));
    if (node && NODE_ICON[node.type]) return nodeMenu(d.g, node, b === 't' ? c : undefined, d);
  }
  if (screen === 'standard' && a && d.std) return standardMenu(a, d.std);
  return { kind: 'main', active: screen };
}

