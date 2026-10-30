/**
 * Documentation and flows: the tree of containers with their flows as leaves on the left, the sheet of the selected
 * piece on the right. A container's sheet says whether its flows pass and where its code lives; a flow's sheet plays
 * its latest evidence. Declared, extracted and observed sit together with their origin in sight.
 */
import {
  ChevronDown, ChevronRight, CircleAlert, CornerLeftUp, GitBranch, GitPullRequestArrow, Radio, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Ruler, Users, type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { typeColor } from '../lib/typeColor.ts';
import { frontNodes } from '../lib/fronts.ts';
import { api, useApi, type DocNote, type Finding, type LiveData, type OwedItem, type DocPiece, type EnvSummary, type FlowInfo, type Indexed, type KnowledgeData, type MapNode, type Seen, type WorkspaceInfo } from '../api.ts';
import { ContractReference, DataModelReference, DesignList, type Loaded } from '../components/Contract.tsx';
import { ActionButton, copy, CopyButton, Dot, Method, Origin, Skeleton, Status, Tabs, toast, type DotState } from '../components/ui.tsx';
import { ago, findingText, secs, FINDING, KIND, pieceLabel, SEVERITY, piecesLabel, plural, reasonText, STAGE, STATUS } from '../lib/es.ts';
import { Markdown } from '../lib/md.tsx';
import { href, pageOf, partsOf, splitStop, whereFailed, withStop } from '../lib/route.ts';
import { failedOn, flowDot, FlowPage, FlowTable, lastWord, RunFlows, Spark, usePick, walkers } from './Flows.tsx';
import { useScope, type Scope } from '../lib/scope.ts';
import { Vars } from './Vars.tsx';
import { FlowScope } from '../components/FlowScope.tsx';
import { CODE_OF, CONTAINERS, iconOf, kindsOf, ownFlows, sectionsOf, TABS_OF, TYPE_ICON } from '../lib/pieceMenu.tsx';
import { FlowList } from './FlowList.tsx';
import { Scenarios } from './Scenarios.tsx';
import { Accept, fixPrompt } from '../components/Accept.tsx';
import { ownerOf } from '../lib/findingOwner.ts';
import { PieceForm } from './PieceForm.tsx';
import { AppSummary, Architecture, FidelityByEnv, FlowLists, FlowLive, FlowStart, FrontCards, ModuleCards, PieceKinds, ProjectsEnvs, ReferencedBy, ScenarioExtras, VarLevels } from './Sheets.tsx';
import { DiagramViewer } from '../components/Viewer.tsx';
import type { FlowView } from './Runs.tsx';

const SYSTEM = ['repository', 'service', 'datastore', 'external'];
/** What the tree holds: the application, its modules and processes; services, stores and externals live in the map. */
const TREE = ['application', 'module', 'process'];
/** Below a piece, its children by type first, in this order; the name of each group, under the application and below. */
const TREE_ORDER = ['module', 'process', 'flow'];
const GROUP_NAME: Record<string, [string, string]> = { module: ['Módulos', 'Submódulos'], process: ['Procesos', 'Subprocesos'], flow: ['Flujos', 'Flujos'] };

/** A flow's links: what must run (on the map) and the process it walks (in the documentation). */
const META: Record<string, string> = { needs: 'Necesita', realizes: 'Realiza' };

/** What a flow runs on, in «Detalles»: its projects and env, its scenario, what it needs by kind, and its last run. */
const NEED_KIND: Array<[RegExp, string]> = [[/^svc:/, 'Servicios'], [/^ds:/, 'Almacenes'], [/^ext:/, 'Externos']];
function FlowFacts({ flow, live }: { flow: FlowInfo; live: string }) {
  const row = flow.history.findLast((h) => h.status !== 'error');
  const groups = NEED_KIND.map(([re, label]) => [label, flow.needs.filter((n) => re.test(n))] as const).filter(([, l]) => l.length);
  const other = flow.needs.filter((n) => !NEED_KIND.some(([re]) => re.test(n)));
  return (
    <>
      {flow.projects?.length ? <><dt>Proyectos</dt><dd>{flow.projects.join(' · ')}</dd></> : null}
      <dt>Entorno</dt><dd>{flow.runsOn ? <><span className="mono">{flow.runsOn.env}</span> <span className="faint">({flow.runsOn.ready ? 'listo' : 'se levanta al ejecutar'})</span></> : <span className="faint">ningún entorno tiene sus proyectos: <code>laru env init all --join …</code></span>} · <a className="rowlink" href={live}>aprovisionar el suyo y probar</a></dd>
      <dt>Escenario</dt><dd>{flow.scenario ? <a className="rowlink mono" href={pageOf(flow.scenario)}>{flow.scenario.replace(/^scn:/, '')}</a> : <span className="faint">ninguno</span>}</dd>
      <dt>Necesita</dt><dd>{flow.needs.length ? <div className="need-groups">{[...groups, ...(other.length ? [['Otros', other] as const] : [])].map(([label, l]) => <div key={label}><span className="faint">{label}</span><span className="chips-inline">{l.map((n) => <a key={n} className="chip" href={href('map', n)}>{n.replace(/^\w+:/, '')}</a>)}</span></div>)}</div> : <span className="faint">nada declarado</span>}</dd>
      {row && <><dt>Último run</dt><dd><a className="rowlink mono" href={href('runs', row.run, flow.slug)}>#{row.run}</a> · {ago(row.at)}{row.ms !== undefined ? ` · ${secs(row.ms)}` : ''} <Spark history={flow.history} /></dd></>}
    </>
  );
}
const metaAt = (m: string) => (Object.hasOwn(META, m) ? Object.keys(META).indexOf(m) : 99);
const statusDot = (s: string): DotState => (['active', 'accepted', 'implemented'].includes(s) ? 'ok' : ['deprecated', 'superseded', 'rejected'].includes(s) ? 'idle' : 'queue');

/** Its flows together: one failed, or none failed and one passed, or none ran. */
const rollup = (states: DotState[]): DotState | undefined => (!states.length ? undefined : states.includes('err') ? 'err' : states.includes('ok') ? 'ok' : 'idle');

export function Docs({ g, parts }: { g: Indexed | null; parts: string[] }) {
  const kd = useApi<KnowledgeData>('/api/knowledge');
  const flows = useApi<FlowInfo[]>('/api/flows');
  const envs = useApi<EnvSummary[]>('/api/envs');
  const seen = useApi<Seen>('/api/seen');
  // The tree can be put away to give the sheet the whole width; the choice is kept in this browser.
  const [showTree, setShowTree] = useState(() => { try { return localStorage.getItem('laru.docs.tree') !== 'off'; } catch { return true; } });
  const toggleTree = (on: boolean) => { setShowTree(on); try { localStorage.setItem('laru.docs.tree', on ? 'on' : 'off'); } catch { /* not kept */ } };
  const k = kd.data;
  const byId = useMemo(() => new Map((k?.pieces ?? []).map((p) => [p.id, p])), [k]);
  // «Paso a paso»'s stop sits after a flow's view and test: the player reads it
  const [first, second, third, fourth] = splitStop(parts)[0];
  const app = k?.pieces.find((p) => p.type === 'application');

  // A flow's menu is the route's own business, not the sheet's: it is there while loading, in its sheet and in its edit form.
  const isFlow = Boolean(first?.startsWith('flow:'));
  const flowMenu = isFlow && <FlowScope id={first} active={second === 'edit' ? 'edit' : second === 't' ? (third === 'env' ? 'live' : third ?? 'summary') : 'summary'} p={byId.get(first)} flow={flows.data?.find((f) => f.id === first)} envs={envs.data} app={app?.id} />;
  if (kd.loading && !k) return <><div className="page"><Skeleton lines={6} /></div>{flowMenu}</>;
  if (kd.error || !k) return <div className="page"><div className="notice">{kd.error}</div></div>;

  // A flow written here must reach the flows too, or its page and its container never see it.
  const reload = () => { kd.reload(); flows.reload(); };
  let main;
  if (first === 'new') main = <PieceForm k={k} type={second} parent={third} presetId={fourth} done={(id) => { reload(); location.hash = pageOf(id); }} />;
  else if (second === 'edit' && byId.get(first)) main = <><PieceForm k={k} piece={byId.get(first)!} done={(id) => { reload(); location.hash = pageOf(id); }} />{!isFlow && <EditScope p={byId.get(first)!} />}</>;
  else if (!app) main = <NoApp />;
  else {
    const id = first ?? app.id;
    const piece = byId.get(id);
    main = piece ? <Sheet tabArg={second === 't' ? third : undefined} sub={second === 't' ? fourth : undefined} k={k} g={g} p={piece} byId={byId} reload={reload} flows={flows} envs={envs.data} seen={seen} view={second === 'map' || second === 'seq' ? second : undefined} test={second === 'map' || second === 'seq' ? third : undefined} op={second === 'op' ? third : undefined} />
      : <div className="page"><div className="notice">No hay ninguna pieza «{id}».</div></div>;
  }
  return (
    <div className={`docs${showTree ? '' : ' no-tree'}`}>
      {showTree && <DocsTree k={k} flows={flows.data} current={first === 'new' ? third : first ?? app?.id} onHide={() => toggleTree(false)} />}
      <div className="sheet">{!showTree && <button className="btn sm tree-show" onClick={() => toggleTree(true)} title="Mostrar el árbol de documentación"><PanelLeftOpen />Árbol</button>}{main}{flowMenu}</div>
    </div>
  );
}

/** While a piece is being edited, the menu keeps a way back to it. */
function EditScope({ p }: { p: DocPiece }) {
  useScope({ back: { label: p.title, to: pageOf(p.id) }, card: { icon: iconOf(p), kind: 'Editando', title: p.title }, sections: [], active: '' });
  return null;
}

const NoApp = () => (
  <div className="page"><div className="head"><div><h1>Documentación</h1><p>El árbol empieza por el aplicativo: su propósito, sus usuarios y su alcance. Lo demás cuelga de él.</p></div>
    <div className="actions"><a className="btn primary" href={href('docs', 'new', 'application', '-')}><Plus />Documentar el aplicativo</a></div></div>
    <section className="panel"><div className="empty">También puede escribirlo Claude: <code>knowledge_write({'{'} type: "application", … {'}'})</code></div></section></div>
);

/* ---------------------------------- tree ---------------------------------- */

const SAY: Record<DotState, string> = { err: 'falla', ok: 'sus flujos pasan', idle: 'sus flujos no han corrido', run: '', queue: '' };

/**
 * The application, its modules and processes, each with its flows as leaves: the tree doubles as a test explorer.
 * One glyph per row (shape and words, never colour alone); one tab stop, arrows to move, Enter to open.
 */
function DocsTree({ k, flows, current, onHide }: { k: KnowledgeData; flows?: FlowInfo[]; current?: string; onHide: () => void }) {
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'' | 'err' | 'idle' | 'ok'>('');
  // The branches the person closed stay closed: kept in this browser, so leaving and coming back finds the tree as it was left.
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('laru.docs.closed') ?? '[]') as string[]); } catch { return new Set(); } });
  useEffect(() => { try { localStorage.setItem('laru.docs.closed', JSON.stringify([...closed])); } catch { /* not kept */ } }, [closed]);
  const [focus, setFocus] = useState<string>();
  const box = useRef<HTMLElement>(null);
  const byFlow = new Map((flows ?? []).map((f) => [f.id, f]));
  const app = k.pieces.find((p) => p.type === 'application');
  const kids = (id: string) => k.pieces.filter((p) => p.parent === id && (TREE.includes(p.type) || p.type === 'flow')).sort((a, b) => TREE_ORDER.indexOf(a.type) - TREE_ORDER.indexOf(b.type));
  // Opening a piece opens the branches above it.
  useEffect(() => {
    const up: string[] = [];
    // and the group of each one's type in its parent (`<parent>#<type>`), when it was folded
    for (let p = k.pieces.find((x) => x.id === current); p; p = k.pieces.find((x) => x.id === p!.parent)) { up.push(p.id); if (p.parent) up.push(`${p.parent}#${p.type}`); }
    setClosed((s) => (up.some((id) => s.has(id)) ? new Set([...s].filter((id) => !up.includes(id))) : s));
  }, [current, k]);
  // Opening another piece puts the tab stop back on it.
  useEffect(() => setFocus(undefined), [current]);
  // Filtering by what the flows did: a flow stays if its last run is that, a container if one of its flows below does.
  const flowOk = (id: string) => !only || flowDot(byFlow.get(id)) === only;
  const below = (id: string): boolean => kids(id).some((c) => (c.type === 'flow' ? flowOk(c.id) : below(c.id)));
  const match = (p: { title?: string; id: string; type?: string }) => (only && (p.type === 'flow' ? !flowOk(p.id) : !below(p.id))) ? false : !q || `${p.id} ${p.title ?? ''}`.toLowerCase().includes(q.toLowerCase());
  // whether a piece shows, itself or through something below it that the filter keeps
  const seen = (p: DocPiece): boolean => match(p) || (p.type !== 'flow' && kids(p.id).some(seen));
  const toggle = (id: string, open: boolean) => setClosed((s) => { const n = new Set(s); if (open) n.delete(id); else n.add(id); return n; });

  const flowSaid = (id: string) => {
    const f = byFlow.get(id);
    if (!f?.exists) return 'sin prueba';
    if (!f.last) return 'sin ejecutar';
    return `${f.last.status === 'failed' ? 'falló' : 'pasó'} en el run ${f.last.run}`;
  };
  const state = (p: DocPiece): DotState | undefined => (!flows ? undefined : p.type === 'flow' ? flowDot(byFlow.get(p.id)) : rollup(ownFlows(k, p.id).map((id) => flowDot(byFlow.get(id)))));

  // The rows in the order they are seen, for the keyboard.
  const rows: Array<{ id: string; parent?: string; kids: number; open: boolean }> = [];
  const node = (p: DocPiece, depth: number, parent?: string): ReactNode => {
    const children = p.type === 'flow' ? [] : kids(p.id);
    const open = !closed.has(p.id);
    const shown = match(p);
    if (shown) rows.push({ id: p.id, parent, kids: children.length, open });
    const Icon = iconOf(p);
    const st = state(p);
    return (
      <li key={p.id} role="none">
        {shown && (
          <div className="node" role="treeitem" data-id={p.id} tabIndex={-1} aria-current={p.id === current ? 'true' : undefined} aria-expanded={children.length ? open : undefined}
            style={{ paddingLeft: 4 + depth * 14 }} onClick={() => { setFocus(p.id); location.hash = href('docs', p.id); }}>
            <span className="tw" onClick={(e) => { if (!children.length) return; e.stopPropagation(); toggle(p.id, !open); }}>
              {children.length ? (open ? <ChevronDown /> : <ChevronRight />) : null}
            </span>
            <Icon /><span className="label">{p.title}</span>
            {p.type === 'flow' && <span className="sr-only">, flujo, {flowSaid(p.id)}</span>}
            {p.type !== 'flow' && st && <span className="sr-only">, {SAY[st]}</span>}
            {p.freshness === 'stale' && <CircleAlert size={13} color="var(--run)" aria-label="Desactualizado" />}
            {p.type !== 'flow' && <NoteChip note={p.note} shown={p.sheet?.shown} />}
            {st && <Dot state={st} />}
          </div>
        )}
        {children.length > 0 && open && <ul role="group">{(() => {
          // grouped by type, each group named, when there is more than one kind below; one kind needs no name
          const types = TREE_ORDER.filter((t) => children.some((c) => c.type === t));
          const draw = (c: DocPiece) => node(c, depth + 1, shown ? p.id : parent);
          if (types.length < 2) return children.map(draw);
          return types.map((t) => {
            const name = GROUP_NAME[t][p.type === 'application' ? 0 : 1];
            const items = children.filter((c) => c.type === t);
            // a group folds as the menu's do: its key is the parent's and the type's, among the branches closed
            const key = `${p.id}#${t}`, gopen = !closed.has(key);
            return (
              <li key={t} role="none">
                {/* shown whenever something in it matches, even with its parent filtered out: else a folded group's matches could not be reached */}
                {items.some(seen) && (
                  <button type="button" className="tree-type" aria-expanded={gopen} onClick={() => toggle(key, !gopen)} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
                    <ChevronDown aria-hidden="true" /><span className="name">{name}</span><span className="count num">{items.length}</span>
                  </button>
                )}
                {gopen && <ul role="group" aria-label={name}>{items.map(draw)}</ul>}
              </li>
            );
          });
        })()}</ul>}
      </li>
    );
  };
  const tree = app ? node(app, 0) : null;
  const stop = rows.find((r) => r.id === focus)?.id ?? rows.find((r) => r.id === current)?.id ?? rows[0]?.id;
  // One tab stop: the row the keyboard is on (the one open, at first).
  useEffect(() => { box.current?.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach((el) => { el.tabIndex = el.dataset.id === stop ? 0 : -1; }); });

  const onKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.id === (e.target as HTMLElement).dataset.id);
    if (i < 0) return;
    const r = rows[i];
    let to: string | undefined;
    if (e.key === 'ArrowDown') to = rows[i + 1]?.id;
    else if (e.key === 'ArrowUp') to = rows[i - 1]?.id;
    else if (e.key === 'Home') to = rows[0]?.id;
    else if (e.key === 'End') to = rows.at(-1)?.id;
    else if (e.key === 'ArrowRight') { if (r.kids && !r.open) toggle(r.id, true); else if (r.kids) to = rows[i + 1]?.id; }
    else if (e.key === 'ArrowLeft') { if (r.kids && r.open) toggle(r.id, false); else to = r.parent; }
    else if (e.key === 'Enter') location.hash = href('docs', r.id);
    else return;
    e.preventDefault();
    if (!to) return;
    setFocus(to);
    box.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(to)}"]`)?.focus();
  };

  return (
    <aside className="tree" aria-label="Árbol de documentación" ref={box}>
      <div className="tree-tools"><button className="icon-btn" onClick={onHide} aria-label="Ocultar el árbol" title="Ocultar el árbol"><PanelLeftClose /></button><input className="tree-filter" placeholder="Filtrar el árbol" aria-label="Filtrar el árbol" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="tree-state" aria-label="Filtrar por el estado de los flujos" value={only} onChange={(e) => setOnly(e.target.value as typeof only)}><option value="">Todos</option><option value="err">Fallan</option><option value="idle">Sin ejecutar</option><option value="ok">Pasan</option></select></div>
      {app ? <ul role="tree" aria-label="Documentación y flujos" onKeyDown={onKey}>{tree}</ul> : <div className="empty">Sin documentar todavía.</div>}
    </aside>
  );
}

