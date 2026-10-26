/**
 * «En vivo»: a person uses the app on an env that is up while the trace of the whole system is read live,
 * act by act; saved, the session is a run. The trace is read about every second without Kafka and every third read
 * with it (a JVM per read): Kafka's hops arrive with that delay, and the screen says so.
 */
import { frontAt, frontsOf, frontLabel } from '../lib/fronts.ts';
import { AppWindow, ArrowLeft, ArrowRight, CircleX, DatabaseBackup, ExternalLink, Flag, Globe, Home as HomeIcon, Maximize2, Minimize2, Play, RotateCw, Square, Upload, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { chain as chainOf } from '@laru/trace/chain';
import { api, apiUrl, indexMap, useApi, type SystemMap, type EnvSummary, type KnowledgeData, type ScenariosData, type Exchange, type Indexed, type RunInfo, type Trace } from '../api.ts';
import { ActionButton, Dialog, Dot, Segmented, Skeleton, Tabs, toast } from '../components/ui.tsx';
import { EnvScope, envOfSession } from '../components/EnvScope.tsx';
import { askFirst } from '../lib/ask.ts';
import { plural } from '../lib/es.ts';
import { href } from '../lib/route.ts';
import { sayCtx } from '../lib/say.ts';
import { layoutSeq } from '../lib/seq.ts';
import { archGraph, layout as mapLayout } from '../lib/sysmap.ts';
import { ExchangeIO, Journey } from './Journey.tsx';
import { ExchangeTable, FlowMap, LogsTab, NetTab, SeqView, Tracks } from './Runs.tsx';

interface SessionBrowser { state: 'none' | 'opening' | 'open' | 'closed' | 'error'; url?: string; error?: string; outside: Array<{ t: number; url: string }> }
interface Live { run: RunInfo; trace: Trace; browser: SessionBrowser }

export function Live({ parts, g }: { parts: string[]; g: Indexed | null }) {
  const [id] = parts;
  return id ? <Session key={id} id={id} g={g} /> : <Start />;
}

// ---------- starting one ----------

/** An env in the studio: a session on it with the embedded browser, opened on its own page (where the studio is). */
export const openStudio = (env: string) => askFirst((confirm) =>
  api<{ run: RunInfo }>('/api/session/start', { method: 'POST', body: { env, title: `Estudio en ${env}`, browser: true, confirm } }).then(({ run }) => { location.hash = href('live', run.id); }), 'Abrir');

/** Opened from a flow's sheet, the session already knows what it is for: that flow, its scenario and its own environment first. */
export interface Preset { flow: string; title: string; scenario?: string; env?: string; to: (id: string) => string }

export function Start({ preset }: { preset?: Preset }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const runs = useApi<RunInfo[]>('/api/runs');
  // Without a flow, the project's environments; with one, only its own: each flow runs isolated.
  const ready = (envs.data ?? []).filter((e) => e.state === 'ready' && (preset ? e.env === `f-${preset.flow}` : !/^f-/.test(e.env)));
  const [env, setEnv] = useState<string>();
  const [title, setTitle] = useState(preset?.title ?? '');
  const map = useApi<SystemMap | null>('/api/map');
  const g = useMemo(() => (map.data ? indexMap(map.data) : null), [map.data]);
  const [front, setFront] = useState<string>();
  const pick = env && ready.some((e) => e.env === env) ? env : ready.find((e) => e.env === preset?.env)?.env ?? ready[0]?.env;
  const sessions = (runs.data ?? []).filter((r) => r.kind === 'session' && (!preset || r.flow === preset.flow));
  const scns = useApi<ScenariosData>(pick ? `/api/scenarios?env=${encodeURIComponent(pick)}` : null);
  const usable = (scns.data?.scenarios ?? []).filter((s) => (s.setup || s.extends) && !s.state?.broken);
  const [scenario, setScenario] = useState(preset?.scenario?.replace(/^scn:/, '') ?? '');
  // An env with several fronts (a web and a mobile one, or those of joined projects): the person says which one the session opens on.
  const kindOf = (svc: string) => g?.nodes.get(`svc:${svc}`)?.kind;
  const fronts = frontsOf(ready.find((e) => e.env === pick)?.addresses ?? [], kindOf);
  const chosen = fronts.find((f) => f.service === front)?.service ?? fronts[0]?.service;
  // The person's own browser opens now, while the click still counts as theirs, and goes to the app once it is known.
  // An env that keeps its data asks first (409): the tab closes, and «Aplicar y empezar» opens it again with a click of its own.
  const start = (browser: boolean) => askFirst((confirm) => {
    const tab = browser ? null : window.open('about:blank', '_blank');
    return api<{ run: RunInfo }>('/api/session/start', { method: 'POST', body: { env: pick, title: title.trim() || undefined, browser, scenario: scenario || undefined, flow: preset?.flow, ...(fronts.length > 1 ? { front: chosen, device: kindOf(chosen!) === 'mobile' ? 'phone' : undefined } : {}), confirm } })
      .then(({ run }) => { if (tab && run.entrance) tab.location.href = run.entrance; else tab?.close(); location.hash = preset ? preset.to(run.id) : href('live', run.id); }, (e) => { tab?.close(); throw e; });
  }, 'Aplicar y empezar');
  return (
    <div className={preset ? undefined : 'page'}>
      {!preset && <div className="head"><div><h1>En vivo</h1><p>Usa el aplicativo y mira, mientras lo haces, cada salto que provoca: de servicio en servicio, en las bases y en las colas. Al parar, la sesión queda guardada como un run.</p></div></div>}
      {envs.error ? <div className="notice" role="alert"><CircleX />{envs.error}</div> : !envs.data ? <Skeleton lines={4} /> : !ready.length ? (
        <section className="panel"><div className="empty">Ningún entorno está arriba. {preset ? <>Aprovisiona el de este flujo aquí arriba, o levanta otro en </> : <>Levanta uno en </>}<a className="rowlink" href={href('envs')}>Entornos</a>, o con <code>laru up local</code>.</div></section>
      ) : (
        <section className="panel">
          <header><h3>Empezar una sesión</h3></header>
          <div className="body live-start">
            {ready.length > 1 && <label className="field"><span>Entorno</span><Segmented label="Entorno" options={ready.map((e) => ({ key: e.env, label: e.env }))} value={pick!} onChange={setEnv} /></label>}
            {fronts.length > 1 && <label className="field"><span>Cliente</span><Segmented label="Cliente" options={fronts.map((f) => ({ key: f.service, label: frontLabel(f.service, kindOf(f.service)) }))} value={chosen!} onChange={setFront} /></label>}
            {usable.length > 0 && (
              <div className="field"><span>Desde qué estado</span>
                <ul className="places" role="radiogroup" aria-label="Desde qué estado">
                  {[{ id: '', title: 'Como esté ahora', note: 'sin aplicar nada' }, ...usable.map((s) => ({ id: s.id, title: s.title, note: s.state ? (s.state.mode === 'snapshot' ? 'desde instantáneas' : 'vuelve a prepararse') : 'se prepara la primera vez' }))].map((o) => (
                    <li key={o.id}><button role="radio" aria-checked={scenario === o.id} className={scenario === o.id ? 'on' : ''} onClick={() => setScenario(o.id)}><span>{o.title}</span><span className="faint">{o.note}</span></button></li>
                  ))}
                </ul>
              </div>
            )}
            <label className="field"><span>Qué vas a probar</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Por ejemplo: subir un fichero infectado" maxLength={120} /></label>
            <div className="row-actions">
              <ActionButton icon={Play} primary run={() => start(true)}>Empezar</ActionButton>
              <ActionButton icon={Globe} run={() => start(false)}>Empezar en mi navegador</ActionButton>
            </div>
            <p className="faint">El aplicativo se abre aquí mismo, en un Chrome sin ventana con un perfil aparte, que graba el vídeo y tus acciones, nunca lo que escribes. En tu navegador se ve el mismo tráfico, sin vídeo; las marcas las pones tú.</p>
          </div>
        </section>
      )}
      {sessions.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <header><h3>Sesiones</h3></header>
          <ul className="feed">{sessions.slice(0, 10).map((r) => (
            <li key={r.id}><Dot state={r.phase === 'done' ? 'ok' : 'run'} /><a className="main rowlink" href={r.phase === 'done' ? href('runs', r.id) : preset ? preset.to(r.id) : href('live', r.id)}>{r.title ?? `Sesión ${r.id}`}</a><span className="when mono">{r.env}</span><span className="when">{r.phase === 'done' ? 'guardada' : 'abierta'}</span></li>
          ))}</ul>
        </section>
      )}
    </div>
  );
}

