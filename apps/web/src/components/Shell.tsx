/** Top bar, side menu and the ⌘K menu, which reaches every screen as well as every node of the map. */
import {
  ArrowLeft, ArrowLeftRight, Box, Boxes, Check, ChevronDown, ChevronsUpDown, Container, Database, DatabaseBackup, FolderOpen, GitBranch, HardDrive, Home as HomeIcon, KeyRound, LayoutDashboard, Library, Mail,
  Network, PanelLeft, PanelLeftClose, PanelLeftOpen, PlayCircle, Plug, Plus, Radio, ScrollText, Search, Server, Settings2, Palette, Shapes, Workflow, type LucideIcon,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react';
import { api, useApi, WS, type RunInfo, type WorkspaceRow } from '../api.ts';
import { HOME, href, liveHref, screenOnly, wsPage } from '../lib/route.ts';
import { ago, plural, RUN_PHASE } from '../lib/es.ts';
import { inProgress, isOffline, nextMisses } from '../lib/service.ts';
import type { Menu, ScopeMenu as Scoped, Section } from '../lib/menu.ts';
import { Dot, Logo, tilde } from './ui.tsx';
import { LiveNotices, Notices, notify, type DockerSeen } from './Notices.tsx';
import { RunningDock } from './RunningDock.tsx';

/** The «add a workspace» dialog lives with the machine's home page: fetched when it is opened. */
const AddWorkspace = lazy(() => import('../pages/Home.tsx').then((m) => ({ default: m.AddWorkspace })));

interface NavItem { route: string; icon: LucideIcon; label: string }
export const NAV: Array<[string, NavItem[]]> = [
  ['', [{ route: 'overview', icon: LayoutDashboard, label: 'Estado' }]],
  ['La aplicación', [
    { route: 'docs', icon: Library, label: 'Documentación y flujos' },
    { route: 'map', icon: Network, label: 'Mapa y servicios' },
    { route: 'envs', icon: Container, label: 'Entornos' },
    { route: 'runs', icon: PlayCircle, label: 'Runs' },
    { route: 'mocks', icon: Plug, label: 'Mocks y fallos' },
    { route: 'repos', icon: GitBranch, label: 'Proyectos' },
  ]],
  ['Manual', [
    { route: 'standard', icon: ScrollText, label: 'Cómo se documenta' },
    { route: 'diagrams', icon: Shapes, label: 'Cómo se dibuja' },
  ]],
  ['Ajustes', [
    { route: 'files', icon: FolderOpen, label: 'Archivos locales' },
    { route: 'settings', icon: Settings2, label: 'Información del sistema' },
    { route: 'theme', icon: Palette, label: 'Tema' },
  ]],
];
/** Screens reached from another one (a flow, an environment) rather than from the menu: who lights up for them. */
const PARENT: Record<string, string> = { data: 'envs', queues: 'envs', storage: 'envs', mail: 'envs', vars: 'envs', live: 'docs', flows: 'docs', scenarios: 'docs' };

export interface Jump { label: string; hint?: string; icon: LucideIcon; to: string }
/** A ⌘K entry: a jump, or an action of the shell (`run`). */
type Item = Jump & { run?: () => void };
const SCREENS: Jump[] = [
  ...NAV.flatMap(([group, items]) => items.map((i) => ({ label: i.label, hint: group || undefined, icon: i.icon, to: href(i.route) }))),
  { label: 'Variables y secretos', hint: 'Secretos', icon: KeyRound, to: href('vars') },
  { label: 'Bases de datos', hint: 'Datos', icon: Database, to: href('data') },
  { label: 'Colas', hint: 'Datos', icon: ArrowLeftRight, to: href('queues') },
  { label: 'Almacenamiento', hint: 'Datos', icon: HardDrive, to: href('storage') },
  { label: 'Correo y mensajes de texto', hint: 'Datos', icon: Mail, to: href('mail') },
  { label: 'Sesiones en vivo', hint: 'Probar en vivo', icon: Radio, to: href('live') },
  { label: 'Flujos', hint: 'Documentación', icon: Workflow, to: href('flows') },
  { label: 'Escenarios', hint: 'Flujos', icon: DatabaseBackup, to: href('scenarios') },
];

/** The last three entries used, kept in this browser only; storage that is off or full just keeps none. */
const RECENT = 'laru.cmdk.recent';
const keyOf = (j: Jump) => `${j.to}\n${j.label}`;
function recent(): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(RECENT) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function remember(j: Jump) {
  try { localStorage.setItem(RECENT, JSON.stringify([keyOf(j), ...recent().filter((k) => k !== keyOf(j))].slice(0, 3))); } catch { /* not kept */ }
}

/**
 * The page's pulse, every 3 s while it is visible: whether the service answers (two misses in a row make it offline, and
 * the first answer after that fires `laru:back`, which makes what is on screen load again), and the service's pulse —
 * Docker as it last saw it, what changed in the workspace from outside, the runs not finished. A change from outside (an
 * agent wrote a doc, a flow, a run ended) fires `laru:changed`, which does the same as `laru:back`; Docker going away
 * or coming back, a refresh and a run that ended become notices.
 */
const RUN_END: Record<string, string> = { passed: 'pasó', failed: 'falló', error: 'no pudo correr', cancelled: 'se canceló', interrupted: 'se interrumpió' };
interface Pulse { docker: DockerSeen; changes?: { n: number; files: string[] }; running?: RunInfo[] }
function useService() {
  const [offline, setOffline] = useState(false);
  const [running, setRunning] = useState<RunInfo[]>([]);
  const [docker, setDocker] = useState<DockerSeen>();
  useEffect(() => {
    let misses = 0, off = false, stop = false, last: Pulse | undefined;
    const beat = async () => {
      if (document.hidden) return;
      let ok = false, slow = false;
      try { ok = (await fetch('/api/ping', { signal: AbortSignal.timeout(2500) })).ok; } catch (e) { slow = (e as Error).name === 'TimeoutError'; }
      if (stop) return;
      misses = nextMisses(misses, ok, slow);
      const now = isOffline(misses);
      if (now !== off) { off = now; setOffline(now); if (!now) dispatchEvent(new Event('laru:back')); }
      if (!ok) return;
      const p = await api<Pulse>('/api/pulse').catch(() => undefined);
      if (!p || stop) return;
      setDocker(p.docker);
      if (p.running) setRunning(inProgress(p.running));
      if (last) {
        const was = last.docker.ok;
        if (was !== null && p.docker.ok === false && was !== false) { notify({ kind: 'docker', title: 'Docker dejó de responder', detail: p.docker.error, state: 'err' }); }
        if (was === false && p.docker.ok) { notify({ kind: 'docker', title: 'Docker volvió', detail: p.docker.version ? `Versión ${p.docker.version}; las pantallas se actualizaron` : 'Las pantallas se actualizaron', state: 'ok' }); dispatchEvent(new Event('laru:changed')); }
        if (p.changes && last.changes && p.changes.n !== last.changes.n) {
          dispatchEvent(new Event('laru:changed'));
          const files = p.changes.files;
          notify({ kind: 'change', title: 'Actualizado', detail: 'Algo cambió el workspace y la pantalla se actualizó', files, state: 'run' });
        }
        // a run that ended: how it ended is read from the run itself
        for (const r of last.running ?? []) if (!p.running?.some((x) => x.id === r.id)) {
          const what = r.kind === 'session' ? `Sesión #${r.id}` : `Run #${r.id}`, to = r.kind === 'session' ? liveHref(r) : href('runs', r.id);
          const detail = r.kind === 'session' ? r.title ?? r.env : r.flows.length === 1 ? r.flows[0] : `${r.flows.length} flujos en ${r.env}`;
          void api<RunInfo>(`/api/run?id=${encodeURIComponent(r.id)}`).then(
            (done) => notify({ kind: 'run', title: `${what} ${RUN_END[done.status] ?? 'terminó'}`, detail, state: done.status === 'passed' ? 'ok' : done.status === 'failed' || done.status === 'error' ? 'err' : 'idle', to }),
            () => notify({ kind: 'run', title: `${what} terminó`, detail, state: 'idle', to }));
        }
      }
      last = p;
    };
    void beat();
    const t = setInterval(beat, 3000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return { offline, running, docker };
}

/** `nav`: the side menu of the address (lib/menu.ts), computed with the screen; `menu`: the application's own sections. */
export function Shell({ app, nav, counts, jumps, menu, children }: { app: string; nav: Menu; counts: Record<string, number>; jumps: Jump[]; menu?: { title: string; sections: Section[] }; children: ReactNode }) {
  // the menu put away stays away after a reload, in this browser
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(HIDDEN) === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(HIDDEN, collapsed ? '1' : '0'); } catch { /* not kept */ } }, [collapsed]);
  const [drawer, setDrawer] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const [adding, setAdding] = useState(false);
  const workspaces = useApi<WorkspaceRow[]>('/api/workspaces');
  const { offline, running, docker } = useService();
  const scope = nav.kind === 'scope' ? nav : undefined, active = nav.kind === 'main' ? nav.active : '';
  const others = (workspaces.data ?? []).filter((w) => w.exists && w.id && w.id !== WS);
  const phone = () => matchMedia('(max-width: 860px)').matches;
  const toggle = () => (phone() ? setDrawer((d) => !d) : setCollapsed((c) => !c));
  // The header's button (and ⌘B) puts both side panels away at once, the menu and the documentation's tree, and brings
  // both back: the sheet gets the whole width. Each panel still hides on its own from its own button.
  const hidden = useRef(collapsed);
  hidden.current = collapsed;
  const both = () => {
    if (phone()) { setDrawer((d) => !d); return; }
    const show = hidden.current;
    setCollapsed(!show);
    dispatchEvent(new CustomEvent('laru:tree', { detail: show }));
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk(true); }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); both(); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  useEffect(() => setDrawer(false), [active, scope?.active]);

  // the menu alone hides from its top right, on the row of «back»; the header's button does both panels
  const hide = <button type="button" className="icon-btn side-hide" onClick={toggle} aria-label="Ocultar el menú" title="Ocultar solo el menú"><PanelLeftClose /></button>;

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}${drawer ? ' drawer' : ''}${scope ? ' scoped' : ''}`}>
      {/* The hash is the router's: following #main would open a screen called «main», so this only moves the focus. */}
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Saltar al contenido</a>
      {offline && <div className="offline-bar" role="status"><span className="spin" aria-hidden="true" />Sin conexión con el servicio, reintentando…</div>}
      <header className="top">
        {/* only to bring the menu back (or open it on a phone): hiding it is at the menu's foot, away from «back» at its top */}
        <button className="icon-btn menu-btn" onClick={both} aria-pressed={collapsed} aria-label={collapsed ? 'Mostrar el menú y el árbol (⌘B)' : 'Ocultar el menú y el árbol (⌘B)'} title={collapsed ? 'Mostrar el menú y el árbol ⌘B' : 'Ocultar el menú y el árbol ⌘B'}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button>
        <a className="brand" href={href('overview')} aria-label="Laru, inicio"><Logo /><span className="hide-sm">Laru</span></a>
        <span className="slash" aria-hidden="true">/</span>
        <Switcher app={app} rows={workspaces.data} offline={offline} onAdd={() => setAdding(true)} />
        <span className="grow" />
        <button className="search" onClick={() => setCmdk(true)} aria-label="Buscar (⌘K)"><Search /><span>Buscar…</span><kbd>⌘K</kbd></button>
        <Notices docker={docker} />
      </header>
      <nav className="side" aria-label="Secciones">
        {scope ? <ScopeMenu scope={scope} hide={hide} /> : <div className="side-top">{hide}</div>}
        {scope ? null : NAV.map(([group, items]) => {
          const link = (i: NavItem) => (
            <a key={i.route} href={href(i.route)} aria-current={(PARENT[active] ?? active) === i.route ? 'page' : undefined}>
              <i.icon /><span>{i.label}</span>
              {i.route === 'runs' && running.length > 0 ? <span className="count live num" title={`${plural(running.length, 'run en curso', 'runs en curso')}`}>{running.length}</span>
                : counts[i.route] !== undefined && <span className="count num">{counts[i.route]}</span>}
            </a>
          );
          const here = (list: NavItem[]) => list.some((i) => (PARENT[active] ?? active) === i.route);
          // «La aplicación» is one menu: what runs it first, then what is written about it (and every living piece).
          if (group === 'La aplicación' && menu) return (
            <span key={group} style={{ display: 'contents' }}>
              <div className="nav-group"><Fold name="Sistema" count={items.filter((i) => i.route !== 'docs').length} here={here(items.filter((i) => i.route !== 'docs'))} at={location.hash}>{items.filter((i) => i.route !== 'docs').map(link)}</Fold></div>
              <AppMenu title={menu.title} sections={menu.sections} active={nav.kind === 'main' ? nav.app : undefined} />
            </span>
          );
          return (
            <div className="nav-group" key={group || 'top'}>
              {group ? <Fold name={group} count={items.length} here={here(items)} at={location.hash}>{items.map(link)}</Fold> : items.map(link)}
            </div>
          );
        })}
        <div className="side-foot">
          <span>Todo corre en esta máquina</span>
          <a className="mono" href={`https://github.com/sahernandezz/laru/releases/tag/v${__LARU_VERSION__}`} target="_blank" rel="noreferrer" title="Qué trae esta versión">laru {__LARU_VERSION__}</a>
          <a href="https://github.com/sahernandezz/laru" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </nav>
      <main id="main" tabIndex={-1}>
        {docker?.ok === false && <div className="docker-bar" role="alert"><b>Docker no responde</b><span>desde {ago(new Date(docker.since).toISOString())}: los entornos se muestran sin estado y no se pueden levantar.</span>{docker.error && <code title={docker.error}>{docker.error}</code>}</div>}
        {children}
      </main>
      <LiveNotices />
      <RunningDock running={running} />
      {cmdk && <CommandMenu jumps={[...SCREENS, ...jumps]} actions={[
        { label: 'Mostrar u ocultar el menú y el árbol', hint: '⌘B', icon: PanelLeft, to: 'action:menu', run: both },
        ...others.map((w): Item => ({ label: `Cambiar a ${nameOf(w, workspaces.data ?? [])}`, hint: 'Workspace', icon: Box, to: `ws:${w.id}`, run: () => { location.href = wsPage(w.id!, screenOnly(location.hash)); } })),
        { label: 'Todos los workspaces y esta máquina', hint: 'Inicio', icon: HomeIcon, to: 'ws:', run: () => { location.href = HOME; } },
      ]} close={() => setCmdk(false)} />}
      {adding && <Suspense fallback={null}><AddWorkspace onClose={() => setAdding(false)} /></Suspense>}
    </div>
  );
}