/* ---------------------------------- sheet --------------------------------- */

type Flows = { data?: FlowInfo[]; error?: string; loading: boolean };

/** What is read from the code, apart from what is written: the sections that look like the pieces' but come from the repositories. */
const FROM_CODE = new Set(['interfaces', 'data', 'tests', 'vars', 'code']);
/**
 * What the code says about a module lives with the piece that says it in writing, not in a section of its own: the endpoints
 * in the contracts, the tables and dependencies in the data models, the tests in the test plans, the variables in the secrets.
 */
const KIND_OF_CODE: Record<string, string> = { interfaces: 'contract', data: 'data-model', tests: 'test-plan', vars: 'secrets' };

function Sheet({ k, g, p, byId, reload, flows, envs, seen, view, test, op, tabArg, sub }: { k: KnowledgeData; g: Indexed | null; p: DocPiece; byId: Map<string, DocPiece>; reload: () => void; flows: Flows; envs?: EnvSummary[]; seen: Loaded<Seen>; view?: FlowView; test?: string; op?: string; tabArg?: string; sub?: string }) {
  // «Entorno» was folded into «Probar en vivo»: an old address still lands there.
  const asked = p.type === 'module' && tabArg && KIND_OF_CODE[tabArg] ? `p-${KIND_OF_CODE[tabArg]}` : tabArg === 'env' ? 'live' : (p.type === 'application' && (tabArg === 'built' || tabArg === 'gov' || tabArg === 'rel')) || (p.type === 'module' && tabArg === 'built') ? undefined : tabArg;
  const [tab, setTab] = useState<string>(asked ?? 'summary');
  useEffect(() => setTab(asked ?? 'summary'), [p.id, op, asked]);
  // The tab is in the address so a sheet can be linked and ⌘K can open it; replacing it does not add a history entry.
  // Each section is a step of its own in the history: «atrás» goes back to the section before, not out of the sheet.
  const pick = (key: string) => { setTab(key); if (TABS_OF[p.type]) location.hash = key === 'summary' ? href('docs', p.id) : href('docs', p.id, 't', key); };
  const chain: DocPiece[] = [];
  for (let x = byId.get(p.parent ?? ''); x; x = byId.get(x.parent ?? '')) chain.unshift(x);
  const { facets: all, inherited } = facetsOf(k, p);
  // Flows are in the tree and in «Estado»: the facets are the rest.
  const facets = all.filter((f) => f.type !== 'flow');
  const flow = p.type === 'flow' ? flows.data?.find((f) => f.id === p.id) : undefined;
  const Icon = iconOf(p);
  // Every kind of piece that may live in this one has its own section, with what there is and a way to add: nobody has to know where a decision goes.
  const under = (x: DocPiece): boolean => { for (let c = byId.get(x.parent ?? ''); c; c = byId.get(c.parent ?? '')) if (c.id === p.id) return true; return false; };
  const kinds = kindsOf(k, byId, p, tab.startsWith('p-') ? tab.slice(2) : undefined);
  const counts: Record<string, number | undefined> = { modules: k.pieces.filter((x) => x.parent === p.id && x.type === 'module').length, processes: k.pieces.filter((x) => x.parent === p.id && x.type === 'process').length, flows: ownFlows(k, p.id).length, owed: (p.sheet?.owed.length ?? 0), code: p.anchors?.length };
  const nFronts = g ? frontNodes(g).length : 0;
  const tabs = [
    ...(TABS_OF[p.type] ? TABS_OF[p.type].filter(([key]) => (key !== 'fronts' || nFronts) && (key !== 'processes' || counts.processes)).map(([key, label]) => ({ key, label, n: key === 'fronts' ? nFronts : counts[key] })) : []),
    ...kinds.map((x) => ({ key: `p-${x.type}`, label: piecesLabel(x.type), n: x.n || undefined })),
    ...(TABS_OF[p.type] ? [] : [{ key: 'summary', label: p.type === 'contract' || p.type === 'data-model' ? 'Referencia' : 'Resumen' }]),
    ...(['service'].includes(p.type) && p.anchors?.length ? [{ key: 'interfaces', label: 'Interfaces' }, { key: 'tests', label: 'Pruebas' }, { key: 'vars', label: 'Variables y secretos' }] : []),
    ...(CONTAINERS.includes(p.type) && !TABS_OF[p.type] ? [{ key: 'facets', label: 'Facetas', n: facets.length + inherited.length }] : []),
    ...(p.anchors?.length && !TABS_OF[p.type] ? [{ key: 'code', label: 'Código', n: p.anchors.length }] : []),
  ];
  // The menu is the container's: this piece's own, or the nearest one above it that has sections (a stack opened from the application keeps the application's menu).
  const owner = TABS_OF[p.type] && (p.type as string) !== 'flow' ? p : (p.type as string) === 'flow' ? undefined : [...chain].reverse().find((x) => TABS_OF[x.type] && (x.type as string) !== 'flow');
  const toCode = () => { setTab('code'); requestAnimationFrame(() => document.getElementById('piece-tab-code')?.focus()); };
  return (
    <div className="page">
      {owner && <ContainerScope k={k} byId={byId} owner={owner} fronts={nFronts} active={owner === p ? tab : `p-${p.type}`} />}
      <nav className="crumbs" aria-label="Ruta">{[...chain, p].map((x, i) => <span key={x.id} style={{ display: 'contents' }}>{i > 0 && <ChevronRight />}<a href={pageOf(x.id)}>{x.title}</a></span>)}</nav>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <span className="type-badge" style={{ '--c': typeColor(p.type) } as React.CSSProperties}><Icon />{pieceLabel(p.type)}{p.kind ? `, ${KIND[p.kind] ?? p.kind}` : ''}</span>
          <h1 style={{ marginTop: 10 }}>{p.title}</h1>
          <p>{p.summary}</p>
          <div className="idline">
            <Status state={statusDot(p.status)}>{STATUS[p.status] ?? p.status}</Status>
            <details className="meta-more"><summary>Detalles</summary>
              <dl className="piece-facts">
                <dt>Id</dt><dd className="idline"><code>{p.id}</code><CopyButton value={p.id} label="Copiar el id" /></dd>
                <dt>Fichero</dt><dd className="mono">{p.path}</dd>
                {p.owner && <><dt>Dueño</dt><dd><Users size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{p.owner} <Origin of="declared" /></dd></>}
                {p.type === 'flow' && flow && <FlowFacts flow={flow} live={href('docs', p.id, 't', 'live')} />}
              </dl>
            </details>
          </div>
        </div>
        <div className="actions" style={{ position: 'relative' }}>
          {p.type === 'flow' && (
            <>
              <div className="act-g"><small>Tú usas la aplicación y Laru lo registra</small><div className="act-row"><a className="btn primary" href={href('docs', p.id, 't', 'live')}><Radio />Probar en vivo</a></div></div>
              <div className="act-g"><small>Corre sola y deja evidencia</small><div className="act-row"><RunFlows chosen={flow ? [flow] : []} envs={envs} single /></div></div>
            </>
          )}
          {p.type !== 'flow' && <a className="btn" href={href('docs', p.id, 'edit')}><Pencil />Editar</a>}
          {CONTAINERS.includes(p.type) && <AddMenu k={k} p={p} />}
        </div>
      </div>
      <Stale p={p} reload={reload} />
      {p.type !== 'application' && <Owed k={k} p={p} />}
      {p.type === 'flow' ? (
        <>
          <Tabs id="piece" label={`Secciones de ${p.title}`} value={tab} onChange={pick} tabs={tabs} className="tabs piece-tabs" />
          <div role="tabpanel" id="piece-panel" aria-labelledby={`piece-tab-${tab}`}>
            {tab === 'summary' && (
              <>
                <FlowPage g={g} flow={flow} error={flows.error} loading={flows.loading} view={view} test={test} k={k} address={(v, t) => href('docs', p.id, v, ...(t ? [t] : []))}
                  onView={(v) => {
                    // the test and the stop «Paso a paso» wrote (without a hashchange) stay in the address
                    const [rest, stop] = splitStop(partsOf(location.hash));
                    const t = rest[1] === p.id && (rest[2] === 'map' || rest[2] === 'seq') ? rest[3] : test;
                    location.replace(withStop(href('docs', p.id, v, ...(t ? [t] : [])), stop));
                  }} />
              </>
            )}
            {tab === 'live' && <>{!sub && <><FlowStart k={k} p={p} flow={flow} envs={envs} /><div style={{ height: 16 }} /></>}<FlowLive p={p} flow={flow} g={g} sid={sub} /></>}
            {tab === 'doc' && <><p style={{ margin: '0 0 12px' }}><a className="btn sm" href={href('docs', p.id, 'edit')}><Pencil />Editar el flujo</a></p><section className="about" aria-labelledby="about-h"><h2 id="about-h" className="section-h">Sobre este flujo</h2><PieceFields k={k} p={p} /></section><section className="about"><h2 className="section-h">Lo que se calcula</h2><FlowLists p={p} flow={flow} /></section><ReferencedBy k={k} p={p} /></>}
          </div>
        </>
      ) : (
        <>
          {/* a process's state and its flows, which the tree no longer shows */}
          {p.type === 'process' && <Estado key={p.id} k={k} g={g} p={p} flows={flows} envs={envs} toCode={toCode} />}
          {CONTAINERS.includes(p.type) && p.type !== 'application' && p.type !== 'module' && <DesignList k={k} g={g} p={p} seen={seen.data} />}
          <Tabs id="piece" label={`Secciones de ${p.title}`} value={tab} onChange={pick} tabs={tabs} className="tabs piece-tabs" />
          <div role="tabpanel" id="piece-panel" aria-labelledby={`piece-tab-${tab}`}>
            {p.type === 'application' && tab === 'summary' && <AppSummary k={k} p={p} g={g} flows={flows.data} envs={envs} />}
            {p.type === 'application' && tab === 'arch' && <Architecture />}
            {p.type === 'application' && tab === 'modules' && <ModuleCards k={k} p={p} />}
            {p.type === 'application' && tab === 'processes' && <ModuleCards k={k} p={p} type="process" />}
            {p.type === 'application' && tab === 'fronts' && <FrontCards g={g} envs={envs} />}
            {p.type === 'application' && tab === 'flows' && <><Scenarios embedded /><div style={{ height: 24 }} /><FlowList embedded /></>}
            {p.type === 'application' && tab === 'envs' && <ProjectsEnvs k={k} g={g} envs={envs} />}
            {tab.startsWith('p-') && <PieceList k={k} p={p} type={tab.slice(2)} under={under} />}
            {p.type === 'module' && tab.startsWith('p-') && CODE_OF[tab.slice(2)] === 'interfaces' && <><div style={{ height: 16 }} /><LiveTab p={p} which="interfaces" /><div style={{ height: 16 }} /><PieceFields k={k} p={p} only={['interfaces']} /></>}
            {p.type === 'module' && tab === 'p-data-model' && <><div style={{ height: 16 }} /><DiagramViewer id={`er:${p.id}`} height={380} /><div style={{ height: 16 }} /><LiveTab p={p} which="data" /><section className="panel" style={{ marginTop: 16 }}><header><h3>Dependencias declaradas</h3><div className="meta"><Origin of="declared" /></div></header>{(p.relations?.depends_on ?? []).length ? <ul className="plain body">{p.relations!.depends_on!.map((d) => <li key={d}><a className="rowlink mono" href={pageOf(d)}>{d}</a></li>)}</ul> : <div className="empty">No declara dependencias (<code>depends_on</code>).</div>}</section></>}
            {p.type === 'module' && tab === 'p-test-plan' && <><div style={{ height: 16 }} /><LiveTab p={p} which="tests" /></>}
            {p.type === 'application' && tab === 'p-secrets' && <AppVars />}
            {p.type === 'module' && tab === 'p-secrets' && <><div style={{ height: 16 }} /><LiveTab p={p} which="vars" /></>}
            {p.type === 'application' && tab === 'owed' && <Owed k={k} p={p} />}
            {p.type === 'application' && tab === 'doc' && <><PieceFields k={k} p={p} /><div style={{ height: 16 }} /><ReferencedBy k={k} p={p} /></>}
            {p.type === 'module' && tab === 'built' && <PieceFields k={k} p={p} only={['built', 'design', 'submodules']} empty="Todavía no se ha escrito cómo está construido." />}
            {p.type === 'module' && tab === 'flows' && <><h2 className="section-h">Escenarios</h2><FacetList k={k} facets={facets.filter((f) => f.type === 'scenario')} inherited={[]} /><h2 className="section-h" style={{ marginTop: 20 }}>Flujos</h2><Estado key={p.id} k={k} g={g} p={p} flows={flows} envs={envs} toCode={toCode} /></>}
            {p.type === 'module' && tab === 'code' && <><CodePanel p={p} g={g} flows={flows.data} /></>}
            {p.type === 'module' && tab === 'owed' && <Owed k={k} p={p} />}
            {p.type === 'module' && tab === 'doc' && <><PieceFields k={k} p={p} /><div style={{ height: 16 }} /><FacetList k={k} facets={facets} inherited={inherited} /><div style={{ height: 16 }} /><ReferencedBy k={k} p={p} /><div style={{ height: 16 }} /></>}
            {p.type !== 'application' && tab === 'summary' && (p.type === 'contract' ? <ContractReference k={k} g={g} p={p} seen={seen} focus={op} />
              : p.type === 'data-model' ? <DataModelReference p={p} g={g} />
              : <>{p.type === 'module' && ((p.fields.usecases as Array<Record<string, string>> | undefined)?.length ?? 0) > 0 && <UseCases p={p} flows={flows.data} />}{/* a module's summary keeps how it is built, its diagram with it: «Construcción» left the menu for Documento, and the drawing went with it */}<PieceFields k={k} p={p} skip={p.type === 'module' ? ['usecases', 'interfaces', 'submodules'] : undefined} />{p.type === 'scenario' && <><div style={{ height: 16 }} /><ScenarioExtras k={k} p={p} envs={envs} /></>}<div style={{ height: 16 }} />{p.type === 'infrastructure' && <><FidelityByEnv envs={envs} /><div style={{ height: 16 }} /></>}<ReferencedBy k={k} p={p} />{p.type !== 'module' && <><div style={{ height: 16 }} /></>}</>)}
            {((tab === 'interfaces' && p.type !== 'module') || tab === 'tests' || tab === 'vars') && <LiveTab p={p} which={tab as 'interfaces' | 'tests' | 'vars'} />}
            {tab === 'facets' && <FacetList k={k} facets={facets} inherited={inherited} />}
            {tab === 'code' && p.type !== 'module' && <CodePanel p={p} g={g} flows={flows.data} />}
          </div>
        </>
      )}
    </div>
  );
}


