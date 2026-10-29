/**
 * Runs: the list, and one run replayed. The story's <video> is the clock (t = currentTime × 1000, read in a
 * requestAnimationFrame loop); the sequence diagram, the caption, the steps and the cursor all follow it. A run
 * still going is followed through its event stream: phases, tests and steps appear as they happen.
 */
import {
  ArrowDownLeft, ArrowUpRight, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsLeft, ChevronsRight, CircleX, Crosshair, Radio, Download, FileCode, FileText, Film, Footprints, GitCompare, Image, Info,
  Maximize2, Minimize2, Pause, Play, RotateCw, ScrollText, Search, Terminal, X, Zap,
} from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { endpointMatcher } from '@laru/trace/assemble';
import { chain as chainOf, type Cause } from '@laru/trace/chain';
import { hopWhat } from '@laru/trace/summarize';
import { api, apiUrl, useApi, type Impact, type RunDetail, type Comparison, type Exchange, type FlowInfo, type Indexed, type KnowledgeData, type LogLine, type MapNode, type RunInfo, type RunnerEvent, type Step, type Trace } from '../api.ts';
import { ExchangeContract } from '../components/Contract.tsx';
import { EdgeLabel, MapCanvas, NodeBox } from '../components/MapCanvas.tsx';
import { ActionButton, PathChip, Code, CodeBlock, copy, Dialog, Dot, HttpStatus, Kind, Level, Origin, Segmented, Skeleton, Status, Tabs, toast, type DotState } from '../components/ui.tsx';
import { askFirst } from '../lib/ask.ts';
import { devicesOf, onlyDevice } from '../lib/devices.ts';
import { ago, KIND, plural, RUN_DOT, RUN_PHASE, RUN_STATUS, secs, size } from '../lib/es.ts';
import { href, liveHref, partsOf, queryOf, splitStop, stopIn, withStop } from '../lib/route.ts';
import { filterRuns, filtersOf, flowsOf, NO_FILTERS, queryString, type RunFilters } from '../lib/runsFilter.ts';
import { at as atMs, say, sayCtx } from '../lib/say.ts';
import { CH, clock, curl, ends, failTime, fit, HEAD_H, LANE_W, labelRoom, layoutSeq, PROJECT_H, ROW_H, route, rowState, sameStop, stepAt, stepStop, stopId, stopOf, walk, type Row, type SeqLayout, type Stop } from '../lib/seq.ts';
import { archGraph, layout as mapLayout, type FlowEdge, type Layout, type Lit, type MapEdge } from '../lib/sysmap.ts';
import { langOf, statusClass } from '../lib/syntax.ts';
import { actName, ChainTab, StepCard, whereOf, type Where } from './Chain.tsx';
import { ExchangeIO, Journey, RouteStrip } from './Journey.tsx';

const fileUrl = (id: string, path: string) => apiUrl(`/api/run-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
const BIG = 'laru.run.bigVideo';
/** the studio: the player on the whole window, kept for the next run this browser opens */
const STUDIO = 'laru.run.studio';
/** where the studio goes back to, and whether that is a run's page (whose «open in the studio» it then remembers off) */
const STUDIO_FROM = 'laru.run.studioFrom';
/** Secuencia or Mapa, kept for the next flow this browser opens (the flow page and Runs share it). */
const VIEW = 'laru.flow.view';
export type FlowView = 'seq' | 'map';
const savedView = (): FlowView => { try { return localStorage.getItem(VIEW) === 'map' ? 'map' : 'seq'; } catch { return 'seq'; } };
/** The view asked for (the flow page's `/map` or `/seq`) wins; else the last one chosen. Choosing one keeps it. */
export function useFlowView(asked?: FlowView, onView?: (v: FlowView) => void): [FlowView, (v: FlowView) => void] {
  const [view, setView] = useState<FlowView>(() => asked ?? savedView());
  useEffect(() => { if (asked) setView(asked); }, [asked]);
  return [view, (v) => { setView(v); try { localStorage.setItem(VIEW, v); } catch { /* only for this view */ } onView?.(v); }];
}
/** The studio's panels as the person left them: the video and inspector widths, the timeline's height and the ones put away. */
const LAYOUT = 'laru.run.studioLayout';
type Panel = 'video' | 'side' | 'tracks';
interface StudioLayout { video: number; side: number; tracks: number; hide: Partial<Record<Panel, boolean>> }
const LAYOUT0: StudioLayout = { video: 380, side: 380, tracks: 170, hide: {} };
const SIZES: Record<Panel, [number, number]> = { video: [200, 1100], side: [260, 1000], tracks: [60, 700] };
/** What the middle view (sequence, map) always keeps; the CSS holds it too, for a layout saved on a larger screen. */
const STAGE_MIN = { w: 320, h: 160 };
function useStudioLayout(): [StudioLayout, (f: (l: StudioLayout) => StudioLayout) => void] {
  const [l, setL] = useState<StudioLayout>(() => { try { return { ...LAYOUT0, ...JSON.parse(localStorage.getItem(LAYOUT) ?? '{}') }; } catch { return LAYOUT0; } });
  const set = useCallback((f: (l: StudioLayout) => StudioLayout) => setL((x) => {
    const y = f(x);
    try { localStorage.setItem(LAYOUT, JSON.stringify(y)); } catch { /* only for this view */ }
    return y;
  }), []);
  return [l, set];
}
/** The bar between two panels: dragged, or moved with the arrow keys, it hands the distance moved to `onMove`. */
/**
 * A panel's edge: dragged (or arrowed) it resizes the panel, and the tab on it puts the panel away or brings it back.
 * A panel put away leaves its edge with the tab only.
 */
function Splitter({ axis, label, area, onMove, panel }: { axis: 'x' | 'y'; label: string; area: string; onMove: (d: number) => void; panel: { name: string; hidden: boolean; onFlip: () => void; /** where the panel lies from its edge */ side: 'left' | 'right' | 'down' } }) {
  const Icon = panel.side === 'down' ? (panel.hidden ? ChevronUp : ChevronDown) : (panel.side === 'left') !== panel.hidden ? ChevronLeft : ChevronRight;
  return (
    <div className={`st-edge st-edge-${axis}`} style={{ gridArea: area }}>
      {!panel.hidden && <SplitBar axis={axis} label={label} onMove={onMove} />}
      <button type="button" className="st-flip" aria-expanded={!panel.hidden} onClick={panel.onFlip} aria-label={panel.hidden ? `Mostrar «${panel.name}»` : `Ocultar «${panel.name}»`} title={panel.hidden ? `Mostrar «${panel.name}»` : `Ocultar «${panel.name}»`}><Icon /></button>
    </div>
  );
}
function SplitBar({ axis, label, onMove }: { axis: 'x' | 'y'; label: string; onMove: (d: number) => void }) {
  return (
    <div role="separator" tabIndex={0} aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} className={`st-split st-split-${axis}`}
      onPointerDown={(e) => {
        e.preventDefault();
        let last = axis === 'x' ? e.clientX : e.clientY;
        const move = (ev: globalThis.PointerEvent) => { const p = axis === 'x' ? ev.clientX : ev.clientY; onMove(p - last); last = p; };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('dragging'); };
        document.body.classList.add('dragging');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      onKeyDown={(e) => {
        const d = ({ ArrowLeft: -24, ArrowUp: -24, ArrowRight: 24, ArrowDown: 24 } as Record<string, number>)[e.key];
        if (d) { e.preventDefault(); e.stopPropagation(); onMove(d); } // the studio's own arrows walk the messages
      }} />
  );
}
const took = (r: RunInfo) => (r.endedAt ? secs(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : undefined);

export function Runs({ parts, g }: { parts: string[]; g: Indexed | null }) {
  // `#/runs/<id>/<flow>/<test>`, and «Paso a paso»'s stop after them
  const [id, slug, test] = splitStop(parts)[0];
  return id ? <Run key={id} id={id} slug={slug} test={test} g={g} /> : <RunList />;
}

