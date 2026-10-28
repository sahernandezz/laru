/**
 * The parts of a sheet that depend on its class: the application's tabs (lifecycle, modules, how it is built, governance,
 * projects and environments), a flow's start and its computed lists, and what a scenario holds. Each part says where it
 * comes from (declared, extracted, observed, calculated) and nothing here is a number typed by hand.
 */
import { ArrowLeftRight, Container, Database, HardDrive, KeyRound, Monitor, Play, Plus, Radio, Server, Smartphone, Trash2, Workflow, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { FIDELITY_WORDS } from '../lib/fidelity.ts';
import { api, useApi, type FlowEnvData, type Fidelity, type DerivedInfo, type DocPiece, type EnvSummary, type FlowInfo, type Indexed, type KnowledgeData, type LiveData, type ScenariosData, type VarsData } from '../api.ts';
import { ActionButton, Dot, Origin, Skeleton, Status, type DotState } from '../components/ui.tsx';
import { DiagramViewer } from '../components/Viewer.tsx';
import { ServiceEnvMap } from '../components/EnvMap.tsx';
import { askFirst } from '../lib/ask.ts';
import { admissionText, plural, pieceLabel, piecesLabel, PLATFORM, reasonText, STACK, STAGE, STATUS } from '../lib/es.ts';
import { frontNodes } from '../lib/fronts.ts';
import { href, pageOf } from '../lib/route.ts';
import { NoteChip, noteLevel, PieceFields } from './Docs.tsx';
import { iconOf } from '../lib/pieceMenu.tsx';
import { flowDot, lastWord } from './Flows.tsx';
import { Session, Start, type Preset } from './Live.tsx';

/**
 * The application's first page: what it is (purpose, users, scope), how it is doing (flows, environments, what the
 * documentation still owes), the flows that need a look, where each service runs, and its modules. In that order: from
 * understanding it, to its state, to the parts.
 */
export function AppSummary({ k, p, g, flows, envs }: { k: KnowledgeData; p: DocPiece; g: Indexed | null; flows?: FlowInfo[]; envs?: EnvSummary[] }) {
  const runnable = (flows ?? []).filter((f) => f.exists);
  const failing = runnable.filter((f) => flowDot(f) === 'err'), passing = runnable.filter((f) => flowDot(f) === 'ok'), idle = runnable.filter((f) => flowDot(f) === 'idle');
  const attention = [...failing, ...idle, ...(flows ?? []).filter((f) => !f.exists)].slice(0, 6);
  const ready = (envs ?? []).filter((e) => e.state === 'ready');
  const owed = (p.sheet?.owed.length ?? 0);
  return (
    <>
      <PieceFields k={k} p={p} only={['purpose', 'users', 'scope', 'out-of-scope']} empty="Todavía no se ha escrito qué es este aplicativo." />
      <h2 className="section-h" style={{ marginTop: 24 }}>Cómo va</h2>
      <div className="stats">
        <a className="stat" href={href('docs', p.id, 't', 'flows')}><span className="k"><Workflow />Flujos que pasan</span><span className="v">{passing.length}<span className="faint"> / {flows?.length ?? '…'}</span></span><span className="s">{failing.length ? `${plural(failing.length, 'falla', 'fallan')}` : idle.length ? `${plural(idle.length, 'sin ejecutar', 'sin ejecutar')}` : 'sin fallos'}</span></a>
        <a className="stat" href={href('envs')}><span className="k"><Container />Entornos listos</span><span className="v">{ready.length}<span className="faint"> / {envs?.length ?? '…'}</span></span><span className="s">{ready.length ? ready.map((e) => e.env).join(', ') : 'ninguno levantado'}</span></a>
        <a className="stat" href={href('docs', p.id, 't', 'owed')}><span className="k"><Dot state={owed ? 'run' : 'ok'} />Documentación</span><span className="v">{owed}</span><span className="s">{owed ? `${plural(owed, 'cosa por completar', 'cosas por completar')}` : 'al día'}</span></a>
        <a className="stat" href={href('map')}><span className="k"><Server />Servicios</span><span className="v">{g?.map.nodes.filter((n) => n.type === 'service').length ?? '—'}</span><span className="s">{g ? `${g.map.repos.length} proyectos leídos` : 'sin leer el código'}</span></a>
      </div>
      {attention.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}><header><h3>Flujos que piden una mirada</h3><div className="meta"><a className="rowlink" href={href('docs', p.id, 't', 'flows')}>Todos los flujos ›</a></div></header>
          <ul className="feed">{attention.map((f) => {
            const [dot, word] = lastWord(f);
            return <li key={f.slug}><Dot state={dot} /><a className="main rowlink" href={pageOf(f.id)}>{f.title}</a><span className="faint">{word}</span>
              {f.exists && <a className="btn sm" href={href('docs', f.id, 't', 'live')}><Radio />Probar en vivo</a>}</li>;
          })}</ul></section>
      )}
      <h2 className="section-h" style={{ marginTop: 24 }}>Dónde corre cada servicio</h2>
      <section className="panel"><header><h3>Servicios por entorno</h3><div className="meta"><Origin of="observed" /> · <a className="rowlink" href={href('envs')}>Entornos ›</a></div></header><ServiceEnvMap g={g} envs={envs} limit={12} /></section>
      <h2 className="section-h" style={{ marginTop: 24 }}>Módulos</h2>
      <ModuleCards k={k} p={p} />
    </>
  );
}