/** The application's secrets: the pieces that say where they live, and the variables and secrets of every env, edited here (one place for both). */
function AppVars() {
  const ws = useApi<WorkspaceInfo>('/api/workspace');
  return <Vars app={ws.data?.app ?? '<app>'} repos={ws.data?.repos.map((r) => r.name) ?? []} />;
}

/** One kind of piece under this one: what there is, and a way to write the next. */
function PieceList({ k, p, type, under }: { k: KnowledgeData; p: DocPiece; type: string; under: (x: DocPiece) => boolean }) {
  const list = k.pieces.filter((x) => x.type === type && under(x));
  const I = iconOf({ type });
  return (
    <section className="panel">
      <header><h3 style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><I size={16} />{piecesLabel(type)}</h3>
        <div className="meta"><span className="faint">{k.shapes[type as keyof typeof k.shapes]?.question}</span><a className="btn sm" href={href('docs', 'new', type, p.id)}><Plus />Crear {pieceLabel(type).toLowerCase()}</a></div></header>
      {list.length ? (
        <ul className="feed">{list.map((x) => (
          <li key={x.id}><a className="main rowlink" href={pageOf(x.id)}>{x.title}</a><span className="faint">{STATUS[x.status] ?? x.status}</span><NoteChip note={x.note} /></li>
        ))}</ul>
      ) : <div className="empty">Todavía no hay {piecesLabel(type).toLowerCase()} aquí.</div>}
    </section>
  );
}