const FOLDED = 'laru.menu.closed';
const HIDDEN = 'laru.menu.hidden';
const folded = (): string[] => { try { return JSON.parse(localStorage.getItem(FOLDED) ?? '[]') as string[]; } catch { return []; } };
/**
 * A group of the menu that folds (a native <details>): the groups the person closed stay closed in this browser, by
 * name; one holding the page that is open opens.
 */
function Fold({ name, here, at, sub, count, children }: { name: string; here?: boolean; /** the page open: arriving at another one of the group opens it again */ at?: string; sub?: boolean; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(() => here || !folded().includes(name));
  // arriving at a page of the group opens it in the same render (an effect would draw it closed for a frame first)
  const now = `${here}|${at}`, [was, setWas] = useState(now);
  if (now !== was) { setWas(now); if (here && !open) setOpen(true); }
  const keep = (now: boolean) => {
    setOpen(now);
    try { localStorage.setItem(FOLDED, JSON.stringify([...folded().filter((x) => x !== name), ...(now ? [] : [name])])); } catch { /* not kept */ }
  };
  return (
    <details className={sub ? 'fold sub' : 'fold'} open={open} onToggle={(e) => { if (e.currentTarget.open !== open) keep(e.currentTarget.open); }}>
      <summary><ChevronDown aria-hidden="true" /><h2>{name}</h2>{count !== undefined && <span className="count num" aria-label={`${count} entradas`}>{count}</span>}</summary>
      {children}
    </details>
  );
}

/** The application's menu: its sections, then a group per stage of the living pieces, each lit up when it is the one open; every group folds. */
function AppMenu({ title, sections, active }: { title: string; sections: Section[]; active?: string }) {
  const groups: Array<[string | undefined, Section[]]> = [];
  for (const x of sections) { const last = groups.at(-1); if (last && last[0] === x.group) last[1].push(x); else groups.push([x.group, [x]]); }
  return (
    <div className="nav-group">
      {groups.map(([group, xs]) => (
        <Fold key={group ?? ''} name={group ?? title} sub={Boolean(group)} count={xs.length} here={xs.some((x) => x.key === active)} at={active}>
          {xs.map((x) => (
            <a key={x.key} href={x.to} aria-current={active === x.key ? 'page' : undefined}>
              {x.icon && <x.icon />}<span>{x.label}</span>{x.n !== undefined && <span className="count num">{x.n}</span>}
            </a>
          ))}
        </Fold>
      ))}
    </div>
  );
}

/** The menu once you are inside something: a way back, what you are in, and its sections. */
function ScopeMenu({ scope, hide }: { scope: Scoped; hide: ReactNode }) {
  const I = scope.card.icon;
  return (
    <div className="scope">
      <div className="scope-top"><a className="scope-back" href={scope.back.to}><ArrowLeft />{scope.back.label}</a>{hide}</div>
      <div className="scope-card">
        <span className="scope-kind">{I && <I />}{scope.card.kind}</span>
        <b>{scope.card.state && <Dot state={scope.card.state} />}{scope.card.title}</b>
        {scope.card.sub && <span className="faint">{scope.card.sub}</span>}
      </div>
      <div className="nav-group">
        {scope.sections.map((x, i) => (
          <span key={x.key} style={{ display: 'contents' }}>
            {x.group && x.group !== scope.sections[i - 1]?.group && <h2>{x.group}</h2>}
            <a href={x.to} aria-current={scope.active === x.key ? 'page' : undefined}>
              {x.icon && <x.icon />}<span>{x.label}</span>{x.n !== undefined && <span className="count num">{x.n}</span>}
            </a>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The workspace switcher: a dialog-like popover listing the workspaces (the arrows move between its rows, Escape
 * closes it and gives the focus back). Picking one loads its page whole, keeping the screen the hash names.
 */
/** A workspace's name in a list: its title, and its id too when another one has the same title (a copy of the same application). */
const nameOf = (w: WorkspaceRow, all: WorkspaceRow[]) => ((w.title ?? w.id) && all.some((x) => x !== w && x.exists && (x.title ?? x.id) === (w.title ?? w.id)) ? `${w.title ?? w.id} · ${w.id}` : (w.title ?? w.id ?? ''));

/**
 * The workspace and the service it is served by, in one place: the button names the workspace, with the service's dot
 * and how many workspaces this machine has; its list starts with the service (its address) and leads to all of them.
 */
function Switcher({ app, rows, offline, onAdd }: { app: string; rows?: WorkspaceRow[]; offline: boolean; onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null), box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) box.current?.querySelector<HTMLElement>('[aria-current="true"], .item')?.focus(); }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const list = (rows ?? []).filter((w) => w.exists && w.id);
  // after switching, the button says which of two copies of one application this is
  const me = list.find((w) => w.id === WS);
  const here = me ? nameOf(me, list) : app;
  return (
    <span className="switch-wrap" onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget)) close(false); }}>
      <button ref={btn} className="switcher" aria-haspopup="dialog" aria-expanded={open} aria-label={`Workspace: ${here}. ${rows ? plural(list.length, 'workspace', 'workspaces') : ''} en ${location.host}. Cambiar de workspace`} onClick={() => setOpen((o) => !o)}>
        <span className="halo" title={offline ? 'El servicio no responde' : `Servicio en ${location.host}`}><Dot state={offline ? 'err' : 'ok'} /></span>
        <span className="sw-name">{here}</span>
        {rows && <span className="sw-count num" aria-hidden="true"><Boxes />{list.length}</span>}
        <ChevronsUpDown className="chev" />
      </button>
      {open && (
        // A press inside keeps the focus where it is: in browsers that do not focus a link when it is pressed (Safari, Firefox on a
        // Mac) the button would lose it, the blur above would close the list, and the link would be gone before the click reached it.
        <div className="popover" role="dialog" aria-label="Workspaces" ref={box} onMouseDown={(e) => e.preventDefault()} onKeyDown={(e) => {
          const items = [...(box.current?.querySelectorAll<HTMLElement>('.item') ?? [])], i = items.indexOf(document.activeElement as HTMLElement);
          if (e.key === 'Escape') { e.preventDefault(); close(); }
          if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        }}>
          <div className="sw-service">
            <Server />
            <span style={{ minWidth: 0 }}>Servicio local<span className="sub">{location.host} · solo esta máquina</span></span>
            <span className="faint" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Dot state={offline ? 'err' : 'ok'} />{offline ? 'sin respuesta' : 'en marcha'}</span>
          </div>
          <hr />
          <div className="h">{rows ? plural(list.length, 'workspace', 'workspaces') : 'Workspaces'}</div>
          <ul>
            {!rows ? <li className="h">Cargando…</li> : list.map((w) => (
              <li key={w.root}>
                <a className="item" href={wsPage(w.id!, screenOnly(location.hash))} aria-current={w.id === WS ? 'true' : undefined}>
                  {w.id === WS ? <Check aria-label="Actual" /> : <span />}
                  <span style={{ minWidth: 0 }}>{nameOf(w, list)}<span className="sub">{tilde(w.root)}</span></span>
                  <span className="faint" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}>{w.envs?.length ? <><Dot state="ok" />{w.envs.join(', ')}</> : <><Dot state="idle" />parado</>}</span>
                </a>
              </li>
            ))}
          </ul>
          <hr />
          <button className="item" onClick={() => { close(false); onAdd(); }}><Plus /><span>Añadir workspace…</span><span /></button>
          <a className="item" href={HOME}><HomeIcon /><span>Todos los workspaces y esta máquina</span><span /></a>
        </div>
      )}
    </span>
  );
}