// ---------- one session, live ----------

/** Reads the session about every second, Kafka every third read; Kafka's hops are kept from its last read between. */
function useLive(id: string) {
  const [live, setLive] = useState<Live>();
  const [error, setError] = useState<string>();
  const [read, setRead] = useState<{ ms: number; at: number; kafkaAt?: number }>();
  useEffect(() => {
    let on = true, n = 0, kafka: Exchange[] = [], kafkaAt: number | undefined;
    (async () => {
      while (on) {
        const t0 = performance.now(), withKafka = n++ % 3 === 0;
        try {
          const d = await api<Live>(`/api/session/trace?id=${encodeURIComponent(id)}&kafka=${withKafka ? 1 : 0}`);
          if (!on) return;
          if (withKafka || d.run.phase === 'done') { kafka = d.trace.exchanges.filter((e) => e.kind === 'kafka'); kafkaAt = Date.now(); }
          else d.trace = { ...d.trace, exchanges: [...d.trace.exchanges, ...kafka].sort((a, b) => a.t0 - b.t0) };
          setLive(d); setError(undefined); setRead({ ms: Math.round(performance.now() - t0), at: Date.now(), kafkaAt });
          if (d.run.phase === 'done') return;
        } catch (e) { if (on) setError((e as Error).message); }
        await new Promise((r) => setTimeout(r, Math.max(250, 1000 - (performance.now() - t0))));
      }
    })();
    return () => { on = false; };
  }, [id]);
  return { live, error, read };
}