/** The side menu of a container: a module keeps its own, with a way back; the application's is the main menu, which lights its section up. A piece opened from it keeps that menu. */
function ContainerScope({ k, byId, owner, active, fronts }: { k: KnowledgeData; byId: Map<string, DocPiece>; owner: DocPiece; active: string; fronts: number }) {
  const parent = byId.get(owner.parent ?? '');
  const Icon = iconOf(owner);
  useScope({
    back: parent ? { label: parent.title, to: pageOf(parent.id) } : { label: 'Resumen', to: href('overview') },
    card: { icon: Icon, kind: pieceLabel(owner.type), title: owner.title },
    sections: sectionsOf(k, byId, owner, active.startsWith('p-') ? active.slice(2) : undefined, fronts),
    active,
    ...(owner.type === 'application' ? { app: true } : {}),
  });
  return null;
}

/** The document's note: a number, always with its words, and a shape of its own so colour is never the only signal. */
export const noteLevel = (n: number) => (n >= 80 ? 'good' : n >= 50 ? 'mid' : 'low');
export function NoteChip({ note, long, shown }: { note: DocNote; long?: boolean; shown?: number }) {
  const score = shown ?? note.score;
  // A perfect note says nothing; only what still owes something is shown.
  if (score >= 100) return null;
  const lvl = noteLevel(score);
  return <span className={`note note-${lvl}`} title={`${shown === undefined ? 'Nota del documento' : 'El menor de la nota del documento y la de la hoja'}: ${score} de 100${note.owed.length ? `; debe ${note.owed.length}` : ''}`}><span aria-hidden>{lvl === 'good' ? '●' : lvl === 'mid' ? '◐' : '○'}</span>{long ? `Nota ${score}` : score}<span className="sr-only"> de 100</span></span>;
}