function RunList() {
  const runs = useApi<RunInfo[]>('/api/runs');
  const all = runs.data ?? [];
  // the filters live in the address: a link with them opens the same list, and a reload keeps it
  const [filters, setFilters] = useState<RunFilters>(() => filtersOf(queryOf(location.hash)));
  useEffect(() => { history.replaceState(null, '', `${location.pathname}${location.search}#/runs${queryString(filters)}`); }, [filters]);
  const list = filterRuns(all, filters);
  const filtered = Boolean(filters.flujo || filters.estado);
  return (
    <div className="page wide">
      <div className="head"><div><h1>Runs</h1><p>Cada ejecución de flujos, con su vídeo, su traza y lo que el entorno vio mientras corría. Se guardan en <a className="rowlink mono" href={href('files')} title="Archivos locales: dónde está cada run y cuánto ocupa">.laru/runs</a>.</p></div></div>
      <ChangesBar />
      {all.length > 0 && (
        <div className="run-filters" role="search" aria-label="Filtrar runs">
          <label>Flujo
            <select value={filters.flujo} onChange={(e) => setFilters((f) => ({ ...f, flujo: e.target.value }))}>
              <option value="">Todos los flujos</option>
              {flowsOf(all).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label>Estado
            <select value={filters.estado} onChange={(e) => setFilters((f) => ({ ...f, estado: e.target.value }))}>
              <option value="">Todos</option>
              {['running', 'passed', 'failed', 'error', 'cancelled', 'interrupted'].map((s) => <option key={s} value={s}>{RUN_STATUS[s]}</option>)}
            </select>
          </label>
          <span className="faint num" aria-live="polite">{filtered ? `${list.length} de ${plural(all.length, 'run', 'runs')}` : plural(all.length, 'run', 'runs')}</span>
          {filtered && <button className="btn sm" onClick={() => setFilters(NO_FILTERS)}>Quitar filtros</button>}
        </div>
      )}
      {runs.error ? <div className="notice" role="alert"><CircleX />{runs.error}</div> : !runs.data ? <Skeleton lines={6} /> : !all.length ? (
        <section className="panel"><div className="empty">Todavía no hay runs. Ejecuta flujos desde <a className="rowlink" href={href('docs')}>Documentación y flujos</a>, con «Probar aquí» en un entorno o con <code>laru test</code>.</div></section>
      ) : !list.length ? (
        <section className="panel"><div className="empty">Ningún run coincide con esos filtros. <button className="btn sm" onClick={() => setFilters(NO_FILTERS)}>Quitar filtros</button></div></section>
      ) : (
        <div className="run-cards">
          {list.map((r) => <RunCard key={r.id} r={r} />)}
        </div>
      )}
    </div>
  );
}

/** The run, followed through its stream while it is not done. The stream replays its events on every connection. */
function useRun(id: string) {
  const first = useApi<RunDetail>(`/api/run?id=${encodeURIComponent(id)}`);
  const [live, setLive] = useState<RunInfo>();
  const [events, setEvents] = useState<RunnerEvent[]>([]);
  const running = first.data ? first.data.phase !== 'done' : false;
  useEffect(() => {
    if (!running) return;
    const es = new EventSource(apiUrl(`/api/run/events?id=${encodeURIComponent(id)}`));
    es.onopen = () => setEvents([]);
    es.addEventListener('run', (m) => {
      try { const r = JSON.parse((m as MessageEvent).data) as RunInfo; setLive(r); if (r.phase === 'done') es.close(); } catch { /* a torn line */ }
    });
    es.onmessage = (m) => { try { const e = JSON.parse(m.data) as RunnerEvent; setEvents((l) => [...l, e]); } catch { /* a torn line */ } };
    return () => es.close();
  }, [id, running]);
  return { run: live ?? first.data, detail: first.data, error: first.error, events };
}

function Run({ id, slug: slugArg, test, g }: { id: string; slug?: string; test?: string; g: Indexed | null }) {
  const { run, detail, error, events } = useRun(id);
  const flows = useApi<FlowInfo[]>('/api/flows');
  // the contracts the sentences and the inspector read, once per run screen; without them they only say less
  const k = useApi<KnowledgeData>('/api/knowledge').data;
  const [comparing, setComparing] = useState(false);
  const [other, setOther] = useState<RunInfo | null>(null);
  const compareBtn = useRef<HTMLButtonElement>(null);
  const headline = useRef<HTMLDivElement>(null);
  // The flow shown while the run is live stays shown when it ends, instead of jumping to the first that failed.
  const shown = useRef<string>(undefined);
  // Ending swaps «Cancelar» and the live tests for other controls: a focus left on one of them goes to the headline,
  // which says how it ended.
  const done = run?.phase === 'done';
  const wasLive = useRef(false);
  useEffect(() => {
    if (!run) return;
    if (!done) { wasLive.current = true; return; }
    if (wasLive.current && (!document.activeElement || document.activeElement === document.body)) headline.current?.focus();
    wasLive.current = false;
  }, [done, Boolean(run)]);
  if (error) return <div className="page"><div className="notice" role="alert"><CircleX />{error}</div></div>;
  if (!run) return <div className="page wide"><Skeleton lines={3} /><div style={{ height: 16 }} /><Skeleton lines={8} /></div>;

  // A session still open is not a run yet: there is no runner to wait for, only the live view.
  if (run.kind === 'session' && !done) { location.replace(liveHref(run)); return null; }
  const failedFirst = run.flows.find((f) => run.results[f]?.status === 'failed' || run.results[f]?.status === 'error');
  const slug = run.flows.includes(slugArg ?? '') ? slugArg! : shown.current ?? failedFirst ?? run.flows[0];
  if (!done) shown.current = slug;
  // A flow not in the results yet is running once the runner opened its spec, and queued before.
  const started = new Set(events.flatMap((e) => (e.e === 'test-begin' ? [e.file.replace(/^.*\/|\.spec\.ts$/g, '')] : [])));
  const flowStatus = (f: string) => run.results[f]?.status ?? (done ? 'skipped' : started.has(f) ? 'running' : 'queued');
  const flow = flows.data?.find((f) => f.slug === slug);
  const result = slug ? run.results[slug] : undefined;
  const [dot, label] = runHeadline(run, result, flow);
  // «Repetir lo que falló»: this run's flows that failed or errored, on the same env
  const failedHere = run.flows.filter((f) => run.results[f]?.status === 'failed' || run.results[f]?.status === 'error');

  return (
    <div className="page wide">
      <nav className="crumbs" aria-label="Migas"><a href={href('runs')}>Runs</a><ChevronRight /><span>Run {run.id}</span>{slug ? <><ChevronRight /><a href={href('docs', `flow:${slug}`)} title="El flujo en Documentación y flujos">{slug}</a></> : null}</nav>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <div className={`status run-state ${dot}`} aria-live="polite" ref={headline} tabIndex={-1}><Dot state={dot} />{label}</div>
          <h1 style={{ marginTop: 6 }}>{run.kind === 'session' ? run.title : run.flows.length === 1 ? flow?.title ?? slug : `Run ${run.id}`}</h1>
          <p>
            Run {run.id} en <a className="rowlink mono" href={href('envs', run.env)}>{run.env}</a>{detail?.projects ? ` (${detail.projects.join(' · ')})` : ''}{run.ephemeral ? ', un entorno efímero' : ''}, lanzado {ago(run.startedAt)}
            {took(run) ? `; duró ${took(run)}` : ''}.{run.flows.length > 1 ? ` ${plural(run.flows.length, 'flujo', 'flujos')}.` : ''}
          </p>
          {detail && <p className="run-dir"><PathChip path={detail.dir} reveal={{ what: 'run', id: run.id }} /> <span className="faint num">{size(detail.bytes)}</span></p>}
        </div>
        <div className="actions">
          {done && <button className="btn" ref={compareBtn} onClick={() => setComparing(true)}><GitCompare />Comparar</button>}
          {!done && run.kind !== 'session' && <ActionButton icon={Ban} run={() => api('/api/runs/cancel', { method: 'POST', body: { id: run.id } })} done={() => `Run ${run.id} cancelado`}>Cancelar</ActionButton>}
          {run.kind === 'session' && !done && <a className="btn primary" href={liveHref(run)}>Ver en vivo</a>}
          {done && run.kind !== 'session' && failedHere.length > 0 && failedHere.length < run.flows.length && <ActionButton icon={RotateCw} run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { env: run.env, flows: failedHere, ephemeral: run.ephemeral, confirm } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')} title={failedHere.join(', ')}>Repetir lo que falló</ActionButton>}
          {done && run.kind !== 'session' && <ActionButton icon={RotateCw} primary run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { env: run.env, flows: run.flows, ephemeral: run.ephemeral, confirm } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')}>Volver a ejecutar</ActionButton>}
        </div>
      </div>

      {run.error && <div className="notice" role="alert"><CircleX /><div><b>{run.status === 'error' ? 'No llegó a terminar.' : 'Aviso.'}</b> <span className="mono pre-line">{run.error}</span></div></div>}
      {run.note && <div className="notice info" role="status"><Info /><div>{run.note}{run.waiting && <> <a className="rowlink" href={href('live', run.waiting)}>Ver la sesión</a></>}</div></div>}
      {run.kind !== 'session' && <Phases run={run} />}
      {run.flows.length > 1 && (
        <nav className="seg flow-switch" aria-label="Flujo del run">
          {run.flows.map((f) => <a key={f} href={href('runs', run.id, f)} aria-current={f === slug ? 'page' : undefined}><Dot state={RUN_DOT[flowStatus(f)] ?? 'idle'} />{f}<span className="sr-only">, {RUN_STATUS[flowStatus(f)] ?? flowStatus(f)}</span></a>)}
        </nav>
      )}
      {other && <CompareView a={other.id} b={run.id} flows={run.flows.filter((f) => other.flows.includes(f))} onClose={() => { setOther(null); compareBtn.current?.focus(); }} />}
      {!slug ? null : done ? <FlowEvidence key={slug} run={run} slug={slug} flow={flow} g={g} test={slug === slugArg ? test : undefined} address={(_, t) => href('runs', run.id, slug, ...(t ? [t] : []))} k={k} studio /> : <LiveView run={run} slug={slug} events={events} flow={flow} />}
      {comparing && <ComparePick run={run} onClose={() => setComparing(false)} onPick={setOther} />}
    </div>
  );
}

function runHeadline(run: RunInfo, result: RunInfo['results'][string] | undefined, flow?: FlowInfo): [DotState, string] {
  if (run.phase !== 'done') return ['run', `En curso: ${RUN_PHASE[run.phase].toLowerCase()}`];
  // The flow on screen speaks for itself; the run's status only when the flow has no result of its own.
  const status = result?.status ?? run.status;
  if (status === 'failed' && result?.failedStep) {
    const step = flow?.steps[result.failedStep - 1]?.step;
    const total = flow?.steps.length;
    return ['err', `Falló en el paso ${result.failedStep}${total ? ` de ${total}` : ''}${step ? `, «${step}»` : ''}`];
  }
  return [RUN_DOT[status] ?? 'idle', RUN_STATUS[status] ?? status];
}

const PHASES: Array<RunInfo['phase']> = ['queued', 'up', 'tests', 'evidence', 'destroy'];

/** What each phase did. Phases have no timestamps of their own: their state, and the tests' time from the results. */
function Phases({ run }: { run: RunInfo }) {
  const results = Object.values(run.results);
  const testsMs = results.reduce((s, r) => s + (r.ms ?? 0), 0);
  const cells = PHASES.map((p, i): [RunInfo['phase'], DotState, string] => {
    if (p === 'destroy' && !run.ephemeral) return [p, 'idle', 'No aplica: persistente'];
    if (run.phase !== 'done') {
      const cur = PHASES.indexOf(run.phase);
      return [p, i < cur ? 'ok' : i === cur ? 'run' : 'idle', i < cur ? 'Hecho' : i === cur ? 'En curso' : 'Pendiente'];
    }
    // Done: how far it got. With results the tests ran; without them it stopped before.
    const ran = results.length > 0;
    const stopped: DotState = run.status === 'error' ? 'err' : 'idle';
    const why = run.status === 'error' ? 'Aquí se detuvo' : RUN_STATUS[run.status];
    if (p === 'queued') return [p, 'ok', 'Hecho'];
    if (p === 'up') return ran ? [p, 'ok', 'Listo'] : [p, stopped, why];
    if (p === 'tests') {
      if (!ran) return [p, 'idle', 'No llegó'];
      const bad = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
      const known = results.reduce((n, r) => n + (r.known ?? 0), 0);
      return [p, bad ? 'err' : 'ok', bad ? `${bad} con fallos, ${secs(testsMs)}` : known ? `${secs(testsMs)}, ${plural(known, 'desviación conocida', 'desviaciones conocidas')}` : secs(testsMs)];
    }
    if (p === 'evidence') return ran ? [p, 'ok', 'Guardada'] : [p, 'idle', 'No llegó'];
    return [p, run.status === 'passed' || run.status === 'failed' ? 'ok' : stopped, 'Destruido'];
  });
  return (
    <ol className="phases" aria-label="Fases del run">
      {cells.map(([p, s, d]) => <li key={p} className={`phase ${s}`}><span className="n"><Dot state={s} />{RUN_PHASE[p]}</span><span className="d">{d}</span></li>)}
    </ol>
  );
}

// ---------- live ----------

interface LiveTest { id: string; title: string; story: boolean; status?: string; ms?: number; steps: Array<{ title: string; status?: string; ms?: number; error?: string }> }
function liveTests(events: RunnerEvent[], slug: string): LiveTest[] {
  const tests = new Map<string, LiveTest>();
  for (const e of events) {
    if (e.e === 'test-begin') { if (e.file.endsWith(`/${slug}.spec.ts`)) tests.set(e.test, { id: e.test, title: e.title, story: e.story, steps: [] }); continue; }
    if (!('test' in e)) continue;
    const t = tests.get(e.test);
    if (!t) continue;
    if (e.e === 'step-begin') t.steps.push({ title: e.title });
    if (e.e === 'step-end') { const s = t.steps.findLast((x) => x.title === e.title && !x.status) ?? (t.steps.push({ title: e.title }), t.steps.at(-1)!); s.status = e.status; s.ms = e.t - e.t0; s.error = e.error; }
    if (e.e === 'test-end') { t.status = e.status; t.ms = e.durationMs; }
  }
  return [...tests.values()];
}

function LiveView({ run, slug, events, flow }: { run: RunInfo; slug: string; events: RunnerEvent[]; flow?: FlowInfo }) {
  const tests = liveTests(events, slug);
  const cur = tests.find((t) => t.story) ?? tests.at(-1);
  return (
    <>
      {!tests.length && <p className="faint live-wait">{run.phase === 'tests' ? 'El runner está arrancando el navegador…' : `${RUN_PHASE[run.phase]}: las pruebas empiezan después.`}</p>}
      <section className="panel" aria-labelledby="live-h">
        <header><h3 id="live-h">Pasos{cur ? ` de «${cur.title}»` : ''}</h3><div className="meta">El vídeo, la secuencia y la red llegan al guardar la evidencia</div></header>
        <ol className="steps live" aria-live="polite">
          {(cur?.steps ?? []).map((s, i) => (
            <li key={i}>
              <Dot state={!s.status ? 'run' : s.status === 'passed' ? 'ok' : s.status === 'failed' ? 'err' : 'idle'} />
              <span>{i + 1}. {s.title}{flow?.steps[i]?.expected ? <span className="exp">Se espera: {String(flow.steps[i].expected)}</span> : null}</span>
              <span className="faint num">{s.ms !== undefined ? secs(s.ms) : 'en curso'}</span>
              {s.error && <span className="why">{s.error}</span>}
            </li>
          ))}
          {cur && !cur.steps.length && <li className="faint">Sin pasos todavía.</li>}
        </ol>
      </section>
    </>
  );
}

// ---------- evidence ----------

/** `test` is the test an address names (where it failed); without one, the story. */
interface Evidence {
  run: RunInfo; slug: string; flow?: FlowInfo; g: Indexed | null; view?: FlowView; onView?: (v: FlowView) => void; test?: string;
  /** the screen's address for a view and a test (none: the story), which «Paso a paso» writes its stop after */
  address?: (v: FlowView, test?: string) => string;
  /** the run's own page opens it in the studio (unless the person left it); elsewhere, such as a flow's sheet, only on request */
  studio?: boolean;
  /** the studio's own screen (#/studio/…): the player is the studio, and leaving it goes back to where it was opened */
  only?: boolean;
  /** the contracts and data model the sentences and the inspector read; read once by the screen, never by the player */
  k?: KnowledgeData;
}

/** A flow's evidence in a run: its tests, and the player for the one picked. Also the flow page's latest evidence. */
export function FlowEvidence({ run, slug, flow, g, view, onView, test, address, k, studio, only }: Evidence) {
  const cached = run.results[slug]?.status === 'cached' ? run.results[slug]?.cachedFrom : undefined;
  if (cached) return (
    <section className="panel"><div className="empty">
      <span>{slug} no se volvió a ejecutar: sus entradas no cambiaron desde el run {cached}, que lo probó.</span>
      <span><a className="rowlink" href={href('runs', cached, slug)}>Ver la evidencia en el run {cached}</a></span>
    </div></section>
  );
  // another flow, run or named test starts over from what it opens on
  return <FlowTraces key={`${run.id}/${slug}/${test ?? ''}`} run={run} slug={slug} flow={flow} g={g} view={view} onView={onView} test={test} address={address} k={k} studio={studio} only={only} />;
}

/** The studio on its own screen, #/studio/<run>/<flow>[/<test>]: only the player, the page it was opened from not mounted. */
export function Studio({ parts, g }: { parts: string[]; g: Indexed | null }) {
  const [[id = '', slug = '', test]] = splitStop(parts);
  const { run, error } = useRun(id);
  const flows = useApi<FlowInfo[]>('/api/flows');
  const k = useApi<KnowledgeData>('/api/knowledge').data;
  if (error) return <div className="page"><div className="notice" role="alert">{error} <a className="rowlink" href={href('runs')}>Ir a los runs</a></div></div>;
  if (!run) return <div className="page"><Skeleton lines={10} /></div>;
  return <FlowEvidence key={`${slug}/${test ?? ''}`} run={run} slug={slug} flow={flows.data?.find((f) => f.slug === slug)} g={g} test={test} address={(_, t) => href('studio', id, slug, ...(t ? [t] : []))} k={k} only />;
}

/** The full map of a page, laid out once for the story and its cases: each test lights its part of it. */
export interface Arch { lay: Layout<MapEdge>; pieces: MapNode[] }

function FlowTraces({ run, slug, flow, g, view, onView, address, k, studio, only }: Evidence) {
  const res = useApi<{ trace: Trace | null; cases: Trace[] }>(`/api/run/trace?id=${encodeURIComponent(run.id)}&flow=${encodeURIComponent(slug)}`);
  const tests = useMemo(() => (res.data?.trace ? [res.data.trace] : []), [res.data]);
  const arch = useMemo(() => {
    if (!g || !tests.length) return null;
    const a = archGraph(g, tests, { onlyUsed: true });
    return { lay: mapLayout(a.sub, a.edges, { keep: true, bands: true }), pieces: a.pieces, lits: a.lits };
  }, [g, tests]);
  // The story: a flow is one recorded test. A stop in the address («Paso a paso») is read once.
  const [asked] = useState(() => stopIn(location.hash));
  const test = tests[0];
  // «Seguir un dispositivo»: only what it sent and what that caused, for the studio's follow-along
  const [device, setDevice] = useState('');
  const devices = useMemo(() => (test ? devicesOf(test, chainOf(test).cause) : undefined), [test]);
  const shown = useMemo(() => (test && device && devices ? onlyDevice(test, devices, device) : test), [test, device, devices]);
  if (res.error) return <div className="notice" role="alert"><CircleX />{res.error}</div>;
  if (!res.data) return <><Skeleton lines={2} /><div style={{ height: 16 }} /><Skeleton lines={10} /></>;
  if (!test) return (
    <section className="panel"><div className="empty">
      <span>{slug} no dejó traza en este run{run.results[slug]?.status === 'error' ? ': no llegó a correr ninguna prueba' : ''}.</span>
      <span>Lo que el runner escribió está en <code>.laru/runs/{run.id}/out/runner.log</code>.</span>
    </div></section>
  );
  const at = 0;
  // one device has nothing to pick
  const follow = devices && devices.list.length > 1 && (
    <label className="faint st-device">Dispositivo{' '}
      <select value={device} onChange={(e) => setDevice(e.target.value)} title="Solo lo que envió ese dispositivo y lo que provocó en el sistema">
        <option value="">Todos</option>
        {devices.list.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.count})</option>)}
      </select>
    </label>
  );
  return (
    <>
      <Player key={`${at}/${device}`} run={run} slug={slug} trace={shown!} story={test.story ?? true} flow={flow} g={g} view={view} onView={onView} k={k}
        arch={arch} lit={arch?.lits[at]} address={address} stop={!device ? asked : undefined} devices={follow || undefined} studioFirst={studio} only={only} />
    </>
  );
}

/** Plays a test: the video (or a timer, for a test without one) drives everything below. */
function useClock(video: HTMLVideoElement | null, duration: number, layout: SeqLayout) {
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  // always starts slow (0,25×): a run is read, not watched
  const [speed, setSpeed] = useState(0.25);
  const at = useRef(0), opts = useRef({ speed });
  opts.current = { speed };
  const show = (t: number) => { at.current = t; setNow(t); };
  const seek = useCallback((t: number) => {
    const c = Math.max(0, Math.min(duration, t));
    if (video) video.currentTime = c / 1000;
    show(c);
  }, [video, duration]);
  // The element may arrive after a first seek (to the failure): it starts where the clock is.
  useEffect(() => { if (video) video.currentTime = at.current / 1000; }, [video]);
  useEffect(() => { if (video) video.playbackRate = speed; }, [video, speed]);
  useEffect(() => {
    if (!video) return;
    const end = () => setPlaying(false);
    video.addEventListener('ended', end);
    return () => video.removeEventListener('ended', end);
  }, [video]);
  useEffect(() => {
    if (!playing) return;
    video?.play().catch(() => setPlaying(false));
    let raf = 0, last = performance.now();
    const tick = (ts: number) => {
      let t = video ? video.currentTime * 1000 : Math.min(duration, at.current + (ts - last) * opts.current.speed);
      last = ts;
      // ~30 updates a second are enough for the eye and halve the work
      if (Math.abs(t - at.current) >= 30) show(t);
      if (!video && t >= duration) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // a pause keeps the frame it stopped on (the clock may sit between two frames: the video says where it is)
    return () => { cancelAnimationFrame(raf); video?.pause(); if (video) show(video.currentTime * 1000); };
  }, [playing, video, duration, layout]);
  const play = useCallback(() => { if (at.current >= duration - 40) seek(0); setPlaying(true); }, [duration, seek]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause]);
  return { now, playing, toggle, play, pause, seek, speed, setSpeed, duration };
}