/** the studio, kept for the next session this browser opens */
const STUDIO = 'laru.live.studio';
const BROWSER: Record<SessionBrowser['state'], string> = { none: 'No abierto', opening: 'Abriéndose…', open: 'Abierto', closed: 'Cerrado', error: 'No se pudo abrir' };
/** m:ss; `base` turns the trace's clock (the video's, once there is one) into the session's own, from its start. */
const clock = (ms: number, base = 0) => { ms += base; const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = (t?: number) => (t === undefined ? '—' : `hace ${Math.max(0, Math.round((Date.now() - t) / 1000))} s`);

export function Session({ id, g, embedded }: { id: string; g: Indexed | null; embedded?: boolean }) {
  const { live, error, read } = useLive(id);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const [marking, setMarking] = useState(false);
  const [mark, setMark] = useState('');
  const [wide, setWide] = useState(false);
  const [drafting, setDrafting] = useState<'flow' | 'scenario' | false>(false);
  const input = useRef<HTMLInputElement>(null);
  const [side, setSide] = useState<Side>('steps');
  const open = live?.run.phase === 'tests';
  // a mark is written in «Pasos»: every «Marcar» opens that tab and puts the cursor in the field, wherever the side was
  const startMark = () => { setMarking(true); setSide('steps'); requestAnimationFrame(() => requestAnimationFrame(() => input.current?.focus())); };
  // «Estudio»: the app, the architecture, the message and a timeline growing as the person uses it, on the whole window.
  // On its own page it opens there (unless the person left it); inside a flow's sheet, only on request.
  const [studio, setStudio] = useState(() => { if (embedded) return false; try { return localStorage.getItem(STUDIO) !== '0'; } catch { return true; } });
  const toggleStudio = () => { if (!embedded) try { localStorage.setItem(STUDIO, studio ? '0' : '1'); } catch { /* only for this view */ } setStudio(!studio); };
  // the hop opened: from the Secuencia or a bar of the timeline
  const [sel, setSel] = useState(-1);
  const layout = useMemo(() => (live ? layoutSeq(live.trace) : null), [live]);
  const noise = useMemo(() => (live ? chainOf(live.trace).noise : new Map()), [live]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!open || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'm') return;
      const at = e.target as HTMLElement | null;
      // the embedded app gets its own keys
      if (/INPUT|TEXTAREA|SELECT/.test(at?.tagName ?? '') || at?.isContentEditable || at?.closest?.('.screen-box')) return;
      e.preventDefault(); startMark();
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [open]);


  // the env's menu from the first frame: while the session loads, the env it was reached from (else the menu waits for it)
  const known = live?.run.env ?? envOfSession.get(id);
  const scope = !embedded && known ? <EnvScope env={known} active="live" session={id} /> : null;
  if (error && !live) return <div className="page">{scope}<div className="notice" role="alert"><CircleX />{error}</div></div>;
  if (!live) return <div className="page wide">{scope}<Skeleton lines={3} /><div style={{ height: 16 }} /><Skeleton lines={10} /></div>;
  const { run, trace, browser } = live;
  const saving = run.phase === 'evidence';
  const sendMark = (e: FormEvent) => {
    e.preventDefault();
    const text = mark.trim() || 'Marca';
    api('/api/session/mark', { method: 'POST', body: { id, text } }).then(() => toast(`Marca «${text}»`), (x: Error) => toast(`No se pudo marcar: ${x.message}`));
    setMark(''); setMarking(false);
  };
  const outsideHosts = [...new Set(browser.outside.map((o) => new URL(o.url).host))];
  const base = trace.t0 - Date.parse(run.startedAt);
  const status = open ? <>Sesión {run.id} abierta · <span className="num">{clock(Date.now() - Date.parse(run.startedAt))}</span></> : saving ? 'Guardando la evidencia…' : `Sesión ${run.id} guardada`;
  const actions = (
    <>
      {open && <button className="btn sm" onClick={startMark} aria-keyshortcuts="M"><Flag />Marcar<kbd>M</kbd></button>}
      {open && <ActionButton icon={Square} primary sm run={() => api('/api/session/stop', { method: 'POST', body: { id } })} done={() => `Sesión ${id} guardada`}>Parar y guardar</ActionButton>}
      {!open && !saving && <button className="btn sm" onClick={() => setDrafting('flow')}><Workflow />Convertir en flujo</button>}
      {!open && !saving && <button className="btn sm" onClick={() => setDrafting('scenario')}><DatabaseBackup />Guardar como escenario</button>}
      {!open && !saving && <a className="btn sm primary" href={href('runs', run.id)}><Play />Abrir como run</a>}
    </>
  );
  const marks = (
    <div className="panel">
      <header><h3>Marcas</h3><div className="meta">Cada una abre un paso</div></header>
      {marking && open && <form className="mark-form" onSubmit={sendMark}><input ref={input} value={mark} onChange={(e) => setMark(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setMarking(false); }} aria-label="Qué vas a hacer" placeholder="Qué vas a hacer ahora" maxLength={120} /><button className="btn sm" type="submit">Marcar</button></form>}
      <ul className="steps">{trace.steps.length ? trace.steps.map((s) => <li key={s.n}><span className="num faint">{s.n}</span><span>{s.title}</span><span className="faint num">{clock(s.t0, base)}</span></li>)
        : <li className="faint" style={{ cursor: 'default' }}><span /><span>Sin marcas: los saltos se agrupan por tus acciones</span></li>}</ul>
    </div>
  );
  const now = open ? Date.now() - trace.t0 : trace.durationMs;
  const picked = layout?.rows[sel]?.ex;

  // the studio is the recorded one, live: the app where the video goes, the Recorrido, and the evidence in tabs beside it
  const pick = (hop: string) => setSel(layout ? layout.rows.findIndex((r) => r.ex.id === hop && !r.reply) : -1);
  const sqls = trace.exchanges.filter((e) => e.kind === 'sql');
  const evidence = (
    <>
      <Tabs id={`live-${id}-side`} label="Evidencia de la sesión" value={side} onChange={setSide} tabs={[
        { key: 'steps', label: 'Pasos', n: trace.steps.length },
        { key: 'net', label: 'Red', n: trace.exchanges.length - sqls.length },
        { key: 'logs', label: 'Logs', n: trace.logs.length },
        { key: 'data', label: 'Datos', n: sqls.length },
        { key: 'queues', label: 'Colas', n: trace.exchanges.filter((e) => e.kind === 'kafka' && !e.id.includes('>')).length },
        { key: 'mail', label: 'Mensajes', n: trace.exchanges.filter((e) => e.msg && !e.msg.cb).length },
      ]} />
      <div role="tabpanel" id={`live-${id}-side-panel`} aria-labelledby={`live-${id}-side-tab-${side}`} className="run-tab">
        {side === 'steps' && marks}
        {side === 'net' && <NetTab exchanges={trace.exchanges} sel={picked?.id} pick={pick} />}
        {side === 'logs' && <LogsTab logs={trace.logs} seek={(t) => layout && setSel(layout.rows.findLastIndex((r) => !r.reply && r.t <= t))} />}
        {side === 'data' && <ExchangeTable list={sqls} sel={picked?.id} pick={pick} empty="Ninguna consulta todavía: aparecen según el aplicativo lee y escribe." />}
        {(side === 'queues' || side === 'mail') && <Outbox trace={trace} base={base} env={run.env} session={open ? id : undefined} only={side} />}
      </div>
    </>
  );
  if (studio) return (
    <div className="studio live-studio" role="region" aria-label={`Estudio de la sesión ${run.id}`}
      onKeyDown={(e) => { const t = e.target as HTMLElement; if (e.key === 'Escape' && !t.closest('.screen-box, input, textarea, select, dialog')) { e.preventDefault(); toggleStudio(); } }}>
      {scope}
      <header className="st-bar">
        <span className="status" aria-live="polite"><Dot state={open || saving ? 'run' : 'ok'} />{status}</span>
        <b className="st-title" title={run.title ?? ''}>{run.title ?? `Sesión ${run.id}`}</b>
        <span className="faint">entorno <a className="rowlink mono" href={href('envs', run.env)}>{run.env}</a> · leído {ago(read?.at)}</span>
        <span className="grow" />
        {actions}
        <button type="button" className="btn sm" onClick={toggleStudio} title="Volver a la página de la sesión (Esc)"><Minimize2 />Salir del estudio</button>
      </header>
      <div className="st-video">
        <div className="screen">
          <Screen id={id} env={run.env} g={g} open={open} browser={browser} entrance={run.entrance ?? browser.url} wide={false} setWide={() => undefined} compact />
        </div>
      </div>
      <div className="st-stage"><LiveViews trace={trace} g={g} base={base} open={open} sel={sel} setSel={setSel} /></div>
      <aside className="st-side" aria-label="Evidencia">{evidence}</aside>
      {layout && <Tracks layout={layout} trace={trace} noise={noise} now={now} T={Math.max(1000, now, trace.durationMs)} sel={picked?.id} onSeek={(t) => setSel(layout.rows.findLastIndex((r) => !r.reply && r.t <= t))} onPick={setSel} />}
      {drafting && <ToDraft kind={drafting} id={id} title={run.title ?? `Sesión ${run.id}`} onClose={() => setDrafting(false)} />}
    </div>
  );

  return (
    <div className={embedded ? undefined : 'page wide'}>
      {scope}
      {!embedded && <nav className="crumbs" aria-label="Migas"><a href={href('live')}>En vivo</a><span aria-hidden="true">/</span><span>Sesión {run.id}</span></nav>}
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <div className="status" aria-live="polite"><Dot state={open ? 'run' : saving ? 'run' : 'ok'} />{status}</div>
          <h1 style={{ marginTop: 6 }}>{run.title ?? `Sesión ${run.id}`}</h1>
          <p>Entorno <a className="rowlink mono" href={href('envs', run.env)}>{run.env}</a>. Nada de esto se ejecuta solo: lo provocas tú al usar el aplicativo.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={toggleStudio}><Maximize2 />Abrir en el estudio</button>
          {actions}
        </div>
      </div>

      <div className="phases live-sources" aria-label="Qué se está leyendo">
        <div className="phase"><span className="n"><Dot state={browser.state === 'open' ? 'ok' : browser.state === 'error' ? 'err' : 'idle'} />Navegador de la sesión</span><span className="d">{browser.state === 'error' ? browser.error : BROWSER[browser.state]}{browser.state === 'none' && open ? ': usa el tuyo por la entrada del entorno' : ''}</span></div>
        <div className="phase"><span className="n"><Dot state={error ? 'err' : 'ok'} />HTTP y SQL</span><span className="d">{error ? `No se pudo leer: ${error}` : read ? `leído ${ago(read.at)}, en ${read.ms} ms` : '—'}</span></div>
        <div className="phase"><span className="n"><Dot state="ok" />Kafka</span><span className="d">cada 3 lecturas: llega con ese retraso; leído {ago(read?.kafkaAt)}</span></div>
        <div className="phase"><span className="n"><Dot state={trace.logs.some((l) => l.level === 'error') ? 'err' : 'ok'} />Logs</span><span className="d">{plural(new Set(trace.logs.map((l) => l.service)).size, 'servicio', 'servicios')} con líneas</span></div>
        <div className="phase"><span className="n"><Dot state={outsideHosts.length ? 'run' : 'ok'} />Fuera del tap</span><span className="d" title={outsideHosts.join(', ')}>{browser.state === 'none' ? 'solo lo sabe el navegador de la sesión' : outsideHosts.length ? `${plural(browser.outside.length, 'petición', 'peticiones')} a ${outsideHosts.slice(0, 2).join(', ')}${outsideHosts.length > 2 ? '…' : ''}` : 'nada'}</span></div>
      </div>

      <section className={`stage-live${wide ? ' wide' : ''}`}>
        <div className="screen">
          <Screen id={id} env={run.env} g={g} open={open} browser={browser} entrance={run.entrance ?? browser.url} wide={wide} setWide={setWide} />
        </div>
        <LiveViews trace={trace} g={g} base={base} open={open} sel={sel} setSel={setSel} />
      </section>

      <section className="panel live-evidence" aria-label="Evidencia">{evidence}</section>
      {drafting && <ToDraft kind={drafting} id={id} title={run.title ?? `Sesión ${run.id}`} onClose={() => setDrafting(false)} />}
    </div>
  );
}