/** What a piece still owes, in the words of its sections. */
export function owedText(k: KnowledgeData, p: DocPiece, o: DocNote['owed'][number]): string {
  const heading = k.shapes[p.type].fields.find((f) => o.at === `fields.${f.name}`)?.heading ?? o.at;
  if (o.key === 'required') return `Falta «${heading}».`;
  if (o.key === 'diagram-missing') return `Falta el diagrama de «${heading}».`;
  if (o.key === 'min-words') return `«${heading}» necesita al menos ${o.params?.min} palabras.`;
  if (o.key === 'summary-short') return `El resumen debe decir algo: al menos ${o.params?.min} caracteres.`;
  if (o.key === 'relation-expected') return `Declara la relación ${o.params?.relation}.`;
  return o.at;
}
/** One thing a container still owes, in words. */
export function owedItemText(k: KnowledgeData, p: DocPiece, o: OwedItem): string {
  if (o.key.startsWith('doc-')) return owedText(k, p, { key: o.key.slice(4), at: o.at ?? '', weight: o.weight, ok: false, params: o.params });
  const prm = o.params ?? {};
  if (o.key === 'anchors') return 'Ánclalo al código del que habla: repo:ruta/**, y que encuentre ficheros.';
  if (o.key === 'usecase-flow') return `El caso «${prm.case}» no tiene un flujo que lo pruebe.`;
  if (o.key === 'contract') return `Su código expone ${prm.endpoints} endpoints y ningún contrato los declara.`;
  if (o.key === 'test-plan') return 'Le falta un plan de pruebas.';
  if (o.key === 'submodule-named') return `Nombra ${prm.id} en «Submódulos».`;
  if (o.key === 'child-sheet') return `La hoja de ${prm.id} aún no está al 100.`;
  if (o.key === 'data-model') return 'Le falta el modelo de datos del conjunto.';
  if (o.key === 'plan') return 'Está en diseño: le falta un plan.';
  if (o.key === 'modules') return 'El aplicativo no tiene ningún módulo.';
  if (o.key.startsWith('has-')) return `Falta ${pieceLabel(o.key.slice(4)).toLowerCase()}.`;
  if (o.key === 'retired-decision') return 'Está retirado: falta la decisión que lo retiró.';
  if (o.key.startsWith('stage-') && o.stage) {
    const rest = o.key.slice(`stage-${o.stage}-`.length);
    return `${STAGE[o.stage]}: ${reasonText({ key: rest, params: prm, text: rest })}`;
  }
  return o.key;
}

const SEV_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };
/** «Lo que debe»: what the piece still owes, structure and contrast, each with its way out. */
function Owed({ k, p }: { k: KnowledgeData; p: DocPiece }) {
  const [accepting, setAccepting] = useState<OwedItem | null>(null);
  const [acceptingFinding, setAcceptingFinding] = useState<Finding | null>(null);
  // Findings (code, documentation and runs disagreeing) live with the piece they are about; the rest, with the application.
  const fl = useApi<Finding[]>(CONTAINERS.includes(p.type) ? '/api/findings' : null);
  const ids = useMemo(() => new Set(k.pieces.map((x) => x.id)), [k]);
  const appId = k.pieces.find((x) => x.type === 'application')?.id ?? '';
  const mine = (fl.data ?? []).filter((f) => !f.accepted && ownerOf(f.subject, ids, appId) === p.id).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const items: OwedItem[] = p.sheet?.items ?? p.note.owed.map((o) => ({ key: `doc-${o.key}`, kind: 'structure' as const, at: o.at, weight: o.weight, ok: false, params: o.params, action: 'complete' as const }));
  const owed = items.filter((i) => !i.ok), done = items.filter((i) => i.ok && i.accepted);
  if (!owed.length && !done.length && !mine.length) return null;
  const go = (i: OwedItem) => i.action === 'create' && i.create ? <a className="btn sm" href={href('docs', 'new', i.create, p.id)}>Crear</a>
    : i.action === 'run' ? <button className="btn sm" onClick={() => document.getElementById('estado-h')?.scrollIntoView({ block: 'start' })}>Ejecutar</button>
    : i.action === 'review' ? <a className="btn sm" href={href('docs', p.id, 'edit')}>Revisar</a>
    : i.action === 'complete' ? <a className="btn sm" href={href('docs', p.id, 'edit')}>Completar</a> : null;
  return (
    <details className="owed" open={owed.length + mine.length > 0 && owed.length + mine.length <= 8}>
      <summary id="owed-h" title="Cada cosa que falta baja una de las dos notas">Lo que debe ({owed.length + mine.length})</summary>
      <ul className="owed-list">
        {owed.map((i, n) => (
          <li key={n}><span className="owed-kind">{i.kind === 'structure' ? 'Estructura' : 'Contraste'}</span><span className="owed-text">{owedItemText(k, p, i)}</span>
            <span className="owed-btns">{go(i)}{i.accept && <button className="btn sm" onClick={() => setAccepting(i)}>Aceptar con motivo</button>}</span></li>
        ))}
      </ul>
      {mine.length > 0 && (
        <ul className="owed-list">{mine.map((f) => (
          <li key={f.key}><span className="owed-kind">Hallazgo</span>
            <span className="owed-text"><span className={`sev ${SEVERITY[f.severity].cls}`}><i aria-hidden="true" />{SEVERITY[f.severity].label}</span> {FINDING[f.type] ?? f.type}: {findingText(f)}</span>
            <span className="owed-btns"><button className="btn sm" onClick={() => setAcceptingFinding(f)}>Aceptar con motivo</button>
              <button className="btn sm" onClick={() => copy(fixPrompt(f, k.pieces.find((x) => x.type === 'application')?.title ?? ''), 'Copiado: pégalo en Claude Code y lo coge el agente developer')}>Pedir arreglo</button></span></li>
        ))}</ul>
      )}
      {done.length > 0 && <details className="owed-done"><summary>Aceptados ({done.length})</summary><ul>{done.map((i, n) => <li key={n}>{owedItemText(k, p, i)} <span className="faint">— {i.accepted!.reason}{i.accepted!.until ? `. Hasta el ${i.accepted!.until}` : ''}</span></li>)}</ul></details>}
      {acceptingFinding && <Accept f={{ key: acceptingFinding.key, title: 'el hallazgo', text: `${FINDING[acceptingFinding.type] ?? acceptingFinding.type}. ${findingText(acceptingFinding)}` }} onClose={() => setAcceptingFinding(null)} onDone={() => { setAcceptingFinding(null); fl.reload(); }} />}
      {accepting && <Accept f={{ key: accepting.accept!, title: pieceLabel(p.type).toLowerCase(), text: owedItemText(k, p, accepting) }} onClose={() => setAccepting(null)} onDone={() => location.reload()} />}
    </details>
  );
}

/** Each thing a person does with a module, the flow that proves it and how that flow went the last time. */
function UseCases({ p, flows }: { p: DocPiece; flows?: FlowInfo[] }) {
  const rows = p.fields.usecases as Array<Record<string, string>>;
  const byId = new Map((flows ?? []).map((f) => [f.id, f]));
  return (
    <section className="panel" style={{ marginBottom: 16 }}><header><h3>Casos de uso</h3><div className="meta"><Origin of="declared" /></div></header>
      <div className="body scroll-x"><table className="t"><thead><tr><th>Caso</th><th>Actor</th><th>Flujo</th><th>Último run</th></tr></thead><tbody>
        {rows.map((r, i) => {
          const f = r.flow ? byId.get(r.flow) : undefined;
          return <tr key={i}><td className="wrap">{r.case}</td><td>{r.actor}</td>
            <td>{r.flow ? <a className="rowlink mono" href={pageOf(r.flow)}>{r.flow}</a> : <span className="pending">sin flujo</span>}</td>
            <td>{!r.flow ? '—' : !f ? 'cargando…' : f.last ? <Status state={flowDot(f)}>{f.last.status === 'failed' ? 'falló' : 'pasó'} · run {f.last.run}</Status> : 'sin ejecutar'}</td></tr>;
        })}
      </tbody></table></div></section>
  );
}