type Tab = 'msg' | 'chain' | 'steps' | 'net' | 'logs' | 'data' | 'behavior' | 'files';
type Mode = 'clock' | 'step';
/** What the player-level keys never take: typing, and widgets with their own arrows. */
const OWN_KEYS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="tablist"], [role="slider"], [role="radiogroup"]';

function Player({ run, slug, trace, story, flow, g, view: asked, onView, k, arch, lit, address, stop: askedStop, devices, studioFirst, only }: Evidence & { trace: Trace; story: boolean; k?: KnowledgeData; arch?: Arch | null; lit?: Lit; stop?: string; /** the studio's pick of one device to follow */ devices?: ReactNode; studioFirst?: boolean }) {
  const layout = useMemo(() => layoutSeq(trace), [trace]);
  const ch = useMemo(() => chainOf(trace), [trace]);
  const ctx = useMemo(() => sayCtx({ trace, rows: layout.rows, chain: ch, map: g?.map, pieces: k?.pieces }), [trace, layout, ch, g, k]);
  // A story that failed stops there: the rest of flow.md's steps never ran, and the Steps tab lists them as such.
  const stepsTotal = story && trace.status === 'failed' ? Math.max(trace.steps.length, trace.stepsTotal ?? flow?.steps.length ?? 0) : trace.steps.length;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const blank = useBlank(video);
  const [dims, setDims] = useState('');
  // The video at the stage's full width, the sequence under it; kept for the next run this browser opens.
  const [big, setBig] = useState(() => { try { return localStorage.getItem(BIG) === '1'; } catch { return false; } });
  // screens opened in their own floating window ('' is the story's own video), each on the same clock
  const [floats, setFloats] = useState<string[]>([]);
  const openFloat = (name: string) => setFloats((f) => (f.includes(name) ? f : [...f, name]));
  const stage = useRef<HTMLElement>(null);
  const toggleBig = () => {
    try { localStorage.setItem(BIG, big ? '0' : '1'); } catch { /* only for this view */ }
    setBig(!big);
    // the video fits with its controls once the stage is at the top of the page (its top does not move as it grows)
    if (!big) stage.current?.scrollIntoView({ block: 'start' });
  };
  // «Estudio»: everything at once on the whole window, nothing to scroll to pause, step or read a message. It is a screen
  // of its own (#/studio/…): nothing of the page it was opened from stays mounted behind it.
  const studio = Boolean(only);
  const studioAt = href('studio', run.id, slug, ...(story ? [] : [trace.test]));
  const openStudio = (replace = false) => {
    try { sessionStorage.setItem(STUDIO_FROM, JSON.stringify({ run: run.id, slug, to: location.hash })); if (studioFirst) localStorage.setItem(STUDIO, '1'); } catch { /* back to the run's page */ }
    if (replace) location.replace(studioAt); else location.hash = studioAt;
  };
  // Back where this studio was opened from; opened by a link (or from another run), to the run's page, which then stays
  // the page: it does not open the studio again by itself.
  const leaveStudio = () => {
    let from: { run?: string; slug?: string; to?: string } = {};
    try { from = JSON.parse(sessionStorage.getItem(STUDIO_FROM) ?? '{}'); sessionStorage.removeItem(STUDIO_FROM); } catch { /* back to the run's page */ }
    const to = from.run === run.id && from.slug === slug && from.to ? from.to : href('runs', run.id, slug, ...(story ? [] : [trace.test]));
    if (partsOf(to)[0] === 'runs') try { localStorage.setItem(STUDIO, '0'); } catch { /* it opens the studio again */ }
    location.hash = to;
  };
  // the run's own page opens in the studio unless the person left it last time
  useEffect(() => { if (!only && studioFirst) { let on = true; try { on = localStorage.getItem(STUDIO) !== '0'; } catch { /* on */ } if (on) openStudio(true); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [lay, setLay] = useStudioLayout();
  // From the size the panel is drawn at (a width saved on a larger screen is drawn smaller), and only as far as the middle
  // view keeps STAGE_MIN of its own: what it has now, less that, is the room there is.
  const resize = (p: Panel, d: number) => {
    const at = (sel: string) => studioRef.current?.querySelector<HTMLElement>(sel);
    const st = at('.st-stage'), el = at(p === 'video' ? '.st-video' : p === 'side' ? '.st-side' : '.tracks');
    const room = st ? Math.max(0, p === 'tracks' ? st.clientHeight - STAGE_MIN.h : st.clientWidth - STAGE_MIN.w) : Infinity;
    setLay((l) => {
      const cur = el ? (p === 'tracks' ? el.offsetHeight : el.offsetWidth) : l[p];
      return { ...l, [p]: Math.min(SIZES[p][1], cur + room, Math.max(SIZES[p][0], cur + d)) };
    });
  };
  const flip = (p: Panel) => setLay((l) => ({ ...l, hide: { ...l.hide, [p]: !l.hide[p] } }));
  const studioRef = useRef<HTMLDivElement>(null);
  const toggleStudio = () => (studio ? leaveStudio() : openStudio());
  useEffect(() => { if (studio) studioRef.current?.focus({ preventScroll: true }); }, [studio]);
  // The clock runs to whichever ends later: the trace or the video (which can outlast it by a second).
  const [videoMs, setVideoMs] = useState(0);
  const c = useClock(video, Math.max(layout.duration, videoMs), layout);
  const [sel, setSel] = useState(layout.bad);
  // «Paso a paso»: the clock stops and the cursor moves one stop at a time. An act's header and the failure are stops
  // with no row of their own: `pin` holds them.
  const [mode, setMode] = useState<Mode>('clock');
  const modeRef = useRef<Mode>('clock');
  const [pin, setPin] = useState<Stop | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const stops = useMemo(() => walk(layout, ch, trace, (id) => showAll || unfolded.has(ch.actOf.get(id) ?? '')), [layout, ch, trace, showAll, unfolded]);
  const cur = useMemo<Stop | null>(() => pin ?? (sel >= 0 ? { kind: 'row', i: sel } : null), [pin, sel]);
  const actNo = useMemo(() => new Map(ch.acts.filter((a) => a.id !== 'preparacion').map((a, i) => [a.id, i + 1])), [ch]);
  // Secuencia or Mapa: the same selection and the same clock, drawn two ways.
  const [view, pickView] = useFlowView(asked, onView);
  const [onStage, setStage] = useState<'journey' | 'view'>('journey');
  const match = useMemo(() => endpointMatcher(g?.map.nodes ?? []), [g]);
  const [tab, setTab] = useState<Tab>(() => (studio ? 'msg' : 'chain'));
  const before = useRef<Tab>('chain');
  const wrap = useRef<HTMLDivElement>(null);
  const step = stepAt(trace.steps, c.now);
  const src = trace.video ? fileUrl(run.id, `flows/${slug}/${trace.video}`) : null;
  // a test without video keeps the side-by-side stage, whatever was chosen for videos
  const large = big && Boolean(src);

  const scrollTo = useCallback((i: number, always = false) => {
    const w = wrap.current, r = layout.rows[i];
    if (!w || !r) return;
    const top = w.scrollTop, h = w.clientHeight - HEAD_H, y = r.y;
    if (always || y < top + 24 || y > top + h - 48) w.scrollTop = Math.max(0, y - h / 2);
  }, [layout]);
  const pickRow = useCallback((i: number) => { setSel(i); c.seek(layout.rows[i].t); scrollTo(i); }, [c.seek, layout, scrollTo]);
  const seek = c.seek;

  // «Seguimiento»: one message after another, each held long enough to read it; the speed shortens or lengthens the stay.
  // It always goes on from the row the person is on (a click or a key moves it), and gives way to whatever else drives the player.
  const [following, setFollowing] = useState(false);
  const at = useRef({ sel, speed: c.speed, rows: layout.rows.length, pick: pickRow });
  at.current = { sel, speed: c.speed, rows: layout.rows.length, pick: pickRow };
  useEffect(() => { if (c.playing || mode === 'step') setFollowing(false); }, [c.playing, mode]);
  useEffect(() => { setFollowing(false); }, [layout]);
  useEffect(() => {
    if (!following) return;
    let timer = 0;
    const step = (i: number) => {
      if (i >= at.current.rows) { setFollowing(false); return; }
      at.current.sel = i;
      at.current.pick(i);
      timer = window.setTimeout(() => step(at.current.sel + 1), 1500 / at.current.speed);
    };
    // from the next row, or from the first when it is on the last one
    step(at.current.sel >= at.current.rows - 1 ? 0 : at.current.sel < 0 ? 0 : at.current.sel);
    return () => window.clearTimeout(timer);
  }, [following]);

  // Opening a failed test lands on the hop that failed; when no hop did (an assertion on the page), on the moment
  // its step failed, with the last message before it in view.
  const failedStep = trace.status === 'failed' && trace.failure ? trace.steps.find((s) => s.n === trace.failure!.step) : undefined;
  const failAt = failTime(layout, trace);

  // The address keeps the stop while walking: replaced, never pushed, and without a hashchange (which re-renders the
  // whole screen).
  const testPart = story ? undefined : trace.test;
  const mark = (s: Stop | null) => {
    if (!address) return;
    const base = address(view, testPart);
    history.replaceState(history.state, '', s ? withStop(base, stopId(s, layout)) : href(...splitStop(partsOf(location.hash))[0]));
  };
  /** The one way the cursor moves: every view, the video and the address follow. */
  const go = (s: Stop) => {
    if (s.kind === 'row') { setPin(null); pickRow(s.i); }
    else {
      setPin(s);
      setSel(s.kind === 'fail' ? layout.bad : -1);
      const t = s.kind === 'act' ? s.act.t0 : failAt ?? c.now;
      seek(t);
      const i = s.kind === 'act' && s.act.roots.length ? layout.rows.findIndex((r) => r.ex.id === s.act.roots[0]) : layout.rows.findLastIndex((r) => r.t <= t);
      if (i >= 0) requestAnimationFrame(() => scrollTo(i, true));
    }
    if (modeRef.current === 'step') mark(s);
  };
  /** «Ir al salto que falló»: the failing hop, else the moment the test failed; the cursor goes there, not only the clock. */
  const toFail = () => { if (layout.bad >= 0) go({ kind: 'row', i: layout.bad }); else if (failAt !== null) go({ kind: 'fail' }); };
  // Secuencia's rows and the logs are memoised: they get callbacks that stay the same, reading the latest cursor through a ref.
  const latest = useRef({ go, along: (_: number): Stop | undefined => undefined, goAt: (_: number) => {} });
  const pickSeq = useCallback((i: number) => latest.current.go({ kind: 'row', i }), []);
  const stepSeq = useCallback((d: number) => { const s = latest.current.along(d); if (s) latest.current.go(s); }, []);
  const logAt = useCallback((t: number) => latest.current.goAt(t), []);
  const timeOf = (s: Stop | null) => (!s ? c.now : s.kind === 'row' ? layout.rows[s.i]?.t ?? c.now : s.kind === 'act' ? s.act.t0 : failAt ?? c.now);
  const pos = stops.findIndex((w) => sameStop(w.s, cur));
  /** the stop d away in the walk; from a stop off the walk (a folded row), the nearest that way in time */
  const along = (d: number) => {
    const t = timeOf(cur);
    const i = pos >= 0 ? pos + d : d > 0 ? stops.findIndex((w) => w.t > t) : stops.findLastIndex((w) => w.t < t);
    return stops[Math.max(0, Math.min(stops.length - 1, i))]?.s;
  };
  latest.current = { go, along, goAt: (t) => goAt(t) };
  const actAlong = (d: number) => {
    const t = timeOf(cur);
    for (let i = pos >= 0 ? pos + d : d > 0 ? stops.findIndex((w) => w.t > t) : stops.findLastIndex((w) => w.t < t); i >= 0 && i < stops.length; i += d) if (stops[i].s.kind === 'act') return stops[i].s;
  };
  /** the last stop at or before `t`; moving `d` from the stop there when it would not move */
  const goAt = (t: number, d = 0) => {
    let i = stops.findLastIndex((w) => w.t <= t);
    if (d && i === pos) i += d;
    const s = stops[Math.max(0, Math.min(stops.length - 1, i))]?.s;
    if (s) go(s);
  };
  /** A Pasos step: its first stop, else its start (where «Paso a paso» has nothing at the cursor). */
  const stepGoal = (s: Step) => stepStop(stops, trace.steps, s) ?? { t: s.t0 + 1 };
  const goStep = (s: Step) => {
    const g = stepGoal(s);
    if ('s' in g) { go(g.s); return; }
    // nothing of its own at the cursor in either mode: the card and «Cadena» must not keep naming another step
    setPin(null); setSel(-1);
    if (modeRef.current === 'step') mark(null);
    seek(g.t);
  };
  const rowOf = (id: string): Stop | undefined => { const i = layout.rows.findIndex((r) => r.ex.id === id && !r.reply); return i >= 0 ? { kind: 'row', i } : undefined; };
  const shownId = (id: string) => !ch.noise.has(id) || showAll || unfolded.has(ch.actOf.get(id) ?? '');
  /** → : what the current hop caused first (an act: its first root) */
  const into = (): Stop | undefined => {
    if (cur?.kind === 'act') { const id = cur.act.roots.find(shownId) ?? cur.act.roots[0]; return id ? rowOf(id) : undefined; }
    if (cur?.kind !== 'row') return undefined;
    const kids = ch.effects.get(layout.rows[cur.i].ex.id) ?? [];
    const id = kids.find(shownId) ?? kids[0];
    return id ? rowOf(id) : undefined;
  };
  /** ← : what caused it, or its act from a root */
  const outOf = (): Stop | undefined => {
    if (cur?.kind !== 'row') return undefined;
    const id = layout.rows[cur.i].ex.id, p = ch.cause.get(id)?.parent;
    if (p) return rowOf(p);
    const act = ch.acts.find((a) => a.id === ch.actOf.get(id));
    return act && { kind: 'act', act };
  };
  /** R : the request and its response */
  const other = (): Stop | undefined => {
    if (cur?.kind !== 'row') return undefined;
    const r = layout.rows[cur.i];
    const i = layout.rows.findIndex((x) => x.ex.id === r.ex.id && x.reply !== r.reply);
    return i >= 0 ? { kind: 'row', i } : undefined;
  };
  const actOfCur = cur?.kind === 'act' ? cur.act.id : cur?.kind === 'row' ? ch.actOf.get(layout.rows[cur.i]?.ex.id ?? '') : undefined;
  const toggleFold = (act: string) => setUnfolded((u) => { const n = new Set(u); if (n.has(act)) n.delete(act); else n.add(act); return n; });

  /** Where «Paso a paso» lands: the selected stop, else the last before now, else the failing hop, else the first act. */
  const landing = (): Stop | undefined => {
    if (cur && stops.some((w) => sameStop(w.s, cur))) return cur;
    const i = stops.findLastIndex((w) => w.t <= c.now);
    if (c.now > 0 && i >= 0) return stops[i].s;
    if (layout.bad >= 0) return { kind: 'row', i: layout.bad };
    return stops.find((w) => w.s.kind === 'act')?.s ?? stops[0]?.s;
  };
  const enter = (s?: Stop) => {
    c.pause();
    if (modeRef.current !== 'step' && !studio) { before.current = tab; setTab('chain'); }
    setMode('step');
    modeRef.current = 'step';
    const to = s ?? landing();
    if (to) go(to);
  };
  const leave = (play = false) => {
    setMode('clock');
    modeRef.current = 'clock';
    if (!studio) setTab(before.current);
    mark(null);
    if (play) c.play();
  };
  useEffect(() => {
    const s = askedStop ? stopOf(askedStop, layout, ch, failAt !== null) : undefined;
    if (s) { enter(s); return; }
    if (layout.bad >= 0) { seek(layout.rows[layout.bad].t); requestAnimationFrame(() => scrollTo(layout.bad, true)); } else toFail();
  }, []);
  // Every move of the clock (playing, a key, the scrubber, a step, a log line) keeps the current row in view.
  const current = layout.rows.findLastIndex((r) => r.t <= c.now);
  // Before the first row (0:00), the first one.
  useEffect(() => scrollTo(Math.max(0, current)), [c.now, current, scrollTo]);
  // Back in Secuencia, the selection is in view.
  useEffect(() => { if (view === 'seq' && sel >= 0) requestAnimationFrame(() => scrollTo(sel, true)); }, [view]);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.closest(OWN_KEYS)) return;
    if (mode === 'clock') {
      // WCAG 2.1.4: a one-letter key only while the focus is in the player
      if ((e.key === 'p' || e.key === 'P') && !e.shiftKey) { e.preventDefault(); enter(); }
      return;
    }
    // a button, a link or a summary does its own Enter and Space
    if ((e.key === 'Enter' || e.key === ' ') && el.closest('button, a, summary, [role="button"]')) return;
    let s: Stop | undefined;
    if (e.key === 'ArrowDown') s = e.shiftKey ? actAlong(1) : along(1);
    else if (e.key === 'ArrowUp') s = e.shiftKey ? actAlong(-1) : along(-1);
    else if (e.key === 'ArrowRight') s = into();
    else if (e.key === 'ArrowLeft') s = outOf();
    else if (e.key === 'Home') s = stops[0]?.s;
    else if (e.key === 'End') s = stops.at(-1)?.s;
    else if (e.key === 'r' || e.key === 'R') s = other();
    else if (e.key === 'Enter') { if (actOfCur) toggleFold(actOfCur); }
    else if (e.key === 'Escape') leave();
    else return;
    e.preventDefault();
    if (s) go(s);
  };

  /** The studio's keys, wherever the focus is in it: Space plays, ← → move a message (⇧ an act), Esc leaves. */
  const studioKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.closest(OWN_KEYS) || el.closest('dialog')) return;
    if (mode === 'step') { keys(e); return; }
    if (e.key === ' ' && !el.closest('button, a, summary, [role="button"]')) { e.preventDefault(); c.toggle(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const d = e.key === 'ArrowRight' ? 1 : -1, s = e.shiftKey ? actAlong(d) : along(d);
      e.preventDefault();
      if (s) { c.pause(); go(s); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); toggleStudio(); return; }
    keys(e);
  };

  const row = cur?.kind === 'row' ? layout.rows[cur.i] : undefined;
  const selected = row?.ex;
  const names = useMemo(() => new Map(trace.participants.map((p) => [p.id, p.name])), [trace]);
  const types = useMemo(() => new Map<string, string>(trace.participants.map((p) => [p.id, p.type])), [trace]);
  const who = (id: string) => names.get(id) ?? id;
  const walkRows = useMemo(() => stops.flatMap((w) => (w.s.kind === 'row' ? [w.s.i] : [])), [stops]);
  const where = whereOf(cur, ctx, layout, walkRows, actNo, trace.steps, timeOf(cur));
  // What the inspector announces: in «Paso a paso», the stop's sentence; else a response says what it answers, and
  // every row says who talks to whom.
  const said = mode === 'step' && cur ? `${actName(where)}${where.m ? `, mensaje ${where.m} de ${where.n}` : ''}: ${say(cur, ctx)}`
    : row ? `${clock(row.t)}: ${row.reply ? `respuesta a ${row.ex.label}: ${row.label}, de ${who(row.ex.to)} a ${who(row.ex.from)}` : `${row.ex.label}, de ${who(ends(row.ex)[0])} a ${who(ends(row.ex)[1])}`}${row.ex.ok ? '' : ', falló'}` : '';
  const failedAt = trace.failure ? trace.steps.find((s) => s.n === trace.failure!.step) : undefined;
  // The hop that failed, by name and template: matched against the map now, whatever test, run or age the trace is.
  const hop = layout.bad >= 0 ? layout.rows[layout.bad].ex : undefined;
  const badEdges = lit ? [...lit.edges.values()].filter((e) => e.bad).length : 0;
  const vid = `view-${run.id}-${slug}`;
  const hot = useMemo(() => (mode === 'clock' ? new Set(layout.rows.filter((r) => rowState(r, c.now) === 'now').map((r) => r.ex.id)) : undefined), [mode, layout, c.now]);
  // In «Paso a paso» the map draws the way the current hop came: its ancestors' edges, or all of an act's.
  const path = useMemo(() => {
    if (mode !== 'step' || !cur) return undefined;
    if (cur.kind === 'act') return new Set(trace.exchanges.filter((e) => ch.actOf.get(e.id) === cur.act.id).map((e) => e.id));
    if (cur.kind !== 'row') return undefined;
    const out = new Set<string>();
    for (let x = ch.cause.get(layout.rows[cur.i].ex.id)?.parent, i = 0; x && i < 200; x = ch.cause.get(x)?.parent, i++) out.add(x);
    return out;
  }, [mode, cur, ch, layout, trace]);
  const folded = useMemo(() => (mode === 'step' ? new Set([...ch.noise.keys()].filter((id) => !shownId(id))) : undefined), [mode, ch, showAll, unfolded]);
  const total = stops.length;
  // An edge stands for its exchanges: the one that failed, else the next from now, else its first.
  const pickEdge = (e: FlowEdge) => {
    const xs = e.ex.map((id) => layout.rows.find((r) => r.ex.id === id)?.ex).filter((x) => x !== undefined);
    const x = xs.find((y) => !y.ok) ?? xs.find((y) => y.t0 >= c.now) ?? xs[0];
    const s = x && rowOf(x.id);
    if (s) go(s);
  };
  const pickEx = (id: string) => { const s = rowOf(id); if (s) go(s); };
  // «Recorrido», the studio's own view: the chain, the order and what each request carried and got back, in one list
  const journey = studio && onStage === 'journey';
  const shown = journey ? 'journey' : view;
  const seqView = (
    <div key="seq" className="diagram">
      <div className="view-bar">
        <Tabs id={vid} className="tabs view-tabs" label="Vista del flujo" value={shown} onChange={(v) => { setStage(v === 'journey' ? 'journey' : 'view'); if (v !== 'journey') pickView(v); }}
          tabs={[...(studio ? [{ key: 'journey' as const, label: 'Recorrido' }] : []), { key: 'seq', label: 'Secuencia' }, { key: 'map', label: 'Mapa' }]} />
        <span className="faint num">{mode === 'step' ? `Paso a paso · ${pos + 1 || '–'} de ${total}` : shown !== 'map' ? plural(trace.exchanges.length, 'mensaje', 'mensajes') : lit ? `${plural(lit.edges.size, 'conexión', 'conexiones')}${badEdges ? ` · ${badEdges} ${badEdges === 1 ? 'falló' : 'fallaron'}` : ''}` : ''}</span>
      </div>
      <div role="tabpanel" id={`${vid}-panel`} aria-labelledby={`${vid}-tab-${shown}`} className="diagram-panel">
        {journey ? <Journey trace={trace} ctx={ctx} lanes={layout.lanes} sel={selected?.id} onPick={(id) => { c.pause(); pickEx(id); }} hot={hot} time={clock} />
          : view === 'seq' ?<SeqView layout={layout} now={c.now} sel={sel} onPick={pickSeq} wrap={wrap} onStep={mode === 'step' ? stepSeq : undefined} folded={folded} />
          : arch && lit ? <FlowMap lay={arch.lay} pieces={arch.pieces} lit={lit} sel={row?.ex.id} hot={hot} path={path} onPick={pickEdge} />
          : <p className="empty flow-map">Sin mapa: pulsa «Releer el código» en <a className="rowlink" href={href('repos')}>Proyectos</a>.</p>}
      </div>
    </div>
  );
  const walking = mode === 'step' ? {
    where, pos, total,
    prev: () => { const s = along(-1); if (s) go(s); }, next: () => { const s = along(1); if (s) go(s); },
    prevAct: () => { const s = actAlong(-1); if (s) go(s); }, nextAct: () => { const s = actAlong(1); if (s) go(s); },
    showAll, setShowAll, leave,
  } : undefined;
  const transport = <Transport key="transport" layout={layout} trace={trace} c={c} onFail={failAt === null ? undefined : toFail} walking={walking} following={following} onFollow={() => { if (following) setFollowing(false); else { c.pause(); setFollowing(true); } }} follow={devices}
    onSeek={mode === 'step' ? (t) => goAt(t, Math.sign(t - c.now)) : c.seek} onWalk={() => (mode === 'step' ? leave() : enter())} onPlay={mode === 'step' ? () => leave(true) : c.toggle} />;
  const cause = selected ? ch.cause.get(selected.id) : undefined;
  // the request the selected hop is part of, forwards included: from the first sender to the piece that served it
  const way = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(trace.exchanges.map((e) => [e.id, e]));
    let head = selected.id;
    for (let c = ch.cause.get(head), i = 0; c?.how === 'forward' && i < 20; c = ch.cause.get(head), i++) head = c.parent;
    const out = [head];
    for (let i = 0; i < 20; i++) { const f = (ch.effects.get(out.at(-1)!) ?? []).find((k) => ch.cause.get(k)?.how === 'forward'); if (!f) break; out.push(f); }
    return out.map((id) => byId.get(id)!).filter(Boolean);
  }, [selected, ch, trace]);

  const screen = (
        <div className="screen">
          <div className="screen-meta"><span>{mode === 'step' ? (src ? `Fotograma de ${atMs(c.now)} · en pausa` : story ? 'Sin vídeo: el fotograma no aplica.' : 'Sin vídeo en los casos cortos: el fotograma no aplica.') : src ? 'Grabación de la historia' : 'Esta prueba no graba vídeo'}</span><span className="screen-tools"><span className="mono num">{clock(c.now)}</span>
            {trace.video && <OneVideo run={run.id} slug={slug} video={trace.video} several={(trace.screens ?? []).some((x) => x.video && x.startMs !== undefined)} />}{src && !studio && <button className="icon-btn" aria-pressed={big} onClick={toggleBig} aria-label="Vídeo grande" title={big ? 'Volver al vídeo junto a la secuencia' : 'Vídeo a todo el ancho, la secuencia debajo'}>{big ? <Minimize2 /> : <Maximize2 />}</button>}{src && <button className="icon-btn" onClick={() => openFloat('')} aria-label="Abrir el vídeo en una ventana" title="Abrir el vídeo en una ventana flotante que se mueve y cambia de tamaño"><ArrowUpRight /></button>}</span></div>
          <div className="player">
            {src ? <video ref={setVideo} src={src} muted playsInline preload="auto" aria-label={`Vídeo de «${trace.test}»`} onClick={mode === 'step' ? () => leave(true) : c.toggle} onLoadedMetadata={(e) => setDims(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`)}
              onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setVideoMs(e.currentTarget.duration * 1000)} />
              : <div className="novideo"><Film /><span>Sin vídeo: el reloj es un temporizador de {secs(layout.duration)}.</span></div>}
            {blank && <div className="novideo">Abriendo el navegador…</div>}
            {step && <div className="caption">{step.n}. {step.title}</div>}
          </div>
          <OtherScreens run={run.id} slug={slug} trace={trace} now={c.now} playing={c.playing} speed={c.speed} onOpen={openFloat} />
          {floats.map((name, i) => {
            const s = name ? (trace.screens ?? []).find((x) => x.name === name) : undefined;
            const fsrc = name ? (s?.video ? fileUrl(run.id, `flows/${slug}/${s.video}`) : null) : src;
            if (!fsrc) return null;
            return <FloatingScreen key={name || '·'} index={i} phone={Boolean(name)} title={name ? `Pantalla de ${name}` : 'Grabación de la historia'} src={fsrc} startMs={s?.startMs ?? 0}
              now={c.now} playing={c.playing} speed={c.speed} onClose={() => setFloats((f) => f.filter((x) => x !== name))} />;
          })}
          <div className="screen-meta"><span>{src ? 'El vídeo marca el reloj de todas las vistas' : 'El temporizador marca el reloj de todas las vistas'}</span><span className="num">{src ? dims : ''}</span></div>
        </div>
  );
  const inspector = (
        <Inspector ex={selected} names={names} said={said} cause={cause} way={way} reply={Boolean(row?.reply)} msgLink={selected?.msg && !run.ephemeral ? href('mail', run.env, selected.msg.id) : undefined}
          card={<StepCard ctx={ctx} layout={layout} cur={cur} go={go} where={where} logs={trace.logs} onLogs={() => setTab('logs')} onWalk={mode === 'clock' ? (s) => enter(s) : undefined} />}
          contract={selected ? <ExchangeContract ex={selected} exchanges={trace.exchanges} k={k} types={types} g={g} match={match} /> : null} />
  );
  const side = journey && (tab === 'msg' || tab === 'chain') ? 'steps' : tab;
  const evidence = (
    <>
          <Tabs id={`run-${run.id}-${slug}`} label="Evidencia del run" value={side} onChange={setTab} tabs={[
            // «Recorrido» already holds the message and the chain: the side keeps the rest
            ...(studio && !journey ? [{ key: 'msg' as const, label: 'Mensaje' }] : []),
            ...(journey ? [] : [{ key: 'chain' as const, label: 'Cadena', n: actNo.size }]),
            { key: 'steps', label: 'Pasos', n: stepsTotal },
            { key: 'net', label: 'Red', n: trace.exchanges.filter((e) => e.kind !== 'sql').length },
            { key: 'logs', label: 'Logs', n: trace.logs.length },
            { key: 'data', label: 'Datos', n: trace.exchanges.filter((e) => e.kind === 'sql').length },
            ...(story && run.kind !== 'session' ? [{ key: 'behavior' as const, label: 'Comportamiento', n: run.results[slug]?.drift }] : []),
            { key: 'files', label: 'Evidencias' },
          ]} />
          <div role="tabpanel" id={`run-${run.id}-${slug}-panel`} aria-labelledby={`run-${run.id}-${slug}-tab-${side}`} className="run-tab">
            {side === 'msg' && inspector}
            {side === 'chain' && <ChainTab ctx={ctx} layout={layout} steps={trace.steps} cur={cur} go={go} hot={hot} showAll={showAll} setShowAll={setShowAll} unfolded={unfolded} toggleFold={toggleFold} actNo={actNo}
              failAct={layout.bad >= 0 ? ch.actOf.get(layout.rows[layout.bad].ex.id) : failAt !== null ? ch.acts.findLast((a) => a.t0 <= failAt)?.id : undefined} onWalk={(a) => enter({ kind: 'act', act: a })} />}
            {side === 'steps' && <StepsTab run={run} slug={slug} steps={trace.steps} total={stepsTotal} cur={step?.n} flow={flow} go={goStep} to={(s) => stepGoal(s).t} />}
            {side === 'net' && <NetTab exchanges={trace.exchanges} sel={selected?.id} pick={pickEx} />}
            {side === 'logs' && <LogsTab logs={trace.logs} seek={logAt} approximate={trace.concurrent} />}
            {side === 'data' && <DataTab run={run} exchanges={trace.exchanges} sel={selected?.id} pick={pickEx} />}
            {side === 'behavior' && <BehaviorTab run={run.id} flow={slug} complete={trace.steps.length >= stepsTotal} />}
            {side === 'files' && <FilesTab id={run.id} detail={'retention' in run ? (run as RunDetail) : undefined} />}
          </div>
    </>
  );

  if (studio) return (
    <div ref={studioRef} className={`studio st-resizable${mode === 'step' ? ' stepping' : ''}`} tabIndex={-1} onKeyDown={studioKeys} role="region" aria-label={`Estudio de «${trace.test}»`}
      style={{ '--st-video': lay.hide.video ? '0px' : `${lay.video}px`, '--st-side': lay.hide.side ? '0px' : `${lay.side}px`, '--st-tracks': lay.hide.tracks ? '0px' : `${lay.tracks}px` } as React.CSSProperties}>
      <header className="st-bar">
        <b className="st-title" title={trace.test}>{trace.test}</b>
        <span className="faint num">run {run.id} · {run.env}</span>
        <span className="grow" />
        <details className="st-help">
          <summary className="btn sm">Atajos</summary>
          <dl className="st-help-pop">
            <dt><kbd>Espacio</kbd></dt><dd>reproduce o pausa</dd>
            <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>mensaje anterior o siguiente</dd>
            <dt><kbd>⇧</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>acción anterior o siguiente</dd>
            <dt><kbd>P</kbd></dt><dd>paso a paso</dd>
            <dt><kbd>Esc</kbd></dt><dd>sale del estudio</dd>
          </dl>
        </details>
        <button type="button" className="btn sm" onClick={toggleStudio} title="Volver a donde lo abriste (Esc)"><Minimize2 />Salir del estudio</button>
      </header>
      <div className="st-video" hidden={lay.hide.video}>{screen}</div>
      <Splitter axis="x" area="vs" label="Ancho del vídeo" onMove={(d) => resize('video', d)} panel={{ name: 'Vídeo', hidden: Boolean(lay.hide.video), onFlip: () => flip('video'), side: 'left' }} />
      <div className="st-stage">{seqView}</div>
      <Splitter axis="x" area="ss" label="Ancho del inspector" onMove={(d) => resize('side', -d)} panel={{ name: 'Inspector', hidden: Boolean(lay.hide.side), onFlip: () => flip('side'), side: 'right' }} />
      <aside className="st-side" aria-label="Inspector" hidden={lay.hide.side}>{evidence}</aside>
      <div className="st-transport">{transport}</div>
      <Splitter axis="y" area="ts" label="Alto de las pistas" onMove={(d) => resize('tracks', -d)} panel={{ name: 'Pistas', hidden: Boolean(lay.hide.tracks), onFlip: () => flip('tracks'), side: 'down' }} />
      <Tracks hidden={lay.hide.tracks} layout={layout} trace={trace} noise={ch.noise} now={c.now} T={Math.max(1, c.duration)} sel={selected?.id} onSeek={mode === 'step' ? (t) => goAt(t, Math.sign(t - c.now)) : c.seek} onPick={(i) => { c.pause(); go({ kind: 'row', i }); }} />
    </div>
  );

  return (
    <div className="run-player" onKeyDown={keys}>
      {trace.foreign ? <div className="notice warn"><Zap /><div><b>Tráfico ajeno en la ventana.</b> {plural(trace.foreign, 'petición llegó', 'peticiones llegaron')} desde fuera del run mientras corría: la traza puede mezclarlas.</div></div> : null}
      <p className="st-open"><button type="button" className="btn sm" onClick={toggleStudio}><Maximize2 />Abrir en el estudio</button><span className="faint">Vídeo, arquitectura, mensaje y línea de tiempo en una sola pantalla</span></p>
      <section ref={stage} className={`${large ? 'stage-run big' : 'stage-run'}${mode === 'step' ? ' stepping' : ''}`} aria-label="Reproducción">
        {screen}
        {/* in the DOM in the order they are seen, so focus and reading follow the screen; keyed, so they move, not remount */}
        {(large ? [transport, seqView] : [seqView, transport])}
      </section>

      <div className="run-bottom">
        <section className="panel">
          {evidence}
        </section>
        {inspector}
      </div>
    </div>
  );
}

/** The sequence diagram. `still` is a drawing with no clock behind it (what a flow that never ran should do). */
export const SeqView = memo(function SeqView({ layout, now, sel, onPick, wrap, still, onStep, folded }: {
  layout: SeqLayout; now: number; sel: number; onPick: (i: number) => void; wrap: RefObject<HTMLDivElement | null>; still?: boolean;
  /** «Paso a paso»: the arrows walk its stops instead of the rows */
  onStep?: (d: 1 | -1) => void;
  /** «Paso a paso»: the rows folded away, dimmed and skipped */
  folded?: Set<string>;
}) {
  const W = layout.width;
  // The pick is announced once, by the inspector.
  const move = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d || !layout.rows.length || (onStep && e.shiftKey)) return;
    e.preventDefault();
    if (onStep) onStep(d);
    else onPick(Math.max(0, Math.min(layout.rows.length - 1, (sel < 0 ? -1 : sel) + d)));
  };
  return (
    <div className="seq-wrap" ref={wrap} tabIndex={0} role="group" onKeyDown={move}
      aria-label={`Diagrama de secuencia, ${plural(layout.rows.length, 'mensaje', 'mensajes')}. ${onStep ? 'Paso a paso: las flechas arriba y abajo recorren los mensajes sin los plegados, con mayúsculas las acciones' : `Las flechas arriba y abajo recorren los mensajes${still ? '' : ' y llevan el vídeo a cada uno'}`}.`}>
      <div className="seq-head" style={{ width: W }}>
        <svg className="seq" width={W} height={HEAD_H + (layout.projects.length ? PROJECT_H : 0)} aria-hidden="true">
          {layout.projects.map((b) => <g key={`${b.project}${b.x1}`} className="proj-band"><line x1={b.x1 + 6} x2={b.x2 - 6} y1={PROJECT_H - 3} y2={PROJECT_H - 3} /><text x={b.x1 + 8} y={PROJECT_H - 7}>{fit(b.project, b.x2 - b.x1 - 16)}</text></g>)}
          <g transform={layout.projects.length ? `translate(0 ${PROJECT_H})` : undefined}>
            {layout.lanes.map((l) => (
              <g key={l.id}>
                <line className="life" x1={l.x} x2={l.x} y1={44} y2={HEAD_H} />
                <g className="lane-h"><rect x={l.x - LANE_W / 2 + 6} y={8} width={LANE_W - 12} height={36} rx={6} /><text x={l.x - LANE_W / 2 + 15} y={23}>{fit(l.name, LANE_W - 24)}</text><text className="sub" x={l.x - LANE_W / 2 + 15} y={37}>{fit(l.sub, LANE_W - 24)}</text></g>
              </g>
            ))}
          </g>
        </svg>
      </div>
      <svg className="seq" width={W} height={layout.height} aria-hidden="true">
        {layout.lanes.map((l) => <line key={l.id} className="life" x1={l.x} x2={l.x} y1={0} y2={layout.height - 8} />)}
        {layout.items.map((it) => it.type === 'band' ? (
          <g key={`b${it.step.n}`} className={`step-band${it.step.status === 'failed' ? ' failed' : ''}`}>
            <line x1={12} x2={W - 12} y1={it.y + 4} y2={it.y + 4} />
            <text x={14} y={it.y + 19}>{it.step.n}. {it.step.title}{it.step.status === 'failed' ? ' · falló' : ''}</text>
          </g>
        ) : <Msg key={it.i} r={it} w={W} state={rowState(it, now)} sel={it.i === sel} fold={Boolean(folded?.has(it.ex.id))} onPick={onPick} />)}
      </svg>
    </div>
  );
});

const KIND_LEGEND: Array<[string, string]> = [['call', 'llamada'], ['event', 'evento'], ['store', 'almacén'], ['observed', 'no está en el código']];
/** The dash patterns of a map's edges, said in words: colour never says it alone. */
export const EdgeLegend = ({ extra }: { extra?: ReactNode }) => (
  <div className="legend">
    {KIND_LEGEND.map(([k, label]) => <span key={k}><svg className="lg" width="22" height="8" aria-hidden="true"><path d="M1 4H21" className={`e ${k}`} /></svg>{label}</span>)}
    {extra}
  </div>
);

/**
 * A test on the full map: every piece of the system, what the test went through lit and the rest dimmed. Lit edges are
 * buttons that pick their exchange (the Red tab is their full list), each with this test's label in the room the page
 * keeps for it; dimmed edges have no label and no stop. Red goes only on the hop that failed. Without `onPick` it is a
 * drawing (what a flow that never ran expects).
 */
/** The most packets that run on a map at once: more than this is a swarm, not a path. */
export const MAX_PACKETS = 24;

export function FlowMap({ lay, pieces, lit, sel, hot, path, onPick, expected }: {
  lay: Layout<MapEdge>; pieces: MapNode[]; lit: Pick<Lit, 'edges' | 'nodes' | 'quiet'>; sel?: string; hot?: Set<string>;
  /** «Paso a paso»: the exchanges the current hop came through */
  path?: Set<string>; onPick?: (e: FlowEdge) => void; expected?: boolean;
}) {
  const name = (id: string) => lay.nodes.find((p) => p.node.id === id)?.node.name ?? id;
  const col = new Map(lay.nodes.map((p) => [p.node.id, p]));
  // Column by column, top to bottom: the order they are seen is the order the keyboard takes.
  const all = [...lay.edges].sort((a, b) => (col.get(a.from)?.col ?? 0) - (col.get(b.from)?.col ?? 0) || (col.get(a.from)?.y ?? 0) - (col.get(b.from)?.y ?? 0) || a.ly - b.ly);
  const edges = all.flatMap((e) => { const f = lit.edges.get(e.id); return f ? [{ ...e, ...f, d: e.d, lx: e.lx, ly: e.ly, lw: e.lw }] : []; });
  const dim = all.filter((e) => !lit.edges.has(e.id));
  const selEdge = sel ? edges.find((e) => e.ex.includes(sel)) : undefined;
  const bad = edges.filter((e) => e.bad).length;
  const said = (e: FlowEdge) => `${name(e.from)} a ${name(e.to)}${e.label ? `: ${(e.kind === 'call' && e.n ? e.label.replace(/^\d+/, plural(e.n, 'petición', 'peticiones')) : e.label).replaceAll(' · ', ', ')}` : ''}`;
  const used = pieces.filter((p) => lit.nodes.has(p.id));
  const onPath = (e: FlowEdge) => Boolean(path && e !== selEdge && e.ex.some((id) => path.has(id)));
  return (
    <div className="flow-map">
      <MapCanvas lay={lay} label={`${expected ? 'Mapa esperado del flujo' : 'Mapa del flujo'}: ${used.length} de ${plural(pieces.length, 'pieza', 'piezas')} usadas, ${plural(edges.length, 'conexión', 'conexiones')}${bad ? `, ${bad} ${bad === 1 ? 'falló' : 'fallaron'}` : ''}`} keep={selEdge?.to}>
        <g aria-hidden="true">{dim.map((e) => <path key={e.id} d={e.d} className={`e ${e.kind} dim`} />)}</g>
        {expected || !onPick ? (
          <g aria-hidden="true">{edges.map((e) => <path key={e.id} d={e.d} className={`e ${e.kind} ${expected ? 'expected' : 'flow'}`} markerEnd="url(#arrow)" />)}</g>
        ) : edges.map((e) => {
          const isSel = e === selEdge, now = Boolean(hot && e.ex.some((id) => hot.has(id)));
          return (
            <g key={e.id} className="fe" role="button" tabIndex={0} aria-pressed={isSel} aria-label={said(e)} onClick={() => onPick(e)}
              onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); onPick(e); } }}>
              <path d={e.d} className="hit" />
              <path d={e.d} className={['e', e.kind, 'flow', e.bad && 'bad', !e.inMap && 'observed', lit.quiet.has(e.id) && 'derived', now && 'now', onPath(e) && 'path', isSel && 'sel'].filter(Boolean).join(' ')} markerEnd={`url(#${e.bad ? 'arrow-err' : isSel || now || onPath(e) ? 'arrow-acc' : 'arrow'})`} />
            </g>
          );
        })}
        {/* A packet runs along each edge a message is on now (playing or stepping), never more than MAX_PACKETS at once; «reduced motion» draws none. */}
        <g aria-hidden="true">{edges.filter((e) => (hot && e.ex.some((id) => hot.has(id))) || onPath(e)).slice(0, MAX_PACKETS).map((e) => (
          <circle key={e.id} className="packet" r={4}><animateMotion dur={`${Math.max(0.8, Math.min(2.2, 0.8 + (e.d.length / 600)))}s`} repeatCount="indefinite" path={e.d} /></circle>
        ))}</g>
        {/* Labels over the lines, each stopping its own; each picks its edge too (the edge itself says it). */}
        <g aria-hidden="true">{edges.map((e) => (
          <g key={e.id} className="fe-l" onClick={() => onPick?.(e)}><EdgeLabel e={e} className={`${e.bad ? 'bad' : ''}${e === selEdge || onPath(e) || (hot && e.ex.some((id) => hot.has(id))) ? ' hot' : ''}`} /></g>
        ))}</g>
        {lay.nodes.map(({ node, x, y }) => {
          const on = lit.nodes.has(node.id) || node.kind === 'actor';
          return <NodeBox key={node.id} node={node} x={x} y={y} className={on ? 'static' : 'static untouched'} sub={!on ? (expected ? 'no lo usaría' : 'no lo usó') : node.kind === 'actor' ? 'actor' : KIND[node.kind ?? ''] ?? node.kind ?? ''} />;
        })}
      </MapCanvas>
      <EdgeLegend extra={expected ? <span>«esperado»: lo dice el código; ningún run lo ha visto</span> : <><span><span className="err-ink">rojo y «falló»</span>: el salto que falló</span><span>atenuado y «no lo usó»: esta prueba no pasó por ahí</span></>} />
    </div>
  );
}