type View = 'journey' | 'seq' | 'map';
type Side = 'steps' | 'net' | 'logs' | 'data' | 'queues' | 'mail';

/**
 * The same trace three ways, as a run shows it: the Recorrido by acts (with what each request carried and got back),
 * the Secuencia and the Mapa of what it reached. What happened in the last 3 seconds is «now»: its rows and edges are lit.
 */
function LiveViews({ trace, g, base, open, sel, setSel }: { trace: Trace; g: Indexed | null; base: number; open: boolean; sel: number; setSel: (i: number) => void }) {
  const [view, setView] = useState<View>('journey');
  const hops = useMemo(() => trace.exchanges.filter((e) => !e.asset).length, [trace]);
  const now = open ? Date.now() - trace.t0 : Infinity;
  const layout = useMemo(() => layoutSeq(trace), [trace]);
  const ctx = useMemo(() => sayCtx({ trace, rows: layout.rows, chain: chainOf(trace), map: g?.map }), [trace, layout, g]);
  const wrap = useRef<HTMLDivElement>(null);
  const arch = useMemo(() => {
    if (!g || !trace.exchanges.length) return null;
    const a = archGraph(g, [trace]);
    return { lay: mapLayout(a.sub, a.edges, { keep: true }), pieces: a.pieces, lit: a.lits[0] };
  }, [g, trace]);
  const hot = useMemo(() => new Set(trace.exchanges.filter((e) => now - e.t0 < 3000).map((e) => e.id)), [trace, now]);
  // the sequence follows what comes, unless the person scrolled up to read
  useEffect(() => { const w = wrap.current; if (view === 'seq' && w && w.scrollHeight - w.scrollTop - w.clientHeight < 200) w.scrollTop = w.scrollHeight; }, [view, layout]);
  return (
    <div className="live-main">
      <div className="live-bar">
        <Tabs id="live-view" label="Vista" className="tabs live-tabs" value={view} onChange={setView} tabs={[{ key: 'journey', label: 'Recorrido' }, { key: 'seq', label: 'Secuencia' }, { key: 'map', label: 'Mapa' }]} />
        <span className="faint num">{plural(hops, 'salto', 'saltos')}</span>
      </div>
      {view === 'journey' ? <Journey trace={trace} ctx={ctx} lanes={layout.lanes} sel={layout.rows[sel]?.ex.id} onPick={(id) => setSel(layout.rows.findIndex((r) => r.ex.id === id && !r.reply))} hot={open ? hot : undefined} time={(t) => clock(t, base)} follow={open} />
        : view === 'seq' ? (layout.rows.length ? <><SeqView layout={layout} now={now} sel={sel} onPick={setSel} wrap={wrap} still={!open} />{layout.rows[sel] && <LiveHop ex={layout.rows[sel].ex} base={base} names={new Map(layout.lanes.map((l) => [l.id, l.name]))} />}</> : <div className="empty">Todavía no ha pasado nada.</div>)
        : !g ? <div className="empty">Sin map no hay mapa: lee el código en Proyectos o con <code>laru map</code>.</div>
        : arch ? <div className="live-map"><FlowMap lay={arch.lay} pieces={arch.pieces} lit={arch.lit} hot={hot} trace={trace} /></div>
        : <div className="empty">Todavía no ha pasado nada.</div>}
    </div>
  );
}

