/** The interface: one shell, one route per screen, and the map loaded once for all of them. */
import { Database, GitBranch, Globe, Server, Waypoints } from 'lucide-react';
import { Component, createElement, lazy, Suspense, useEffect, useMemo, type ComponentType, type ReactNode } from 'react';
import { indexMap, useApi, type EnvSummary, type FlowInfo, type Indexed, type KnowledgeData, type RunInfo, type StandardData, type SystemMap, type WorkspaceInfo } from './api.ts';
import { NAV, Shell, type Jump } from './components/Shell.tsx';
import { Skeleton } from './components/ui.tsx';
import { FINDING, pieceLabel } from './lib/es.ts';
import { addRouteFix, HOME, href, pageOf, splitStop, useRoute } from './lib/route.ts';
import { EXPLORERS, menuOf, type Menu } from './lib/menu.ts';
import { FromFlow } from './components/FromFlow.tsx';
import { frontNodes } from './lib/fronts.ts';
import { appMenuOf, iconOf, TABS_OF } from './lib/pieceMenu.ts';
import { homeOf } from './lib/sysmap.ts';

/**
 * Each screen's code is its own file: the first page loads only its own, and the rest come in behind once it is drawn,
 * so opening another screen never waits on its code (no skeleton between two screens).
 */
const loaders: Array<() => Promise<unknown>> = [];
const page = <K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) => {
  // once its code is here the screen is drawn as it is: a lazy one would suspend for a moment and keep the old screen up
  let ready: ComponentType<any> | undefined;
  const got = () => load().then((m) => (ready = m[name]));
  const Lazy = lazy(() => got().then((C) => ({ default: C })));
  loaders.push(got);
  return (props: any) => (ready ? createElement(ready, props) : createElement(Lazy, props));
};
const preload = () => { for (const l of loaders) void l().catch(() => undefined); };
const Data = page(() => import('./pages/Data.tsx'), 'Data');
const Envs = page(() => import('./pages/Envs.tsx'), 'Envs');
const Files = page(() => import('./pages/Files.tsx'), 'Files');
const Theme = page(() => import('./pages/Theme.tsx'), 'Theme');
const Live = page(() => import('./pages/Live.tsx'), 'Live');
const Scenarios = page(() => import('./pages/Scenarios.tsx'), 'Scenarios');
const MapView = page(() => import('./pages/MapView.tsx'), 'MapView');
const Mocks = page(() => import('./pages/Mocks.tsx'), 'Mocks');
const Overview = page(() => import('./pages/Overview.tsx'), 'Overview');
const Queues = page(() => import('./pages/Queues.tsx'), 'Queues');
const Mail = page(() => import('./pages/Mail.tsx'), 'Mail');
const Repos = page(() => import('./pages/Repos.tsx'), 'Repos');
const Runs = page(() => import('./pages/Runs.tsx'), 'Runs');
const Studio = page(() => import('./pages/Runs.tsx'), 'Studio');
const Settings = page(() => import('./pages/Settings.tsx'), 'Settings');
const DiagramsManual = page(() => import('./pages/Standard.tsx'), 'DiagramsManual');
const Standard = page(() => import('./pages/Standard.tsx'), 'Standard');
const FlowList = page(() => import('./pages/FlowList.tsx'), 'FlowList');
const Storage = page(() => import('./pages/Storage.tsx'), 'Storage');
const Vars = page(() => import('./pages/Vars.tsx'), 'Vars');
const Docs = page(() => import('./pages/Docs.tsx'), 'Docs');

/** Path words that name a view rather than a thing: `#/docs/flow:x/map`. */
const VIEW: Record<string, string> = { map: 'Mapa', seq: 'Secuencia', op: 'Operación' };