/** The modules as cards, each with its note (the smaller of its two) and how many flows it has. */
export function ModuleCards({ k, p }: { k: KnowledgeData; p: DocPiece }) {
  const mods = k.pieces.filter((x) => x.parent === p.id && x.type === 'module');
  if (!mods.length) return <section className="panel"><div className="empty">Todavía no hay módulos. <a className="rowlink" href={href('docs', 'new', 'module', p.id)}>Crear el primero</a></div></section>;
  const nested = (id: string): DocPiece[] => k.pieces.filter((x) => x.parent === id && x.type === 'module').flatMap((m) => [m, ...nested(m.id)]);
  return (
    <div className="cards">{mods.map((m) => {
      const I = iconOf(m), subs = nested(m.id);
      return (
        <a key={m.id} className="card" href={pageOf(m.id)}>
          <span className="card-h"><I />{m.title}</span>
          <span className="card-s">{m.summary}</span>
          <span className="card-f"><NoteChip note={m.note} shown={m.sheet?.shown} />{subs.length > 0 && <span className="faint">{plural(subs.length, 'submódulo', 'submódulos')}</span>}</span>
        </a>
      );
    })}</div>
  );
}

/**
 * «Clientes»: what a person uses, each recognised in the code (a web app, a mobile one, several of either in one project) with the
 * backs it calls and the environments that serve it. «Probar en vivo» lets the person pick any of them; a native app has no
 * address to open, so it is mapped by what it calls.
 */
export function FrontCards({ g, envs }: { g: Indexed | null; envs?: EnvSummary[] }) {
  const fronts = g ? frontNodes(g) : [];
  if (!fronts.length) return <section className="panel"><div className="empty">No se reconoce ningún cliente (web o móvil) en el código. <a className="rowlink" href={href('repos')}>Proyectos</a></div></section>;
  return (
    <div className="cards">{fronts.map((f) => {
      const I = f.kind === 'mobile' ? Smartphone : Monitor;
      const where = (envs ?? []).filter((e) => e.addresses.some((a) => a.service === f.name && a.kind === 'http'));
      return (
        <div key={f.id} className="card">
          <span className="card-h"><I /><a className="rowlink" href={href('map', f.id)}>{f.name}</a></span>
          <span className="card-s">{f.kind === 'mobile' ? `App móvil${f.platform ? `, ${PLATFORM[f.platform] ?? f.platform}` : ''}` : 'Web'}{f.stack ? ` · ${STACK[f.stack] ?? f.stack}` : ''}{f.repo ? ` · ${f.repo}${f.dir && f.dir !== '.' ? `/${f.dir}` : ''}` : ''}</span>
          <span className="card-s">{f.backends.length ? <>Llama a {f.backends.map((b, i) => <span key={b.id}>{i ? ', ' : ''}<a className="rowlink" href={href('map', b.id)}>{b.name}</a> <span className="faint">({plural(b.endpoints, 'endpoint', 'endpoints')})</span></span>)}</> : 'No se le ha visto llamar a ningún servicio.'}</span>
          <span className="card-f">{where.length
            ? where.map((e) => <a key={e.env} className="chip" href={href('live')} title={e.state === 'ready' ? `Probar en vivo en ${e.env}` : `${e.env} está parado`}><Dot state={e.state === 'ready' ? 'ok' : 'idle'} />{e.env}</a>)
            : <span className="faint">{f.kind === 'mobile' ? 'Sin dirección web: se mapea por lo que llama, no se abre en vivo.' : 'Ningún entorno lo sirve todavía.'}</span>}</span>
        </div>
      );
    })}</div>
  );
}