/** What the code of a module says, next to what is written: interfaces, tests by name, variables (never their values). */
function LiveTab({ p, which }: { p: DocPiece; which: 'interfaces' | 'data' | 'tests' | 'vars' }) {
  const live = useApi<LiveData>(`/api/live?id=${encodeURIComponent(p.id)}`);
  if (live.loading && !live.data) return <section className="panel"><div className="body"><Skeleton lines={4} /></div></section>;
  const d = live.data;
  if (live.error || !d) return <section className="panel"><div className="empty">{live.error ?? 'Sin datos del código: pulsa «Releer el código» en Proyectos.'}</div></section>;
  const at = (file: string, line?: number) => <span className="mono faint">{file}{line ? `:${line}` : ''}</span>;
  if (which === 'interfaces') return (
    <>
      <section className="panel"><header><h3>Endpoints de su código</h3><div className="meta"><Origin of="extracted" /></div></header>
        {d.endpoints.length || d.declaredOnly.length ? <div className="body scroll-x"><table className="t">
          <thead><tr><th>Operación</th><th>Dónde</th><th>Contrato</th></tr></thead>
          <tbody>
            {d.endpoints.map((e) => <tr key={e.id}><td><Method m={e.method} /> <span className="mono">{e.path}</span></td><td>{at(e.file, e.line)}</td><td>{e.declared ? 'declarado' : <span className="pending">en el código y en ningún contrato</span>}</td></tr>)}
            {d.declaredOnly.map((o, i) => <tr key={`d${i}`}><td><Method m={o.method} /> <span className="mono">{o.path}</span></td><td className="faint">no está en su código</td><td><a className="rowlink mono" href={pageOf(o.contract)}>{o.contract}</a></td></tr>)}
          </tbody></table></div> : <div className="empty">Su código no expone endpoints.</div>}
      </section>
    </>
  );
  if (which === 'data') return (
    <section className="panel"><header><h3>Eventos y tablas</h3><div className="meta"><Origin of="extracted" /></div></header>
      {d.events.length || d.tables.length ? <div className="body scroll-x"><table className="t"><thead><tr><th>Qué</th><th>Cómo</th><th>Dónde</th></tr></thead><tbody>
        {d.events.map((e, i) => <tr key={`e${i}`}><td className="mono">{e.topic}</td><td>{e.dir === 'publishes' ? 'publica' : 'consume'}</td><td>{at(e.file, e.line)}</td></tr>)}
        {d.tables.map((t, i) => <tr key={`t${i}`}><td className="mono">{t.table}</td><td>{t.op === 'maps' ? 'mapea (entidad)' : 'define (migración)'}</td><td>{at(t.file, t.line)}</td></tr>)}
      </tbody></table></div> : <div className="empty">Su código no toca eventos ni tablas.</div>}
    </section>
  );
  if (which === 'vars') return (
    <>
    <VarLevels names={[...new Map(d.vars.map((v) => [v.name, { name: v.name, secret: v.secret }])).values()]} />
    <div style={{ height: 16 }} />
    <section className="panel"><header><h3>Variables que lee su código</h3><div className="meta"><Origin of="extracted" /> · nunca se muestra un valor</div></header>
      {d.vars.length ? <div className="body scroll-x"><table className="t"><thead><tr><th>Variable</th><th>Tipo</th><th>Dónde se lee</th></tr></thead><tbody>
        {d.vars.map((v, i) => <tr key={i}><td className="mono">{v.name}</td><td>{v.secret ? 'secreto' : 'variable'}{v.hasDefault ? ' · con valor por defecto' : ''}</td><td>{at(v.file, v.line)}</td></tr>)}
      </tbody></table></div> : <div className="empty">Su código no lee variables de entorno.</div>}
    </section>
    </>
  );
  const total = d.tests.reduce((n, t) => n + t.count, 0);
  return (
    <section className="panel"><header><h3>Pruebas de su código</h3><div className="meta"><Origin of="extracted" /> · {plural(total, 'prueba', 'pruebas')} en {plural(d.tests.length, 'fichero', 'ficheros')}</div></header>
      <p className="faint" style={{ padding: '0 16px' }}>Una prueba es de esta pieza si su fichero cuelga de la carpeta de sus anclas o de su espejo en <code>src/test</code>.</p>
      {d.tests.length ? <div className="body">{d.tests.map((t) => (
        <details key={t.file} className="test-file"><summary><span className="mono">{t.file.slice(t.file.indexOf(':') + 1).split('/').at(-1)}</span> <span className="faint">· {t.level} · {plural(t.count, 'prueba', 'pruebas')} · {t.file}</span></summary>
          <ul>{t.cases.map((c) => <li key={c.line}><span>{c.name}</span> <span className="mono faint">:{c.line}</span></li>)}</ul></details>
      ))}</div> : <div className="empty">Ninguna prueba cuelga de sus anclas.</div>}
    </section>
  );
}

/** The endpoints in a piece's anchored code. */
const ownedEndpoints = (g: Indexed, p: DocPiece) => g.map.nodes.filter((n) => n.type === 'endpoint' && n.anchor && p.anchors!.some((a) => anchorMatches(a, n.anchor!.repo, n.anchor!.path, String(n.attrs?.handler ?? ''))));