/** The label with its masks boxed, as everywhere else: odd pieces are marks, each on a box drawn under it. */
function Label({ text, x, y, className }: { text: string; x: number; y: number; className?: string }) {
  const parts = text.split(/(…[\w-]{4})/);
  let at = 0;
  const boxes = parts.map((p, i) => { const box = i % 2 ? <rect key={i} className="mask" x={x + at * CH - 2} y={y - 10} width={p.length * CH + 4} height={13} rx={2} /> : null; at += p.length; return box; });
  return <>{boxes}<text x={x} y={y} className={className}>{parts.map((p, i) => (i % 2 ? <tspan key={i} className="mask">{p}</tspan> : p))}</text></>;
}

const Msg = memo(function Msg({ r, w, state, sel, fold, onPick }: { r: Row; w: number; state: string; sel: boolean; fold: boolean; onPick: (i: number) => void }) {
  const { x1, x2, y } = r;
  const dir = x2 >= x1 ? 1 : -1;
  const cls = ['msg', `k-${r.ex.kind}`, state, r.bad ? 'bad' : '', r.fault ? 'fault' : '', sel ? 'sel' : '', fold ? 'fold' : ''].filter(Boolean).join(' ');
  const dash = r.reply ? 'ret' : r.async ? 'async' : r.derived ? 'derived' : undefined;
  const self = x1 === x2;
  return (
    <g className={cls} onClick={() => onPick(r.i)}>
      <title>{`${clock(r.t)} ${r.ex.kind} ${r.label}${r.ex.origin === 'derived' ? ' (derivado)' : ''}${fold ? ' (plegado)' : ''}`}</title>
      <rect className="hit" x={8} y={y - ROW_H / 2 + 1} width={w - 16} height={ROW_H - 2} rx={4} />
      <rect className="tick" x={2} y={y - ROW_H / 2 + 1} width={3} height={ROW_H - 2} rx={1.5} />
      {self ? <path className={dash} d={`M${x1} ${y - 6} h22 v12 h-22`} /> : <line className={dash} x1={x1} x2={x2} y1={y} y2={y} />}
      {state !== 'future' && <path d={self ? `M${x1 + 6} ${y + 2} L${x1} ${y + 6} L${x1 + 6} ${y + 10}` : `M${x2 - dir * 7} ${y - 4} L${x2} ${y} L${x2 - dir * 7} ${y + 4}`} />}
      <Label text={fit(r.label, labelRoom(r, w))} x={Math.min(x1, x2) + 8} y={y - 5} className={r.reply && r.ex.status !== undefined ? `st-${statusClass(r.ex.status)}` : undefined} />
      {r.fault && <text className="f" x={Math.max(x1, x2) - 8} y={y - 5} textAnchor="end">{r.fault}</text>}
    </g>
  );
});