export function App() {
  const route = useRoute();
  const [screen = 'overview', arg] = route;
  const ws = useApi<WorkspaceInfo>('/api/workspace');
  const map = useApi<SystemMap | null>('/api/map');
  const pieces = useApi<KnowledgeData>('/api/knowledge');
  const g = useMemo(() => (map.data ? indexMap(map.data) : null), [map.data]);
  // The browser tab, from the specific to the general: «invoices · public · postgres · local · Bases · Comercio — Laru».
  const screenName = NAV.flatMap(([, items]) => items).find((i) => i.route === screen)?.label ?? ({ flows: 'Flujos', scenarios: 'Escenarios', envs: 'Entornos', data: 'Bases de datos', queues: 'Colas', storage: 'Almacenamiento', live: 'En vivo', studio: 'Estudio' } as Record<string, string>)[screen] ?? screen;
  // Parts that are words rather than names read in Spanish: «Variable sin uso», «Decisión · Nueva pieza», «Editar».
  // «Paso a paso»'s stop moves, and goes, without a hashchange: the tab names the screen, not the stop it opened on
  const parts = splitStop(route.slice(1))[0];
  const said = screen === 'docs' && parts[0] === 'new' ? ['Nueva pieza', pieceLabel(parts[1] ?? ''), ...parts.slice(2).filter((p) => p !== '-')]
    : screen === 'standard' || screen === 'diagrams' ? parts.map(pieceLabel)
    : screen === 'docs' && parts[1] === 't' ? [parts[0], Object.values(TABS_OF).flat().find(([key]) => key === parts[2])?.[1] ?? parts[2]]
    : screen === 'docs' && parts[1] === 'edit' ? [parts[0], 'Editar']
    : parts.map((p) => VIEW[p] ?? p);
  const title = [...said.reverse(), screenName, ws.data?.title].filter(Boolean).join(' · ');
  useEffect(() => { document.title = `${title} — Laru`; }, [title]);
  useEffect(() => { const t = setTimeout(preload, 1500); return () => clearTimeout(t); }, []);

  // A table or a topic lives at its store's address, an endpoint at its service's: put right before anything is drawn.
  useEffect(() => g ? addRouteFix(([s, id]) => { const home = s === 'map' && id ? homeOf(g, id) : id; return home !== id ? href('map', home) : null; }) : undefined, [g]);
  const fronts = g ? frontNodes(g).length : 0;
  const nav = useMenu(route, g, pieces.data, fronts);
  if (ws.gone) return <div className="page"><div className="notice" role="alert"><div><b>Este workspace ya no está registrado en esta máquina.</b> <a className="rowlink" href={HOME}>Ir a todos los workspaces</a></div></div></div>;
  if (ws.error) return <div className="page"><div className="notice">{ws.error}</div></div>;
  const jumps: Jump[] = g ? g.map.nodes.flatMap((n): Jump[] => {
    if (n.type === 'service') return [{ label: n.name, hint: 'Servicio', icon: Server, to: href('map', n.id) }];
    if (n.type === 'repository') return [{ label: n.name, hint: 'Repositorio', icon: GitBranch, to: `#/repos/${n.name}` }];
    if (n.type === 'endpoint') return [{ label: `${n.name}`, hint: g.nodes.get(n.service ?? '')?.name, icon: Waypoints, to: href('map', n.service ?? '') }];
    if (n.type === 'datastore' || n.type === 'external' || n.type === 'table' || n.type === 'topic') return [{ label: n.name, hint: n.type === 'table' ? 'Tabla' : n.type === 'topic' ? 'Tema' : n.kind, icon: n.type === 'external' ? Globe : Database, to: href('map', homeOf(g, n.id)) }];
    return [];
  }) : [];
  // Each piece, and each tab of the classes that have their own sheet: «Compartir › Pruebas».
  const docJumps: Jump[] = (pieces.data?.pieces ?? []).flatMap((p): Jump[] => [
    { label: p.title, hint: pieceLabel(p.type), icon: iconOf(p), to: pageOf(p.id) },
    ...(TABS_OF[p.type] ?? []).filter(([key]) => key !== 'summary').map(([key, label]): Jump => ({ label: `${p.title} › ${label}`, hint: pieceLabel(p.type), icon: iconOf(p), to: href('docs', p.id, 't', key) })),
  ]);
  const counts: Record<string, number> = g ? { repos: g.map.repos.length, map: g.map.nodes.filter((n) => n.type === 'service').length } : {};

  let body;
  if (screen === 'overview') body = <Overview title={ws.data?.title} g={g} />;
  else if (screen === 'mocks') body = <Mocks parts={route.slice(1)} />;
  else if (screen === 'queues') body = <Queues parts={route.slice(1)} />;
  else if (screen === 'mail') body = <Mail parts={route.slice(1)} />;
  else if (screen === 'storage') body = <Storage parts={route.slice(1)} />;
  else if (screen === 'repos') body = <Repos g={g} selected={arg} reloadMap={map.reload} />;
  else if (screen === 'docs') body = <Docs g={g} parts={route.slice(1)} />;
  else if (screen === 'standard') body = <Standard parts={route.slice(1)} />;
  else if (screen === 'diagrams') body = <DiagramsManual parts={route.slice(1)} />;
  else if (screen === 'flows') body = <FlowList />;
  else if (screen === 'envs') body = <Envs selected={arg} g={g} />;
  else if (screen === 'data') body = <Data parts={route.slice(1)} g={g} />;
  else if (screen === 'runs') body = <Runs parts={route.slice(1)} g={g} />;
  else if (screen === 'live') body = <Live parts={route.slice(1)} g={g} />;
  else if (screen === 'scenarios') body = <Scenarios />;
  else if (screen === 'vars') body = <Vars env={arg} app={ws.data?.app ?? '<app>'} repos={ws.data?.repos.map((r) => r.name) ?? []} />;
  else if (screen === 'settings') body = <Settings />;
  else if (screen === 'files') body = <Files />;
  else if (screen === 'theme') body = <Theme />;
  else if (map.loading && !map.data) body = <div className="page"><Skeleton lines={6} /></div>;
  else if (!g) body = <NoMap />;
  else if (screen === 'map') body = <MapView g={g} selected={arg} tabArg={route[2] === 't' ? route[3] : undefined} />;
  else body = <div className="page"><div className="notice">No existe la pantalla «{screen}». <a className="rowlink" href="#/overview">Ir al resumen</a></div></div>;

  // The studio is a screen of its own, on the whole window: no shell, no menu, nothing of the page it came from.
  if (screen === 'studio') return <div className="studio-page"><Guard at={route.join('/')}><Suspense fallback={<div className="page"><Skeleton lines={10} /></div>}><Studio parts={route.slice(1)} g={g} /></Suspense></Guard></div>;
  const explorer = ['data', 'queues', 'storage', 'vars', 'mail'].includes(screen);
  return <Shell app={ws.data?.title ?? '…'} nav={nav} counts={counts} jumps={[...docJumps, ...jumps]} menu={pieces.data ? appMenuOf(pieces.data, fronts) : undefined}>{explorer && /^f-./.test(arg ?? '') && <FromFlow />}<Guard at={route.join('/')}><Suspense fallback={<div className="page"><Skeleton lines={6} /></div>}>{body}</Suspense></Guard></Shell>;
}