/** The services its anchors fall in: the one whose folder holds the anchor's path (the deepest, as impact reads it). */
function homesOf(g: Indexed, p: DocPiece): MapNode[] {
  const services = g.map.nodes.filter((n) => n.type === 'service');
  const out = new Map<string, MapNode>();
  for (const a of p.anchors ?? []) {
    const [repo, glob = ''] = a.replace(/#.*$/, '').split(/:(.+)/);
    const path = glob.replace(/[*?[].*$/, '').replace(/\/$/, '');
    const s = services.map((x) => ({ x, dir: String(x.attrs?.dir ?? '.') })).filter(({ x, dir }) => x.repo === repo && (dir === '.' || path === dir || path.startsWith(`${dir}/`))).sort((a, b) => b.dir.length - a.dir.length)[0]?.x;
    if (s) out.set(s.id, s);
  }
  return [...out.values()];
}

const chips = (nodes: MapNode[]) => <span className="chips-inline">{nodes.map((n) => <a key={n.id} className="chip" href={href('map', n.id)}>{n.name}</a>)}</span>;

interface Said { dot: DotState; word: string; text: ReactNode; to?: string }

/** One word and one sentence: whether its own flows pass, and where the first one that failed did. */
function verdict(k: KnowledgeData, p: DocPiece, own: FlowInfo[], passing: FlowInfo[]): Said {
  const failed = own.filter((f) => f.last?.status === 'failed'), passed = own.filter((f) => f.last && f.last.status !== 'failed');
  const link = (f: FlowInfo) => <a className="rowlink" href={href('docs', f.id)}>{f.title}</a>;
  if (!own.length) {
    if (passing.length) {
      const bad = passing.filter((f) => f.last?.status === 'failed').length;
      return { dot: 'idle', word: 'Sin flujos propios', text: `${passing.length === 1 ? 'Pasa por su código 1 flujo' : `Pasan por su código ${passing.length} flujos`}; ${bad ? `${bad} ${bad === 1 ? 'falló' : 'fallaron'}` : passing.length === 1 ? 'no falló' : 'ninguno falló'} en su último run.` };
    }
    return { dot: 'idle', word: 'Sin probar', text: <>Ningún flujo lo recorre.{k.shapes.flow.livesIn.includes(p.type as never) && <> <a className="rowlink" href={href('docs', 'new', 'flow', p.id)}>Crear un flujo</a></>}</> };
  }
  if (failed.length === 1) {
    const f = failed[0], l = f.last!, step = l.failure ? f.steps[l.failure.step - 1] : undefined, h = l.failure?.hop;
    const expected = step?.expected ? ` Se esperaba: ${step.expected.replace(/\.?$/, '.')}` : '';
    const text = l.failure
      ? <>«{link(f)}» falló en el paso {l.failure.step}{step?.step ? `, «${step.step}»` : ''} (run {l.run}, {ago(l.at)}){h ? `: ${h.from} → ${h.to}, ${h.what} ${h.status !== undefined ? `respondió ${h.status}` : `falló${h.error ? `: ${h.error}` : ''}`}.` : '. Ningún salto entre servicios falló: el fallo está en la página.'}{expected}</>
      : <>«{link(f)}» falló un caso (run {l.run}, {ago(l.at)}){l.cases.find((c) => c.status === 'failed') ? <>: «{l.cases.find((c) => c.status === 'failed')!.test}»</> : null}.</>;
    return { dot: 'err', word: 'Falla', text, to: whereFailed(f) };
  }
  if (failed.length > 1) {
    const shown = failed.slice(0, 3), rest = failed.length - shown.length;
    return {
      dot: 'err', word: 'Falla', to: whereFailed(failed[0]),
      text: <>{failed.length} de {plural(own.length, 'flujo', 'flujos')} fallaron en su último run: {shown.map((f, i) => (
        <span key={f.id}>{i === 0 ? '' : i === shown.length - 1 && !rest ? ' y ' : ', '}{link(f)} ({f.last!.failure ? `paso ${f.last!.failure.step}` : 'un caso'})</span>
      ))}{rest ? ` y ${rest} más` : ''}.</>,
    };
  }
  if (passed.length) return { dot: 'ok', word: 'Pasa', text: passed.length < own.length ? `${passed.length} de ${own.length} flujos pasaron en su último run; ${own.length - passed.length} sin ejecutar.` : own.length === 1 ? 'Su flujo pasó en su último run.' : `Sus ${own.length} flujos pasaron en su último run.` };
  return { dot: 'idle', word: 'Sin ejecutar', text: own.length === 1 ? 'Tiene un flujo y todavía no ha corrido.' : `Tiene ${own.length} flujos y todavía no han corrido.` };
}

/**
 * «Estado»: whether it is green and why, the flows that prove it (with a run button), where its code lives and what
 * its class still requires. A row with nothing to say is left out.
 */
function Estado({ flows, ...rest }: { k: KnowledgeData; g: Indexed | null; p: DocPiece; flows: Flows; envs?: EnvSummary[]; toCode: () => void }) {
  if (flows.error) return <section className="panel estado"><header><h3>Estado</h3></header><p className="estado-row">No se pudo leer el historial de runs: {flows.error}</p></section>;
  if (!flows.data) return <section className="panel estado" aria-busy="true"><header><h3>Estado</h3></header><div className="body" style={{ display: 'grid', gap: 10 }}>{[70, 90, 60].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div></section>;
  return <EstadoBody all={flows.data} {...rest} />;
}

function EstadoBody({ k, g, p, all, envs, toCode }: { k: KnowledgeData; g: Indexed | null; p: DocPiece; all: FlowInfo[]; envs?: EnvSummary[]; toCode: () => void }) {
  const byId = new Map(all.map((f) => [f.id, f]));
  const own = ownFlows(k, p.id).flatMap((id) => byId.get(id) ?? []);
  // Its own flows that have a spec start ticked.
  const pick = usePick(() => own.filter((f) => f.exists).map((f) => f.slug));

  const owned = g && p.anchors?.length ? ownedEndpoints(g, p) : [];
  const ownedIds = new Set(owned.map((e) => e.id));
  // Flows «de paso»: not its own, and their last run reached one of its endpoints.
  const passing = all.filter((f) => !own.includes(f)).map((f) => ({ f, n: f.last?.endpoints.filter((e) => ownedIds.has(e.id)).length ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const v = verdict(k, p, own, passing.map((x) => x.f));
  const pieces = new Map(k.pieces.map((x) => [x.id, x]));
  const home = (f: FlowInfo) => { const x = pieces.get(pieces.get(f.id)?.parent ?? ''); return x ? { id: x.id, title: x.title } : null; };
  const chosen = all.filter((f) => pick.picked.has(f.slug));
  const passBad = passing.filter((x) => x.f.last?.status === 'failed').length;
  const walked = owned.filter((e) => walkers(all, e.id).length).length;
  const steps = p.type === 'process' && g ? [...new Set(((p.fields.steps ?? []) as Array<Record<string, string>>).map((r) => r.service).filter(Boolean))].flatMap((id) => g.nodes.get(id) ?? []) : [];
  const pending = (p.coverage ?? []).filter((c) => c.required && c.state !== 'full' && c.stage !== 'test');

  const code = p.type === 'application' ? (g ? <>{plural(g.map.repos.length, 'proyecto', 'proyectos')} · {plural(g.map.nodes.filter((n) => n.type === 'service').length, 'servicio', 'servicios')} · {plural(g.map.nodes.filter((n) => n.type === 'endpoint').length, 'endpoint', 'endpoints')} · <a className="rowlink" href={href('map')}>Ver el mapa ›</a></> : null)
    : steps.length ? <>Pasos en: {chips(steps)}</>
    : !p.anchors?.length ? null
    : !g ? <>Sin mapa: pulsa «Releer el código» en <a className="rowlink" href={href('repos')}>Proyectos</a>.</>
    : <>{homesOf(g, p).length ? <>Vive en {chips(homesOf(g, p))} · </> : null}{plural(owned.length, 'endpoint', 'endpoints')}{owned.length ? `, ${plural(walked, 'recorrido', 'recorridos')} en su último run` : ''} <button className="linkish" onClick={toCode}>Ver código ›</button></>;

  return (
    <section className="panel estado" aria-labelledby="estado-h">
      <header>
        <h3 id="estado-h">Estado</h3>
        <div className="meta">
          {p.type === 'application' && (
            <ActionButton icon={GitPullRequestArrow} disabled={!own.some((f) => f.exists)} title="Marca los flujos cuyo camino toca lo que cambió en los proyectos"
              run={() => api<{ flows: Array<{ id: string }> }>('/api/impact').then((im) => {
                const ids = new Set(im.flows.map((f) => f.id));
                const hit = own.filter((f) => f.exists && ids.has(f.id)).map((f) => f.slug);
                pick.setPicked(new Set(hit));
                return hit.length;
              })}
              done={(n) => (n ? plural(n as number, 'flujo afectado marcado', 'flujos afectados marcados') : 'Ningún flujo afectado por los cambios')}>
              Marcar afectados
            </ActionButton>
          )}
          {(own.length > 0 || passing.length > 0) && <RunFlows chosen={chosen} envs={envs} />}
        </div>
      </header>
      <div className="estado-row estado-verdict">
        <Dot state={v.dot} /><p><b>{v.word}.</b> {v.text}</p>
        {v.to && <a className="rowlink nowrap" href={v.to}>Ver dónde falló ›</a>}
      </div>
      {own.length > 0 && <FlowTable rows={own} pick={pick} home={home} label="sus flujos" />}
      {passing.length > 0 && (
        <details className="passing">
          <summary>{passing.length === 1 ? 'Pasa por su código otro flujo' : `Pasan por su código otros ${passing.length} flujos`} · {passBad ? `${passBad} ${passBad === 1 ? 'falló' : 'fallaron'}` : passing.length === 1 ? 'no falló' : 'ninguno falló'}</summary>
          <FlowTable rows={passing.map((x) => x.f)} pick={pick} home={home} label="los flujos que pasan por su código" sub={(f) => `pasa por ${passing.find((x) => x.f === f)!.n} de sus endpoints`} />
        </details>
      )}
      {code && <div className="estado-row"><span className="k">Código</span><div>{code}</div></div>}
      {pending.length > 0 && (
        <div className="estado-row"><span className="k">Pendiente</span><div>{pending.map((c) => <span key={c.stage} className="pending"><b>{STAGE[c.stage]}</b>: {c.reasons.map(reasonText).join(' ')} </span>)}</div></div>
      )}
    </section>
  );
}

/** A piece's own fields and its links, as written. */
export function PieceFields({ k, p, skip, only, empty }: { k: KnowledgeData; p: DocPiece; skip?: string[]; only?: string[]; empty?: string }) {
  // A link reads as what it points at: a piece by its title, a map node by its name (its id is the title attribute).
  const named = (id: string) => k.pieces.find((x) => x.id === id)?.title ?? id.replace(/^\w+:/, '');
  return (
    <section className="panel"><div className="body fields">
      {empty && !k.shapes[p.type].fields.some((f) => hasValue(p.fields[f.name]) && (!only || only.includes(f.name))) && <p className="faint">{empty}</p>}
      {k.shapes[p.type].fields.filter((f) => hasValue(p.fields[f.name]) && !skip?.includes(f.name) && (!only || only.includes(f.name))).map((f) => (
        <section key={f.name} className="field-view"><h3>{f.heading}</h3><FieldView value={p.fields[f.name]} columns={f.columns} /></section>
      ))}
      {Object.entries(p.meta ?? {}).sort(([a], [b]) => metaAt(a) - metaAt(b)).map(([m, v]) => <section key={m} className="field-view"><h3>{META[m] ?? m}</h3><p>{(Array.isArray(v) ? v : [v]).map((id) => <a key={id} className="chip" href={pageOf(id)} title={id} style={{ marginRight: 4 }}>{named(id)}{m === 'realizes' ? ' ›' : ''}</a>)}</p></section>)}
    </div></section>
  );
}

/** The facets that hang from a piece, and the conventions it inherits from the pieces above it. */
export function facetsOf(k: KnowledgeData, p: DocPiece) {
  const byId = new Map(k.pieces.map((x) => [x.id, x]));
  const chain: DocPiece[] = [];
  for (let x = byId.get(p.parent ?? ''); x; x = byId.get(x.parent ?? '')) chain.push(x);
  return {
    facets: k.pieces.filter((x) => x.parent === p.id && !CONTAINERS.includes(x.type)),
    inherited: chain.reverse().flatMap((a) => k.pieces.filter((x) => x.parent === a.id && x.type === 'convention').map((c) => ({ c, from: a }))),
  };
}

const hasValue = (v: unknown) => v !== undefined && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== '');

export function FieldView({ value, columns }: { value: unknown; columns?: Array<{ name: string; heading: string }> }) {
  if (typeof value === 'string') return <Markdown text={value} />;
  if (columns) return (
    <div className="scroll-x"><table className="t">
      <thead><tr>{columns.map((c) => <th key={c.name}>{c.heading}</th>)}</tr></thead>
      <tbody>{(value as Array<Record<string, string>>).map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.name} className="wrap">{/^(svc|mod|proc|ds|ext|repo|flow|ctr|dm|dec|conv|guide|rb|tp|plan|scn|gls|infra|arch|ver|stack|sec):/.test(r[c.name] ?? '') ? <a className="rowlink mono" href={pageOf(r[c.name])}>{r[c.name]}</a> : r[c.name]}</td>)}</tr>)}</tbody>
    </table></div>
  );
  return <ul>{(value as string[]).map((x, i) => <li key={i}><Markdown text={x} /></li>)}</ul>;
}

export function FacetList({ k, facets, inherited }: { k: KnowledgeData; facets: DocPiece[]; inherited: Array<{ c: DocPiece; from: DocPiece }> }) {
  const groups = [...new Set(facets.map((f) => f.type))];
  if (!facets.length && !inherited.length) return <section className="panel"><div className="empty">Sin facetas. Usa «Añadir» o pídeselo a Claude con <code>knowledge_write</code>.</div></section>;
  const row = (f: DocPiece, from?: DocPiece) => {
    const violations = f.type === 'convention' ? k.conventions[f.id]?.violations.length ?? 0 : 0;
    return (
      <div key={f.id + (from?.id ?? '')} className="facet">
        <div className="ttl"><a className="rowlink" href={href('docs', f.id)}>{f.title}</a><code>{f.id}</code></div>
        <div className="desc">{f.summary}</div>
        <div className="side-info">
          <Status state={statusDot(f.status)}>{STATUS[f.status] ?? f.status}</Status>
          {f.freshness === 'stale' && <span className="chip run">Desactualizado</span>}
          {f.type === 'convention' && k.conventions[f.id] && <span className={`chip ${violations ? 'err' : 'ok'}`}>{violations ? `${violations} incumplimientos` : 'Se cumple'}</span>}
          {from && <span className="inherited"><CornerLeftUp size={12} />Heredada de {from.title}</span>}
        </div>
      </div>
    );
  };
  return (
    <section className="panel"><div className="facets">
      {groups.map((t) => { const I = TYPE_ICON[t]; return <div key={t} className="facet-group"><h5><I />{piecesLabel(t)}<span className="faint" style={{ marginLeft: 'auto', fontWeight: 400 }}>{k.shapes[t as keyof typeof k.shapes].question}</span></h5>{facets.filter((f) => f.type === t).map((f) => row(f))}</div>; })}
      {inherited.length > 0 && <div className="facet-group"><h5><Ruler />Convenciones heredadas</h5>{inherited.map(({ c, from }) => row(c, from))}</div>}
    </div></section>
  );
}

const commits = (p: DocPiece) => Object.entries(p.verified?.commits ?? {}).map(([r, c]) => `${r}@${c}`).join(', ');

/** The code a piece is anchored to changed since it was verified: it says so, and the piece can be marked still true. */
export function Stale({ p, reload }: { p: DocPiece; reload: () => void }) {
  if (p.freshness !== 'stale') return null;
  return (
    <div className="notice warn"><CircleAlert /><div><b>El código anclado cambió</b> desde {commits(p)}. Revisa que la pieza siga siendo cierta y márcala como verificada.
      <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => api('/api/knowledge/verify', { method: 'POST', body: { id: p.id } }).then(() => { toast('Verificada contra el código actual'); reload(); })}><RefreshCw />Sigue siendo cierta</button></div></div></div>
  );
}