interface Walking {
  where: Where; pos: number; total: number;
  prev: () => void; next: () => void; prevAct: () => void; nextAct: () => void;
  showAll: boolean; setShowAll: (b: boolean) => void; leave: () => void;
}

function Transport({ layout, trace, c, onFail, walking, following, onFollow, follow, onSeek, onWalk, onPlay }: { layout: SeqLayout; trace: Trace; c: ReturnType<typeof useClock>; onFail?: () => void; walking?: Walking; following: boolean; onFollow: () => void; /** what Seguimiento follows: one device, or all */ follow?: ReactNode; onSeek: (t: number) => void; onWalk: () => void; onPlay: () => void }) {
  const T = Math.max(1, c.duration);
  const scrub = useRef<HTMLDivElement>(null);
  const fromX = (e: PointerEvent) => { const r = scrub.current!.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * T); };
  const keys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 5000 : 500;
    const to = e.key === 'ArrowRight' ? c.now + step : e.key === 'ArrowLeft' ? c.now - step : e.key === 'Home' ? 0 : e.key === 'End' ? T : null;
    if (to !== null) { e.preventDefault(); onSeek(to); }
    if (e.key === ' ') { e.preventDefault(); onPlay(); }
  };
  const steps = [...trace.steps].sort((a, b) => a.t0 - b.t0);
  const w = walking?.where;
  const scrubber = (
    <div className="scrub" ref={scrub} role="slider" tabIndex={0} aria-label="Tiempo" aria-valuemin={0} aria-valuemax={Math.round(T)} aria-valuenow={Math.round(c.now)} aria-valuetext={clock(c.now)}
      onKeyDown={keys} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); fromX(e); }} onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromX(e)}>
      <div className="bands">{steps.map((s) => <span key={s.n} className={s.status === 'failed' ? 'err' : undefined} style={{ left: `${(s.t0 / T) * 100}%`, width: `${(Math.max(0, s.t1 - s.t0) / T) * 100}%` }} title={`${s.n}. ${s.title}`} />)}</div>
      <div className="evs">{layout.rows.filter((r) => !r.reply).map((r) => <i key={r.i} className={r.bad || r.ex.ok === false ? 'bad' : undefined} style={{ left: `${(r.t / T) * 100}%` }} />)}</div>
      <div className="head-line" style={{ left: `${(c.now / T) * 100}%` }} />
    </div>
  );
  if (walking && w) return (
    <div className="transport walking" role="group" aria-label="Paso a paso">
      <div className="walk-row">
        <button type="button" className="btn sm" onClick={walking.prev} aria-keyshortcuts="ArrowUp"><ChevronLeft />Anterior <kbd>↑</kbd></button>
        <button type="button" className="btn sm" onClick={walking.next} aria-keyshortcuts="ArrowDown">Siguiente <kbd>↓</kbd><ChevronRight /></button>
        <button type="button" className="btn sm" onClick={walking.prevAct} aria-keyshortcuts="Shift+ArrowUp"><ChevronsLeft />Acción <kbd>⇧↑</kbd></button>
        <button type="button" className="btn sm" onClick={walking.nextAct} aria-keyshortcuts="Shift+ArrowDown">Acción <kbd>⇧↓</kbd><ChevronsRight /></button>
        <span className="walk-where num">{actName(w)}{w.act && w.act.id !== 'preparacion' ? ` de ${w.acts}` : ''}{w.m ? ` · mensaje ${w.m} de ${w.n}` : ''}{w.step ? ` · paso ${w.step.n}` : ''}</span>
      </div>
      <div className="walk-row">
        <span className="time">{atMs(c.now)} / {clock(T)}</span>
        {scrubber}
        {follow}
        <button type="button" className="btn sm" aria-pressed={walking.showAll} onClick={() => walking.setShowAll(!walking.showAll)}>Mostrar lo plegado</button>
        <button type="button" className="btn sm" onClick={onPlay}><Play />Reproducir desde aquí</button>
        <button type="button" className="btn sm" onClick={walking.leave} aria-keyshortcuts="Escape"><X />Salir <kbd>Esc</kbd></button>
      </div>
    </div>
  );
  return (
    <div className="transport">
      <button className="icon-btn" onClick={onPlay} aria-label={c.playing ? 'Pausar' : 'Reproducir'}>{c.playing ? <Pause /> : <Play />}</button>
      <button className="icon-btn" onClick={() => onFail?.()} aria-disabled={!onFail || undefined} aria-label={layout.bad >= 0 || !onFail ? 'Ir al salto que falló' : 'Ir al momento en que falló'} title={!onFail ? 'Nada falló en esta prueba' : layout.bad >= 0 ? 'Ir al salto que falló' : 'Ir al momento en que falló'}><Crosshair /></button>
      <span className="time">{clock(c.now)} / {clock(T)}</span>
      {scrubber}
      <div className="speed" role="group" aria-label="Velocidad">{[0.25, 0.5, 1, 2].map((s) => <button key={s} aria-pressed={c.speed === s} onClick={() => c.setSpeed(s)}>{String(s).replace('.', ',')}×</button>)}</div>
      <button className="btn sm" aria-pressed={following} onClick={onFollow} title="Recorre la secuencia un mensaje tras otro, quedándose un rato en cada uno para seguirla (la velocidad lo acorta o lo alarga)">{following ? <Pause /> : <Radio />}Seguimiento</button>
      {follow}
      <button className="btn sm" aria-pressed={false} onClick={onWalk} aria-keyshortcuts="P" title="Un mensaje cada vez, con el reloj parado (P)"><Footprints />Paso a paso</button>
      <span className="kinds" aria-label="Tipos de intercambio en el diagrama">{[...new Set(trace.exchanges.map((e) => e.kind))].map((k) => <span key={k} className={`k-${k}`}><i aria-hidden="true" />{k}</span>)}</span>
    </div>
  );
}