/** For each kind of piece the application is built from: what exists, or a way to create it. */
export function PieceKinds({ k, p, types, title, origin }: { k: KnowledgeData; p: DocPiece; types: string[]; title: string; origin?: 'declared' | 'derived' }) {
  const byId = new Map(k.pieces.map((x) => [x.id, x]));
  const under = (x: DocPiece): boolean => { for (let c = byId.get(x.parent ?? ''); c; c = byId.get(c.parent ?? '')) if (c.id === p.id) return true; return false; };
  const all = (t: string) => k.pieces.filter((x) => x.type === t && under(x));
  // a kind with nothing in it is not shown (what a piece still owes is in «Lo que debe»; «Añadir» creates one)
  const present = types.filter((t) => all(t).length);
  if (!present.length) return null;
  return (
    <section className="panel"><header><h3>{title}</h3><div className="meta"><Origin of={origin ?? 'declared'} /></div></header>
      <div className="body kinds">{present.map((t) => {
        const I = iconOf({ type: t }), list = all(t);
        return (
          <div key={t} className="kinds-box"><div className="kinds-h"><I /><b>{piecesLabel(t)}</b>{!list.length && k.shapes[t as keyof typeof k.shapes]?.livesIn.includes('application') && <a className="btn sm" href={href('docs', 'new', t, p.id)}><Plus />Crear</a>}</div>
            {list.length ? <ul>{list.map((x) => <li key={x.id}><a className="rowlink" href={pageOf(x.id)}>{x.title}</a> <span className="faint">{STATUS[x.status] ?? x.status}</span> <NoteChip note={x.note} /></li>)}</ul> : <p className="faint">Falta {pieceLabel(t).toLowerCase()}.</p>}
          </div>
        );
      })}</div></section>
  );
}

/** Projects (repos and folders) and the environments they run in, with the scenarios. */
export function ProjectsEnvs({ k, g, envs }: { k: KnowledgeData; g: Indexed | null; envs?: EnvSummary[] }) {
  const scn = k.pieces.filter((x) => x.type === 'scenario');
  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}><header><h3>Servicios por entorno</h3><div className="meta"><Origin of="observed" /> · <a className="rowlink" href={href('envs')}>Entornos ›</a></div></header><ServiceEnvMap g={g} envs={envs} /></section>
      <section className="panel"><header><h3>Proyectos</h3><div className="meta"><Origin of="extracted" /></div></header>
        {g?.map.repos.length ? <div className="body scroll-x"><table className="t"><thead><tr><th>Proyecto</th><th>Rama</th><th>Commit</th></tr></thead><tbody>
          {g.map.repos.map((r) => <tr key={r.name}><td><a className="rowlink" href={`#/repos/${r.name}`}>{r.name}</a></td><td className="mono">{r.ref}</td><td className="mono">{r.commit.slice(0, 7)}</td></tr>)}
        </tbody></table></div> : <div className="empty">Sin mapa todavía. <a className="rowlink" href={href('repos')}>Proyectos</a></div>}
      </section>
      <section className="panel" style={{ marginTop: 16 }}><header><h3>Entornos</h3><div className="meta"><Origin of="observed" /> · <a className="rowlink" href={href('envs')}>Entornos ›</a></div></header>
        {envs?.length ? <div className="body scroll-x"><table className="t"><thead><tr><th>Entorno</th><th>Estado</th><th>Servicios</th></tr></thead><tbody>
          {envs.map((e) => <tr key={e.env}><td><a className="rowlink" href={href('envs', e.env)}>{e.env}</a></td><td>{e.state}</td><td>{e.services.length}</td></tr>)}
        </tbody></table></div> : <div className="empty">Ningún entorno todavía: <code>laru env init</code>.</div>}
      </section>
      <section className="panel" style={{ marginTop: 16 }}><header><h3>Escenarios</h3><div className="meta"><Origin of="declared" /> · <a className="rowlink" href={href('scenarios')}>Escenarios ›</a></div></header>
        {scn.length ? <ul className="plain">{scn.map((x) => <li key={x.id}><a className="rowlink" href={pageOf(x.id)}>{x.title}</a> <span className="faint">{x.summary}</span></li>)}</ul> : <div className="empty">Ningún escenario declarado.</div>}
      </section>
    </>
  );
}

