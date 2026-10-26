/**
 * Flows: business journeys that are documentation and test at once. `FlowTable` says how each one did in its last ten
 * runs and runs the ones picked; `FlowPage` is one flow with the player of its latest evidence, or, when it never
 * ran, what its steps and the code say it should do.
 */
import { CircleX, Play } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, useApi, type EnvSummary, type FlowInfo, type Indexed, type KnowledgeData, type RunInfo } from '../api.ts';
import { ActionButton, CopyButton, Segmented, Skeleton, Status, Tabs, type DotState } from '../components/ui.tsx';
import { askFirst } from '../lib/ask.ts';
import { ago, lastText, plural, RUN_STATUS, secs } from '../lib/es.ts';
import { href, whereFailed } from '../lib/route.ts';
import { expectedTrace, layoutSeq } from '../lib/seq.ts';
import { archGraph, expectedGraph, layout, type FlowEdge } from '../lib/sysmap.ts';
import { FlowEvidence, FlowMap, SeqView, useFlowView, type FlowView } from './Runs.tsx';

/** A flow's glyph: its newest result that says something about the code (a cached one passed). */
export const flowDot = (f?: FlowInfo): DotState => (!f?.exists || !f.last ? 'idle' : f.last.status === 'failed' ? 'err' : 'ok');
/** The flows whose last run reached an endpoint. */
export const walkers = (flows: FlowInfo[], ep: string) => flows.filter((f) => f.last?.endpoints.some((e) => e.id === ep));
/** Whether the flow's failing hop landed on that endpoint. */
export const failedOn = (f: FlowInfo, ep: string) => { const h = f.last?.failure?.hop; return h !== undefined && `ep:${h.to}:${h.what}` === ep; };

/** Which flows are ticked: the table's checkboxes and the run button share it. */
export function usePick(initial: () => string[]) {
  const [picked, setPicked] = useState(() => new Set(initial()));
  const toggle = (slug: string) => setPicked((s) => { const n = new Set(s); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });
  return { picked, setPicked, toggle };
}
export type FlowPick = ReturnType<typeof usePick>;

/**
 * Runs the flows on an env that is up, then opens the run. Unavailable, its title says why. With several projects the
 * env is the smallest that runs every project the flows need, and the run starts it when it is not up.
 */
export function RunFlows({ chosen, envs, single }: { chosen: FlowInfo[]; envs?: EnvSummary[]; single?: boolean }) {
  if (chosen.some((f) => f.projects !== undefined)) return <RunAcross chosen={chosen} single={single} />;
  return <RunOnReady chosen={chosen} envs={envs} single={single} />;
}

function RunAcross({ chosen, single }: { chosen: FlowInfo[]; single?: boolean }) {
  const runnable = chosen.filter((f) => f.exists);
  const on = useApi<{ env: string; ready: boolean }>(runnable.length ? `/api/runs/env?flows=${encodeURIComponent(runnable.map((f) => f.slug).join(','))}` : null);
  const why = single && !runnable.length ? 'Sin prueba' : !runnable.length ? 'Marca los flujos que quieres ejecutar' : on.error ? on.error : undefined;
  return (
    <>
      <ActionButton icon={Play} primary={!single} disabled={Boolean(why) || !on.data} title={why}
        run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { flows: runnable.map((f) => f.slug), confirm, pwTrace: true } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')}>
        {single ? 'Ejecutar prueba automática' : !runnable.length ? 'Ejecutar' : `Ejecutar ${plural(runnable.length, 'flujo', 'flujos')}`}{!single && on.data ? ` en ${on.data.env}${on.data.ready ? '' : ' (se levanta)'}` : ''}
      </ActionButton>
    </>
  );
}

function RunOnReady({ chosen, envs, single }: { chosen: FlowInfo[]; envs?: EnvSummary[]; single?: boolean }) {
  const [envSel, setEnv] = useState<string>();
  const ready = (envs ?? []).filter((e) => e.state === 'ready');
  const env = ready.find((e) => e.env === envSel)?.env ?? ready[0]?.env;
  const runnable = chosen.filter((f) => f.exists);
  const why = single && !runnable.length ? 'Sin prueba' : !env ? 'Levanta un entorno para ejecutar flujos' : !runnable.length ? 'Marca los flujos que quieres ejecutar' : undefined;
  return (
    <>
      {ready.length > 1 && <Segmented label="Entorno" value={env ?? ''} onChange={setEnv} options={ready.map((e) => ({ key: e.env, label: e.env }))} />}
      <ActionButton icon={Play} primary={!single} disabled={Boolean(why)} title={why}
        run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { env, flows: runnable.map((f) => f.slug), confirm, pwTrace: true } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')}>
        {single ? 'Ejecutar prueba automática' : !runnable.length ? 'Ejecutar' : `Ejecutar ${plural(runnable.length, 'flujo', 'flujos')}`}{!single && env ? ` en ${env}` : ''}
      </ActionButton>
    </>
  );
}

