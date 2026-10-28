/**
 * Environments: what runs, where to reach it and what it says. The service runs ups and downs detached, so the
 * screen follows two streams (the env's events and its masked logs) and polls the status while an operation runs.
 */
import { FidelityTable } from './Sheets.tsx';
import { openStudio } from './Live.tsx';
import { AppWindow, ArrowLeftRight, ArrowDown, CircleX, Container, Database, FlaskConical, GitBranch, Globe, Hammer, HardDrive, KeyRound, Laptop, Play, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, useApi, type Address, type Admission, type DestroyReport, type EnvDetail, type EnvEvent, type EnvSummary, type JointProposal, type RepoStatus, type ServiceStatus, type WorkspaceRow, apiUrl, type Indexed } from '../api.ts';
import { ActionButton, Code, CodeBlock, CopyButton, Dialog, Dot, Level, PathChip, Segmented, Skeleton, Status, toast, type DotState } from '../components/ui.tsx';
import { askFirst, Cancelled } from '../lib/ask.ts';
import { admissionText, BUILT, ENV_STATE, STATE_DOT, HEALTH, laruLine, MODE, PHASE, phaseNote, plural, secs, upError } from '../lib/es.ts';
import { HOME, href } from '../lib/route.ts';
import { appsOf } from '../lib/sysmap.ts';
import { MapTabs } from '../components/MapTabs.tsx';
import { EnvScope } from '../components/EnvScope.tsx';

const HEALTH_DOT: Record<ServiceStatus['health'], DotState> = {
  healthy: 'ok', running: 'ok', host: 'ok', done: 'ok', starting: 'run', waiting: 'run', unhealthy: 'err', exited: 'err', oom: 'err', absent: 'idle',
};
const FAILED = new Set(['unhealthy', 'exited', 'oom']);
const PHASES = ['snapshot', 'import', 'values', 'render', 'pull', 'build', 'ready'];
const INIT = 'laru env init local --from <repo>:<compose>';

const nf = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
const mem = (b: number) => (b < 2 ** 30 ? `${Math.round(b / 2 ** 20)} MB` : `${nf.format(b / 2 ** 30)} GB`);

function envState(e: EnvSummary): [DotState, string] {
  if (e.op && !e.op.done) return ['run', e.op.kind === 'up' ? 'Levantando' : 'Destruyendo'];
  return [STATE_DOT[e.state], ENV_STATE[e.state]];
}