/** «Lo referencian»: the pieces that name this one, in a field, a relation or a link. */
export function ReferencedBy({ k, p }: { k: KnowledgeData; p: DocPiece }) {
  const has = (v: unknown): boolean => typeof v === 'string' ? v === p.id || v.includes(`[[${p.id}]]`) : Array.isArray(v) ? v.some(has) : v && typeof v === 'object' ? Object.values(v).some(has) : false;
  const from = k.pieces.filter((x) => x.id !== p.id && (has(x.fields) || has(x.meta) || has(x.relations)));
  return (
    <section className="panel"><header><h3>Lo referencian</h3><div className="meta"><Origin of="derived" /></div></header>
      {from.length ? <ul className="plain body">{from.map((x) => <li key={x.id}><a className="rowlink" href={pageOf(x.id)}>{x.title}</a> <span className="faint">{pieceLabel(x.type)}</span></li>)}</ul> : <div className="empty">Ninguna pieza la nombra todavía.</div>}
    </section>
  );
}

/** The derived diagrams of the application: pick one, look at it, open any box. Nobody writes these, so they are never stale. */
export function Architecture() {
  const list = useApi<DerivedInfo[]>('/api/diagrams');
  const [pick, setPick] = useState<string>();
  const shown = (list.data ?? []).filter((d) => d.id !== 'relations');
  const id = pick ?? shown.find((d) => d.id === 'c4-container')?.id ?? shown[0]?.id;
  if (list.loading && !list.data) return <section className="panel"><div className="body"><Skeleton lines={4} /></div></section>;
  if (!id) return <section className="panel"><div className="empty">Todavía no se ha leído el código: sin mapa no hay diagramas calculados. <a className="rowlink" href={href('repos')}>Proyectos › Releer el código</a></div></section>;
  return (
    <>
      <div className="chips-row" role="tablist" aria-label="Diagramas calculados">
        {shown.map((d) => <button key={d.id} role="tab" aria-selected={d.id === id} className={`chip pick${d.id === id ? ' on' : ''}`} onClick={() => setPick(d.id)}>{d.title}</button>)}
      </div>
      <DiagramViewer id={id} />
    </>
  );
}

/**
 * A flow's start: where it runs, from which scenario, what it needs and how long it may take, and its own environment —
 * an instance of a project env with only what the flow needs, its scenario in and addresses of its own — to provision,
 * play its tests in and remove, from here. The progress is the env's own page.
 */