/**
 * The studio's timeline, as a video editor has it: the steps on top, then a track per piece of the system with a bar for
 * each message it handled, from when it arrived to when it answered. The playhead crosses them all; a click on a track
 * moves the clock there, a click on a bar opens that message.
 */
export function Tracks({ layout, trace, noise, now, T, sel, onSeek, onPick, hidden }: { layout: SeqLayout; trace: Trace; noise: Map<string, unknown>; now: number; T: number; sel?: string; onSeek: (t: number) => void; onPick: (i: number) => void; /** put away in the studio (a narrow screen shows it anyway) */ hidden?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const rowOf = useMemo(() => new Map(layout.rows.filter((r) => !r.reply).map((r) => [r.ex.id, r.i])), [layout]);
  // a track per piece that handled something, in the order of the sequence's lanes
  const tracks = useMemo(() => {
    const by = Map.groupBy(trace.exchanges.filter((e) => rowOf.has(e.id)), (e) => ends(e)[1]);
    return trace.participants.filter((p) => by.has(p.id)).map((p) => ({ id: p.id, name: p.name, bars: by.get(p.id)! }));
  }, [trace, rowOf]);
  const steps = [...trace.steps].sort((a, b) => a.t0 - b.t0);
  const pct = (t: number) => `${(Math.max(0, Math.min(T, t)) / T) * 100}%`;
  const fromX = (e: PointerEvent) => { const r = box.current!.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * T); };
  return (
    <div className="tracks" role="group" aria-label="Línea de tiempo por pieza" hidden={hidden}>
      <div className="tk-names" aria-hidden="true"><span>Pasos</span>{tracks.map((k) => <span key={k.id} title={k.name}>{k.name}</span>)}</div>
      <div className="tk-lanes" ref={box} onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.tk-bar')) return; e.currentTarget.setPointerCapture(e.pointerId); fromX(e); }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromX(e)}>
        <div className="tk-lane">{steps.map((s) => <span key={s.n} className={`tk-step${s.status === 'failed' ? ' err' : ''}`} style={{ left: pct(s.t0), width: pct(Math.max(0, s.t1 - s.t0)) }} title={`${s.n}. ${s.title}`}>{s.n}. {s.title}</span>)}</div>
        {tracks.map((k) => (
          <div key={k.id} className="tk-lane">
            {k.bars.map((e) => (
              <button key={e.id} type="button" tabIndex={-1} className={['tk-bar', `k-${e.kind}`, (e.t1 ?? e.t0) - e.t0 > T * 0.3 && 'long', e.ok === false && 'bad', e.id === sel && 'sel', noise.has(e.id) && 'noise', now >= e.t0 && now <= (e.t1 ?? e.t0) + 40 && 'now'].filter(Boolean).join(' ')}
                style={{ left: pct(e.t0), width: pct(Math.max(0, (e.t1 ?? e.t0) - e.t0)) }} title={`${e.label} · ${clock(e.t0)}${e.t1 !== undefined ? ` · ${secs(e.t1 - e.t0)}` : ''}`} onClick={() => onPick(rowOf.get(e.id)!)} />
            ))}
          </div>
        ))}
        <div className="tk-head" style={{ left: pct(now) }} aria-hidden="true" />
      </div>
    </div>
  );
}

// ---------- tabs ----------

const STEP_DOT: Record<Step['status'], DotState> = { passed: 'ok', failed: 'err', skipped: 'idle', todo: 'idle' };

function StepsTab({ run, slug, steps, total, cur, flow, go, to }: { run: RunInfo; slug: string; steps: Step[]; total: number; cur?: number; flow?: FlowInfo; go: (s: Step) => void; to: (s: Step) => number }) {
  const missing = Array.from({ length: Math.max(0, total - steps.length) }, (_, i) => steps.length + i + 1);
  if (!steps.length && !missing.length) return <p className="empty">Esta prueba no marcó pasos con <code>step()</code>.</p>;
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.n} className={s.n === cur ? 'cur' : undefined}>
          <Dot state={STEP_DOT[s.status]} />
          <button className="step-go" onClick={() => go(s)}>
            <span>{s.n}. {s.title}<span className="sr-only">, {RUN_STATUS[s.status] ?? s.status}. Ir a {clock(to(s))}</span></span>
            {(s.expected ?? flow?.steps[s.n - 1]?.expected) ? <span className="exp">Se espera: {String(s.expected ?? flow?.steps[s.n - 1]?.expected)}</span> : null}
          </button>
          <span className="faint num">{secs(Math.max(0, s.t1 - s.t0))}</span>
          {s.error && <span className="why">{s.error}</span>}
          {s.screenshot && <a className="shot" href={fileUrl(run.id, `flows/${slug}/${s.screenshot}`)} target="_blank" rel="noreferrer"><img src={fileUrl(run.id, `flows/${slug}/${s.screenshot}`)} alt={`Captura del paso ${s.n} al fallar`} loading="lazy" /><span className="sr-only"> (se abre en otra pestaña)</span></a>}
        </li>
      ))}
      {missing.map((n) => (
        <li key={n} className="unreached">
          <Dot state="idle" />
          <span>{n}. {flow?.steps[n - 1]?.step ?? 'Paso sin título'}<span className="exp">No llegó a correr: la prueba se detuvo antes.</span></span>
          <span className="faint">—</span>
        </li>
      ))}
    </ol>
  );
}

