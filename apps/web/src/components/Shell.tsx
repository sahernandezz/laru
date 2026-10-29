/** Top bar, side menu and the ⌘K menu, which reaches every screen as well as every node of the map. */
import {
  ArrowLeft, ArrowLeftRight, Box, Check, ChevronDown, ChevronsUpDown, Container, Database, DatabaseBackup, FolderOpen, GitBranch, HardDrive, Home as HomeIcon, KeyRound, LayoutDashboard, Library, Mail,
  Network, PanelLeft, PanelLeftClose, PlayCircle, Plug, Plus, Radio, ScrollText, Search, Settings2, Shapes, Workflow, type LucideIcon,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react';
import { api, useApi, WS, type RunInfo, type WorkspaceRow } from '../api.ts';
import { HOME, href, liveHref, screenOnly, wsPage } from '../lib/route.ts';
import { plural, RUN_PHASE } from '../lib/es.ts';
import { inProgress, isOffline, nextMisses } from '../lib/service.ts';
import { useCurrentScope, type Scope } from '../lib/scope.ts';
import { Dot, Logo, tilde } from './ui.tsx';

/** The «add a workspace» dialog lives with the machine's home page: fetched when it is opened. */
const AddWorkspace = lazy(() => import('../pages/Home.tsx').then((m) => ({ default: m.AddWorkspace })));

interface NavItem { route: string; icon: LucideIcon; label: string }
export const NAV: Array<[string, NavItem[]]> = [
  ['', [{ route: 'overview', icon: LayoutDashboard, label: 'Estado' }]],
  ['La aplicación', [
    { route: 'docs', icon: Library, label: 'Documentación y flujos' },
    { route: 'map', icon: Network, label: 'Servicios y entornos' },
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
  ]],
];
/** Screens reached from another one (a flow, an environment) rather than from the menu: who lights up for them. */
const PARENT: Record<string, string> = { envs: 'map', data: 'map', queues: 'map', storage: 'map', mail: 'map', live: 'docs', flows: 'docs', scenarios: 'docs' };

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
  { label: 'Entornos', hint: 'Servicios y entornos', icon: Container, to: href('envs') },
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
 * Whether the service answers (every 3 s while the page is visible) and which runs are not finished. Two misses in a
 * row make it offline; the first answer after that fires `laru:back`, which makes what is on screen load again.
 */
function useService() {
  const [offline, setOffline] = useState(false);
  const [running, setRunning] = useState<RunInfo[]>([]);
  useEffect(() => {
    let misses = 0, off = false, stop = false;
    const beat = async () => {
      if (document.hidden) return;
      let ok = false, slow = false;
      try { ok = (await fetch('/api/ping', { signal: AbortSignal.timeout(2500) })).ok; } catch (e) { slow = (e as Error).name === 'TimeoutError'; }
      if (stop) return;
      misses = nextMisses(misses, ok, slow);
      const now = isOffline(misses);
      if (now !== off) { off = now; setOffline(now); if (!now) dispatchEvent(new Event('laru:back')); }
      if (ok && WS) api<RunInfo[]>('/api/runs?running=1').then((l) => !stop && setRunning(inProgress(l)), () => undefined);
    };
    void beat();
    const t = setInterval(beat, 3000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return { offline, running };
}

/** Plays a class's CSS animation again on an element that is already there (nothing is remounted, so focus and scroll stay). */
function replay(el: HTMLElement | null, cls: string) {
  if (!el) return;
  el.classList.remove('swap-in', 'swap-l', 'swap-r');
  void el.offsetWidth;
  el.classList.add(cls);
}

export function Shell({ app, active, counts, jumps, menu, children }: { app: string; active: string; counts: Record<string, number>; jumps: Jump[]; menu?: { title: string; sections: Scope['sections'] }; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const [adding, setAdding] = useState(false);
  const workspaces = useApi<WorkspaceRow[]>('/api/workspaces');
  const { offline, running } = useService();
  const scope = useCurrentScope();
  // The screen comes in with a short rise when the route changes (not for a query or a tab of the same page), and the menu slides when it
  // changes level: in from the right going into a flow or a module, in from the left coming back.
  const mainRef = useRef<HTMLElement>(null), sideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let was = location.hash.split('?')[0];
    const on = () => { const now = location.hash.split('?')[0]; if (now !== was) { was = now; replay(mainRef.current, 'swap-in'); } };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const sideKey = scope && !scope.app ? `${scope.card.kind}:${scope.card.title}` : '';
  const sideWas = useRef(sideKey);
  useEffect(() => {
    // a screen hands the menu to the next one in two steps (one leaves, the other arrives): only a level that stays slides in
    const t = setTimeout(() => { if (sideWas.current !== sideKey) { replay(sideRef.current, sideKey ? 'swap-r' : 'swap-l'); sideWas.current = sideKey; } }, 80);
    return () => clearTimeout(t);
  }, [sideKey]);
  const others = (workspaces.data ?? []).filter((w) => w.exists && w.id && w.id !== WS);
  const toggle = () => (matchMedia('(max-width: 860px)').matches ? setDrawer((d) => !d) : setCollapsed((c) => !c));
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk(true); }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggle(); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  useEffect(() => setDrawer(false), [active, scope?.active]);

  // hiding the menu sits at its top right, on the row of «back» (the header's button only brings it back)
  const hide = <button type="button" className="icon-btn side-hide" onClick={toggle} aria-label="Ocultar el menú (⌘B)" title="Ocultar el menú ⌘B"><PanelLeftClose /></button>;

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}${drawer ? ' drawer' : ''}${scope && !scope.app ? ' scoped' : ''}`}>
      {/* The hash is the router's: following #main would open a screen called «main», so this only moves the focus. */}
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Saltar al contenido</a>
      {offline && <div className="offline-bar" role="status"><span className="spin" aria-hidden="true" />Sin conexión con el servicio, reintentando…</div>}
      <header className="top">
        {/* only to bring the menu back (or open it on a phone): hiding it is at the menu's foot, away from «back» at its top */}
        <button className="icon-btn menu-btn" onClick={toggle} aria-label="Mostrar el menú (⌘B)" title="Mostrar el menú ⌘B"><PanelLeft /></button>
        <a className="brand" href={href('overview')} aria-label="Laru, inicio"><Logo /><span className="hide-sm">Laru</span></a>
        <span className="slash" aria-hidden="true">/</span>
        <Switcher app={app} rows={workspaces.data} onAdd={() => setAdding(true)} />
        <span className="grow" />
        <button className="search" onClick={() => setCmdk(true)} aria-label="Buscar (⌘K)"><Search /><span>Buscar…</span><kbd>⌘K</kbd></button>
        <a className="daemon" href={HOME} title="El servicio local escucha solo en 127.0.0.1. Todos los workspaces y esta máquina"><Dot state="ok" /><span className="lbl">{location.host}{workspaces.data ? ` · ${plural(workspaces.data.length, 'workspace', 'workspaces')}` : ''}</span></a>
      </header>
      <nav className="side" aria-label="Secciones" ref={sideRef}>
        {scope && !scope.app ? <ScopeMenu scope={scope} hide={hide} /> : <div className="side-top">{hide}</div>}
        {scope && !scope.app ? null : NAV.map(([group, items]) => {
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
              <AppMenu title={menu.title} sections={menu.sections} active={scope?.app ? scope.active : undefined} />
            </span>
          );
          return (
            <div className="nav-group" key={group || 'top'}>
              {group ? <Fold name={group} count={items.length} here={here(items)} at={location.hash}>{items.map(link)}</Fold> : items.map(link)}
            </div>
          );
        })}
        {running.length > 0 && (
          <div className="side-live" aria-label="Runs en curso">
            <h2>En curso</h2>
            {running.slice(0, 3).map((r) => (
              <a key={r.id} href={r.kind === 'session' ? liveHref(r) : href('runs', r.id)} title={`Run ${r.id} en ${r.env}`}>
                <Dot state="run" /><span className="mono">#{r.id}</span><span className="what">{r.kind === 'session' ? 'Sesión' : r.flows.length === 1 ? r.flows[0] : `${r.flows.length} flujos`}</span><span className="faint">{RUN_PHASE[r.phase]}</span>
              </a>
            ))}
            {running.length > 3 && <a href={`${href('runs')}?estado=running`} className="more">y {running.length - 3} más</a>}
          </div>
        )}
        <div className="side-foot"><span>Todo corre en esta máquina</span><span className="mono">laru 0.1.0</span></div>
      </nav>
      <main id="main" tabIndex={-1} ref={mainRef}>{children}</main>
      {cmdk && <CommandMenu jumps={[...SCREENS, ...jumps]} actions={[
        { label: 'Mostrar u ocultar el menú', hint: '⌘B', icon: PanelLeft, to: 'action:menu', run: toggle },
        ...others.map((w): Item => ({ label: `Cambiar a ${nameOf(w, workspaces.data ?? [])}`, hint: 'Workspace', icon: Box, to: `ws:${w.id}`, run: () => { location.href = wsPage(w.id!, screenOnly(location.hash)); } })),
        { label: 'Todos los workspaces y esta máquina', hint: 'Inicio', icon: HomeIcon, to: 'ws:', run: () => { location.href = HOME; } },
      ]} close={() => setCmdk(false)} />}
      {adding && <Suspense fallback={null}><AddWorkspace onClose={() => setAdding(false)} /></Suspense>}
    </div>
  );
}

const FOLDED = 'laru.menu.closed';
const folded = (): string[] => { try { return JSON.parse(localStorage.getItem(FOLDED) ?? '[]') as string[]; } catch { return []; } };
/**
 * A group of the menu that folds (a native <details>): the groups the person closed stay closed in this browser, by
 * name; one holding the page that is open opens.
 */
function Fold({ name, here, at, sub, count, children }: { name: string; here?: boolean; /** the page open: arriving at another one of the group opens it again */ at?: string; sub?: boolean; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(() => here || !folded().includes(name));
  useEffect(() => { if (here) setOpen(true); }, [here, at]);
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
function AppMenu({ title, sections, active }: { title: string; sections: Scope['sections']; active?: string }) {
  const groups: Array<[string | undefined, Scope['sections']]> = [];
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
function ScopeMenu({ scope, hide }: { scope: Scope; hide: ReactNode }) {
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

function Switcher({ app, rows, onAdd }: { app: string; rows?: WorkspaceRow[]; onAdd: () => void }) {
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
      <button ref={btn} className="switcher" aria-haspopup="dialog" aria-expanded={open} aria-label={`Workspace: ${here}. Cambiar de workspace`} onClick={() => setOpen((o) => !o)}><Box /><span>{here}</span><ChevronsUpDown className="chev" /></button>
      {open && (
        // A press inside keeps the focus where it is: in browsers that do not focus a link when it is pressed (Safari, Firefox on a
        // Mac) the button would lose it, the blur above would close the list, and the link would be gone before the click reached it.
        <div className="popover" role="dialog" aria-label="Workspaces" ref={box} onMouseDown={(e) => e.preventDefault()} onKeyDown={(e) => {
          const items = [...(box.current?.querySelectorAll<HTMLElement>('.item') ?? [])], i = items.indexOf(document.activeElement as HTMLElement);
          if (e.key === 'Escape') { e.preventDefault(); close(); }
          if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        }}>
          <div className="h">Workspaces</div>
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