export function FlowStart({ k, p, flow, envs }: { k: KnowledgeData; p: DocPiece; flow?: FlowInfo; envs?: EnvSummary[] }) {
  const slug = p.id.replace(/^flow:/, '');
  const fe = useApi<FlowEnvData>(`/api/flow-env?flow=${encodeURIComponent(slug)}`);
  const scenario = flow?.scenario ?? (p.meta?.scenario as string | undefined);
  const needs = flow?.needs ?? ([] as string[]).concat(p.meta?.needs ?? []);
  const row = (label: string, v: ReactNode) => <div className="estado-row"><span className="k">{label}</span><div>{v}</div></div>;
  const d = fe.data;
  const busy = d?.op && !d.op.done;
  // while it starts or stops, ask again
  useEffect(() => { if (!busy) return; const t = setInterval(() => fe.reload(), 2500); return () => clearInterval(t); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const bases = (envs ?? []).filter((e) => !/^f-/.test(e.env)).map((e) => e.env);
  const [from, setFrom] = useState<string>();
  const base = from ?? d?.base ?? bases[0];
  const state = d?.status?.state;
  const post = (path: string, body: object) => api(path, { method: 'POST', body }).then(() => fe.reload());
  const refused = d?.op?.error && d.op.admission;
  return (
    <section className="panel estado" aria-labelledby="start-h"><header><h3 id="start-h">Cómo arrancarlo</h3><div className="meta"><Origin of="declared" /></div></header>
      {row('Entorno', d?.exists ? <><a className="rowlink mono" href={href('envs', d.instance)}>{d.instance}</a> — {state === 'ready' ? 'listo' : state === 'starting' || busy ? 'levantándose' : state ?? 'sin levantar'}{d.base ? `, derivado de ${d.base}` : ''}</>
        : flow?.runsOn ? <><span className="mono">{flow.runsOn.env}</span> ({flow.runsOn.ready ? 'listo' : 'se levanta al ejecutar'})</> : 'el que elijas al ejecutar, o uno propio de este flujo')}
      {row('Escenario', scenario ? <a className="rowlink mono" href={pageOf(scenario)}>{scenario}</a> : 'ninguno: parte de lo que haya')}
      {row('Necesita', needs.length ? <span className="chips-inline">{needs.map((n) => <a key={n} className="chip" href={href('map', n)}>{n}</a>)}</span> : 'nada declarado')}
      {row('Límite de tiempo', flow?.timeoutMs ? `${Math.round(flow.timeoutMs / 1000)} s` : 'el de siempre')}
      <div className="estado-acts">
        {!d?.exists || state === 'absent' ? <>
          {bases.length > 1 && <label className="faint">Derivarlo de <select value={base} onChange={(e) => setFrom(e.target.value)}>{bases.map((b) => <option key={b}>{b}</option>)}</select></label>}
          <ActionButton icon={Play} primary run={() => post('/api/flow-env/up', { flow: slug, from: base })} done={() => 'Levantando el entorno de este flujo'}>Aprovisionar su entorno</ActionButton>
        </> : <>
          {scenario && state === 'ready' && <ActionButton icon={Play} run={() => askFirst((confirm) => api('/api/scenarios/apply', { method: 'POST', body: { name: scenario, env: d.instance, confirm: confirm || true } }), 'Aplicar')} done={() => 'Escenario aplicado'}>Aplicar el escenario</ActionButton>}
          {state === 'ready' && <ActionButton icon={Play} primary run={() => askFirst((confirm) => api('/api/runs/start', { method: 'POST', body: { env: d.instance, flows: [slug], confirm } }), 'Ejecutar')} done={() => 'Jugando el flujo en su entorno'}>Ejecutar sus pruebas aquí</ActionButton>}
          <ActionButton icon={Trash2} run={() => post('/api/flow-env/down', { flow: slug })} done={() => 'Desaprovisionando'}>Desaprovisionar</ActionButton>
          <a className="btn" href={href('envs', d.instance)}>Ver su entorno</a>
        </>}
      </div>
      {refused && <div className="notice" role="alert" style={{ margin: '0 16px 12px' }}><div><b>No se levantó.</b> {admissionText(d!.op!.admission!, d!.instance)}
        {d!.op!.admission!.offer && <> <ActionButton icon={Play} sm run={() => post('/api/flow-env/up', { flow: slug, from: base, stopOffered: true })}>{`Parar ${d!.op!.admission!.offer!.env} y seguir`}</ActionButton></>}</div></div>}
      {d?.op?.error && !refused && <div className="notice" role="alert" style={{ margin: '0 16px 12px' }}><div><b>No se pudo.</b> <span className="mono">{d.op.error}</span></div></div>}
      <p className="faint" style={{ margin: '4px 16px 12px' }}>Es una instancia de {bases.length ? bases.join(' o ') : 'un entorno'} entera (la aplicación llama a más servicios de los que el flujo nombra), con direcciones propias en 127.0.0.1; tu {bases[0] ?? 'entorno'} no se toca salvo que confirmes pararlo para que quepa.</p>
    </section>
  );
}

/**
 * «Probar en vivo», inside the flow it is about: start a session with this flow's scenario on its own environment (or one
 * that is up), use the application and read, act by act, what each click provokes. Saved, the session is a run.
 */
export function FlowLive({ p, flow, g, sid }: { p: DocPiece; flow?: FlowInfo; g: Indexed | null; sid?: string }) {
  const slug = p.id.replace(/^flow:/, '');
  const fe = useApi<FlowEnvData>(`/api/flow-env?flow=${encodeURIComponent(slug)}`);
  const own = fe.data?.exists && fe.data.status?.state === 'ready' ? fe.data.instance : undefined;
  const scenario = flow?.scenario ?? (p.meta?.scenario as string | undefined);
  const preset: Preset = { flow: slug, title: `Probar «${p.title}»`, scenario, env: own, to: (id) => href('docs', p.id, 't', 'live', id) };
  if (sid) return <><p style={{ margin: '0 0 12px' }}><a className="rowlink" href={href('docs', p.id, 't', 'live')}>‹ Sesiones de este flujo</a></p><Session id={sid} g={g} embedded /></>;
  return (
    <>
      <p className="faint" style={{ maxWidth: '72ch', margin: '0 0 12px' }}>Usa el aplicativo con los datos de este flujo y mira, mientras lo haces, cada salto que provoca: de servicio en servicio, en las bases y en las colas. Al parar, la sesión queda guardada como un run de «{p.title}».</p>
      <Start preset={preset} />
    </>
  );
}

/** The computed lists of a flow: the services and endpoints its last run reached, and its spec by name and line. */
export function FlowLists({ p, flow }: { p: DocPiece; flow?: FlowInfo }) {
  const live = useApi<LiveData>(`/api/live?id=${encodeURIComponent(p.id)}`);
  const eps = flow?.last?.endpoints ?? [];
  return (
    <>
      <section className="panel"><header><h3>Servicios y endpoints que toca</h3><div className="meta"><Origin of="observed" /></div></header>
        {flow?.last ? (
          <div className="body">
            <p>{flow.last.nodes.map((n) => <a key={n} className="chip" style={{ marginRight: 4 }} href={href('map', n)}>{n}</a>)}</p>
            {eps.length ? <div className="scroll-x"><table className="t"><thead><tr><th>Endpoint</th><th>Pasos</th><th>Resultado</th></tr></thead><tbody>
              {eps.map((e) => <tr key={e.id}><td className="mono">{e.id.replace(/^ep:/, '')}</td><td>{e.steps.map((s) => s + 1).join(', ')}</td><td><Status state={e.ok ? 'ok' : 'err'}>{e.ok ? 'bien' : 'con error'}</Status></td></tr>)}
            </tbody></table></div> : <p className="faint">Su último run no llegó a ningún endpoint dentro de un paso.</p>}
          </div>
        ) : <div className="empty">Nunca corrió: lo que toca se sabrá con su primer run.</div>}
      </section>
      <section className="panel" style={{ marginTop: 16 }}><header><h3>Pruebas de este flujo</h3><div className="meta"><Origin of="extracted" /></div></header>
        {live.loading && !live.data ? <div className="body"><Skeleton lines={3} /></div> : !live.data?.tests.length ? <div className="empty">Sin fichero de pruebas.</div> : (
          <div className="body">{live.data.tests.map((t) => (
            <div key={t.file}><p className="faint mono small">{t.file}</p><ul className="cases">{t.cases.map((c) => <li key={c.line}>{c.name} <span className="mono faint">:{c.line}</span></li>)}</ul></div>
          ))}</div>
        )}
      </section>
      {live.data && live.data.deviations.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}><header><h3>Desviaciones conocidas</h3><div className="meta"><Origin of="extracted" /> · lo que la aplicación hace distinto de lo documentado</div></header>
          <ul className="body cases">{live.data.deviations.map((d) => <li key={d.line}>{d.text} <span className="mono faint">:{d.line}</span></li>)}</ul></section>
      )}
    </>
  );
}