export function Envs({ selected, g }: { selected?: string; g?: Indexed | null }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const list = envs.data ?? [];
  // Without one in the address, the env that is ready; kept while the screen is open, so a Destruir does not jump away.
  const auto = useRef<string>(undefined);
  const name = list.find((e) => e.env === selected)?.env ?? (auto.current ??= list.find((e) => e.state === 'ready')?.env ?? list[0]?.env);
  const [joining, setJoining] = useState(false);
  if (envs.error) return <div className="page"><div className="notice" role="alert"><CircleX />{envs.error}</div></div>;
  if (!envs.data) return <div className="page wide"><div className="envs"><Skeleton lines={3} /><Skeleton lines={6} /></div></div>;
  if (!name) return <NoEnvs />;
  // With several projects: each project's own envs, then the joint ones («Conjuntos» only when there is one).
  const several = new Set(list.flatMap((e) => e.projects ?? [])).size > 1;
  const own = list.filter((e) => !/^f-/.test(e.env)), ofFlows = list.filter((e) => /^f-/.test(e.env));
  const groups: Array<[string | null, EnvSummary[]]> = [
    ...(several ? [['Por proyecto', own.filter((e) => !e.join)], ['Conjuntos', own.filter((e) => e.join)]] as Array<[string | null, EnvSummary[]]> : [[ofFlows.length ? 'Del proyecto' : null, own] as [string | null, EnvSummary[]]]),
    ...(ofFlows.length ? [['De los flujos', ofFlows] as [string | null, EnvSummary[]]] : []),
  ];
  return (
    <div className="page wide">
      {selected && list.some((e) => e.env === selected) && <EnvScope env={selected} active="state" />}
      <MapTabs active="envs" />
      <div className="envs">
        <nav className="env-list" aria-label="Entornos">
          {groups.filter(([, es]) => es.length).map(([title, es]) => (
            <div key={title ?? 'all'} className="env-group">
              {title && <h2 className="env-group-h">{title}</h2>}
              {es.map((e) => {
                const [dot, label] = envState(e);
                return <a key={e.env} href={href('envs', e.env)} aria-current={e.env === name ? 'page' : undefined}><Dot state={dot} /><b className="mono">{e.env}</b><span>{label}{several && e.projects ? `. ${e.projects.join(' · ')}` : e.source ? `. ${e.source}` : ''}</span></a>;
              })}
            </div>
          ))}
          {several ? <button className="btn sm" onClick={() => setJoining(true)}><Plus />Nuevo entorno conjunto</button> : <p className="faint" style={{ margin: 0, fontSize: 'var(--t-12)' }}>Un entorno conjunto junta varios proyectos. <a href={href('repos')}>Añade otro proyecto</a> para crearlo.</p>}
        </nav>
        <EnvView key={name} name={name} onChange={envs.reload} g={g} />
      </div>
      {joining && <NewJoint envs={list} onClose={() => setJoining(false)} onDone={(n) => { envs.reload(); location.hash = href('envs', n).replace(/^#?/, '#'); }} />}
    </div>
  );
}

/** «Nuevo entorno conjunto»: the projects to run together, each with its env (or one to create), and what Laru proposes. */
function NewJoint({ envs, onClose, onDone }: { envs: EnvSummary[]; onClose: () => void; onDone: (name: string) => void }) {
  const repos = useApi<RepoStatus[]>('/api/repos');
  const projects = (repos.data ?? []).map((r) => r.name);
  const [name, setName] = useState('all');
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? projects;
  const [envOf, setEnvOf] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Set<string>>(new Set());
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const members = chosen.map((r) => envOf[r] ?? r);
  const prop = useApi<JointProposal>(chosen.length > 1 ? `/api/env/join-proposal?name=${encodeURIComponent(name)}&members=${encodeURIComponent(members.join(','))}` : null);
  const p = prop.data;
  const share = useMemo(() => Object.fromEntries(Object.entries(p?.share ?? {}).filter(([k]) => !off.has(k))), [p, off]);
  const yaml = p ? `join: [${p.members.map((m) => m.env).join(', ')}]\n${Object.keys(share).length ? `share: { ${Object.entries(share).map(([a, b]) => `${a}: ${b}`).join(', ')} }\n` : ''}persistent: true\n` : '';
  const own = (repo: string) => envs.filter((e) => !e.join && e.projects?.length === 1 && e.projects[0] === repo).map((e) => e.env);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!p) return;
    setBusy(true); setError('');
    try {
      await api('/api/env/create', { method: 'POST', body: { name, join: p.members.map((m) => m.env), share, create: p.members.filter((m) => m.create).map((m) => ({ env: m.env, from: m.create })) } });
      toast(`envs/${name}.yaml escrito. Levántalo con «Levantar»`);
      onDone(name); onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const repoOf = (u: string) => p?.collisions.find((c) => Object.values(c.as).includes(u)) ? Object.entries(p!.collisions.find((c) => Object.values(c.as).includes(u))!.as).find(([, v]) => v === u)?.[0] : undefined;
  return (
    <Dialog title="Nuevo entorno conjunto" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="dlg-body form">
          <label className="fld"><span className="l">Nombre</span><input className="mono" data-autofocus required value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} pattern="[a-z0-9][a-z0-9-]*" autoComplete="off" spellCheck={false} /></label>
          <fieldset className="fld"><legend className="l">Proyectos</legend>
            {projects.map((r) => {
              const m = p?.members.find((x) => x.repo === r);
              const mine = own(r);
              return (
                <div key={r} className="check" style={{ alignItems: 'center' }}>
                  <input type="checkbox" id={`j-${r}`} checked={chosen.includes(r)} onChange={(e) => setPicked(e.target.checked ? [...chosen, r] : chosen.filter((x) => x !== r))} />
                  <label htmlFor={`j-${r}`} className="mono">{r}</label>
                  {chosen.includes(r) && (m?.create ? <span className="faint">sin entorno propio: se crea <span className="mono">{m.env}</span> desde <span className="mono">{m.create}</span></span>
                    : mine.length > 1 ? <Segmented label={`Entorno de ${r}`} value={envOf[r] ?? m?.env ?? mine[0]} onChange={(v) => setEnvOf({ ...envOf, [r]: v })} options={mine.map((x) => ({ key: x, label: x }))} />
                    : <span className="faint">con su entorno <span className="mono">{m?.env ?? mine[0]}</span></span>)}
                </div>
              );
            })}
          </fieldset>
          {chosen.length < 2 ? <p className="h">Elige al menos dos proyectos.</p> : prop.error ? <p className="form-err" role="alert">{prop.error}</p> : !p ? <Skeleton lines={3} /> : <>
            {Object.keys(p.share).length > 0 && <fieldset className="fld"><legend className="l">Compartir</legend>
              {Object.entries(p.share).map(([dropped, used]) => (
                <label key={dropped} className="check"><input type="checkbox" checked={!off.has(dropped)} onChange={(e) => { const n = new Set(off); if (e.target.checked) n.delete(dropped); else n.add(dropped); setOff(n); }} />
                  <span>{repoOf(dropped) ?? dropped} usa el <span className="mono">{used}</span> de {repoOf(used) ?? 'el otro proyecto'} — consume <span className="mono">{p.shareWhy[dropped]}</span>, que publica el otro</span></label>
              ))}
            </fieldset>}
            {p.collisions.length > 0 && <div className="fld"><span className="l">Nombres</span>
              <p className="h">{p.collisions.map((c) => c.name).join(' y ')} existen en {Object.keys(p.collisions[0].as).length > 2 ? 'varios' : 'los dos'}: cada proyecto conserva el suyo dentro de su red; fuera se llaman {p.collisions.map((c) => Object.values(c.as).join(' / ')).join(' y ')}.</p></div>}
            <div className="fld"><span className="l">Cómo se hablan</span>
              {p.talks.length ? <ul className="plain">{p.talks.map((x, i) => <li key={i} className="mono" title={x.at}>{x.from.replace(/^svc:/, '')} → {x.to.replace(/^(svc|ep|ds):/, '')}{x.note ? <span className="faint"> ({x.note.replace(/,? ?across projects/, '')})</span> : null}</li>)}</ul> : <p className="h">El mapa no ve llamadas entre estos proyectos.</p>}
            </div>
            <div className="fld"><span className="l">envs/{name}.yaml</span><CodeBlock text={yaml} lang="text" className="yaml" label={`envs/${name}.yaml`} /></div>
          </>}
          {error && <p className="form-err" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !p || chosen.length < 2}>Crear entorno</button>
        </footer>
      </form>
    </Dialog>
  );
}

const NoEnvs = () => (
  <div className="page">
    <div className="head"><div><h1>Entornos</h1><p>Producción en local a partir del compose de cada proyecto: las mismas imágenes, direcciones estables y datos que se pueden tirar.</p></div></div>
    <section className="panel">
      <div className="empty">
        <span>Todavía no hay entornos. Crea el primero a partir del compose de un proyecto:</span>
        <span className="cmd"><code>{INIT}</code><CopyButton value={INIT} label="Copiar el comando" /></span>
        <span>Después levántalo aquí con «Levantar» o con <code>laru up local</code>.</span>
      </div>
    </section>
  </div>
);

/** The events of the env's last up. The service replays the file from the start on every connection. */
function useEnvEvents(env: string) {
  const [events, set] = useState<EnvEvent[]>([]);
  useEffect(() => {
    const es = new EventSource(apiUrl(`/api/env/events?env=${encodeURIComponent(env)}`));
    es.onopen = () => set([]);
    es.onmessage = (m) => {
      let e: EnvEvent;
      try { e = JSON.parse(m.data) as EnvEvent; } catch { return; }
      set((l) => (e.kind === 'phase' && e.phase === 'snapshot' ? [e] : [...l, e]));
    };
    return () => es.close();
  }, [env]);
  return [events, () => set([])] as const;
}

function EnvView({ name, onChange, g }: { name: string; onChange: () => void; g?: Indexed | null }) {
  const detail = useApi<EnvDetail>(`/api/env?env=${encodeURIComponent(name)}`);
  const [events, clearEvents] = useEnvEvents(name);
  const [destroying, setDestroying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const opened = useRef(Date.now());
  const d = detail.data;
  const busy = Boolean(d?.op && !d.op.done);
  const { reload } = detail;

  // An operation is polled every 2 s until it settles; otherwise CPU and memory refresh every 15 s.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && reload(), busy ? 2000 : 15_000);
    return () => clearInterval(t);
  }, [busy, reload]);
  const wasBusy = useRef(busy);
  useEffect(() => { if (wasBusy.current && !busy) onChange(); wasBusy.current = busy; }, [busy, onChange]);
  // A service changing state is worth a fresh status, once the burst settles.
  const last = events.at(-1);
  useEffect(() => {
    if (!last || last.t < opened.current || last.kind === 'log') return;
    const t = setTimeout(reload, 800);
    return () => clearTimeout(t);
  }, [last, reload]);

  if (detail.error) return <div className="notice" role="alert"><CircleX />{detail.error}</div>;
  if (!d) return <div style={{ minWidth: 0 }}><Skeleton lines={2} /><div style={{ height: 16 }} /><Skeleton lines={6} /></div>;

  const terminal = events.findLast((e) => e.kind === 'ready' || e.kind === 'error');
  const failure = terminal?.kind === 'error' ? terminal : null;
  const upRunning = d.op ? d.op.kind === 'up' && !d.op.done : Boolean(last && !terminal && Date.now() - last.t < 10 * 60_000);
  const [dot, label]: [DotState, string] = upRunning ? ['run', 'Levantando'] : envState(d);
  const from = d.spec?.from;
  // An up started from the CLI shows only through its events: it blocks the buttons all the same.
  const blocked = busy || upRunning;
  const ready = d.state === 'ready' && !blocked;

  const startUp = async (worktree = false) => {
    clearEvents();
    await api('/api/env/up', { method: 'POST', body: { env: name, worktree } });
    reload();
    onChange();
  };

  return (
    <div style={{ minWidth: 0 }}>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <div className="status env-state"><Dot state={dot} />{label}{d.spec ? (d.spec.persistent ? ', persistente' : ', efímero') : ''}</div>
          <h1 className="mono env-name">{name}</h1>
          <p>
            {from ? <>Compose de <span className="mono">{from.repo}:{from.path}</span></> : d.spec?.join ? <>Conjunto de <span className="mono">{d.spec.join.join(' + ')}</span>{Object.keys(d.spec.share).length ? <>; {Object.entries(d.spec.share).map(([a, b]) => `${a} usa ${b}`).join(', ')}</> : null}</> : 'Sin compose de origen'}
            {d.sources ? <> en <span className="mono">{d.sources.join(' · ')}</span></> : d.source ? <> en <span className="mono">{d.source}</span></> : null}.
            {d.subnets ? <> Redes: <span className="mono">{Object.entries(d.subnets).map(([r, n]) => `${r} 172.30.${n}.0/24`).join(' · ')}</span>.</> : null}
            {terminal?.kind === 'ready' ? ` Último arranque en ${secs(terminal.ms)}.` : ''}
          </p>
          <p className="run-dir"><span className="faint">Carpeta del entorno</span> <PathChip path={d.dir} reveal={{ what: 'env', id: name }} /></p>
        </div>
        <div className="actions">
          <ActionButton icon={Play} primary disabled={blocked} run={() => startUp()} done={() => `Levantando ${name}`}>Levantar</ActionButton>
          <ActionButton icon={GitBranch} disabled={!ready} title={ready ? 'Construye desde tus copias de trabajo, también lo que no has commiteado: solo se reconstruye y se reemplaza lo que cambió' : `${name} tiene que estar listo`} run={() => startUp(true)} done={() => `Recargando ${name} desde tu copia`}>Recargar desde mi copia</ActionButton>
          <button className="btn" aria-disabled={!ready || undefined} title={ready ? 'Construye de nuevo, sin la caché de Docker, los servicios que elijas, y vuelve a crear sus contenedores' : `${name} tiene que estar listo`} onClick={() => ready && setRebuilding(true)}><Hammer />Reconstruir sin caché</button>
          <button className="btn" aria-disabled={!ready || undefined} title={ready ? undefined : `${name} tiene que estar listo`} onClick={() => ready && setResetting(true)}><RotateCcw />Resetear datos</button>
          <ActionButton icon={AppWindow} disabled={!ready} title={ready ? 'Usa la aplicación en el estudio: tu navegador, la arquitectura, cada mensaje y su línea de tiempo, mientras lo haces' : `${name} tiene que estar listo`} run={() => openStudio(name)}>Abrir en el estudio</ActionButton>
          <ActionButton icon={FlaskConical} disabled={!ready} title={ready ? 'Ejecuta los flujos sobre este entorno, sin crear otro' : `${name} tiene que estar listo`}
            run={() => askFirst((confirm) => api<{ id: string }>('/api/runs/start', { method: 'POST', body: { env: name, confirm } }).then((r) => { location.hash = href('runs', r.id); }), 'Ejecutar')}>Probar aquí</ActionButton>
          <button className="btn danger" aria-disabled={blocked || undefined} onClick={() => !blocked && setDestroying(true)}><Trash2 />Destruir</button>
        </div>
      </div>

      {d.specError && <div className="notice" role="alert"><CircleX /><div><b>envs/{name}.yaml no es válido.</b> <span className="mono">{d.specError}</span></div></div>}
      {failure && <Failure name={name} e={failure} onForce={async () => { clearEvents(); await api('/api/env/up', { method: 'POST', body: { env: name, force: true } }); reload(); onChange(); }} />}
      {d.op?.kind === 'down' && d.op.done && d.op.error && <div className="notice" role="alert"><CircleX /><div><b>No se pudo destruir {name}.</b> {d.op.error}</div></div>}
      {(upRunning || failure) && <Progress events={events} failed={Boolean(failure)} />}

      {d.state === 'absent' && !upRunning ? (
        <section className="panel"><div className="empty">{name} todavía no se ha levantado. Pulsa «Levantar» o ejecuta <code>laru up {name}</code>.</div></section>
      ) : (
        <>
          <Addresses addresses={d.addresses} services={d.services} />
          <section className="panel block"><header><h3>Fidelidad con producción</h3><div className="meta">Solo lo que se diferencia; el detalle está en <a className="rowlink" href={href('docs')}>la infraestructura</a></div></header><FidelityTable env={name} compact /></section>
          <Services env={name} services={d.services} source={d.source} g={g} />
          <Logs env={name} services={d.services.filter((s) => s.container).map((s) => s.service)} epoch={d.services.map((s) => s.container?.id ?? '').join()} />
        </>
      )}
      {destroying && <Destroy env={name} onClose={() => setDestroying(false)} onStarted={() => { reload(); onChange(); }} />}
      {resetting && <Reset env={name} onClose={() => setResetting(false)} />}
      {rebuilding && <Rebuild env={name} services={d.services.filter((s) => s.built === 'built' || s.built === 'cached').map((s) => s.service)} onClose={() => setRebuilding(false)} onStarted={() => { clearEvents(); reload(); onChange(); }} />}
    </div>
  );
}

function Failure({ name, e, onForce }: { name: string; e: Extract<EnvEvent, { kind: 'error' }>; onForce: () => Promise<void> }) {
  if (e.admission) return <Refused name={name} a={e.admission} onForce={onForce} />;
  const { title, detail, vars } = upError(e.message, name, e.service);
  return (
    <div className="notice" role="alert">
      <CircleX />
      <div>
        <b>{title}</b>
        {vars && <> <a className="rowlink" href={href('vars', name)}>Revísalos en Variables y secretos</a>, cada uno con su arreglo.</>}
        {detail && <div className="pre-line">{detail}</div>}
        {e.logs?.length ? <><div className="faint notice-sub">Últimas líneas{e.service ? ` de ${e.service}` : ''}</div><CodeBlock className="ctx tail" text={e.logs.join('\n')} lang="log" label={`Últimas líneas${e.service ? ` de ${e.service}` : ''}`} /></> : null}
      </div>
    </div>
  );
}

/**
 * An up that was not admitted: who runs, and what to do — stop one of them (through its own workspace, with the dry run
 * first) or, for memory only, start it anyway. maxEnvs is changed on the home page («Esta máquina»).
 */
function Refused({ name, a, onForce }: { name: string; a: Admission; onForce: () => Promise<void> }) {
  const rows = useApi<WorkspaceRow[]>('/api/workspaces');
  const [stopping, setStopping] = useState<{ ws: string; env: string; label: string } | null>(null);
  const idOf = (key: string) => rows.data?.find((w) => w.key === key)?.id ?? null;
  return (
    <div className="notice" role="alert">
      <CircleX />
      <div>
        <b>No se ha levantado {name}.</b> {admissionText(a, name)}{a.kind === 'maxEnvs' && <> <a className="rowlink" href={HOME}>Ir a Esta máquina</a></>}
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {a.others.filter((o) => !/ \(run \d+\)$|^tool$/.test(o.env)).map((o) => {
            const ws = idOf(o.key);
            return ws && <button key={`${o.key}/${o.env}`} className="btn sm danger" onClick={() => setStopping({ ws, env: o.env, label: `${o.app}/${o.env}` })}><Square />Detener {o.app}/{o.env}</button>;
          })}
          {a.kind === 'memory' && <ActionButton icon={Play} sm run={onForce} done={() => `Levantando ${name}`}>Levantar igualmente</ActionButton>}
        </div>
      </div>
      {stopping && <Destroy env={stopping.env} ws={stopping.ws} label={stopping.label} onClose={() => setStopping(null)} onStarted={() => toast(`Cuando ${stopping.label} se detenga, pulsa «Levantar»`)} />}
    </div>
  );
}

/** The build's own lines as they come, following the end unless the person scrolled up. */
function BuildLog({ lines }: { lines: Array<{ source: string; line: string }> }) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [lines.length]);
  return (
    <details className="buildlog" open>
      <summary>Registro de la construcción <span className="faint num">{plural(lines.length, 'línea', 'líneas')}</span></summary>
      <pre ref={box} className="mono" tabIndex={0} aria-label="Registro de la construcción" onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24; }}>{lines.map((l) => (l.source === 'laru' ? laruLine(l.line) : l.line)).join('\n')}</pre>
    </details>
  );
}