/** The newest result in a few words: an error says it could not run, the rest as the flow's last result. */
export const lastWord = (f: FlowInfo): [DotState, string] => {
  if (!f.exists) return ['idle', 'Sin prueba'];
  if (f.history.at(-1)?.status === 'error') return ['err', 'No pudo correr'];
  return [flowDot(f), lastText(f.last)];
};

/**
 * The flows of a piece: how each did, its last ten runs and when. «Vive en» only when they come from more than one
 * container; `sub` replaces the id line (the flows «de paso» say how many of its endpoints they reach).
 */
export function FlowTable({ rows, pick, home, sub, label }: { rows: FlowInfo[]; pick: FlowPick; home?: (f: FlowInfo) => { id: string; title: string } | null; sub?: (f: FlowInfo) => string; label: string }) {
  const runnable = rows.filter((f) => f.exists);
  const all = runnable.length > 0 && runnable.every((f) => pick.picked.has(f.slug));
  const where = home && new Set(rows.map((f) => home(f)?.id)).size > 1;
  return (
    <div className="scroll-x">
      <table className="t flows">
        <thead>
          <tr>
            <th className="pick"><input type="checkbox" aria-label={`Elegir todos: ${label}`} checked={all} disabled={!runnable.length} onChange={() => pick.setPicked((s) => { const n = new Set(s); for (const f of runnable) if (all) n.delete(f.slug); else n.add(f.slug); return n; })} /></th>
            <th>Flujo</th>{where && <th className="c-where">Vive en</th>}<th className="c-last">Último</th><th className="c-spark">Últimos 10</th><th className="r c-dur">Dur.</th><th className="r">Cuándo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const last = f.history.at(-1);
            const parent = home?.(f);
            const cmd = `laru flow scaffold ${f.id}`;
            const [dot, word] = lastWord(f);
            const failAt = whereFailed(f);
            const fail = failAt && <div className="sub"><a className="rowlink" href={failAt} aria-label={`Ver dónde falló ${f.title}`}>Ver dónde falló ›</a></div>;
            return (
              <tr key={f.slug}>
                <td className="pick">{f.exists && <input type="checkbox" aria-label={`Elegir ${f.title}`} checked={pick.picked.has(f.slug)} onChange={() => pick.toggle(f.slug)} />}</td>
                <td className="wrap">
                  <a className="rowlink" href={href('docs', f.id)} style={{ fontWeight: 500 }}>{f.title}</a>
                  <div className="faint mono sub">{sub?.(f) ?? `${f.id} · ${plural(f.steps.length, 'paso', 'pasos')}${f.cases.length ? `, ${plural(f.cases.length, 'caso', 'casos')}` : ''}`}</div>
                  <div className="only-sm sub"><Status state={dot}>{word}</Status>{fail}</div>
                  {!f.exists && <div className="scaffold"><span className="faint">Créala con</span> <code>{cmd}</code><CopyButton value={cmd} label={`Copiar el comando para crear la prueba de ${f.title}`} /></div>}
                </td>
                {where && <td className="c-where">{parent ? <a className="rowlink" href={href('docs', parent.id)}>{parent.title}</a> : <span className="faint">—</span>}</td>}
                <td className="c-last"><Status state={dot}>{word}</Status>{fail}</td>
                <td className="c-spark"><Spark history={f.history} /></td>
                <td className="r num c-dur">{last?.ms !== undefined ? secs(last.ms) : <span className="faint">—</span>}</td>
                <td className="r faint">{last ? <a className="rowlink" href={href('runs', last.run, f.slug)} title={new Date(last.at).toLocaleString('es')}>{ago(last.at)}</a> : 'nunca'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The last ten runs as bars: tall and grey when they passed, short and red otherwise. */
export function Spark({ history }: { history: FlowInfo['history'] }) {
  if (!history.length) return <span className="faint">—</span>;
  const ok = history.filter((h) => h.status === 'passed' || h.status === 'cached').length;
  return (
    <span className="spark" role="img" aria-label={`${ok} de ${history.length} correctos`}>
      {history.map((h) => <i key={h.run} className={h.status === 'passed' || h.status === 'cached' ? 'ok' : 'bad'} title={`Run ${h.run}: ${RUN_STATUS[h.status] ?? h.status}`} />)}
    </span>
  );
}

/**
 * A flow's page below its header: its latest evidence in the run player (Secuencia or Mapa, the same selection and
 * clock), or what it should do when it never ran.
 */
export function FlowPage({ g, flow, error, loading, view, onView, test, address, k }: { g: Indexed | null; flow?: FlowInfo; error?: string; loading: boolean; view?: FlowView; onView: (v: FlowView) => void; test?: string; address?: (v: FlowView, test?: string) => string; k?: KnowledgeData }) {
  if (error) return <div className="notice" role="alert"><CircleX />No se pudo leer el historial de runs: {error}</div>;
  if (!flow) return loading ? <><Skeleton lines={2} /><div style={{ height: 16 }} /><Skeleton lines={8} /></>
    : <div className="notice warn"><CircleX /><div>El historial de runs todavía no conoce este flujo. Recarga la página para leerlo de nuevo.</div></div>;
  const row = flow.history.findLast((h) => h.status !== 'error');
  const newest = flow.history.at(-1);
  return (
    <>
      {row?.status === 'cached' && flow.last && <p className="faint last-note">De la caché: la evidencia es del run {flow.last.run}.</p>}
      {newest?.status === 'error' && <div className="notice warn"><CircleX /><div>El run {newest.run} no llegó a correr ninguna prueba{flow.last ? `; la evidencia es del run ${flow.last.run}` : ''}.</div></div>}
      {flow.last ? <LastEvidence g={g} flow={flow} view={view} onView={onView} test={test} address={address} k={k} /> : <Expected g={g} flow={flow} view={view} onView={onView} />}
    </>
  );
}

function LastEvidence({ g, flow, view, onView, test, address, k }: { g: Indexed | null; flow: FlowInfo; view?: FlowView; onView: (v: FlowView) => void; test?: string; address?: (v: FlowView, test?: string) => string; k?: KnowledgeData }) {
  const run = useApi<RunInfo>(`/api/run?id=${encodeURIComponent(flow.last!.run)}`);
  if (run.error) return <div className="notice" role="alert"><CircleX />{run.error}</div>;
  if (!run.data) return <><Skeleton lines={2} /><div style={{ height: 16 }} /><Skeleton lines={8} /></>;
  return <FlowEvidence run={run.data} slug={flow.slug} flow={flow} g={g} view={view} onView={onView} test={test} address={address} k={k} />;
}

const noop = () => {};

/** A flow that never ran: its steps as a sequence and the code's edges among what it needs. Nothing here was seen. */
function Expected({ g, flow, view: asked, onView }: { g: Indexed | null; flow: FlowInfo; view?: FlowView; onView: (v: FlowView) => void }) {
  const [view, pickView] = useFlowView(asked, onView);
  const seq = useMemo(() => layoutSeq(expectedTrace(flow)), [flow]);
  const wrap = useRef<HTMLDivElement>(null);
  // The full map, with what its Pasos and the code expect lit and the rest dimmed; every expected edge says only that.
  const arch = useMemo(() => {
    if (!g) return null;
    const eg = expectedGraph(g, flow), a = archGraph(g, []);
    const ids = new Set(eg.edges.map((e) => e.id));
    const edges = new Map(eg.edges.map((e): [string, FlowEdge] => [e.id, { ...e, label: 'esperado', ex: [], n: 0, sse: 0, failed: 0, errors: 0, bad: false, tables: [], inMap: true }]));
    return { lay: layout(a.sub, a.edges.map((e) => (ids.has(e.id) ? { ...e, label: 'esperado' } : e)), { keep: true }), pieces: a.pieces, lit: { edges, nodes: new Set(eg.sub.nodes.keys()), quiet: new Set<string>() } };
  }, [g, flow]);
  const cmd = `laru flow scaffold ${flow.id}`;
  return (
    <section className="panel expected" aria-labelledby="expected-h">
      <header>
        <h3 id="expected-h" className="status">{flow.exists
          ? <><span className="dot idle" aria-hidden="true" />Sin ejecutar. Esto es lo esperado según sus Pasos y el código; no es evidencia.</>
          : <><span className="dot idle" aria-hidden="true" />Sin prueba. Créala con <code>{cmd}</code><CopyButton value={cmd} label={`Copiar el comando para crear la prueba de ${flow.title}`} /></>}</h3>
      </header>
      <div className="view-bar">
        <Tabs id="expected" className="tabs view-tabs" label="Vista del flujo" value={view} onChange={pickView} tabs={[{ key: 'seq', label: 'Secuencia' }, { key: 'map', label: 'Mapa' }]} />
        <span className="faint num">{view === 'seq' ? plural(seq.rows.length, 'mensaje esperado', 'mensajes esperados') : arch ? plural(arch.lit.edges.size, 'conexión esperada', 'conexiones esperadas') : ''}</span>
      </div>
      <div role="tabpanel" id="expected-panel" aria-labelledby={`expected-tab-${view}`} className="diagram-panel">
        {view === 'seq' ? <SeqView layout={seq} now={Infinity} sel={-1} onPick={noop} wrap={wrap} still />
          : !arch ? <p className="empty">Sin mapa: pulsa «Releer el código» en <a className="rowlink" href={href('repos')}>Proyectos</a>.</p>
          : <FlowMap lay={arch.lay} pieces={arch.pieces} lit={arch.lit} expected />}
      </div>
    </section>
  );
}