/** What a scenario adds to its declared sections: who uses it, and whether it is ready. */
export function ScenarioExtras({ k, p, envs }: { k: KnowledgeData; p: DocPiece; envs?: EnvSummary[] }) {
  const users = k.pieces.filter((x) => x.type === 'flow' && ([] as string[]).concat(x.meta?.scenario ?? []).includes(p.id));
  const ran = (envs ?? []).filter((e) => e.state !== 'absent');
  const exclusive = String(p.meta?.exclusive) === 'true' || (p.fields.restart as string[] | undefined)?.length || (p.fields.mocks as unknown[] | undefined)?.length || (p.fields.faults as unknown[] | undefined)?.length;
  return (
    <>
      <section className="panel"><header><h3>Estado en cada entorno</h3><div className="meta"><Origin of="observed" /> · <a className="rowlink" href={href('scenarios')}>Escenarios ›</a></div></header>
        <p className="faint" style={{ padding: '0 16px' }}>{exclusive ? 'Es exclusivo: necesita el entorno entero, así que en un run corre solo, al final, restaurado desde su instantánea.' : 'Se siembra: en un run cada flujo juega su preparación con sus propios nombres, sin restaurar nada, junto a los demás.'}</p>
        {!envs ? <div className="body"><Skeleton lines={2} /></div> : !ran.length ? <div className="empty">Ningún entorno se ha levantado.</div>
          : <div className="body scroll-x"><table className="t"><thead><tr><th>Entorno</th><th>Estado</th><th>Cómo se pone</th><th>Se repite en</th><th>Qué conserva</th></tr></thead><tbody>{ran.map((e) => <ScenarioInEnv key={e.env} env={e.env} id={p.id} />)}</tbody></table></div>}
      </section>
      <section className="panel" style={{ marginTop: 16 }}><header><h3>Flujos que lo usan</h3><div className="meta"><Origin of="derived" /></div></header>
        {users.length ? <ul className="plain body">{users.map((f) => <li key={f.id}><a className="rowlink" href={pageOf(f.id)}>{f.title}</a></li>)}</ul> : <div className="empty">Ningún flujo parte de este escenario.</div>}</section>
    </>
  );
}