export const NetTab = memo(function NetTab({ exchanges, sel, pick }: { exchanges: Exchange[]; sel?: string; pick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [bad, setBad] = useState(false);
  const list = exchanges.filter((e) => e.kind !== 'sql' && (!bad || !e.ok) && `${e.from} ${e.to} ${e.label} ${e.status ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="toolbar">
        <label className="search-in"><Search /><span className="sr-only">Buscar en la red</span><input type="search" placeholder="Buscar ruta, servicio o estado" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className="btn sm" aria-pressed={bad} onClick={() => setBad((b) => !b)}>Solo fallos</button>
        <span className="faint num" aria-live="polite">{plural(list.length, 'intercambio', 'intercambios')}</span>
      </div>
      <ExchangeTable list={list} sel={sel} pick={pick} empty={bad ? 'Ningún intercambio falló.' : 'Nada coincide.'} />
    </>
  );
});

export function ExchangeTable({ list, sel, pick, empty, extra }: { list: Exchange[]; sel?: string; pick: (id: string) => void; empty: string; extra?: (e: Exchange) => ReactNode }) {
  if (!list.length) return <p className="empty">{empty}</p>;
  return (
    <div className="scroll-x run-list">
      <table className="t">
        <thead><tr><th>Tiempo</th><th>Intercambio</th><th>Estado</th><th className="r">Duración</th></tr></thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.id} className={`${e.id === sel ? 'sel' : ''}${e.ok ? '' : ' bad'}`}>
              <td className="num faint">{clock(e.t0)}</td>
              <td className="wrap">
                <div className="ex-cell"><Kind k={e.kind} /><button className="ex-go mono" onClick={() => pick(e.id)} aria-current={e.id === sel || undefined}><ExLabel e={e} /></button>{e.origin === 'derived' && <Origin of="derived" label={false} />}{e.fault && <span className="chip run"><Zap />{e.fault}</span>}{extra?.(e)}</div>
                <div className="ex-route mono">{route(e, (id) => id)}</div>
              </td>
              <td>{e.ok ? (e.status !== undefined ? <HttpStatus n={e.status} /> : <span className="faint">correcto</span>) : <Status state="err">{e.status !== undefined ? <HttpStatus n={e.status} /> : e.error ?? 'falló'}</Status>}</td>
              <td className="r num faint">{e.t1 !== undefined ? secs(e.t1 - e.t0) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** POST /api/files with its method in colour, a statement with its verb as a keyword; masks boxed in all of them. */
const ExLabel = ({ e }: { e: Exchange }) => <Code text={e.label} lang={e.kind === 'sql' ? 'sql' : e.method ? 'http' : 'text'} />;

const LEVELS: Array<[string, string]> = [['', 'Todos'], ['error', 'Errores'], ['warn', 'Avisos'], ['info', 'Info']];
export const LogsTab = memo(function LogsTab({ logs, seek, approximate }: { logs: LogLine[]; seek: (t: number) => void; approximate?: boolean }) {
  const [svc, setSvc] = useState('');
  const [lv, setLv] = useState('');
  const services = [...new Set(logs.map((l) => l.service))].sort();
  const shown = logs.filter((l) => (!svc || l.service === svc) && (!lv || l.level === lv));
  if (!logs.length) return <p className="empty">Ningún servicio escribió en su log durante esta prueba.</p>;
  return (
    <>
      <div className="toolbar">
        <Segmented className="seg log-filter" label="Servicio" value={svc} onChange={setSvc} options={['', ...services].map((s) => ({ key: s, label: s || 'Todos' }))} />
        <Segmented label="Nivel" value={lv} onChange={setLv} options={LEVELS.map(([k, l]) => ({ key: k, label: l }))} />
      </div>
      {approximate && <p className="faint logs-empty">Se jugó junto a otros flujos: un servicio escribe un solo log, así que estas líneas pueden incluir las de otra prueba que corría a la vez.</p>}
      <div className="logs run-logs" tabIndex={0} role="log" aria-label="Logs de la prueba">
        {shown.map((l) => (
          <div key={l.id}>
            <button className="ts num" onClick={() => seek(l.t)} aria-label={`Ir a ${clock(l.t)}`}>{clock(l.t)}</button><span className="sv">{l.service}</span>
            <Level lv={l.level} /><span className="msg"><Code text={l.line} lang="log" /></span>
          </div>
        ))}
        {!shown.length && <p className="faint logs-empty">Ninguna línea con ese filtro.</p>}
      </div>
    </>
  );
});

function DataTab({ run, exchanges, sel, pick }: { run: RunInfo; exchanges: Exchange[]; sel?: string; pick: (id: string) => void }) {
  const sql = exchanges.filter((e) => e.kind === 'sql');
  const tables = Map.groupBy(sql.filter((e) => e.table), (e) => `${e.to}|${e.table}`);
  if (!sql.length) return <p className="empty">Esta prueba no lanzó ninguna sentencia SQL que el registro de la base viera.</p>;
  return (
    <>
      <div className="toolbar tables-touched" aria-label="Tablas tocadas">
        {[...tables].map(([k, es]) => {
          const [store, table] = k.split('|');
          const [schema, name] = table!.includes('.') ? table!.split('.') : ['public', table!];
          const writes = es.filter((e) => /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)/.test(e.label)).length;
          return <a key={k} className="chip" href={href('data', run.env, store, schema, name)} title={`Abrir ${table} en Bases`}><span className="mono">{table}</span> {writes ? `${writes} escrituras, ` : ''}{plural(es.length, 'sentencia', 'sentencias')}</a>;
        })}
      </div>
      <ul className="sql-list">
        {sql.map((e) => (
          <li key={e.id} className={`${e.id === sel ? 'sel' : ''}${e.ok ? '' : ' bad'}`}>
            <div className="sql-h"><span className="faint num">{clock(e.t0)}</span><span className="mono">{e.from} → {e.to}</span><button className="ex-go mono" onClick={() => pick(e.id)}><Code text={e.label} lang="sql" /></button>{!e.ok && <Status state="err">Error</Status>}</div>
            {e.req?.text && <CodeBlock className="sql-text" text={e.req.text} lang="sql" format label={`Sentencia de ${clock(e.t0)}`} />}
            {e.error && <p className="why mono"><Code text={e.error} lang="log" /></p>}
          </li>
        ))}
      </ul>
    </>
  );
}

const FILE_ICON: Array<[RegExp, typeof Film]> = [[/\.webm$/, Film], [/\.png$/, Image], [/\.json$/, FileCode], [/\.(log|jsonl)$/, ScrollText]];
interface BehaviorData { approved: (BehaviorDoc & { approved: { run: string; at: string; soft: number } }) | null; now: BehaviorDoc; drifts: Array<{ step: string; kind: 'missing' | 'new' | 'cause'; hop: string; was?: string; now?: string }> }
interface BehaviorDoc { steps: Array<{ step: string; hops: string[]; causes: Record<string, string> }> }
const DRIFT = { new: ['+', 'ahora lo hace'], missing: ['−', 'ya no lo hace'], cause: ['~', 'otra causa'] } as const;

/**
 * «Comportamiento»: what the system did under each step of this story, against what was approved. Reads
 * are shown but never drift; what changes something and anything that fails does. Approving writes behavior.yaml,
 * which goes in the workspace's PR with the change.
 */
function BehaviorTab({ run, flow, complete }: { run: string; flow: string; complete: boolean }) {
  const d = useApi<BehaviorData>(`/api/behavior?run=${encodeURIComponent(run)}&flow=${encodeURIComponent(flow)}`);
  if (d.error) return <div className="notice" role="alert"><CircleX />{d.error}</div>;
  if (!d.data) return <Skeleton lines={6} />;
  const { approved, now, drifts } = d.data;
  const approve = () => api<{ run: string; hops: number }>('/api/behavior/approve', { method: 'POST', body: { flow, run } }).then(() => d.reload());
  return (
    <div className="behavior">
      <div className="behavior-head">
        {approved ? <span><Dot state={drifts.length ? 'err' : 'ok'} />{drifts.length ? `${plural(drifts.length, 'salto distinto', 'saltos distintos')} del comportamiento aprobado en el run ${approved.approved.run}` : `Hace lo aprobado en el run ${approved.approved.run}`}</span>
          : <span className="faint">Este flujo no tiene comportamiento aprobado: lo que hizo este run puede serlo.</span>}
        <span className="grow" />
        {(!approved || approved.approved.run !== run) && <ActionButton icon={Check} disabled={!complete} title={complete ? 'Escribe behavior.yaml junto a flow.md, para commitearlo con el cambio' : 'La historia no recorrió todos sus pasos'} run={approve} done={() => 'Comportamiento aprobado: behavior.yaml escrito'}>Aprobar este comportamiento</ActionButton>}
      </div>
      {now.steps.map((s, i) => {
        const mine = drifts.filter((x) => x.step === s.step);
        const gone = mine.filter((x) => x.kind === 'missing');
        return (
          <section key={i} className="behavior-step">
            <h4>{i + 1}. {s.step}</h4>
            <ul>
              {s.hops.map((h) => { const x = mine.find((y) => y.hop === h && y.kind !== 'missing'); return <li key={h} className={x ? `drift ${x.kind}` : ''}><span className="mark">{x ? DRIFT[x.kind][0] : ''}</span><code>{h}</code>{s.causes[h] && <span className="faint"> ⟵ {s.causes[h]}</span>}{x && <span className="why">{DRIFT[x.kind][1]}{x.kind === 'cause' ? `: antes ⟵ ${x.was}` : ''}</span>}</li>; })}
              {gone.map((x) => <li key={`-${x.hop}`} className="drift missing"><span className="mark">−</span><code>{x.hop}</code><span className="why">{DRIFT.missing[1]}</span></li>)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function FilesTab({ id, detail }: { id: string; detail?: RunDetail }) {
  const files = useApi<Array<{ path: string; bytes: number }>>(`/api/run/files?id=${encodeURIComponent(id)}`);
  if (files.error) return <p className="form-err" style={{ padding: 16 }}>{files.error}</p>;
  if (!files.data) return <div style={{ padding: 16 }}><div className="sk" style={{ height: 14, width: '70%' }} /></div>;
  return (
    <>
      <ul className="files">
        {files.data.map((f) => {
          const Icon = FILE_ICON.find(([re]) => re.test(f.path))?.[1] ?? FileText;
          const isTrace = /(^|\/)trace(-\d+)?\.zip$/.test(f.path);
          return <li key={f.path}><Icon /><a className="rowlink mono" href={fileUrl(id, f.path)} target="_blank" rel="noreferrer">{f.path}<span className="sr-only"> (se abre en otra pestaña)</span></a>{isTrace && <><a className="btn sm" href={`/trace-viewer/index.html?trace=${encodeURIComponent(new URL(fileUrl(id, f.path), location.origin).href)}`} target="_blank" rel="noreferrer"><Play />Abrir traza</a></>}<span className="faint num">{size(f.bytes)}</span><a className="copy" href={fileUrl(id, f.path)} download aria-label={`Descargar ${f.path}`}><Download /></a>{detail && <PathChip path={`${detail.dir}/${f.path}`} reveal={{ what: 'run-file', id: `${id}/${f.path}` }} hide />}</li>;
        })}
        {!files.data.length && <li className="faint">Este run no guardó evidencia.</li>}
      </ul>
      <p className="faint files-note">Lo que se grabó del run. La salida en bruto del runner (<span className="mono">out/</span>) se queda en <span className="mono">.laru/runs/{id}</span> y no se sirve.</p>
      {detail?.retention && <p className="faint files-note">{retentionText(detail)}</p>}
    </>
  );
}

const short = (d: number) => new Date(d).toLocaleDateString('es', { day: 'numeric', month: 'short' });
/** When retention takes this run's video and the run itself, or why it keeps them. */
function retentionText(r: RunDetail): string {
  const p = r.retention!.policy, t = Date.parse(r.startedAt);
  if (r.pruned) return `El vídeo y las capturas se borraron por retención ${ago(r.pruned.at)}; la traza y los registros siguen aquí.`;
  const kept = r.retention!.keptFor;
  if (kept) return `Se conserva: es el último ${kept.status === 'failed' ? 'fallido' : 'verde'} de ${kept.flow}. Se conservan siempre el último verde y el último fallido de cada flujo.`;
  return `Retención: el vídeo se borra el ${short(t + p.videoDays * 86_400_000)} (${p.videoDays} días) y el run el ${short(t + p.runDays * 86_400_000)} (${p.runDays}). Se conservan siempre el último verde y el último fallido de cada flujo.`;
}

// ---------- inspector ----------

/**
 * «Este mensaje»: the card of the stop the player is at (its sentence, where it sits, what caused it and what it
 * caused), the contract it exercises, and under them the exchange itself: headers, bodies and cURL, folded.
 */
/** A mail or SMS the env's mailbox kept, or the status call it made: what it is, to whom, and where to read it. Nothing here left the machine. */
function MessageCard({ m, link }: { m: NonNullable<Exchange['msg']>; link?: string }) {
  return (
    <div className="insp-msg" role="note">
      <span className="chip">{m.cb ? 'Aviso de estado' : m.kind === 'mail' ? 'Correo' : 'SMS'}</span>
      <span>{m.cb ? `El SMS pasó a «${m.cb}»` : m.kind === 'mail' ? <><b>{m.subject || '(sin asunto)'}</b> para {m.to}</> : <>Para {m.to}</>}</span>
      <span className="faint">Quedó en el buzón del entorno; no salió de tu máquina.</span>
      {link && <a className="rowlink" href={link}>Ver en el buzón</a>}
    </div>
  );
}

function Inspector({ ex, names, said, contract, card, cause, msgLink, way, reply }: { msgLink?: string; ex?: Exchange; names: Map<string, string>; said: string; contract?: ReactNode; card: ReactNode; cause?: Cause; way: Exchange[]; reply: boolean }) {
  const cmd = ex ? curl(ex) : null;
  const sql = ex?.kind === 'sql';
  return (
    <section className="panel insp" aria-labelledby="insp-h">
      <header>
        <h3 id="insp-h">Este mensaje</h3>
        <span className="sr-only" aria-live="polite">{said}</span>
        <div className="meta">
          {cause?.certainty === 'possible' && <span className="ct-maybe" title="La causa de este mensaje es posible, no segura">?</span>}
          {ex && <Origin of={ex.origin} />}
          {cmd && <button className="btn sm" onClick={() => copy(cmd, 'Copiado como cURL')}><Terminal />cURL</button>}
        </div>
      </header>
      {ex && (
        <div className={`insp-head k-${ex.kind}`} key={ex.id}>
          <RouteStrip way={way} at={Math.max(0, way.findIndex((w) => w.id === ex.id))} reply={reply} names={names} />
          <div className="insp-title">
            <span className="insp-what mono">{sql ? ex.label : ex.method ? <><b>{ex.method}</b> {ex.path ?? '/'}{ex.query ? `?${ex.query}` : ''}</> : ex.label}</span>
            {ex.status !== undefined ? <HttpStatus n={ex.status} /> : ex.ok === false ? <span className="chip err">falló</span> : null}
            {ex.t1 !== undefined && <span className="num faint">{secs(ex.t1 - ex.t0)}</span>}
            {ex.fault && <span className="chip run"><Zap />{ex.fault}</span>}{ex.mock && <span className="chip">mock: {ex.mock}</span>}
          </div>
        </div>
      )}
      {card}
      {ex?.msg && <MessageCard m={ex.msg} link={msgLink} />}
      {ex && <ExchangeIO ex={ex} names={names} reply={reply} />}
      {ex && contract}
    </section>
  );
}

// ---------- compare ----------

function ComparePick({ run, onClose, onPick }: { run: RunInfo; onClose: () => void; onPick: (r: RunInfo) => void }) {
  const runs = useApi<RunInfo[]>('/api/runs');
  const others = (runs.data ?? []).filter((r) => r.id !== run.id && r.phase === 'done' && r.flows.some((f) => run.flows.includes(f)));
  // The list arrives after the dialog opens: the focus moves to its first run then, not to «Cancelar».
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, [runs.data]);
  return (
    <Dialog title={`Comparar el run ${run.id} con…`} onClose={onClose}>
      <div className="dlg-body">
        {runs.error ? <p className="form-err">{runs.error}</p> : !runs.data ? <div className="sk" style={{ height: 14, width: '70%' }} /> : !others.length ? <p>No hay otro run terminado de estos flujos con el que comparar.</p> : (
          <ul className="pick-list" aria-label="Runs">
            {others.map((r, i) => (
              <li key={r.id}>
                <button ref={i === 0 ? first : undefined} onClick={() => { onPick(r); onClose(); }}>
                  <Dot state={RUN_DOT[r.status] ?? 'idle'} /><b className="mono">#{r.id}</b><span>{RUN_STATUS[r.status]}, {ago(r.startedAt)}</span><span className="faint mono">{r.flows.join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer><button type="button" className="btn" onClick={onClose}>Cancelar</button></footer>
    </Dialog>
  );
}

/** Only the flows both runs ran are compared: the rest has nothing to set against. */
function CompareView({ a, b, flows, onClose }: { a: string; b: string; flows: string[]; onClose: () => void }) {
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => h.current?.focus(), [a]);
  const cmp = useApi<Comparison>(`/api/runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  const side = (x?: { count: number; statuses: number[]; p50?: number }) => (x ? `${x.count}× ${x.statuses.join('/') || '—'}${x.p50 !== undefined ? `, ${secs(x.p50)}` : ''}` : 'no aparece');
  const shared = (cmp.data?.exchanges ?? []).filter((e) => flows.includes(e.flow));
  const diff = shared.filter((e) => !e.a || !e.b || e.a.count !== e.b.count || e.a.statuses.join() !== e.b.statuses.join());
  const same = shared.length - diff.length;
  return (
    <section className="panel block" aria-labelledby="cmp-h">
      <header><h3 id="cmp-h" ref={h} tabIndex={-1}>Comparado con el run {a}</h3><div className="meta">{cmp.data && <span>{plural(diff.length, 'diferencia', 'diferencias')}, {same} iguales</span>}<button className="icon-btn" onClick={onClose} aria-label="Cerrar la comparación"><X /></button></div></header>
      {cmp.error ? <p className="form-err" style={{ padding: 16 }}>{cmp.error}</p> : !cmp.data ? <div style={{ padding: 16 }}><div className="sk" style={{ height: 14, width: '60%' }} /></div> : (
        <>
          <div className="cmp-steps">
            {flows.map((f) => {
              const sa = cmp.data!.steps.a[f] ?? [], sb = cmp.data!.steps.b[f] ?? [];
              const n = Math.max(sa.length, sb.length);
              if (!sa.length || !sb.length) return (
                <div key={f}>
                  <h4 className="mono">{f}</h4>
                  <p className="faint cmp-absent">{sa.length ? 'No corrió en este run.' : `No corrió en el run ${a}.`}</p>
                </div>
              );
              return (
                <div key={f}>
                  <h4 className="mono">{f}</h4>
                  <ol>{Array.from({ length: n }, (_, i) => {
                    const x = sa[i]?.split(':')[1], y = sb[i]?.split(':')[1];
                    return <li key={i} className={x !== y ? 'chg' : undefined}><span className="num">{i + 1}</span><Status state={x ? STEP_DOT[x as Step['status']] : 'idle'}>run {a}: {x ? RUN_STATUS[x] : 'sin paso'}</Status><Status state={y ? STEP_DOT[y as Step['status']] : 'idle'}>este: {y ? RUN_STATUS[y] : 'sin paso'}</Status></li>;
                  })}</ol>
                </div>
              );
            })}
          </div>
          {diff.length ? (
            <div className="scroll-x">
              <table className="t">
                <thead><tr><th>Flujo</th><th>De → a</th><th>Intercambio</th><th>Run {a}</th><th>Este run</th><th className="r">Δ p50</th></tr></thead>
                <tbody>{diff.map((e, i) => (
                  <tr key={i}>
                    <td className="mono faint">{e.flow}</td><td className="mono">{e.from} → {e.to}</td><td className="mono wrap">{e.label}</td>
                    <td className={e.a ? undefined : 'faint'}>{side(e.a)}</td><td className={e.b ? undefined : 'faint'}>{side(e.b)}</td>
                    <td className="r num">{e.a?.p50 !== undefined && e.b?.p50 !== undefined ? `${e.b.p50 - e.a.p50 >= 0 ? '+' : '−'}${secs(Math.abs(e.b.p50 - e.a.p50))}` : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="empty">Las mismas llamadas, las mismas veces y con los mismos estados.</p>}
        </>
      )}
    </section>
  );
}

/**
 * What the working copies changed and which flows it reaches, with «Recargar y repetir»: rebuild the changed services
 * from the copy, then play what the change reaches and what failed unexpectedly last time.
 */
function ChangesBar() {
  const im = useApi<Impact>('/api/impact');
  const i = im.data;
  if (!i || !i.changes.length) return null;
  const names = i.flows.map((f) => f.id.replace(/^flow:/, ''));
  return (
    <div className="notice info changes-bar">
      <div className="grow">
        <b>Tu copia tiene {plural(i.changes.length, 'archivo cambiado', 'archivos cambiados')}.</b>{' '}
        {names.length ? <>Afectan a {plural(names.length, 'flujo', 'flujos')}: <span className="mono">{names.join(', ')}</span>.</> : 'No afectan a ningún flujo.'}
        {(i.reach.length > 0 || i.whole.length > 0) && (
          <details className="faint">
            <summary>Por qué</summary>
            <ul>
              {i.reach.map((r) => <li key={r.file}><span className="mono">{r.file.replace(/^[^:]+:/, '')}</span> llega a {r.calls.join(', ')}</li>)}
              {i.whole.map((w) => <li key={w.id}><span className="mono">{w.id}</span> entero: {w.why}</li>)}
            </ul>
          </details>
        )}
      </div>
      <ActionButton icon={RotateCw} primary title="Reconstruye lo que cambió desde tu copia y ejecuta los flujos afectados y los que fallaron sin esperarlo"
        run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { affected: true, failed: true, confirm } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')}>Recargar y repetir</ActionButton>
    </div>
  );
}

/** A frame of a flow's video as its thumbnail, loaded only when the tile is on screen (a list has hundreds of videos). */
function Thumb({ run, slug, bad, ms }: { run: string; slug: string; bad: boolean; ms?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); o.disconnect(); } }, { rootMargin: '200px' });
    o.observe(el);
    return () => o.disconnect();
  }, [seen]);
  // a little past the middle: every run opens on the same login screen, the middle is where the flow differs
  return <div ref={box} className={`thumb${bad ? ' bad' : ''}`}>{seen && <video muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" src={`${fileUrl(run, `flows/${slug}/video.webm`)}#t=${ms ? Math.max(1, (ms / 1000) * 0.55).toFixed(1) : 1}`} />}</div>;
}

/** One run: a single thumbnail (a frame of the first flow that failed, else of the first), and what it played, when, where and how it ended. */
function RunCard({ r }: { r: RunInfo }) {
  const session = r.kind === 'session';
  const open = session && r.phase !== 'done' ? liveHref(r) : href('runs', r.id);
  const known = r.status === 'passed' && Object.values(r.results).some((x) => x.known);
  const done = r.phase === 'done';
  const bad = (f: string) => r.results[f]?.status === 'failed' || r.results[f]?.status === 'error';
  const shown = r.flows.find((f) => bad(f) && r.results[f]?.video) ?? r.flows.find((f) => r.results[f]?.video);
  return (
    <article className="run-card" onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button,input,select')) location.hash = open; }}>
      {shown && <a className="run-thumb" href={href('runs', r.id, shown)} aria-label={`Abrir ${shown}`} title={shown}><Thumb run={r.id} slug={shown} bad={bad(shown)} ms={r.results[shown]?.ms} /></a>}
      <div className="run-main">
        <header className="run-head">
          <a className="rowlink mono" href={open}>#{r.id}</a>
          <Status state={RUN_DOT[r.status] ?? 'idle'}>{done ? RUN_STATUS[r.status] : `${RUN_PHASE[r.phase]}…`}</Status>
          {known && <span className="faint" title="Pasó: solo fallan las desviaciones que la aplicación tiene a propósito documentadas (// app:)">con desviaciones conocidas</span>}
          <span className="grow" />
          <span className="mono faint">{r.env}{r.ephemeral ? ' · efímero' : ''}</span>
          <span className="faint" title={new Date(r.startedAt).toLocaleString('es')}>{ago(r.startedAt)}</span>
          <span className="num">{took(r) ?? <span className="faint">—</span>}</span>
        </header>
        {session ? <div className="run-session">Sesión: {r.title}</div> : r.flows.length > 0 && (
          <ul className="run-flows">
            {r.flows.map((f) => {
              const x = r.results[f];
              return (
                <li key={f}>
                  <a className={`run-flow${bad(f) ? ' bad' : ''}`} href={href('runs', r.id, f)} title={`${f}${x ? `: ${RUN_STATUS[x.status] ?? x.status}${x.ms ? `, ${secs(x.ms)}` : ''}${x.steps ? `, ${plural(x.steps, 'paso', 'pasos')}` : ''}${x.known ? `, ${x.known} desviaciones conocidas` : ''}` : ''}`}>
                    <Dot state={x ? RUN_DOT[x.status] ?? 'idle' : 'run'} />{f}{x?.ms ? <span className="faint"> {secs(x.ms)}</span> : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}

/** Playwright's video shows a magenta placeholder until the page paints its first frame: true while the frame on screen is that one. */
function useBlank(v: HTMLVideoElement | null) {
  const [blank, setBlank] = useState(false);
  useEffect(() => {
    if (!v) return;
    const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!cx) return;
    const look = () => {
      if (v.readyState < 2) return;
      try { cx.drawImage(v, 0, 0, 1, 1); const [r, g, b] = cx.getImageData(0, 0, 1, 1).data; setBlank(r! > 200 && g! < 100 && b! > 200); } catch { setBlank(false); }
    };
    const on = ['loadeddata', 'seeked', 'timeupdate'];
    on.forEach((e) => v.addEventListener(e, look));
    return () => on.forEach((e) => v.removeEventListener(e, look));
  }, [v]);
  return blank;
}

function PeerScreen({ who, closed, src, label, register, onOpen }: { who: string; closed: boolean; src: string; label: string; register: (el: HTMLVideoElement | null) => void; onOpen?: () => void }) {
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const blank = useBlank(el);
  return (
    <figure>
      <div className="peer">
        <video ref={(v) => { setEl(v); register(v); }} src={src} muted playsInline preload="auto" aria-label={label} />
        {(closed || blank) && <div className="novideo">{who} aún no ha abierto su pantalla</div>}
        {onOpen && <button type="button" className="icon-btn open-float" onClick={onOpen} aria-label={`Abrir la pantalla de ${who} en una ventana`} title="Abrir en una ventana flotante que se mueve y cambia de tamaño"><ArrowUpRight /></button>}
      </div>
      <figcaption>Pantalla de {who}</figcaption>
    </figure>
  );
}

/** One screen in its own window over the page, to see it large: moved by its bar, resized by its corner, on the clock of the main video. */
function FloatingScreen({ title, src, startMs, now, playing, speed, index, phone, onClose }: { title: string; src: string; startMs: number; now: number; playing: boolean; speed: number; index: number; phone: boolean; onClose: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState({ x: 120 + index * 36, y: 90 + index * 36 });
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const want = Math.max(0, now - startMs) / 1000;
    v.playbackRate = speed;
    if (Math.abs(v.currentTime - want) > 0.1) v.currentTime = Math.min(want, Number.isFinite(v.duration) ? v.duration : want);
    if (playing && now >= startMs && v.paused) void v.play().catch(() => undefined);
    if ((!playing || now < startMs) && !v.paused) v.pause();
  }, [now, playing, speed, startMs]);
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const dx = e.clientX - pos.x, dy = e.clientY - pos.y;
    const move = (ev: globalThis.PointerEvent) => setPos({ x: Math.max(0, ev.clientX - dx), y: Math.max(0, ev.clientY - dy) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={`float-screen${phone ? ' phone' : ''}`} role="dialog" aria-label={title} style={{ left: pos.x, top: pos.y }}>
      <div className="float-bar" onPointerDown={drag}>
        <span title={title}>{title}</span>
        <button type="button" className="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} aria-label={`Cerrar «${title}»`}><X /></button>
      </div>
      <video ref={ref} src={src} muted playsInline preload="auto" aria-label={title} />
    </div>
  );
}

/** The video of the flow, from the header of the player: with several screens, all of them in one (made the first time, then kept); with one, its own. */
function OneVideo({ run, slug, video, several }: { run: string; slug: string; video: string; several: boolean }) {
  const [busy, setBusy] = useState(false);
  const what = several ? 'Descargar todas las pantallas en un solo vídeo' : 'Descargar el vídeo';
  const save = (file: string, name: string) => { const a = document.createElement('a'); a.href = fileUrl(run, file); a.download = name; a.click(); };
  return (
    <button className="icon-btn" aria-busy={busy || undefined} aria-label={what} title={what} onClick={async () => {
      if (busy) return;
      if (!several) { save(`flows/${slug}/${video}`, `${slug}${video.slice(video.lastIndexOf('.'))}`); return; }
      setBusy(true);
      try { save((await api<{ file: string }>('/api/run/video', { method: 'POST', body: { id: run, flow: slug } })).file, `${slug}.mp4`); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    }}><Download className={busy ? 'spin' : undefined} /></button>
  );
}

/**
 * The test's other screens (Luis's browser beside Ana's), each its own video on the clock of the main one: it plays when the clock plays, pauses
 * when it pauses and is put back when it drifts more than a tenth of a second. Before its video begins, and after it ends, it shows the first or
 * last frame, as a person's screen that has not opened yet.
 */
function OtherScreens({ run, slug, trace, now, playing, speed, onOpen }: { run: string; slug: string; trace: Trace; now: number; playing: boolean; speed: number; onOpen?: (name: string) => void }) {
  const screens = (trace.screens ?? []).filter((s) => s.video && s.startMs !== undefined);
  const els = useRef(new Map<string, HTMLVideoElement>());
  useEffect(() => {
    for (const s of screens) {
      const v = els.current.get(s.name);
      if (!v) continue;
      const want = Math.max(0, now - s.startMs!) / 1000;
      v.playbackRate = speed;
      if (Math.abs(v.currentTime - want) > 0.1) v.currentTime = Math.min(want, Number.isFinite(v.duration) ? v.duration : want);
      if (playing && now >= s.startMs! && v.paused) void v.play().catch(() => undefined);
      if ((!playing || now < s.startMs!) && !v.paused) v.pause();
    }
  }, [now, playing, speed, screens]);
  if (!screens.length) return null;
  return (
    <div className="other-screens" role="group" aria-label="Otras pantallas de la prueba">
      {screens.map((s) => {
        // before its first exchange the screen is closed, whatever its video shows
        const first = Math.min(...trace.exchanges.filter((e) => e.from === `browser:${s.name}` || e.to === `browser:${s.name}`).map((e) => e.t0));
        const who = s.name.charAt(0).toUpperCase() + s.name.slice(1);
        return (
          <PeerScreen key={s.name} who={who} closed={Number.isFinite(first) && now < first} src={fileUrl(run, `flows/${slug}/${s.video}`)} label={`Pantalla de ${s.name}`} onOpen={onOpen && (() => onOpen(s.name))} register={(el) => { if (el) els.current.set(s.name, el); else els.current.delete(s.name); }} />
        );
      })}
    </div>
  );
}