/** A screen that throws says so in its place; the shell keeps working, and going elsewhere clears it. */
class Guard extends Component<{ at: string; children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { at: string }) { if (prev.at !== this.props.at && this.state.error) this.setState({ error: undefined }); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="page"><div className="notice" role="alert"><div><b>Esta pantalla falló al dibujarse.</b> <span className="mono">{this.state.error.message}</span><div className="faint notice-sub">El resto de Laru sigue funcionando. Vuelve a cargar la página para intentarlo otra vez.</div></div></div></div>;
  }
}

const NoMap = () => (
  <div className="page"><section className="panel"><div className="empty">Todavía no se ha leído el código. Pulsa «Releer el código» en <a className="rowlink" href="#/repos">Proyectos</a>, o ejecuta <code>laru map</code>.</div></section></div>
);

/** The menu of the address, from what the page has loaded: the reads are the shared cache's, so they cost nothing twice. */
function useMenu(route: string[], g: Indexed | null, k: KnowledgeData | undefined, fronts: number): Menu {
  const [screen, a] = route;
  const thing = Boolean(a) && screen !== 'runs';
  const flows = useApi<FlowInfo[]>(thing && (screen === 'docs' || screen === 'map' || EXPLORERS.includes(screen)) ? '/api/flows' : null);
  const envs = useApi<EnvSummary[]>(thing && (screen === 'envs' || EXPLORERS.includes(screen)) ? '/api/envs' : null);
  const runs = useApi<RunInfo[]>(thing && (screen === 'envs' || screen === 'live' || EXPLORERS.includes(screen)) ? '/api/runs' : null);
  const std = useApi<StandardData>(thing && screen === 'standard' ? '/api/standard' : null);
  const session = useApi<{ id: string; env: string }>(thing && screen === 'live' ? `/api/run?id=${encodeURIComponent(a)}` : null);
  return menuOf(route, { k, g, flows: flows.data, envs: envs.data, runs: runs.data, session: session.data, std: std.data, fronts });
}