function CommandMenu({ jumps, actions, close }: { jumps: Jump[]; actions: Item[]; close: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const id = useId();
  // Read while rendering, before autoFocus moves the focus into the input: closing gives it back to this.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const list = useRef<HTMLUListElement>(null);
  const match = (j: Jump) => `${j.label} ${j.hint ?? ''}`.toLowerCase().includes(q.toLowerCase());
  const all: Item[] = [...jumps, ...actions];
  const recents = q ? [] : recent().flatMap((k) => all.find((j) => keyOf(j) === k) ?? []);
  const groups: Array<[string, Item[]]> = [['Recientes', recents], ['Ir a', jumps.filter(match).slice(0, 40)], ['Acciones', actions.filter(match)]];
  const shown = groups.flatMap(([, items]) => items);
  const go = (j?: Item) => {
    close();
    if (!j) return;
    remember(j);
    if (j.run) j.run(); else location.hash = j.to;
  };
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [i]);
  useEffect(() => () => {
    const o = opener.current;
    if (o?.isConnected && o !== document.body) o.focus(); else document.getElementById('main')?.focus();
  }, []);
  // The input is the menu's only stop (a combobox): Tab stays in it, and the arrows move the option it points to.
  let n = 0;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Buscar">
        <input autoFocus placeholder="Busca una pantalla, un servicio, un endpoint, una tabla o un tema…" aria-label="Buscar" value={q}
          role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={shown.length ? `${id}-o${i}` : undefined}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(shown.length - 1, x + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            // Cancelled first: closing gives the focus back to the opener mid-keystroke, and Enter would then press it.
            if (e.key === 'Enter') { e.preventDefault(); go(shown[i]); }
            if (e.key === 'Escape') close();
            if (e.key === 'Tab') e.preventDefault();
          }} />
        <ul role="listbox" id={`${id}-list`} aria-label="Resultados" ref={list}>
          {groups.map(([g, items]) => items.length > 0 && [
            <li key={g} className="h" role="presentation">{g}</li>,
            ...items.map((j) => {
              const k = n++;
              return (
                <li key={`${g}:${keyOf(j)}`} id={`${id}-o${k}`} className="o" role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => go(j)}>
                  <j.icon aria-hidden="true" /><span>{j.label}</span>{j.hint && <span className="hint">{j.hint}</span>}
                </li>
              );
            }),
          ])}
        </ul>
        <p className={shown.length ? 'sr-only' : 'h'} role="status">{shown.length ? '' : 'Nada coincide. Prueba con el nombre de una pantalla, un servicio, una tabla o una ruta.'}</p>
        <footer><span><kbd>↑</kbd> <kbd>↓</kbd> moverse</span><span><kbd>↵</kbd> abrir</span><span><kbd>esc</kbd> cerrar</span></footer>
      </div>
    </div>
  );
}
