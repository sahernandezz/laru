/**
 * The overview: what is up, what ran last, what does not match between code, documentation and runs, and what
 * changed since the last run. One request; every number links to the screen that explains it.
 */
import { AppWindow, CircleX, Container, History, Play, Route, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, useApi, type FlowInfo, type Indexed, type Overview as Data } from '../api.ts';
import { flowDot, Spark } from './Flows.tsx';
import { openStudio } from './Live.tsx';
import { ActionButton, Dot, Status, type DotState } from '../components/ui.tsx';
import { askFirst } from '../lib/ask.ts';
import { ago, ENV_STATE, FINDING, findingText, plural, RUN_DOT, RUN_PHASE, RUN_STATUS, secs, SEVERITY, whyText } from '../lib/es.ts';
import { href, pageOf } from '../lib/route.ts';

const ENV_DOT: Record<string, DotState> = { ready: 'ok', starting: 'run', failed: 'err', stopped: 'idle', absent: 'idle' };
/** The envs that are not ready, by state, as the reference says it: «1 arrancando, 2 parados». */
const NOT_READY: Array<[string, string, string]> = [['starting', 'arrancando', 'arrancando'], ['failed', 'con fallos', 'con fallos'], ['stopped', 'parado', 'parados'], ['absent', 'sin levantar', 'sin levantar']];
const took = (r: Data['runs'][number]) => (r.endedAt ? secs(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : undefined);

export function Overview({ title, g }: { title?: string; g: Indexed | null }) {
  const o = useApi<Data>('/api/overview');
  const flows = useApi<FlowInfo[]>('/api/flows');
  const d = o.data;
  const head = (actions?: ReactNode) => (
    <div className="head">
      <div><h1>{title ?? 'Resumen'}</h1><p>Lo que está arriba, lo último que corrió y lo que no casa entre el código, la documentación y lo que se ha visto en los runs.</p></div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
  if (o.error) return <div className="page">{head()}<div className="notice" role="alert"><CircleX />{o.error}</div></div>;
  if (!d) return <div className="page wide">{head()}<OverviewSkeleton /></div>;

  const ready = d.envs.filter((e) => e.state === 'ready');
  const runEnv = ready[0]?.env;
  const notReady = NOT_READY.flatMap(([s, one, many]) => { const n = d.envs.filter((e) => e.state === s).length; return n ? [plural(n, one, many)] : []; }).join(', ');
  const runnable = new Set(d.flows.filter((f) => f.exists).map((f) => f.slug));
  const affected = (d.impact?.flows ?? []).map((f) => f.id.replace(/^flow:/, '')).filter((s) => runnable.has(s));
  const done = d.runs.filter((r) => r.phase === 'done');
  const passed = done.filter((r) => r.status === 'passed').length;
  const failed = done.filter((r) => r.status === 'failed' || r.status === 'error').length;
  const high = d.findings.errors.length;
  const titleOf = new Map(d.flows.map((f) => [f.slug, f.title]));
  const last = done[0];
  const fl = flows.data ?? [];
  const order = (f: FlowInfo) => (flowDot(f) === 'err' ? 0 : !f.exists ? 3 : !f.last ? 2 : 1);
  const tiles = [...fl].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title));
  const red = fl.filter((f) => flowDot(f) === 'err').length, green = fl.filter((f) => flowDot(f) === 'ok').length, never = fl.length - red - green;
  // the state in one sentence: what is up, how the last run went, what the changes touch
  const pulse = [
    ready.length ? `${ready.map((e) => e.env).join(', ')} ${ready.length === 1 ? 'está' : 'están'} en marcha` : d.envs.length ? 'Ningún entorno está en marcha' : 'Todavía no hay entornos',
    last ? `el último run (#${last.id}) ${last.status === 'passed' ? 'salió bien' : 'falló'} ${ago(last.startedAt)}` : 'todavía no ha corrido nada',
    affected.length ? `tus cambios tocan ${plural(affected.length, 'flujo', 'flujos')}` : d.impact ? 'tus cambios no tocan ningún flujo' : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="page wide ov">
      <header className="ov-hero">
        <div>
          <h1>{title ?? 'Resumen'}</h1>
          <p className="ov-pulse">{pulse}.</p>
        </div>
        <div className="actions">
          {runEnv && <ActionButton icon={AppWindow} run={() => openStudio(runEnv)} title="Usa la aplicación con su traza al lado: la arquitectura, cada mensaje y su línea de tiempo">Abrir {runEnv} en el estudio</ActionButton>}
          {affected.length > 0 && (
            <ActionButton icon={Play} primary disabled={!runEnv} title={runEnv ? undefined : 'Levanta un entorno para ejecutar flujos'}
              run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { env: runEnv, flows: affected, confirm } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')}>
              Ejecutar {plural(affected.length, 'flujo afectado', 'flujos afectados')}
            </ActionButton>
          )}
        </div>
      </header>

      <section aria-labelledby="ov-envs" className="ov-block">
        <h2 id="ov-envs" className="ov-h"><Container />Entornos<span className="faint">{d.envs.length ? `${ready.length} de ${d.envs.length} en marcha${notReady ? `; ${notReady}` : ''}` : ''}</span><a className="more" href={href('envs')}>Servicios y entornos</a></h2>
        {d.envs.length ? (
          <div className="ov-envs">
            {d.envs.map((e) => {
              const on = e.state === 'ready';
              return (
                <div key={e.env} className={`ov-env${on ? ' on' : ''}`}>
                  <div className="ov-env-h"><Dot state={ENV_DOT[e.state] ?? 'idle'} /><a className="rowlink mono" href={href('envs', e.env)}>{e.env}</a><span className="faint">{ENV_STATE[e.state] ?? e.state}</span></div>
                  <div className="ov-health" role="img" aria-label={`${e.healthy} de ${e.services} servicios sanos`}>
                    {Array.from({ length: e.services }, (_, i) => <i key={i} className={i < e.healthy ? 'ok' : on ? 'bad' : ''} />)}
                  </div>
                  <div className="ov-env-f faint">
                    <span>{e.services ? `${e.healthy} de ${plural(e.services, 'servicio', 'servicios')} sanos` : 'sin servicios'}</span>
                    <span>{e.source ? <span className="mono">{e.source}</span> : null}{e.lastReadyAt ? ` · ${ago(e.lastReadyAt)}` : ''}</span>
                  </div>
                  {on && <ActionButton icon={AppWindow} sm run={() => openStudio(e.env)}>Estudio</ActionButton>}
                </div>
              );
            })}
          </div>
        ) : <div className="panel"><div className="empty">Todavía no hay entornos. Crea el primero en <a className="rowlink" href={href('envs')}>Servicios y entornos</a> o con <code>laru env init local --from &lt;repo&gt;:&lt;compose&gt;</code>.</div></div>}
      </section>

      <section aria-labelledby="ov-flows" className="ov-block">
        <h2 id="ov-flows" className="ov-h"><Route />Flujos<span className="faint">{fl.length ? [red && plural(red, 'falla', 'fallan'), green && plural(green, 'en verde', 'en verde'), never && plural(never, 'sin ejecutar', 'sin ejecutar')].filter(Boolean).join(' · ') : ''}</span><a className="more" href={href('docs')}>Escenarios y flujos</a></h2>
        {fl.length ? (
          <div className="ov-flows">
            {tiles.map((f) => {
              const st = flowDot(f);
              return (
                <a key={f.slug} className={`ov-flow ${st}${affected.includes(f.slug) ? ' touched' : ''}`} href={pageOf(f.id)} title={affected.includes(f.slug) ? 'Tus cambios lo tocan' : undefined}>
                  <span className="ov-flow-t"><Dot state={st} />{f.title}</span>
                  <span className="ov-flow-f"><Spark history={f.history.slice(-10)} />{affected.includes(f.slug) && <span className="chip run">afectado</span>}</span>
                </a>
              );
            })}
          </div>
        ) : <div className="panel"><div className="empty">Todavía no hay flujos. Se crean desde <a className="rowlink" href={href('docs')}>Escenarios y flujos</a>.</div></div>}
      </section>

      <div className="split">
        <section className="panel" aria-labelledby="ov-runs">
          <header><h3 id="ov-runs">Últimos runs</h3><div className="meta">{d.runs.length ? `${plural(passed, 'correcto', 'correctos')}, ${plural(failed, 'con fallos', 'con fallos')}` : ''} · <a className="more" href={href('runs')}>Runs</a></div></header>
          {d.runs.length ? (
            <ul className="feed">
              {d.runs.map((r) => (
                <li key={r.id}>
                  <Dot state={RUN_DOT[r.status] ?? 'idle'} />
                  <a className="main rowlink" href={href('runs', r.id)} title={r.flows.join(', ')}>
                    <span className="mono">#{r.id}</span> {r.kind === 'session' ? r.title ?? 'Sesión en vivo' : r.flows.map((f) => titleOf.get(f) ?? f).join(', ')}
                    <span className="sr-only">, {r.phase === 'done' ? RUN_STATUS[r.status] : RUN_PHASE[r.phase]}</span>
                  </a>
                  <span className="when num">{took(r) ?? '—'}</span>
                  <span className="when">{ago(r.startedAt)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="empty">Todavía no hay runs. Ejecuta flujos desde <a className="rowlink" href={href('docs')}>Escenarios y flujos</a> o con <code>laru test</code>.</div>}
        </section>

        <div className="grid" style={{ alignContent: 'start' }}>
          <section className="panel" aria-labelledby="ov-impact">
            <header><h3 id="ov-impact">Tus cambios</h3><div className="meta">desde el último run</div></header>
            {!d.impact ? <div className="empty">No se pudo calcular: hace falta el mapa. Pulsa «Releer el código» en <a className="rowlink" href={href('repos')}>Proyectos</a>.</div> : (
              <p className="impact-sum">
                {d.impact.changes ? `${plural(d.impact.changes, 'fichero cambiado', 'ficheros cambiados')}` : 'Ningún fichero cambiado'}
                {d.impact.services.length ? <>, en {d.impact.services.map((s, i) => <span key={s.id}>{i ? ', ' : ' '}<a className="rowlink mono" href={href('map', s.id)}>{s.id.replace(/^svc:/, '')}</a></span>)}</> : null}
                {d.impact.flows.length ? `; ${plural(d.impact.flows.length, 'flujo afectado', 'flujos afectados')}, marcados arriba` : ''}.
              </p>
            )}
          </section>
          <section className="panel" aria-labelledby="ov-findings">
            <header><h3 id="ov-findings"><TriangleAlert size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Desacuerdos</h3><div className="meta">{d.findings.open} abiertos{high ? ` · ${high} graves` : ''}{d.findings.accepted ? ` · ${d.findings.accepted} aceptados` : ''}</div></header>
            {high ? (
              <ul className="feed">{d.findings.errors.map((f) => <li key={f.key}><span className={`sev ${SEVERITY[f.severity].cls}`}><i />{SEVERITY[f.severity].label}</span><span className="main" title={findingText(f)}>{findingText(f)}</span></li>)}</ul>
            ) : Object.keys(d.findings.byType).length ? (
              <div className="body ov-chips">{Object.entries(d.findings.byType).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([t, n]) => <a key={t} className="chip" href={href('docs')}>{FINDING[t] ?? t}<b className="num">{n}</b></a>)}</div>
            ) : <div className="empty">Nada abierto: el código, la documentación y los runs coinciden.</div>}
          </section>
          {d.stale.length > 0 && (
            <section className="panel" aria-labelledby="ov-stale">
              <header><h3 id="ov-stale"><History size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Por revisar</h3><div className="meta">su código anclado cambió</div></header>
              <ul className="feed">{d.stale.map((s) => <li key={s.id}><a className="main rowlink" href={pageOf(s.id)}>{s.title}</a><span className="mono faint">{s.id}</span></li>)}</ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** The overview's own shape while it loads: four numbers, then two columns of panels. */
function OverviewSkeleton() {
  const lines = (n: number) => <div className="body" style={{ display: 'grid', gap: 12 }}>{Array.from({ length: n }, (_, i) => <div key={i} className="sk" style={{ height: 14, width: `${[84, 66, 92, 58, 76][i % 5]}%` }} />)}</div>;
  return (
    <>
      <div className="stats" aria-hidden="true">{[0, 1, 2, 3].map((i) => <div key={i} className="stat"><div className="sk" style={{ height: 12, width: '60%' }} /><div className="sk" style={{ height: 26, width: 40, margin: '4px 0' }} /><div className="sk" style={{ height: 10, width: '70%' }} /></div>)}</div>
      <div className="split" aria-busy="true">
        <div className="grid" style={{ alignContent: 'start' }}><div className="panel">{lines(4)}</div><div className="panel">{lines(3)}</div></div>
        <div className="grid" style={{ alignContent: 'start' }}><div className="panel">{lines(4)}</div><div className="panel">{lines(5)}</div></div>
      </div>
      <span className="sr-only" role="status">Cargando el resumen</span>
    </>
  );
}