function ScenarioInEnv({ env, id }: { env: string; id: string }) {
  const sc = useApi<ScenariosData>(`/api/scenarios?env=${encodeURIComponent(env)}`);
  const st = sc.data?.scenarios.find((s) => `scn:${s.slug}` === id)?.state;
  const secs = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
  return (
    <tr><td><a className="rowlink mono" href={href('envs', env)}>{env}</a></td>
      <td>{!sc.data ? '…' : !st ? 'sin preparar' : st.broken ? <span className="pending">roto</span> : 'preparado'}</td>
      <td>{!st || st.broken ? '—' : st.mode === 'snapshot' ? 'desde instantáneas' : 'jugando su preparación'}</td>
      <td className="mono">{secs(st?.applyMs ?? st?.ms)}</td>
      <td className="wrap">{!st || st.broken ? '—' : [st.touched.length ? `escribe en ${st.touched.join(', ')}` : 'no escribe', st.keeps.length ? `${st.keeps.join(', ')} sin instantánea: conservan lo de antes` : ''].filter(Boolean).join('; ')}</td></tr>
  );
}

const LEVEL_WORD: Record<string, string> = { compose: 'el compose', app: 'aplicativo', env: 'entorno', service: 'servicio', flows: 'flujos', personal: 'personal' };

/**
 * Which level of the vault wins for each variable a piece's code reads, in the environment you pick, and its value: this
 * is the person's own machine, so a secret is shown like any other. Changing one is done in «Variables y secretos».
 */
export function VarLevels({ names, service }: { names: Array<{ name: string; secret: boolean }>; service?: string }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const [pick, setPick] = useState<string>();
  const env = pick ?? envs.data?.find((e) => e.state === 'ready')?.env ?? envs.data?.[0]?.env;
  const vars = useApi<VarsData>(env ? `/api/vars?env=${encodeURIComponent(env)}` : null);
  const [vals, setVals] = useState<Array<{ section: string; key: string; value: string }>>([]);
  useEffect(() => { if (env) api<{ entries: typeof vals }>('/api/vars/values', { method: 'POST', body: { env } }).then((r) => setVals(r.entries), () => setVals([])); }, [env]);
  if (!names.length) return <section className="panel"><div className="empty">Su código no lee variables de entorno.</div></section>;
  const rows = new Map((vars.data?.rows ?? []).map((r) => [r.key, r]));
  return (
    <section className="panel"><header><h3>Variables y secretos</h3>
      <div className="meta"><Origin of="extracted" /> + vault{env && <> · <a className="rowlink" href={href('vars', env)}>Editar ›</a></>}{envs.data && envs.data.length > 1 && <select aria-label="Entorno" value={env} onChange={(e) => setPick(e.target.value)} style={{ marginLeft: 8 }}>{envs.data.map((e) => <option key={e.env}>{e.env}</option>)}</select>}</div></header>
      <div className="body scroll-x"><table className="t"><thead><tr><th>Variable</th><th>Tipo</th><th>Nivel efectivo{env ? ` en ${env}` : ''}</th><th>Valor</th><th>La fijan</th></tr></thead><tbody>
        {names.map((n) => {
          const r = rows.get(n.name);
          return <tr key={n.name}><td className="mono">{n.name}</td><td>{n.secret || r?.secret ? 'secreto' : 'variable'}</td>
            <td>{!env ? '—' : !vars.data ? '…' : !r ? <span className="faint">el vault no la conoce</span> : r.effective ? LEVEL_WORD[r.effective] ?? r.effective : <span className="pending">sin valor</span>}</td>
            <td className="mono">{r?.effective ? (vals.find((v) => v.section === r.effective && v.key === n.name)?.value ?? <span className="faint">{r.effective === 'compose' ? 'el del compose' : '—'}</span>) : '—'}</td>
            <td className="faint">{r?.levels.map((l) => LEVEL_WORD[l] ?? l).join(' › ') || '—'}{service && r && !r.readers.includes(service) ? '' : ''}</td></tr>;
        })}
      </tbody></table></div></section>
  );
}