function Progress({ events, failed }: { events: EnvEvent[]; failed: boolean }) {
  const done = new Map<string, Extract<EnvEvent, { kind: 'phase' }>>();
  const trail = new Map<string, Array<Extract<EnvEvent, { kind: 'service' }>>>();
  for (const e of events) {
    if (e.kind === 'phase') done.set(e.phase, e);
    if (e.kind === 'service') (trail.get(e.service) ?? trail.set(e.service, []).get(e.service)!).push(e);
  }
  const current = PHASES.find((p) => !done.has(p));
  const start = events[0]?.t ?? 0;
  const log = events.findLast((e) => e.kind === 'log');
  const building = events.filter((e): e is Extract<EnvEvent, { kind: 'log' }> => e.kind === 'log' && ['build', 'pull', 'laru'].includes(e.source)).slice(-120);
  return (
    <section className="panel block" aria-labelledby="progress-h">
      <header><h3 id="progress-h">Progreso</h3><div className="meta" aria-live="polite">{failed ? 'Se detuvo con un error' : current ? `${PHASE[current]}…` : 'Terminando'}</div></header>
      <div className="progress">
        <ol className="phase-list">
          {PHASES.map((p) => {
            const e = done.get(p);
            const state: DotState = e ? 'ok' : p === current ? (failed ? 'err' : 'run') : 'idle';
            return <li key={p}><Dot state={state} /><span className={e || p === current ? undefined : 'faint'}>{PHASE[p]}</span><span className="note">{phaseNote(e?.note)}</span><span className="num faint">{e ? secs(e.ms) : ''}</span></li>;
          })}
        </ol>
        <ul className="svc-trail" aria-label="Servicios">
          {[...trail].map(([s, t]) => (
            <li key={s}>
              <Status state={HEALTH_DOT[t.at(-1)!.health]}>{s}</Status>
              <span className="trail">{t.map((x) => `${HEALTH[x.health]} ${secs(x.t - start)}`).join(' → ')}</span>
            </li>
          ))}
          {!trail.size && <li className="faint">Los servicios aparecen al arrancar sus contenedores.</li>}
        </ul>
      </div>
      {building.length > 0 && <BuildLog lines={building} />}
      {log?.kind === 'log' && <div className="lastlog mono" title={log.line}><span className="faint">{log.source}</span> {log.source === 'laru' ? laruLine(log.line) : log.line}</div>}
    </section>
  );
}