/** One hop of the sequence opened as it comes: who called whom, how it ended and what each side said (already masked). */
function LiveHop({ ex, base, names }: { ex: Exchange; base: number; names: Map<string, string> }) {
  const ms = ex.t1 !== undefined ? ex.t1 - ex.t0 : undefined;
  return (
    <section className="panel live-hop"><header><h3>{names.get(ex.from) ?? ex.from} → {names.get(ex.to) ?? ex.to}</h3><div className="meta"><span className="mono">{ex.label}</span><span>{ex.ok ? 'bien' : 'con error'}{ex.status ? ` · ${ex.status}` : ''}</span>{ms !== undefined && <span className="num">{ms} ms</span>}<span className="num faint">{clock(ex.t0, base)}</span></div></header>
      <ExchangeIO ex={ex} names={names} />
    </section>
  );
}

/** «Colas» and «Mensajes»: what was published, and the mail and SMS the app sent (a mail's link opens in the session). */
function Outbox({ trace, base, env, session, only }: { trace: Trace; base: number; env?: string; session?: string; only: 'queues' | 'mail' }) {
  const sent = trace.exchanges.filter((e) => e.msg && !e.msg.cb);
  // the link a mail carries, opened by the session's own browser: only an address of the env's entrance goes (the service checks it again)
  const openLink = async (id: string) => {
    try {
      const m = await api<{ links: Array<{ open?: string }> }>(`/api/mail/message?env=${encodeURIComponent(env ?? '')}&id=${encodeURIComponent(id)}`);
      const url = m.links.find((l) => l.open)?.open;
      if (!url) return toast('Este mensaje no trae un enlace que se pueda abrir aquí');
      await api('/api/session/input', { method: 'POST', body: { id: session, input: { t: 'nav', to: 'goto', url } } });
    } catch (e) { toast((e as Error).message); }
  };
  const published = trace.exchanges.filter((e) => e.kind === 'kafka' && !e.id.includes('>'));
  const Row = ({ t, who, lv, msg }: { t: number; who: string; lv: string; msg: string }) => <div><span className="ts">{clock(t, base)}</span><span>{who}</span><span className="lv">{lv}</span><span className="msg" title={msg}>{msg}</span></div>;
  const queues = (
      <section className="panel"><header><h3>Colas</h3><div className="meta"><span className="chip run">con retraso de lectura</span></div></header>
        <div className="logs live-logs">{published.length ? published.slice(-50).map((e) => <Row key={e.id} t={e.t0} who={e.from} lv="pub" msg={`${e.label} ${e.req?.text ?? ''}`} />) : <div className="faint"><span /><span>Ningún mensaje todavía</span></div>}</div></section>
  );
  const mail = (
      <section className="panel"><header><h3>Mensajes</h3><div className="meta">{sent.length}</div></header>
        <div className="logs live-logs">{sent.length ? sent.slice(-50).map((e) => <div key={e.id}><span className="ts">{clock(e.t0, base)}</span><span>{e.from}</span><span className="lv">{e.msg!.kind === 'mail' ? 'correo' : 'SMS'}</span><span className="msg">{e.msg!.kind === 'mail' ? `${e.msg!.subject || '(sin asunto)'} → ${e.msg!.to}` : `→ ${e.msg!.to}`}{e.msg!.kind === 'mail' && session && env && <> <button type="button" className="btn sm" onClick={() => void openLink(e.msg!.id)}>Abrir en la sesión</button></>}</span></div>) : <div className="empty faint">Nada enviado todavía. El correo y los SMS que la aplicación mande aparecen aquí y no salen de tu máquina.</div>}</div></section>
  );
  return only === 'queues' ? queues : mail;
}