/** Where a piece is anchored in the code, and against which commits it was last verified. */
export function Anchors({ p }: { p: DocPiece }) {
  return (
    <section className="panel"><header><h3>Anclas</h3><div className="meta"><Origin of="declared" />{p.verified && <span className="mono">{p.verified.fingerprint}</span>}</div></header>
      {(p.anchors ?? []).map((a) => <div key={a} className="anchor"><GitBranch /><code>{a}</code></div>)}
      <div className="legend">{p.freshness === 'fresh' ? `Verificada el ${p.verified?.at} contra ${commits(p)}` : p.freshness === 'stale' ? 'El código cambió desde la última verificación' : 'Sin verificar'}</div>
    </section>
  );
}

function CodePanel({ p, g, flows }: { p: DocPiece; g: Indexed | null; flows?: FlowInfo[] }) {
  if (!p.anchors?.length) return <section className="panel"><div className="empty">Sin anclas al código. Una funcionalidad se ancla con <code>repo:ruta/**</code>: así se sabe a qué módulo pertenece cada fichero y cuándo la pieza deja de ser cierta.</div></section>;
  const eps = g ? ownedEndpoints(g, p) : [];
  return (
    <div className="grid cols-2">
      <Anchors p={p} />
      <section className="panel"><header><h3>Endpoints en su código</h3><div className="meta"><Origin of="extracted" /></div></header>
        {!eps.length ? <div className="empty">Ningún endpoint en los ficheros anclados.</div> : (
          <div className="scroll-x"><table className="t">
            <thead><tr><th>Ruta</th><th>Servicio</th><th>Lo recorren</th></tr></thead>
            <tbody>{eps.map((e) => {
              const w = flows ? walkers(flows, e.id) : [];
              return (
                <tr key={e.id}>
                  <td className="wrap"><Method m={String(e.attrs?.method)} /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{String(e.attrs?.path)}</span></td>
                  <td><a className="rowlink" href={href('map', e.service ?? '')}>{g!.nodes.get(e.service ?? '')?.name}</a></td>
                  <td className="wrap walkers">{!flows ? <span className="faint">—</span> : w.length ? (
                    <span title={w.length > 2 ? w.map((x) => x.title).join(', ') : undefined}>
                      {w.slice(0, 2).map((x, i) => <span key={x.id}>{i ? ', ' : ''}<a className={`rowlink${failedOn(x, e.id) ? ' err-ink' : ''}`} href={href('docs', x.id)}>{x.title}</a></span>)}
                      {w.length > 2 && ` y ${w.length - 2} más`}
                    </span>
                  ) : <span className="faint">— sin recorrer</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

export function anchorMatches(anchor: string, repo: string, path: string, handler: string): boolean {
  const sym = anchor.match(/#([\w.$*]+)$/)?.[1];
  if (sym && !(sym.endsWith('*') ? handler.startsWith(sym.slice(0, -1)) : handler === sym || handler.startsWith(sym + '.'))) return false;
  const [r, glob] = anchor.replace(/#.*$/, '').split(/:(.+)/);
  if (r !== repo) return false;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { const slash = glob[i + 2] === '/'; re += slash ? '(?:.*/)?' : '.*'; i += slash ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\?]/, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path) || glob.replace(/\/$/, '') === path;
}

export function AddMenu({ k, p }: { k: KnowledgeData; p: DocPiece }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return; const close = () => setOpen(false); setTimeout(() => addEventListener('click', close, { once: true })); return () => removeEventListener('click', close); }, [open]);
  const all = Object.values(k.shapes);
  const fits = all.filter((s) => s.livesIn.includes(p.type as never) && !SYSTEM.includes(s.type));
  const not = all.filter((s) => !s.livesIn.includes(p.type as never) && !CONTAINERS.includes(s.type));
  return (
    <>
      <button className="btn primary" aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}><Plus />Añadir</button>
      {open && (
        <div className="menu" role="menu" style={{ right: 0, top: 40 }}>
          <h6>Caben en {pieceLabel(p.type).toLowerCase()}{p.kind ? ` (${KIND[p.kind]})` : ''}</h6>
          {fits.map((s) => { const I = TYPE_ICON[s.type]; return <a key={s.type} className="item" role="menuitem" href={href('docs', 'new', s.type, p.id)}><I /><div><div>{pieceLabel(s.type)}</div><div className="q">{s.question}</div></div></a>; })}
          {not.length > 0 && <><hr /><h6>No caben aquí</h6>{not.map((s) => { const I = TYPE_ICON[s.type]; return <div key={s.type} className="item off" aria-disabled="true"><I /><div><div>{pieceLabel(s.type)}</div><div className="q">Vive en {s.livesIn.map((t) => pieceLabel(t).toLowerCase()).join(', ')}.</div></div></div>; })}</>}
        </div>
      )}
    </>
  );
}