/** Test files by name and line, with where each came from. */
export function TestList({ tests, rule }: { tests: LiveData['tests']; rule?: string }) {
  const total = tests.reduce((n, t) => n + t.count, 0);
  return (
    <section className="panel"><header><h3>Pruebas</h3><div className="meta"><Origin of="extracted" /> · {plural(total, 'prueba', 'pruebas')} en {plural(tests.length, 'fichero', 'ficheros')}</div></header>
      {rule && <p className="faint" style={{ padding: '0 16px' }}>{rule}</p>}
      {tests.length ? <div className="body">{tests.map((t) => (
        <details key={t.file} className="test-file"><summary><span className="mono">{t.file.slice(t.file.indexOf(':') + 1).split('/').at(-1)}</span> <span className="faint">· {t.level} · {plural(t.count, 'prueba', 'pruebas')} · {t.file}</span></summary>
          <ul>{t.cases.map((c) => <li key={c.line}><span>{c.name}</span> <span className="mono faint">:{c.line}</span></li>)}</ul></details>
      ))}</div> : <div className="empty">Ninguna prueba.</div>}
    </section>
  );
}

export { noteLevel };

const VERDICT_DOT: Record<string, DotState> = { igual: 'ok', aceptado: 'idle', distinto: 'err', 'sin referencia': 'queue', 'no aplica': 'idle' };

/**
 * An env against what the infrastructure declares of production: each aspect with its verdict. A difference accepted on
 * purpose shows its reason; what no source says is marked as having no reference, never as equal.
 */
export function FidelityTable({ env, compact }: { env: string; compact?: boolean }) {
  const f = useApi<Fidelity>(`/api/fidelity?env=${encodeURIComponent(env)}`);
  if (f.loading && !f.data) return <div className="body"><Skeleton lines={3} /></div>;
  if (f.error || !f.data) return <div className="empty">{/never been started/.test(f.error ?? '') ? `${env} todavía no se ha levantado: su fidelidad se lee de lo que corre.` : f.error}</div>;
  const noRef = f.data.rows.filter((r) => r.verdict === 'sin referencia').length;
  const rows = f.data.rows.filter((r) => r.prod !== '—' && r.verdict !== 'sin referencia' && (!compact || r.verdict === 'distinto' || r.verdict === 'aceptado'));
  if (!rows.length) return <div className="empty">{compact ? 'Todo lo que producción declara coincide con este entorno.' : 'Nada que contrastar todavía: declara aspectos de producción en la infraestructura.'}</div>;
  return (
    <div className="body scroll-x"><table className="t">
      <thead><tr><th>Quién</th><th>Aspecto</th><th>Producción</th><th>Este entorno</th><th>Veredicto</th></tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i}><td className="mono">{r.name}</td><td>{FIDELITY_WORDS[r.aspect ?? ''] ?? r.aspect ?? r.kind}</td><td className="wrap">{r.prod ?? <span className="faint">sin referencia</span>}</td><td className="wrap">{r.local}</td>
          <td><Status state={VERDICT_DOT[r.verdict ?? 'sin referencia']}>{r.verdict}</Status>{r.accepted && <div className="faint small">{r.accepted.reason}{r.accepted.until ? `. Hasta el ${r.accepted.until}` : ''}</div>}</td></tr>
      ))}</tbody>
    </table>{noRef > 0 && <p className="faint small" style={{ marginTop: 8 }}>{plural(noRef, 'aspecto de este entorno', 'aspectos de este entorno')} sin referencia de producción: no se comparan hasta que la infraestructura los declare.</p>}</div>
  );
}

/** The infrastructure sheet's contrast: every env that has run, one table each. */
export function FidelityByEnv({ envs }: { envs?: EnvSummary[] }) {
  const ran = (envs ?? []).filter((e) => e.state !== 'absent');
  return (
    <section className="panel"><header><h3>Fidelidad</h3><div className="meta"><Origin of="derived" /> · cada aspecto declarado frente a cada entorno</div></header>
      {!envs ? <div className="body"><Skeleton lines={3} /></div> : !ran.length ? <div className="empty">Ningún entorno se ha levantado: <code>laru up</code>.</div>
        : ran.map((e) => <div key={e.env}><h4 style={{ margin: '12px 16px 0' }}>{e.env}</h4><FidelityTable env={e.env} /></div>)}
    </section>
  );
}