// ---------- the app, embedded ----------

const W = 1280, H = 800;
const MODS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);
const BUTTON = ['left', 'middle', 'right'] as const;

/**
 * The session's browser as a picture that answers: Chrome's frames, and the person's mouse, keys, pasted text and
 * picked files sent back to it. Keys go to the app while the picture has the focus; a click elsewhere gives them back.
 */
function Screen({ id, env, g, open, browser, entrance, wide, setWide, compact }: { id: string; env: string; g: Indexed | null; open: boolean; browser: SessionBrowser; entrance?: string; wide: boolean; setWide: (b: boolean) => void; /** the studio's column: the address keeps the room, the buttons go as icons */ compact?: boolean }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  // The web fronts of this env: several when it joins projects (a flow that enters by one and calls the other's back can be seen from the other's front)
  const kindOf = (svc: string) => g?.nodes.get(`svc:${svc}`)?.kind;
  const fronts = frontsOf(envs.data?.find((e) => e.env === env)?.addresses ?? [], kindOf);
  const img = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [shown, setShown] = useState(false);
  const [asks, setAsks] = useState<{ multiple: boolean } | null>(null);
  const [focus, setFocus] = useState(false);
  const live = open && browser.state === 'open';
  useEffect(() => {
    if (!live) return;
    const es = new EventSource(apiUrl(`/api/session/screen?id=${encodeURIComponent(id)}`));
    es.addEventListener('frame', (m) => { if (img.current) img.current.src = `data:image/jpeg;base64,${(m as MessageEvent).data}`; setShown(true); });
    es.addEventListener('url', (m) => setUrl((m as MessageEvent).data));
    es.addEventListener('files', (m) => { setAsks(JSON.parse((m as MessageEvent).data)); });
    es.addEventListener('closed', () => es.close());
    return () => es.close();
  }, [id, live]);
  // One after another: separate requests could overtake each other, and the text would land before the click that
  // focuses its field. Known limit: one request per event, moves at most every 50 ms; batch them if it ever lags.
  const line = useRef(Promise.resolve());
  const send = (input: unknown) => { line.current = line.current.then(() => api('/api/session/input', { method: 'POST', body: { id, input } })).then(() => undefined, () => undefined); };
  const at = (e: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    // the frame is the page's own pixels: 1280 × 800, or a phone's when a mobile front is shown
    // (drawn whole, centred: a phone's frame leaves bands at the sides)
    const w = img.current!.naturalWidth || W, h = img.current!.naturalHeight || H, k = Math.min(r.width / w, r.height / h);
    const x = (e.clientX - r.left - (r.width - w * k) / 2) / k, y = (e.clientY - r.top - (r.height - h * k) / 2) / k;
    return { x: Math.round(Math.min(w - 1, Math.max(0, x))), y: Math.round(Math.min(h - 1, Math.max(0, y))) };
  };
  const lastMove = useRef(0);
  const keyOf = (e: React.KeyboardEvent) => {
    const combo = [e.ctrlKey && 'Control', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && e.key.length > 1 && 'Shift'].filter(Boolean);
    return combo.length ? `${combo.join('+')}+${e.key}` : e.key;
  };
  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = await Promise.all([...list].map(async (f) => {
      if (f.size > 25 * 2 ** 20) throw new Error(`${f.name} pasa de 25 MB`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { name: f.name, mimeType: f.type || 'application/octet-stream', b64: btoa(bin) };
    })).catch((e: Error) => { toast(e.message); return null; });
    if (files) { send({ t: 'files', files }); setAsks(null); }
  };
  return (
    <>
      <div className="screen-bar">
        <button className="icon-btn" disabled={!live} onClick={() => send({ t: 'nav', to: 'back' })} aria-label="Atrás" title="Atrás"><ArrowLeft /></button>
        <button className="icon-btn" disabled={!live} onClick={() => send({ t: 'nav', to: 'forward' })} aria-label="Adelante" title="Adelante"><ArrowRight /></button>
        <button className="icon-btn" disabled={!live} onClick={() => send({ t: 'nav', to: 'reload' })} aria-label="Recargar" title="Recargar"><RotateCw /></button>
        <button className="icon-btn" disabled={!live} onClick={() => send({ t: 'nav', to: 'home' })} aria-label="Volver a la entrada" title="Volver a la entrada"><HomeIcon /></button>
        {fronts.length > 1 && (
          <select className="front-pick" aria-label="Cliente que se muestra" title="Cambia a otro cliente de este entorno: la sesión sigue grabando todo el tráfico" disabled={!live}
            value={frontAt(fronts, url || entrance || '')?.url ?? ''} onChange={(e) => { const f = fronts.find((x) => x.url === e.target.value); if (f) send({ t: 'nav', to: 'goto', url: f.url, device: kindOf(f.service) === 'mobile' ? 'phone' : 'desktop' }); }}>
            <option value="" disabled>Cliente…</option>
            {fronts.map((f) => <option key={f.url} value={f.url}>{frontLabel(f.service, kindOf(f.service))}</option>)}
          </select>
        )}
        <span className="addr mono" title={url || entrance}>{(url || entrance || '').replace(/^https?:\/\//, '')}</span>
        {entrance && (compact ? <a className="icon-btn" href={entrance} target="_blank" rel="noreferrer" aria-label="Abrir en el navegador" title="Abrir en tu navegador: se ve el mismo tráfico, sin vídeo ni acciones grabadas"><ExternalLink /></a>
          : <a className="btn sm" href={entrance} target="_blank" rel="noreferrer" title="Tu navegador: se ve el mismo tráfico, sin vídeo ni acciones grabadas"><ExternalLink />Abrir en el navegador</a>)}
        {!compact && <button className="icon-btn" onClick={() => setWide(!wide)} aria-label={wide ? 'Reducir' : 'Ampliar'} title={wide ? 'Reducir' : 'Ampliar'}>{wide ? <Minimize2 /> : <Maximize2 />}</button>}
      </div>
      {asks && (
        <div className="notice info screen-ask"><Upload /><span>La página pide {asks.multiple ? 'ficheros' : 'un fichero'}.</span>
          <button className="btn sm" onClick={() => picker.current?.click()}>Elegir</button><button className="btn sm" onClick={() => { send({ t: 'files', files: [] }); setAsks(null); }}>Ninguno</button>
          <input ref={picker} type="file" hidden multiple={asks.multiple} onChange={(e) => pick(e.target.files)} /></div>
      )}
      <div className={`screen-box${focus ? ' focus' : ''}`} role="application" aria-label="El aplicativo: el teclado y el ratón van a él mientras tenga el foco"
        onMouseDown={(e) => { if (!live) return; e.preventDefault(); keys.current?.focus({ preventScroll: true }); send({ t: 'down', ...at(e), button: BUTTON[e.button] ?? 'left', clicks: e.detail || 1 }); }}
        onMouseUp={(e) => { if (live) send({ t: 'up', ...at(e), button: BUTTON[e.button] ?? 'left', clicks: e.detail || 1 }); }}
        onMouseMove={(e) => { if (!live || performance.now() - lastMove.current < 50) return; lastMove.current = performance.now(); send({ t: 'move', ...at(e) }); }}
        onWheel={(e) => { if (live) send({ t: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY }); }}
        onContextMenu={(e) => e.preventDefault()}>
        {/* What is typed lands here first, so accents, ñ, dictation and paste arrive whole as text; a named key or a
            combination goes as a key. */}
        <textarea ref={keys} className="screen-keys" aria-label="Escribir en el aplicativo" tabIndex={live ? 0 : -1} autoComplete="off" spellCheck={false}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          onKeyDown={(e) => {
            if (!live || MODS.has(e.key) || e.nativeEvent.isComposing || e.key === 'Dead' || e.key === 'Process') return;
            const combo = e.ctrlKey || e.metaKey || e.altKey;
            if (combo && e.key.toLowerCase() === 'v') return; // the paste lands in the field and goes as text
            if (e.key.length > 1 || combo) { e.preventDefault(); send({ t: 'key', down: true, key: keyOf(e) }); }
          }}
          onKeyUp={(e) => { if (live && !MODS.has(e.key) && e.key.length > 1 && e.key !== 'Dead' && !e.metaKey && !e.ctrlKey && !e.altKey) send({ t: 'key', down: false, key: e.key }); }}
          onInput={(e) => { const el = e.currentTarget; if ((e.nativeEvent as InputEvent).isComposing) return; if (el.value) send({ t: 'text', text: el.value }); el.value = ''; }}
          onCompositionEnd={(e) => { const el = e.currentTarget; if (el.value) send({ t: 'text', text: el.value }); el.value = ''; }} />
        <img ref={img} alt="" draggable={false} style={{ visibility: shown && live ? 'visible' : 'hidden' }} />
        {!(shown && live) && (
          <div className="screen-empty">
            {!open ? <span>La sesión está guardada: su vídeo está en el run.</span>
              : browser.state === 'opening' ? <span>Abriendo el aplicativo…</span>
              : browser.state === 'error' ? <span className="err-ink">No se pudo abrir: {browser.error}</span>
              : browser.state === 'open' ? <span>Esperando la primera imagen…</span>
              : <span>{browser.state === 'closed' ? 'El navegador de la sesión se cerró.' : 'Lo estás usando en tu navegador.'}</span>}
            {open && (browser.state === 'none' || browser.state === 'closed' || browser.state === 'error') && <ActionButton icon={AppWindow} sm run={() => api('/api/session/browser', { method: 'POST', body: { id } })}>Abrirlo aquí</ActionButton>}
          </div>
        )}
      </div>
      <div className="screen-meta"><span>{live ? (focus ? 'El teclado va al aplicativo; pulsa fuera para recuperarlo' : 'Pulsa sobre el aplicativo para usarlo') : ''}</span><span className="num">{W} × {H}</span></div>
    </>
  );
}

// ---------- the session as a flow ----------

interface Drafted { ok: boolean; id?: string; spec?: string; setup?: string; issues: Array<{ at: string; message: string }>; checks?: Array<{ line?: number; key: string; message: string }> }

/** Where the draft lives (a module or a process) and what it is called; then what is left to write in it. */
/** «Convertir en flujo» and «Guardar como escenario»: the same session written as the draft of one or the other. */
function ToDraft({ kind, id, title: first, onClose }: { kind: 'flow' | 'scenario'; id: string; title: string; onClose: () => void }) {
  const flow = kind === 'flow';
  const k = useApi<KnowledgeData>('/api/knowledge');
  const places = (k.data?.pieces ?? []).filter((p) => p.type === 'module' || (flow ? p.type === 'process' : p.type === 'application'));
  const [where, setWhere] = useState<string>();
  const [title, setTitle] = useState(first);
  const [done, setDone] = useState<Drafted>();
  const make = () => api<Drafted>(`/api/session/to-${kind}`, { method: 'POST', body: { id, in: where, title: title.trim() } }).then((r) => {
    if (!r.ok) throw new Error(r.issues.map((i) => `${i.at}: ${i.message}`).join('; '));
    setDone(r);
  });
  return (
    <Dialog title={flow ? 'Convertir en flujo' : 'Guardar como escenario'} onClose={onClose} wide>
      {done ? (
        <div className="to-flow">
          <p><a className="rowlink mono" href={href('docs', done.id!)}>{done.id}</a> está escrito como borrador, con {flow ? <>su prueba en <code>{done.spec}</code>. Lo tecleado no se guarda y lo que viste no se sabe: queda por escribir.</> : <>su preparación en <code>{done.setup}</code>. Lo tecleado no se guarda: queda por escribir, y decir quién puede entrar. Luego se aprovisiona.</>}</p>
          <ul className="steps">{(done.checks ?? []).map((c, i) => <li key={i} style={{ cursor: 'default' }}><span className="num faint">{c.line ?? '—'}</span><span><code>{c.key}</code> {c.message}</span><span /></li>)}</ul>
          <div className="row-actions"><a className="btn primary" href={href('docs', done.id!)}>{flow ? 'Abrir el flujo' : 'Abrir el escenario'}</a><button className="btn" onClick={onClose}>Cerrar</button></div>
        </div>
      ) : (
        <div className="to-flow">
          <label className="field"><span>{flow ? 'Título del flujo' : 'Título del escenario'}</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-autofocus /></label>
          <div className="field"><span>Dónde vive</span>
            {!k.data ? <Skeleton lines={3} /> : !places.length ? <p className="faint">No hay {flow ? 'módulos ni procesos' : 'módulos ni aplicativo'} documentados: crea uno en <a className="rowlink" href={href('docs')}>Documentación y flujos</a>.</p> : (
              <ul className="places" role="radiogroup" aria-label="Dónde vive">{places.map((p) => (
                <li key={p.id}><button role="radio" aria-checked={where === p.id} className={where === p.id ? 'on' : ''} onClick={() => setWhere(p.id)}><span>{p.title}</span><span className="mono faint">{p.id}</span></button></li>
              ))}</ul>
            )}
          </div>
          <p className="faint">{flow ? <>Tus marcas serán sus Pasos, tus acciones el código de cada paso y lo que hicieron los servicios, sus <code>observed.wait</code>.</> : <>Tus marcas serán el estado que deja, y tus acciones, su preparación: se juega para ponerlo.</>}</p>
          <div className="row-actions"><ActionButton icon={flow ? Workflow : DatabaseBackup} primary disabled={!where || !title.trim()} run={make}>Escribir el borrador</ActionButton><button className="btn" onClick={onClose}>Cancelar</button></div>
        </div>
      )}
    </Dialog>
  );
}