const ADDR_ICON = { http: Globe, tcp: ArrowLeftRight, store: Database };

function Addresses({ addresses, services }: { addresses: Address[]; services: ServiceStatus[] }) {
  const of = (svc: string) => services.find((s) => s.service === svc);
  const what = (a: Address) => {
    const s = of(a.service);
    if (a.kind === 'http') return s?.mode === 'host' ? 'HTTP, en tu máquina' : 'HTTP por la entrada';
    const image = s?.built === 'image' || !s?.built ? s?.image : undefined;
    return `${a.kind === 'tcp' ? 'TCP' : 'Almacén'}${image ? `, ${image}` : ''}`;
  };
  return (
    <section className="panel block clip">
      <header><h3>Direcciones</h3><div className="meta">Estables entre arranques</div></header>
      {addresses.length ? (
        <div className="urls">
          {addresses.map((a) => {
            const Icon = ADDR_ICON[a.kind];
            return (
              <div className="url" key={a.url}>
                <span className="h"><Icon />{a.service}</span>
                <span className="u">
                  {a.kind === 'http'
                    ? <a href={a.url} target="_blank" rel="noreferrer"><code>{a.url.replace(/^http:\/\//, '')}</code><span className="sr-only"> (se abre en otra pestaña)</span></a>
                    : <code>{a.url}</code>}
                  <CopyButton value={a.url} label={`Copiar la dirección de ${a.service}`} />
                </span>
                <span className="s">{what(a)}</span>
              </div>
            );
          })}
        </div>
      ) : <div className="empty">Sin direcciones: aparecen cuando el entorno arranca.</div>}
    </section>
  );
}

function Services({ env, services, source, g }: { env: string; services: ServiceStatus[]; source?: string; g?: Indexed | null }) {
  // with several applications in the workspace, which one each service belongs to (a store or an external: by who uses it)
  const apps = g ? appsOf(g) : undefined;
  const appOf = (svc: string) => ['svc', 'ds', 'ext'].map((p) => apps?.get(`${p}:${svc}`)).find(Boolean);
  return (
    <section className="panel block">
      <header><h3>Servicios</h3><div className="meta">Construido y sano se miden por separado</div></header>
      <div className="scroll-x">
        <table className="t">
          <thead><tr><th>Servicio</th>{apps && <th>Aplicativo</th>}<th>Origen</th><th>Construido</th><th>Sano</th><th>Modo</th><th className="r">CPU y memoria</th></tr></thead>
          <tbody>
            {services.map((s) => {
              const fromRepo = s.mode === 'host' || s.built === 'cached' || s.built === 'built';
              const probe = FAILED.has(s.health) ? s.note?.trim().split('\n').pop() : undefined;
              return (
                <tr key={s.compose}>
                  <td style={{ fontWeight: 500 }}>{s.service}</td>
                  {apps && <td>{appOf(s.service) ?? <span className="faint">—</span>}</td>}
                  <td className="mono">{fromRepo ? <>{source ?? '—'} <span className="faint">build</span></> : s.image ?? <span className="faint">—</span>}</td>
                  <td>{s.built ? BUILT[s.built] : <span className="faint">—</span>}</td>
                  <td className="wrap" style={{ minWidth: 150 }}>
                    <Status state={HEALTH_DOT[s.health]}>{s.health === 'exited' && s.container ? `${HEALTH.exited} (código ${s.container.exitCode})` : HEALTH[s.health]}</Status>
                    {probe && <div className="probe mono" title={s.note}>{probe}</div>}
                    {s.mode === 'host' && s.health === 'waiting' && <div className="probe mono">laru run --env {env} --service {s.service} -- …</div>}
                  </td>
                  <td>{s.mode === 'host' ? <span className="chip accent"><Laptop />En tu máquina</span> : <span className="faint">{MODE[s.mode]}</span>}</td>
                  <td className="r num">{s.mode === 'host' ? <span className="faint">En tu máquina</span> : s.memBytes ? `${nf.format(s.cpu ?? 0)} %, ${mem(s.memBytes)}` : <span className="faint">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface Line { id: number; service: string; at: string; time: string; text: string; lv: '' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' }
const KEEP = 500;
const LEVEL_OF = (t: string): Line['lv'] => (/\b(ERROR|FATAL|SEVERE)\b|level[=":]+(error|fatal)/.test(t) ? 'ERROR' : /\bWARN(ING)?\b|level[=":]+warn/.test(t) ? 'WARN' : /\bINFO\b|level[=":]+info/.test(t) ? 'INFO' : /\bDEBUG\b|level[=":]+debug/.test(t) ? 'DEBUG' : '');

/** Docker prefixes each line with an RFC 3339 time whose fraction drops trailing zeros: padded, it sorts as text. */
function parseLine(id: number, service: string, line: string): Line {
  const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z /);
  if (!m) return { id, service, at: '', time: '', text: line, lv: LEVEL_OF(line) };
  const frac = (m[2] ?? '').padEnd(9, '0');
  const text = line.slice(m[0].length);
  return { id, service, at: `${m[1]}.${frac}`, time: `${new Date(`${m[1]}Z`).toTimeString().slice(0, 8)}.${frac.slice(0, 3)}`, text, lv: LEVEL_OF(text) };
}

/** `epoch` names the containers: `docker logs -f` ends with its container, so a recreated one needs a new stream. */
function Logs({ env, services, epoch }: { env: string; services: string[]; epoch: string }) {
  const [filter, setFilter] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setError('');
    let pending: Line[] = [], n = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      setLines((l) => [...l, ...batch].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-KEEP));
    };
    const q = new URLSearchParams({ env, tail: filter ? String(KEEP) : '60', ...(filter ? { service: filter } : {}) });
    const es = new EventSource(apiUrl(`/api/env/logs?${q}`));
    es.onmessage = (m) => {
      const { service, line } = JSON.parse(m.data) as { service: string; line: string };
      pending.push(parseLine(n++, service, line));
      timer ??= setTimeout(flush, 150);
    };
    es.addEventListener('error', (m) => { if (m instanceof MessageEvent) setError(JSON.parse(m.data)); });
    return () => { es.close(); clearTimeout(timer); };
  }, [env, filter, epoch]);

  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  return (
    <section className="panel" aria-labelledby="logs-h">
      <header>
        <h3 id="logs-h">Registro</h3>
        <div className="meta">
          {!follow && <button className="btn sm" onClick={() => { setFollow(true); box.current?.focus(); }}><ArrowDown />Ir al final</button>}
          <span className="num">{plural(lines.length, 'línea', 'líneas')}{lines.length >= KEEP ? ', las últimas' : ''}</span>
        </div>
      </header>
      <div className="toolbar">
        <Segmented className="seg log-filter" label="Servicio" value={filter} onChange={setFilter} options={['', ...services].map((s) => ({ key: s, label: s || 'Todos' }))} />
      </div>
      {error && <div className="notice warn" style={{ margin: 12 }}>{error}</div>}
      <div className="logs" ref={box} role="log" aria-live="polite" aria-label={`Registro de ${filter || env}`} tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }}>
        {lines.map((l) => (
          <div key={l.id}>
            <span className="ts num">{l.time}</span><span className="sv">{l.service}</span>
            <Level lv={l.lv} /><span className="msg"><Code text={l.text} lang="log" /></span>
          </div>
        ))}
        {!lines.length && !error && <p className="faint logs-empty">Sin líneas todavía.</p>}
      </div>
    </section>
  );
}

/** «Destruir» with its dry run first. `ws`: an env of another workspace (the home page, an admission refusal). */
export function Destroy({ env, ws, label = env, onClose, onStarted }: { env: string; ws?: string; label?: string; onClose: () => void; onStarted: () => void }) {
  const [report, setReport] = useState<DestroyReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const url = ws ? `/api/w/${encodeURIComponent(ws)}/env/down` : '/api/env/down';
  useEffect(() => {
    api<DestroyReport>(url, { method: 'POST', body: { env, dryRun: true } }).then(setReport, (e: Error) => setError(e.message));
  }, [env, url]);
  const nothing = report && !report.containers && !report.networks && !report.volumes;
  const confirm = async () => {
    setBusy(true);
    try {
      await api(url, { method: 'POST', body: { env } });
      toast(`Destruyendo ${label}`);
      onStarted();
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={`Destruir ${label}`} onClose={onClose}>
      <div className="dlg-body" aria-live="polite">
        {error ? <p className="form-err" role="alert">{error}</p>
          : !report ? <><div className="sk" style={{ height: 14, width: '86%' }} /><span className="sr-only">Contando lo que se borrará…</span></>
          : nothing ? <p>No queda nada con las etiquetas de {label}: no hay qué borrar.</p>
          : <p>Se borrarán por etiqueta {plural(report.containers, 'contenedor', 'contenedores')}, {plural(report.networks, 'red', 'redes')} y {plural(report.volumes, 'volumen', 'volúmenes')}; las cachés se conservan.</p>}
        <p className="faint">Solo se toca lo que lleva las etiquetas de este entorno. El código, el vault y los demás contenedores de la máquina no cambian.</p>
      </div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={onClose}>Cancelar</button>
        <button type="button" className="btn destroy" disabled={!report || Boolean(nothing) || busy} onClick={confirm}><Trash2 />Destruir</button>
      </footer>
    </Dialog>
  );
}

/** Every Postgres of the env back to its «base» snapshot. The services reconnect through their pools. */
/** «Reconstruir sin caché»: which services are built again from their code with no Docker cache, and their containers replaced. */
function Rebuild({ env, services, onClose, onStarted }: { env: string; services: string[]; onClose: () => void; onStarted: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (s: string) => setPicked((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));
  const go = async () => {
    if (busy || !picked.length) return;
    setBusy(true); setError('');
    try {
      // on a persistent env that is running the service asks first, with what it will do
      await askFirst((confirm) => api('/api/env/up', { method: 'POST', body: { env, rebuild: picked, confirm } }), 'Reconstruir', `Reconstruir ${picked.join(', ')} sin caché`);
      toast(`Reconstruyendo ${picked.join(', ')} sin caché`);
      onStarted(); onClose();
    } catch (e) { if (!(e instanceof Cancelled)) setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={`Reconstruir sin caché en ${env}`} onClose={onClose}>
      <div className="dlg-body">
        <p>Elige los servicios que se construyen de nuevo desde su código, sin usar la caché de Docker. Solo se vuelven a crear sus contenedores; los datos de las bases se conservan.</p>
        {!services.length ? <p className="faint">{env} no tiene servicios que se construyan del código.</p> : (
          <fieldset className="pick-list"><legend className="sr-only">Servicios</legend>
            <label><input type="checkbox" checked={picked.length === services.length} onChange={() => setPicked(picked.length === services.length ? [] : [...services])} /> <b>Todos</b></label>
            {services.map((s) => <label key={s}><input type="checkbox" checked={picked.includes(s)} onChange={() => toggle(s)} /> <span className="mono">{s}</span></label>)}
          </fieldset>
        )}
        {error && <p className="form-err" role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" aria-disabled={!picked.length || busy || undefined} onClick={go}><Hammer className={busy ? 'spin' : undefined} />Reconstruir{picked.length ? ` ${picked.length}` : ''}</button>
      </footer>
    </Dialog>
  );
}

function Reset({ env, onClose }: { env: string; onClose: () => void }) {
  const [stores, setStores] = useState<Array<{ service: string; kind: string; db: string }> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Array<{ service: string; kind: string; db: string }>>(`/api/db/stores?env=${encodeURIComponent(env)}`).then((l) => setStores(l.filter((s) => s.kind === 'postgres')), (e: Error) => setError(e.message));
  }, [env]);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<Array<{ service: string; ms: number }>>('/api/env/reset', { method: 'POST', body: { env } });
      toast(r.length ? `Datos de ${env} devueltos a «base» en ${secs(Math.max(...r.map((x) => x.ms)))}` : 'No había nada que resetear');
      onClose();
    } catch (e) {
      const m = (e as Error).message.match(/^(\S+) has no snapshot yet/);
      setError(m ? `${m[1]} todavía no tiene instantánea «base». Tómala con laru snapshot ${env} y vuelve a intentarlo.` : (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Resetear los datos de ${env}`} onClose={onClose}>
      <div className="dlg-body" aria-live="polite">
        {!stores && !error ? <><div className="sk" style={{ height: 14, width: '80%' }} /><span className="sr-only">Buscando las bases del entorno…</span></>
          : stores && !stores.length ? <p>{env} no tiene ninguna base Postgres en marcha: no hay qué resetear.</p>
          : stores ? <p>Vuelven a la instantánea «base» {stores.map((s) => `${s.service} (${s.db})`).join(', ')}. Todo lo escrito desde entonces se pierde; los servicios se reconectan solos.</p> : null}
        {error && <p className="form-err" role="alert">{error}</p>}
        <p className="faint">MinIO y los offsets de Kafka no se resetean: cada flujo se aísla con un sufijo propio.</p>
      </div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={onClose}>Cancelar</button>
        <button type="button" className="btn destroy" aria-disabled={!stores?.length || busy || undefined} onClick={() => stores?.length && confirm()}><RotateCcw className={busy ? 'spin' : undefined} />Resetear datos</button>
      </footer>
    </Dialog>
  );
}
